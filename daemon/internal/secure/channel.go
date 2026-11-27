package secure

import (
	"context"
	"crypto/ecdh"
	"errors"
	"fmt"
	"sync"

	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

// MaxRelayPlaintextSize is the largest plaintext whose ChaChaPoly-sealed
// ciphertext (plaintext + 16-byte MAC) still fits within the 32 KiB frame
// limit of the DataChannel. The name predates the move from the relay to
// WebRTC; the limit is the same.
const MaxRelayPlaintextSize = MaxMessageSize - 16

var (
	// ErrSessionClosed is returned when sending on a closed or dropped connection.
	ErrSessionClosed = errors.New("secure: session closed")
	// ErrPayloadTooLarge is returned when plaintext exceeds MaxRelayPlaintextSize.
	ErrPayloadTooLarge = errors.New("secure: payload exceeds frame budget")
)

// FrameSender sends opaque encrypted bytes toward one client connection. The
// production implementation writes them to that client's WebRTC DataChannel.
type FrameSender interface {
	SendFrame(ctx context.Context, connectionID string, data []byte) error
}

// ManagerConfig configures a per-connection Noise responder manager.
type ManagerConfig struct {
	DeviceID  []byte
	StaticKey *ecdh.PrivateKey
	Sender    FrameSender
	// Prologue returns the Noise prologue for one connection. It is called
	// when that connection's responder handshake starts. Production binds
	// the DTLS fingerprints of both peers into it (WebRTCPrologue); an error,
	// such as a connection with no known fingerprints, aborts the handshake
	// before any message is processed.
	Prologue func(connectionID string) ([]byte, error)
	// VerifyPeer validates the client's Noise static public key as soon as
	// message 3 delivers it. Returning a non-nil error aborts the handshake
	// before any session is created.
	VerifyPeer func(ctx context.Context, connectionID string, clientStatic []byte) error
	// OnSessionReady runs after the 3-message Noise XX handshake completes.
	OnSessionReady func(ctx context.Context, session *ManagedSession)
	// OnSessionClosed runs when a connection leaves or is closed/revoked.
	OnSessionClosed func(connectionID string)
	// OnMessage runs for each authenticated, decrypted inner payload.
	OnMessage func(ctx context.Context, session *ManagedSession, plaintext []byte)
	// OnError reports handshake failures, decrypt failures, or replay rejections.
	OnError func(connectionID string, err error)
}

// ManagedSession represents one authenticated Noise session bound to a single
// connection ID.
type ManagedSession struct {
	ConnectionID string
	session      *Session
	sender       FrameSender

	mu     sync.RWMutex
	closed bool
}

// PeerStatic returns a copy of the peer's verified Noise static public key.
func (s *ManagedSession) PeerStatic() []byte {
	return s.session.PeerStatic()
}

// Send encrypts plaintext under this connection's Noise session and forwards
// the ciphertext over the connection's DataChannel.
func (s *ManagedSession) Send(ctx context.Context, plaintext []byte) error {
	s.mu.RLock()
	closed := s.closed
	s.mu.RUnlock()
	if closed {
		return ErrSessionClosed
	}
	if len(plaintext) > MaxRelayPlaintextSize {
		return fmt.Errorf("%w: %d bytes (limit %d)", ErrPayloadTooLarge, len(plaintext), MaxRelayPlaintextSize)
	}
	ct, err := s.session.Encrypt(plaintext)
	if err != nil {
		return err
	}
	return s.sender.SendFrame(ctx, s.ConnectionID, ct)
}

func (s *ManagedSession) close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
}

type connState struct {
	mu       sync.Mutex
	hs       *HandshakeState
	session  *ManagedSession
	failed   bool
	frameCtx context.Context
}

// Manager owns one independent Noise XX responder state machine per client
// connection.
type Manager struct {
	cfg ManagerConfig

	mu    sync.Mutex
	conns map[string]*connState
}

// NewManager validates cfg and constructs a Noise session manager.
func NewManager(cfg ManagerConfig) (*Manager, error) {
	if len(cfg.DeviceID) != protocol.DeviceIDSize {
		return nil, fmt.Errorf("secure: device id is %d bytes, want %d", len(cfg.DeviceID), protocol.DeviceIDSize)
	}
	if cfg.StaticKey == nil {
		return nil, errors.New("secure: static key is required")
	}
	if cfg.Sender == nil {
		return nil, errors.New("secure: frame sender is required")
	}
	if cfg.VerifyPeer == nil {
		return nil, errors.New("secure: VerifyPeer is required")
	}
	if cfg.Prologue == nil {
		return nil, errors.New("secure: Prologue is required")
	}
	return &Manager{
		cfg:   cfg,
		conns: make(map[string]*connState),
	}, nil
}

// HandleDisconnected tears down all active Noise handshakes and sessions.
// A new connection always starts a fresh handshake.
func (m *Manager) HandleDisconnected() {
	m.mu.Lock()
	old := m.conns
	m.conns = make(map[string]*connState)
	m.mu.Unlock()

	for connID, entry := range old {
		entry.mu.Lock()
		hadSession := entry.session != nil
		if entry.session != nil {
			entry.session.close()
		}
		entry.failed = true
		entry.mu.Unlock()
		if hadSession && m.cfg.OnSessionClosed != nil {
			m.cfg.OnSessionClosed(connID)
		}
	}
}

