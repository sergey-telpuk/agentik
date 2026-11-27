package webrtc

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // the coturn scheme under test uses HMAC-SHA1
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func fpText(b byte) string {
	parts := make([]string, 32)
	for i := range parts {
		parts[i] = strings.ToUpper(string("0123456789abcdef"[b>>4])) + strings.ToUpper(string("0123456789abcdef"[b&15]))
	}
	return strings.Join(parts, ":")
}

func TestExtractFingerprint(t *testing.T) {
	a, b := fpText(0xAB), fpText(0xCD)
	cases := []struct {
		name string
		sdp  string
		want []byte
		err  bool
	}{
		{"session level", "v=0\r\na=fingerprint:sha-256 " + a + "\r\nm=application\r\n", bytes.Repeat([]byte{0xAB}, 32), false},
		{"media level lower case", "v=0\r\nm=application\r\na=fingerprint:SHA-256 " + strings.ToLower(a) + "\r\n", bytes.Repeat([]byte{0xAB}, 32), false},
		{"same value twice", "a=fingerprint:sha-256 " + a + "\r\na=fingerprint:sha-256 " + a + "\r\n", bytes.Repeat([]byte{0xAB}, 32), false},
		{"two different values", "a=fingerprint:sha-256 " + a + "\r\na=fingerprint:sha-256 " + b + "\r\n", nil, true},
		{"none", "v=0\r\n", nil, true},
		{"only sha-1", "a=fingerprint:sha-1 AB:CD\r\n", nil, true},
		{"short", "a=fingerprint:sha-256 AB:CD\r\n", nil, true},
		{"not hex", "a=fingerprint:sha-256 " + strings.Replace(a, "AB", "ZZ", 1) + "\r\n", nil, true},
		{"missing value", "a=fingerprint:sha-256\r\n", nil, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ExtractFingerprint(c.sdp)
			if c.err {
				if err == nil {
					t.Fatalf("accepted: %x", got)
				}
				return
			}
			if err != nil || !bytes.Equal(got, c.want) {
				t.Fatalf("got %x, %v", got, err)
			}
		})
	}
	if _, err := ExtractFingerprint("v=0"); !errors.Is(err, ErrNoFingerprint) {
		t.Fatalf("want ErrNoFingerprint, got %v", err)
	}
}

func TestTURNCredentialsMatchCoturnScheme(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := ICEConfig{TURNSecret: []byte("secret"), TURNTTL: time.Hour, Now: func() time.Time { return now }}
	user, cred := c.TURNCredentials("agentik")
	if user != "1700003600:agentik" {
		t.Fatalf("username = %q", user)
	}
	mac := hmac.New(sha1.New, []byte("secret"))
	mac.Write([]byte(user))
	if want := base64.StdEncoding.EncodeToString(mac.Sum(nil)); cred != want {
		t.Fatalf("credential = %q, want %q", cred, want)
	}
	if _, other := (ICEConfig{TURNSecret: []byte("other"), TURNTTL: time.Hour, Now: c.Now}).TURNCredentials("agentik"); other == cred {
		t.Fatal("the credential does not depend on the secret")
	}
	if u, _ := (ICEConfig{TURNSecret: []byte("s"), Now: c.Now}).TURNCredentials(""); u != "1700000600" {
		t.Fatalf("default TTL username = %q", u)
	}
}

func TestICEConfigValidate(t *testing.T) {
	ok := ICEConfig{STUNURLs: []string{"stun:a.example:3478"}, TURNURLs: []string{"turns:a.example:5349?transport=tcp"}, TURNSecret: []byte("s")}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (ICEConfig{}).Validate(); err != nil {
		t.Fatalf("an empty config (direct paths only) must be valid: %v", err)
	}
	bad := []ICEConfig{
		{TURNURLs: []string{"turn:a.example"}},
		{STUNURLs: []string{"turn:a.example"}, TURNSecret: []byte("s")},
		{TURNURLs: []string{"stun:a.example"}, TURNSecret: []byte("s")},
		{STUNURLs: []string{"https://a.example"}},
		{STUNURLs: []string{"stun:"}},
		{TURNURLs: []string{"turn:a.example"}, TURNSecret: []byte("s"), TURNTTL: -time.Second},
	}
	for i, c := range bad {
		if c.Validate() == nil {
			t.Errorf("case %d accepted: %+v", i, c)
		}
	}
	if s := (ICEConfig{STUNURLs: []string{"stun:a.example"}}).Servers("x"); len(s) != 1 || s[0].Username != "" {
		t.Fatalf("STUN-only servers = %+v", s)
	}
}
