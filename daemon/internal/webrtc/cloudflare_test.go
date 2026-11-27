package webrtc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// cloudflareStub answers like the documented endpoint and records the calls.
func cloudflareStub(t *testing.T, body string, status int) (*httptest.Server, *atomic.Int64, *atomic.Value) {
	t.Helper()
	var calls atomic.Int64
	var lastAuth atomic.Value
	lastAuth.Store("")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		lastAuth.Store(r.Header.Get("Authorization"))
		if r.Method != http.MethodPost {
			t.Errorf("got method %s, want POST", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls, &lastAuth
}

const validICEBody = `{"iceServers":[
  {"urls":["stun:stun.cloudflare.com:3478"]},
  {"urls":["turn:turn.cloudflare.com:3478?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"],
   "username":"user-abc","credential":"cred-xyz"}
]}`

// provider points a CloudflareTURN at the stub instead of the real endpoint.
func provider(t *testing.T, srv *httptest.Server, now func() time.Time) *CloudflareTURN {
	t.Helper()
	return &CloudflareTURN{
		KeyID:      "key-1",
		Token:      "token-secret",
		TTL:        10 * time.Minute,
		Now:        now,
		HTTPClient: srv.Client(),
		endpoint:   srv.URL,
	}
}

func TestCloudflareTURNReturnsCredentialsFromTheAPI(t *testing.T) {
	srv, calls, auth := cloudflareStub(t, validICEBody, http.StatusCreated)
	p := provider(t, srv, nil)

	servers, err := p.Servers(context.Background())
	if err != nil {
		t.Fatalf("Servers failed: %v", err)
	}
	if len(servers) != 2 {
		t.Fatalf("got %d ICE servers, want 2", len(servers))
	}
	if servers[1].Username != "user-abc" || servers[1].Credential != "cred-xyz" {
		t.Fatalf("credentials not carried through: %+v", servers[1])
	}
	if calls.Load() != 1 {
		t.Fatalf("got %d API calls, want 1", calls.Load())
	}
	// The token authenticates the daemon to Cloudflare and must be sent as a
	// bearer token, never as part of the ICE list handed to a phone.
	if got := auth.Load().(string); got != "Bearer token-secret" {
		t.Fatalf("got Authorization %q", got)
	}
	for _, s := range servers {
		for _, u := range s.URLs {
			if strings.Contains(u, "token-secret") {
				t.Fatal("the API token leaked into an ICE URL")
			}
		}
	}
}

func TestCloudflareTURNCachesUntilTheCredentialsAreNearlyExpired(t *testing.T) {
	srv, calls, _ := cloudflareStub(t, validICEBody, http.StatusCreated)
	base := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	clock := base
	p := provider(t, srv, func() time.Time { return clock })

	if _, err := p.Servers(context.Background()); err != nil {
		t.Fatalf("first fetch failed: %v", err)
	}
	// Well inside the lifetime: served from the cache.
	clock = base.Add(1 * time.Minute)
	if _, err := p.Servers(context.Background()); err != nil {
		t.Fatalf("cached fetch failed: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("got %d API calls, want the cache to be used", calls.Load())
	}

	// Inside the renewal window: fetched again, so a phone never receives a
	// credential that expires while ICE is still negotiating.
	clock = base.Add(9 * time.Minute)
	if _, err := p.Servers(context.Background()); err != nil {
		t.Fatalf("renewal failed: %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("got %d API calls, want a renewal", calls.Load())
	}
}

func TestCloudflareTURNReportsFailuresWithoutLeakingTheToken(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		status int
	}{
		{"refused", `{"error":"bad token token-secret"}`, http.StatusUnauthorized},
		{"malformed", `not json`, http.StatusCreated},
		{"empty list", `{"iceServers":[]}`, http.StatusCreated},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, _, _ := cloudflareStub(t, tc.body, tc.status)
			p := provider(t, srv, nil)
			_, err := p.Servers(context.Background())
			if err == nil {
				t.Fatal("expected an error")
			}
			// The response body may echo the token back; the error must not.
			if strings.Contains(err.Error(), "token-secret") {
				t.Fatalf("the token leaked into an error: %v", err)
			}
		})
	}
}

func TestCloudflareTURNDropsThePortBrowsersBlock(t *testing.T) {
	body := `{"iceServers":[{"urls":["turn:turn.cloudflare.com:53?transport=udp","turn:turn.cloudflare.com:3478?transport=udp"],"username":"u","credential":"c"}]}`
	srv, _, _ := cloudflareStub(t, body, http.StatusCreated)
	p := provider(t, srv, nil)

	servers, err := p.Servers(context.Background())
	if err != nil {
		t.Fatalf("Servers failed: %v", err)
	}
	for _, s := range servers {
		for _, u := range s.URLs {
			if strings.Contains(u, ":53") {
				t.Fatalf("port 53 is blocked by browsers and should be dropped: %q", u)
			}
		}
	}
}

func TestCloudflareTURNRequestsTheConfiguredTTL(t *testing.T) {
	var got atomic.Value
	got.Store(int64(0))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			TTL int64 `json:"ttl"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		got.Store(body.TTL)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(validICEBody))
	}))
	t.Cleanup(srv.Close)

	p := provider(t, srv, nil)
	p.TTL = 7 * time.Minute
	if _, err := p.Servers(context.Background()); err != nil {
		t.Fatalf("Servers failed: %v", err)
	}
	if got.Load().(int64) != 420 {
		t.Fatalf("got ttl %v seconds, want 420", got.Load())
	}
}

func TestCloudflareTURNValidatesItsConfiguration(t *testing.T) {
	// Built per case rather than stored in the table: CloudflareTURN holds a
	// mutex, and ranging over a table of them would copy it.
	cases := []struct {
		name string
		make func() *CloudflareTURN
	}{
		{"no key id", func() *CloudflareTURN { return &CloudflareTURN{Token: "t"} }},
		{"no token", func() *CloudflareTURN { return &CloudflareTURN{KeyID: "k"} }},
		{"negative ttl", func() *CloudflareTURN { return &CloudflareTURN{KeyID: "k", Token: "t", TTL: -time.Second} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.make().Validate(); err == nil {
				t.Fatal("expected the configuration to be refused")
			}
		})
	}
}
