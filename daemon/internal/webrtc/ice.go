package webrtc

import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // coturn's use-auth-secret scheme is defined with HMAC-SHA1
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultTURNTTL is how long generated TURN credentials stay valid.
const DefaultTURNTTL = 10 * time.Minute

// ICEServer is one STUN or TURN server in the form RTCPeerConnection expects.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// ICEConfig describes the STUN and TURN servers the daemon uses and hands to
// the phone. Nothing here names a provider: every URL comes from the
// operator's configuration, typically a coturn instance on their own VPS.
type ICEConfig struct {
	// STUNURLs are plain STUN servers (stun: or stuns: URLs).
	STUNURLs []string
	// TURNURLs are TURN servers (turn: or turns: URLs).
	TURNURLs []string
	// TURNSecret is the shared secret of coturn's use-auth-secret mode.
	// It never leaves the daemon: only credentials derived from it do.
	TURNSecret []byte
	// TURNTTL is the lifetime of derived credentials; zero means DefaultTURNTTL.
	TURNTTL time.Duration
	// Now is the clock, replaceable in tests.
	Now func() time.Time
}

// Validate checks the URLs and that TURN servers come with a secret.
func (c ICEConfig) Validate() error {
	for _, u := range c.STUNURLs {
		if err := validateICEURL(u, "stun", "stuns"); err != nil {
			return err
		}
	}
	for _, u := range c.TURNURLs {
		if err := validateICEURL(u, "turn", "turns"); err != nil {
			return err
		}
	}
	if len(c.TURNURLs) > 0 && len(c.TURNSecret) == 0 {
		return errors.New("webrtc: TURN URLs need a TURN secret to derive time-limited credentials")
	}
	if c.TURNTTL < 0 {
		return errors.New("webrtc: TURN TTL must not be negative")
	}
	return nil
}

func validateICEURL(raw string, schemes ...string) error {
	scheme, rest, ok := strings.Cut(raw, ":")
	if !ok || rest == "" {
		return fmt.Errorf("webrtc: invalid ICE URL %q", raw)
	}
	for _, s := range schemes {
		if scheme == s {
			// Parse the host part the way the ICE agent will.
			if _, err := url.Parse("//" + strings.SplitN(rest, "?", 2)[0]); err != nil {
				return fmt.Errorf("webrtc: invalid ICE URL %q", raw)
			}
			return nil
		}
	}
	return fmt.Errorf("webrtc: ICE URL %q must use one of %v", raw, schemes)
}

// Servers returns the ICE server list with freshly derived TURN credentials.
// label is mixed into the username for auditing in the TURN server's logs; it
// carries no authority.
func (c ICEConfig) Servers(label string) []ICEServer {
	var out []ICEServer
	if len(c.STUNURLs) > 0 {
		out = append(out, ICEServer{URLs: append([]string(nil), c.STUNURLs...)})
	}
	if len(c.TURNURLs) > 0 && len(c.TURNSecret) > 0 {
		user, cred := c.TURNCredentials(label)
		out = append(out, ICEServer{
			URLs:       append([]string(nil), c.TURNURLs...),
			Username:   user,
			Credential: cred,
		})
	}
	return out
}

// TURNCredentials derives a time-limited credential in coturn's
// use-auth-secret form: the username is "<expiry unix seconds>:<label>" and
// the password is base64(HMAC-SHA1(secret, username)). The TURN server
// recomputes the HMAC and refuses the credential once the expiry has passed.
func (c ICEConfig) TURNCredentials(label string) (username, credential string) {
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	ttl := c.TURNTTL
	if ttl == 0 {
		ttl = DefaultTURNTTL
	}
	expiry := now().Add(ttl).Unix()
	username = strconv.FormatInt(expiry, 10)
	if label != "" {
		username += ":" + label
	}
	mac := hmac.New(sha1.New, c.TURNSecret)
	mac.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
