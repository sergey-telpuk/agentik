package webrtc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Cloudflare Realtime TURN mints short-lived credentials through its own API
// rather than from a shared secret, so the coturn derivation in ice.go does not
// apply. The long-lived API token stays on this computer: only the derived
// username and credential are sent to the phone, exactly as with coturn.
//
// https://developers.cloudflare.com/realtime/turn/generate-credentials/
const cloudflareTURNEndpoint = "https://rtc.live.cloudflare.com/v1/turn/keys"

// cloudflareRequestTimeout bounds one credential request. A phone is waiting
// for ice_servers, so failing fast and falling back to STUN beats hanging.
const cloudflareRequestTimeout = 10 * time.Second

// cloudflareRenewBefore is how long before expiry a cached list is refreshed,
// so a credential handed out now is still valid while ICE is negotiating.
const cloudflareRenewBefore = 2 * time.Minute

// CloudflareTURN fetches ICE servers from Cloudflare Realtime TURN.
//
// Credentials are cached until shortly before they expire: every phone that
// attaches would otherwise cost an API round trip, and the rate limit in
// acceptor.go bounds issuance, not fetching.
type CloudflareTURN struct {
	// KeyID identifies the TURN key; it is not a secret.
	KeyID string
	// Token is the API token for that key. It never leaves this computer.
	Token string
	// TTL is the lifetime requested for a credential; zero means DefaultTURNTTL.
	TTL time.Duration
	// HTTPClient is replaceable in tests; nil means a client with a timeout.
	HTTPClient *http.Client
	// Now is the clock, replaceable in tests.
	Now func() time.Time
	// endpoint overrides the API base in tests; empty means Cloudflare's.
	endpoint string

	mu       sync.Mutex
	cached   []ICEServer
	expires  time.Time
	fetching bool
}

// Validate reports whether the provider is configured well enough to use.
func (c *CloudflareTURN) Validate() error {
	if strings.TrimSpace(c.KeyID) == "" {
		return errors.New("webrtc: Cloudflare TURN needs a key id")
	}
	if strings.TrimSpace(c.Token) == "" {
		return errors.New("webrtc: Cloudflare TURN needs an API token")
	}
	if c.TTL < 0 {
		return errors.New("webrtc: TURN TTL must not be negative")
	}
	return nil
}

func (c *CloudflareTURN) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *CloudflareTURN) ttl() time.Duration {
	if c.TTL > 0 {
		return c.TTL
	}
	return DefaultTURNTTL
}

// Servers returns the current ICE server list, fetching a new one when the
// cached credentials are gone or about to expire. On any failure it returns
// nil, and the caller falls back to its configured STUN servers: a TURN
// outage must not take the direct path down with it.
func (c *CloudflareTURN) Servers(ctx context.Context) ([]ICEServer, error) {
	c.mu.Lock()
	if c.cached != nil && c.now().Before(c.expires.Add(-cloudflareRenewBefore)) {
		servers := append([]ICEServer(nil), c.cached...)
		c.mu.Unlock()
		return servers, nil
	}
	c.mu.Unlock()

	fetched, expires, err := c.fetch(ctx)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.cached = fetched
	c.expires = expires
	servers := append([]ICEServer(nil), fetched...)
	c.mu.Unlock()
	return servers, nil
}

type cloudflareICEResponse struct {
	ICEServers []struct {
		URLs       []string `json:"urls"`
		Username   string   `json:"username"`
		Credential string   `json:"credential"`
	} `json:"iceServers"`
}

func (c *CloudflareTURN) fetch(ctx context.Context) ([]ICEServer, time.Time, error) {
	if err := c.Validate(); err != nil {
		return nil, time.Time{}, err
	}
	ttl := c.ttl()
	body, err := json.Marshal(map[string]any{"ttl": int64(ttl.Seconds())})
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("webrtc: encode TURN request: %w", err)
	}

	reqCtx, cancel := context.WithTimeout(ctx, cloudflareRequestTimeout)
	defer cancel()
	base := c.endpoint
	if base == "" {
		base = cloudflareTURNEndpoint
	}
	url := fmt.Sprintf("%s/%s/credentials/generate-ice-servers", base, c.KeyID)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("webrtc: build TURN request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: cloudflareRequestTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("webrtc: request TURN credentials: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// Bounded: a malfunctioning endpoint must not be able to exhaust memory.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("webrtc: read TURN response: %w", err)
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		// The body may carry the token back; report the status only.
		return nil, time.Time{}, fmt.Errorf("webrtc: TURN credentials refused with status %d", resp.StatusCode)
	}

	var decoded cloudflareICEResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, time.Time{}, fmt.Errorf("webrtc: decode TURN response: %w", err)
	}

	servers := make([]ICEServer, 0, len(decoded.ICEServers))
	for _, entry := range decoded.ICEServers {
		urls := make([]string, 0, len(entry.URLs))
		for _, u := range entry.URLs {
			// Port 53 is blocked by browsers and only costs ICE time.
			if strings.Contains(u, ":53?") || strings.HasSuffix(u, ":53") {
				continue
			}
			urls = append(urls, u)
		}
		if len(urls) == 0 {
			continue
		}
		servers = append(servers, ICEServer{URLs: urls, Username: entry.Username, Credential: entry.Credential})
	}
	if len(servers) == 0 {
		return nil, time.Time{}, errors.New("webrtc: TURN response carried no usable ICE servers")
	}
	return servers, c.now().Add(ttl), nil
}
