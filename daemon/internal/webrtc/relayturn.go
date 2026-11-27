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
	ready   chan struct{}
}

// Wait blocks until credentials have arrived, the context ends, or the grace
// period passes.
//
// A phone that attaches while the daemon is still registering would otherwise
// be handed a list with no relayed candidate in it, and fail to connect on a
// network that needs one. Waiting a moment is better than that; giving up
// after the grace period is better than hanging.
func (r *RelayTURN) Wait(ctx context.Context, grace time.Duration) {
	r.mu.Lock()
	if len(r.servers) > 0 {
		r.mu.Unlock()
		return
	}
	if r.ready == nil {
		r.ready = make(chan struct{})
	}
	ready := r.ready
	r.mu.Unlock()

	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-ready:
	case <-timer.C:
	case <-ctx.Done():
	}
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
	if r.ready != nil {
		close(r.ready)
		r.ready = nil
	}
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
