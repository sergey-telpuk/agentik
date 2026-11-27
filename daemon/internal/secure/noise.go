// Package secure wraps the Noise handshake and transport used between the
// phone and the daemon.
//
// The profile is Noise_XX_25519_ChaChaPoly_SHA256. XX transmits both static
// public keys and authenticates both peers to each other, but it does not
// decide whether a key should be trusted: that is this application's job.
// The daemon checks the phone's key against its paired clients, and the phone
// checks the daemon's key against the one pinned from the QR code.
//
// Commands are accepted only after the handshake completes. There is no
// 0-RTT and no early-data command path, so no command can be acted on before
// both peers are authenticated.
package secure

import (
	"crypto/ecdh"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/flynn/noise"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

var (
	// ErrHandshakeIncomplete is returned when transport operations are
	// attempted before the handshake finishes.
	ErrHandshakeIncomplete = errors.New("secure: handshake is not complete")
	// ErrHandshakeComplete is returned when handshake operations continue
	// past completion.
	ErrHandshakeComplete = errors.New("secure: handshake already complete")
	// ErrPeerKeyUnavailable is returned when the peer's static key is read
	// before the handshake message that carries it.
	ErrPeerKeyUnavailable = errors.New("secure: peer static key not yet received")
	// ErrPeerRejected is returned when the application declines the peer's
	// static key.
	ErrPeerRejected = errors.New("secure: peer static key rejected")
	// ErrWrongTurn is returned when a peer tries to send or read out of
	// turn.
	ErrWrongTurn = errors.New("secure: not this peer's turn")
)

// cipherSuite is the single suite this version implements. Pinning one suite
// avoids negotiation, which removes downgrade as a class of problem.
var cipherSuite = noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)

// MaxMessageSize bounds a single Noise transport message.
//
// Noise itself caps a message at 65535 bytes. The design document starts from
// a 32 KiB payload budget for relay frames, so the plaintext bound is set
// below the Noise cap with room for the authentication tag.
const MaxMessageSize = 32 * 1024

// Config describes one side of a handshake.
type Config struct {
	// Initiator is true for the peer that sends the first message. The
	// phone initiates; the daemon responds.
	Initiator bool
	// StaticKey is this peer's long-term X25519 key pair.
	StaticKey *ecdh.PrivateKey
	// Prologue is authenticated by the handshake. Both peers must supply
	// identical bytes or the handshake fails, which is what binds the
	// session to one protocol version, role pair, and device.
	Prologue []byte
	// VerifyPeer decides whether the peer's static key is acceptable. It
	// runs as soon as that key is known and before any transport message
	// is produced, so a rejected peer never reaches the command layer.
	//
	// A nil VerifyPeer is a configuration error rather than an implicit
	// accept-all: trusting a key must be a deliberate decision.
	VerifyPeer func(staticKey []byte) error
}

// HandshakeState drives one Noise XX handshake.
//
// The zero value is not usable; call NewHandshake.
type HandshakeState struct {
	state     *noise.HandshakeState
	initiator bool
	verify    func([]byte) error

	// verified records that VerifyPeer has already accepted the peer's
	// key, so it runs exactly once per handshake.
	verified bool
	// done is set when the handshake has produced transport ciphers.
	done bool
	// turn tracks whose move it is, so a misuse of the API surfaces as
	// ErrWrongTurn instead of a confusing Noise-level failure.
	writeTurn bool

	send, recv *noise.CipherState
}

// NewHandshake starts a Noise XX handshake.
func NewHandshake(cfg Config) (*HandshakeState, error) {
	return newHandshake(cfg, nil)
}

func newHandshake(cfg Config, rng io.Reader) (*HandshakeState, error) {
	if cfg.StaticKey == nil {
		return nil, errors.New("secure: static key is required")
	}
	if cfg.VerifyPeer == nil {
		return nil, errors.New("secure: VerifyPeer is required")
	}

	static := noise.DHKey{
		Private: cfg.StaticKey.Bytes(),
		Public:  cfg.StaticKey.PublicKey().Bytes(),
	}
	state, err := noise.NewHandshakeState(noise.Config{
		CipherSuite:   cipherSuite,
		Pattern:       noise.HandshakeXX,
		Initiator:     cfg.Initiator,
		StaticKeypair: static,
		Prologue:      cfg.Prologue,
		Random:        rng, // nil selects crypto/rand
	})
	if err != nil {
		return nil, fmt.Errorf("secure: start handshake: %w", err)
	}

	return &HandshakeState{
		state:     state,
		initiator: cfg.Initiator,
		verify:    cfg.VerifyPeer,
		writeTurn: cfg.Initiator, // the initiator moves first
	}, nil
}

