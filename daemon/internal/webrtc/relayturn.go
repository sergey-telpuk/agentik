package webrtc

import (
	"context"
	"errors"
	"sync"
	"time"
)

// RelayTURN holds the ICE servers the relay minted for this device.
//
// TURN has no anonymous mode, so somebody's key has to sign for the traffic.
// Having the relay hold one key and hand out derived, short-lived credentials
// is what keeps a user from configuring anything: the daemon asks once it has
// registered, and the registration signature is what entitles it to ask.
type RelayTURN struct {
	// Now is the clock, replaceable in tests.
	Now func() time.Time

	mu      sync.RWMutex
	servers []ICEServer
	expires time.Time
}

// ErrNoRelayCredentials is returned before the relay has answered, or once
// the credentials it gave have expired.
var ErrNoRelayCredentials = errors.New("webrtc: no TURN credentials from the relay")

func (r *RelayTURN) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Store records credentials and how long they last.
func (r *RelayTURN) Store(servers []ICEServer, ttl time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.servers = append([]ICEServer(nil), servers...)
	r.expires = r.now().Add(ttl)
}

// Servers returns the stored list while it is still valid.
//
// Expired credentials are reported as absent rather than handed over: a phone
// that tried them would fail ICE for a reason it could not see. The daemon
// re-registers on every reconnect, which is when fresh ones arrive.
func (r *RelayTURN) Servers(context.Context) ([]ICEServer, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.servers) == 0 || !r.now().Before(r.expires) {
		return nil, ErrNoRelayCredentials
	}
	return append([]ICEServer(nil), r.servers...), nil
}
