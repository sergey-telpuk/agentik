package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/pairing"
	"github.com/sergey-telpuk/agentik/daemon/internal/secure"
)

// Hub wires a pairing.Service, runtime.Service, and secure.Manager together
// over a transport frame sender, enforcing peer admission, session tracking,
// and live event broadcasting strictly to paired, non-revoked clients.
type Hub struct {
	identity *identity.Identity
	pairing  *pairing.Service
	runtime  *Service
	manager  *secure.Manager

	mu       sync.Mutex
	sessions map[string]*secure.ManagedSession
}

// NewHub creates a secure.Manager + Hub binding Noise sessions to pairing and
// the local task runtime.
func NewHub(
	id *identity.Identity,
	pairSvc *pairing.Service,
	rtCfg Config,
	sender secure.FrameSender,
	onSecureError func(connectionID string, err error),
) (*Hub, error) {
	if id == nil {
		return nil, errors.New("runtime: identity is required")
	}
	if pairSvc == nil {
		return nil, errors.New("runtime: pairing service is required")
	}
	if sender == nil {
		return nil, errors.New("runtime: frame sender is required")
	}

	h := &Hub{
		identity: id,
		pairing:  pairSvc,
		sessions: make(map[string]*secure.ManagedSession),
	}

	rtCfg.Publish = func(eventName string, data any) {
		h.BroadcastTrusted(context.Background(), eventName, data)
	}
	rt, err := NewService(context.Background(), rtCfg)
	if err != nil {
		return nil, err
	}
	h.runtime = rt

	mgr, err := secure.NewManager(secure.ManagerConfig{
		DeviceID:  id.DeviceID(),
		StaticKey: id.NoisePrivateKey(),
		Sender:    sender,
		VerifyPeer: func(ctx context.Context, _ string, clientStatic []byte) error {
			_, verifyErr := pairSvc.VerifyTrustedClient(ctx, clientStatic)
			if verifyErr == nil {
				return nil
			}
			// Revoked phones are always rejected at the Noise handshake.
			if errors.Is(verifyErr, pairing.ErrClientRevoked) {
				return verifyErr
			}
			// Unknown phones may complete a Noise XX handshake ONLY while an active
			// pairing invitation exists so they can submit pair.submit over Noise.
			if errors.Is(verifyErr, pairing.ErrUnknownClient) {
				active, activeErr := pairSvc.HasActiveInvitation(ctx)
				if activeErr == nil && active {
					return nil
				}
			}
			return verifyErr
		},
		OnSessionReady: func(_ context.Context, sess *secure.ManagedSession) {
			h.mu.Lock()
			h.sessions[sess.ConnectionID] = sess
			h.mu.Unlock()
		},
		OnSessionClosed: func(connectionID string) {
			h.mu.Lock()
			delete(h.sessions, connectionID)
			h.mu.Unlock()
			rt.CloseTerminalsForConnection(connectionID)
		},
		OnMessage: func(ctx context.Context, sess *secure.ManagedSession, plaintext []byte) {
			rt.HandleMessage(ctx, sess, plaintext)
		},
		OnError: onSecureError,
	})
	if err != nil {
		rt.Close()
		return nil, err
	}
	h.manager = mgr
	return h, nil
}

// Manager returns the underlying secure.Manager to wire into transport.Client callbacks.
func (h *Hub) Manager() *secure.Manager { return h.manager }

// Runtime returns the local task runtime.
func (h *Hub) Runtime() *Service { return h.runtime }

// NotifyPeerPaired sends a pair.updated event to any active Noise session
// matching peerStatic after local operator confirmation or rejection.
func (h *Hub) NotifyPeerPaired(ctx context.Context, peerStatic []byte, state string) {
	payload, err := json.Marshal(OutboundEvent{
		V:     ProtocolVersion,
		Type:  "event",
		Event: "pair.updated",
		Data: PairUpdatedEventData{
			DeviceID: h.identity.DeviceIDString(),
			State:    state,
		},
	})
	if err != nil || len(payload) > secure.MaxRelayPlaintextSize {
		return
	}

	h.mu.Lock()
	var targets []*secure.ManagedSession
	for _, sess := range h.sessions {
		if equalBytes(sess.PeerStatic(), peerStatic) {
			targets = append(targets, sess)
		}
	}
	h.mu.Unlock()

	for _, sess := range targets {
		_ = sess.Send(ctx, payload)
	}
}

// RevokePeer marks peerStatic revoked in SQLite and immediately terminates all
// active Noise sessions held by that phone.
func (h *Hub) RevokePeer(ctx context.Context, peerStatic []byte) error {
	if err := h.pairing.RevokeByKey(ctx, peerStatic); err != nil {
		return err
	}
	h.runtime.CloseTerminalsForPeer(peerStatic)
	h.manager.RevokePeer(peerStatic)
	return nil
}

// BroadcastTrusted sends an event exclusively to currently connected sessions
// belonging to paired, non-revoked phones.
func (h *Hub) BroadcastTrusted(ctx context.Context, eventName string, data any) {
	payload, err := json.Marshal(OutboundEvent{
		V:     ProtocolVersion,
		Type:  "event",
		Event: eventName,
		Data:  data,
	})
	if err != nil || len(payload) > secure.MaxRelayPlaintextSize {
		return
	}

	h.mu.Lock()
	list := make([]*secure.ManagedSession, 0, len(h.sessions))
	for _, sess := range h.sessions {
		list = append(list, sess)
	}
	h.mu.Unlock()

	for _, sess := range list {
		if _, err := h.pairing.VerifyTrustedClient(ctx, sess.PeerStatic()); err != nil {
			continue
		}
		_ = sess.Send(ctx, payload)
	}
}

func (h *Hub) Close() {
	h.manager.HandleDisconnected()
	h.runtime.Close()
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