// HandlePeerState starts or tears down the Noise state for one client
// connection.
func (m *Manager) HandlePeerState(ctx context.Context, connectionID string, present bool) {
	if !present {
		m.CloseConnection(connectionID)
		return
	}

	hs, err := m.newResponderHandshake(connectionID)
	if err != nil {
		m.reportError(connectionID, err)
		return
	}

	m.mu.Lock()
	prev := m.conns[connectionID]
	entry := &connState{hs: hs, frameCtx: ctx}
	m.conns[connectionID] = entry
	m.mu.Unlock()

	if prev != nil {
		prev.mu.Lock()
		hadSession := prev.session != nil
		if prev.session != nil {
			prev.session.close()
		}
		prev.failed = true
		prev.mu.Unlock()
		if hadSession && m.cfg.OnSessionClosed != nil {
			m.cfg.OnSessionClosed(connectionID)
		}
	}
}

// CloseConnection removes the Noise session or handshake for connectionID.
func (m *Manager) CloseConnection(connectionID string) {
	m.mu.Lock()
	entry, ok := m.conns[connectionID]
	if ok {
		delete(m.conns, connectionID)
	}
	m.mu.Unlock()

	if !ok {
		return
	}
	entry.mu.Lock()
	hadSession := entry.session != nil
	if entry.session != nil {
		entry.session.close()
	}
	entry.failed = true
	entry.mu.Unlock()

	if hadSession && m.cfg.OnSessionClosed != nil {
		m.cfg.OnSessionClosed(connectionID)
	}
}

// RevokePeer immediately terminates all active sessions belonging to peerStatic.
func (m *Manager) RevokePeer(peerStatic []byte) {
	m.mu.Lock()
	var targets []string
	for connID, entry := range m.conns {
		entry.mu.Lock()
		if entry.session != nil && protocol.ConstantTimeEqual(entry.session.PeerStatic(), peerStatic) {
			targets = append(targets, connID)
		}
		entry.mu.Unlock()
	}
	m.mu.Unlock()

	for _, connID := range targets {
		m.CloseConnection(connID)
	}
}

// Session returns the active ManagedSession for connectionID, if established.
func (m *Manager) Session(connectionID string) (*ManagedSession, bool) {
	m.mu.Lock()
	entry := m.conns[connectionID]
	m.mu.Unlock()
	if entry == nil {
		return nil, false
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.failed || entry.session == nil {
		return nil, false
	}
	return entry.session, true
}

// HandleFrame processes one inbound opaque DataChannel frame from connectionID, either
// advancing the Noise XX handshake or decrypting an authenticated transport
// message.
func (m *Manager) HandleFrame(ctx context.Context, connectionID string, frame []byte) {
	m.mu.Lock()
	entry := m.conns[connectionID]
	m.mu.Unlock()
	if entry == nil {
		m.reportError(connectionID, errors.New("secure: frame for unknown connection"))
		return
	}

	entry.mu.Lock()
	if entry.failed {
		entry.mu.Unlock()
		return
	}

	if entry.session == nil {
		sess, reply, err := m.stepHandshake(ctx, connectionID, entry, frame)
		entry.mu.Unlock()
		if err != nil {
			m.reportError(connectionID, err)
			return
		}
		if len(reply) > 0 {
			if err := m.cfg.Sender.SendFrame(ctx, connectionID, reply); err != nil {
				m.reportError(connectionID, fmt.Errorf("secure: send handshake reply: %w", err))
				return
			}
		}
		if sess != nil && m.cfg.OnSessionReady != nil {
			m.cfg.OnSessionReady(ctx, sess)
		}
		return
	}

	sess := entry.session
	entry.mu.Unlock()

	plaintext, err := sess.session.Decrypt(frame)
	if err != nil {
		m.reportError(connectionID, err)
		return
	}
	if m.cfg.OnMessage != nil {
		m.cfg.OnMessage(ctx, sess, plaintext)
	}
}

func (m *Manager) stepHandshake(
	ctx context.Context,
	connectionID string,
	entry *connState,
	frame []byte,
) (ready *ManagedSession, reply []byte, err error) {
	entry.frameCtx = ctx
	if _, err := entry.hs.ReadMessage(frame); err != nil {
		entry.failed = true
		return nil, nil, err
	}
	if !entry.hs.Complete() {
		reply, err = entry.hs.WriteMessage(nil)
		if err != nil {
			entry.failed = true
			return nil, nil, err
		}
		return nil, reply, nil
	}

	rawSess, err := entry.hs.Session()
	if err != nil {
		entry.failed = true
		return nil, nil, err
	}
	managed := &ManagedSession{
		ConnectionID: connectionID,
		session:      rawSess,
		sender:       m.cfg.Sender,
	}
	entry.session = managed
	return managed, nil, nil
}

func (m *Manager) newResponderHandshake(connectionID string) (*HandshakeState, error) {
	prologue, err := m.cfg.Prologue(connectionID)
	if err != nil {
		return nil, fmt.Errorf("secure: prologue for connection: %w", err)
	}
	return NewHandshake(Config{
		Initiator: false,
		StaticKey: m.cfg.StaticKey,
		Prologue:  prologue,
		VerifyPeer: func(peerStatic []byte) error {
			m.mu.Lock()
			entry := m.conns[connectionID]
			m.mu.Unlock()
			vctx := context.Background()
			if entry != nil && entry.frameCtx != nil {
				vctx = entry.frameCtx
			}
			return m.cfg.VerifyPeer(vctx, connectionID, peerStatic)
		},
	})
}

func (m *Manager) reportError(connectionID string, err error) {
	if m.cfg.OnError != nil {
		m.cfg.OnError(connectionID, err)
	}
}