// WriteMessage produces the next handshake message.
//
// payload must be empty or carry only data safe to send at that point in the
// handshake: the first XX message is unencrypted and the second is not yet
// authenticated to a verified peer. This package sends no command data during
// the handshake.
func (h *HandshakeState) WriteMessage(payload []byte) ([]byte, error) {
	if h.done {
		return nil, ErrHandshakeComplete
	}
	if !h.writeTurn {
		return nil, fmt.Errorf("%w: expected to read", ErrWrongTurn)
	}

	msg, cs0, cs1, err := h.state.WriteMessage(nil, payload)
	if err != nil {
		return nil, fmt.Errorf("secure: write handshake message: %w", err)
	}
	h.writeTurn = false
	if cs0 != nil && cs1 != nil {
		// The peer's key arrived in an earlier message and must already
		// have been accepted before this side completes.
		if !h.verified {
			return nil, fmt.Errorf("%w: handshake completed without verifying the peer", ErrPeerRejected)
		}
		h.finish(cs0, cs1)
	}
	return msg, nil
}

// ReadMessage consumes a handshake message from the peer.
//
// As soon as the message carries the peer's static key, VerifyPeer is
// consulted. A rejection stops the handshake there: no transport cipher is
// derived and no reply is produced.
func (h *HandshakeState) ReadMessage(message []byte) ([]byte, error) {
	if h.done {
		return nil, ErrHandshakeComplete
	}
	if h.writeTurn {
		return nil, fmt.Errorf("%w: expected to write", ErrWrongTurn)
	}

	payload, cs0, cs1, err := h.state.ReadMessage(nil, message)
	if err != nil {
		return nil, fmt.Errorf("secure: read handshake message: %w", err)
	}
	h.writeTurn = true

	if peer := h.state.PeerStatic(); len(peer) > 0 && !h.verified {
		if err := h.verify(peer); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrPeerRejected, err)
		}
		h.verified = true
	}

	if cs0 != nil && cs1 != nil {
		if !h.verified {
			return nil, fmt.Errorf("%w: handshake completed without a peer key", ErrPeerRejected)
		}
		h.finish(cs0, cs1)
	}
	return payload, nil
}

// finish assigns the transport ciphers.
//
// Noise returns the pair in a fixed order: the first encrypts data from the
// initiator, the second from the responder. Each side picks accordingly so
// that the two directions use separate keys and separate nonce sequences.
func (h *HandshakeState) finish(cs0, cs1 *noise.CipherState) {
	if h.initiator {
		h.send, h.recv = cs0, cs1
	} else {
		h.send, h.recv = cs1, cs0
	}
	h.done = true
}

// Complete reports whether the handshake has finished.
func (h *HandshakeState) Complete() bool { return h.done }

// PeerStatic returns the peer's verified static public key.
func (h *HandshakeState) PeerStatic() ([]byte, error) {
	peer := h.state.PeerStatic()
	if len(peer) == 0 {
		return nil, ErrPeerKeyUnavailable
	}
	return append([]byte(nil), peer...), nil
}

// Session returns the transport session once the handshake is complete.
func (h *HandshakeState) Session() (*Session, error) {
	if !h.done {
		return nil, ErrHandshakeIncomplete
	}
	peer, err := h.PeerStatic()
	if err != nil {
		return nil, err
	}
	return &Session{send: h.send, recv: h.recv, peerStatic: peer}, nil
}

// Session encrypts and decrypts transport messages after a completed
// handshake.
//
// A Session is bound to one connection. After a reconnect the peers perform a
// new handshake rather than reusing these keys, so nonce sequences always
// start fresh and an old message cannot be replayed into a new connection.
type Session struct {
	sendMu     sync.Mutex
	recvMu     sync.Mutex
	send, recv *noise.CipherState
	peerStatic []byte
}

// PeerStatic returns the verified static public key of the peer.
func (s *Session) PeerStatic() []byte {
	return append([]byte(nil), s.peerStatic...)
}

// Encrypt seals one message for the peer.
func (s *Session) Encrypt(plaintext []byte) ([]byte, error) {
	if len(plaintext) > MaxMessageSize {
		return nil, fmt.Errorf("secure: message is %d bytes, limit is %d", len(plaintext), MaxMessageSize)
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	out, err := s.send.Encrypt(nil, nil, plaintext)
	if err != nil {
		return nil, fmt.Errorf("secure: encrypt: %w", err)
	}
	return out, nil
}

// Decrypt opens one message from the peer.
//
// Noise nonces advance strictly, so a replayed or reordered ciphertext fails
// authentication rather than being accepted out of order.
func (s *Session) Decrypt(ciphertext []byte) ([]byte, error) {
	s.recvMu.Lock()
	defer s.recvMu.Unlock()
	out, err := s.recv.Decrypt(nil, nil, ciphertext)
	if err != nil {
		return nil, fmt.Errorf("secure: decrypt: %w", err)
	}
	return out, nil
}

// DevicePrologue returns the prologue for a phone-to-daemon session.
//
// Both peers derive it from the same inputs; any disagreement makes the
// handshake fail rather than producing a session with mismatched assumptions.
func DevicePrologue(deviceID []byte) []byte {
	return protocol.NoisePrologue(protocol.Version, protocol.RoleClient, protocol.RoleDevice, deviceID)
}
