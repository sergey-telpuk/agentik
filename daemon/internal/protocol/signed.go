package protocol

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"time"
)

// Role names a peer's part in the protocol. It is covered by signatures and by
// the Noise prologue so that a message meant for one role cannot be replayed
// against the other.
type Role string

const (
	// RoleDevice is the computer running the daemon.
	RoleDevice Role = "device"
	// RoleClient is the Mini App on the phone.
	RoleClient Role = "client"
)

// Valid reports whether r is a role this version defines.
func (r Role) Valid() bool {
	return r == RoleDevice || r == RoleClient
}

var (
	// ErrSignature is returned when a signature does not verify.
	ErrSignature = errors.New("protocol: signature verification failed")
	// ErrExpired is returned when a signed structure is past its expiry.
	ErrExpired = errors.New("protocol: signed structure expired")
	// ErrNotYetValid is returned when a structure's expiry implies a clock
	// skew too large to accept.
	ErrNotYetValid = errors.New("protocol: signed structure not yet valid")
	// ErrMalformed is returned when a structure's fields are missing or the
	// wrong size.
	ErrMalformed = errors.New("protocol: malformed structure")
)

// MaxClockSkew bounds how far in the future a peer's expiry may sit relative
// to local time. Without it, a peer with a badly wrong clock could present a
// structure that stays valid indefinitely.
const MaxClockSkew = 5 * time.Minute

// ChallengeSize is the length in bytes of a relay registration challenge.
// 32 bytes of randomness makes guessing a live challenge infeasible.
const ChallengeSize = 32

// DeviceIDSize is the length of a device identifier, which is the SHA-256 of
// the registration public key.
const DeviceIDSize = 32

// RegisterRequest is a device's claim to its relay route.
//
// The relay issues Challenge against one specific socket; the device signs it
// together with its own identity and an expiry. The relay then verifies the
// signature with RegisterPublicKey and checks that the challenge is the one it
// issued on that socket. Possession of a device_id alone proves nothing.
type RegisterRequest struct {
	// Version is the protocol version. The relay rejects versions it does
	// not implement rather than assuming compatibility.
	Version uint16
	// Role is the signer's role; always RoleDevice for registration.
	Role Role
	// RelayID names the relay the request is addressed to, so a signature
	// captured by one relay cannot be replayed against another.
	RelayID string
	// DeviceID is SHA-256 of RegisterPublicKey.
	DeviceID []byte
	// RegisterPublicKey is the Ed25519 key that verifies Signature.
	RegisterPublicKey ed25519.PublicKey
	// Challenge is the random value the relay bound to this socket.
	Challenge []byte
	// ExpiresAt is when this request stops being acceptable.
	ExpiresAt time.Time
	// Signature covers every field above under ContextRelayRegister.
	Signature []byte
}

// signingBytes returns the canonical bytes covered by a registration
// signature. Every field that affects the meaning of the request is included,
// so none of them can be altered in transit without invalidating it.
func (r *RegisterRequest) signingBytes() ([]byte, error) {
	return NewEncoder(ContextRelayRegister).
		AddUint16(r.Version).
		AddString(string(r.Role)).
		AddString(r.RelayID).
		AddBytes(r.DeviceID).
		AddBytes(r.RegisterPublicKey).
		AddBytes(r.Challenge).
		AddInt64(r.ExpiresAt.Unix()).
		Bytes()
}

// Sign fills in Signature using priv.
//
// The caller is responsible for priv matching RegisterPublicKey; Sign checks
// this to catch a mismatched key pair before a signature that could never
// verify reaches the relay.
func (r *RegisterRequest) Sign(priv ed25519.PrivateKey) error {
	if len(priv) != ed25519.PrivateKeySize {
		return fmt.Errorf("%w: private key is %d bytes, want %d", ErrMalformed, len(priv), ed25519.PrivateKeySize)
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return fmt.Errorf("%w: private key has no Ed25519 public key", ErrMalformed)
	}
	if !pub.Equal(r.RegisterPublicKey) {
		return fmt.Errorf("%w: private key does not match RegisterPublicKey", ErrMalformed)
	}
	if err := r.validateShape(); err != nil {
		return err
	}
	msg, err := r.signingBytes()
	if err != nil {
		return err
	}
	r.Signature = ed25519.Sign(priv, msg)
	return nil
}

// validateShape checks field presence and sizes, independently of any
// signature. It runs before verification so that a malformed request is
// rejected with a precise error rather than a generic signature failure.
func (r *RegisterRequest) validateShape() error {
	if r.Version != Version {
		return fmt.Errorf("%w: version %d, want %d", ErrMalformed, r.Version, Version)
	}
	if r.Role != RoleDevice {
		return fmt.Errorf("%w: role %q, want %q", ErrMalformed, r.Role, RoleDevice)
	}
	if r.RelayID == "" {
		return fmt.Errorf("%w: empty relay id", ErrMalformed)
	}
	if len(r.RegisterPublicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("%w: registration key is %d bytes, want %d", ErrMalformed, len(r.RegisterPublicKey), ed25519.PublicKeySize)
	}
	if len(r.DeviceID) != DeviceIDSize {
		return fmt.Errorf("%w: device id is %d bytes, want %d", ErrMalformed, len(r.DeviceID), DeviceIDSize)
	}
	if len(r.Challenge) != ChallengeSize {
		return fmt.Errorf("%w: challenge is %d bytes, want %d", ErrMalformed, len(r.Challenge), ChallengeSize)
	}
	return nil
}

// Verify checks the request against an expected relay, the challenge the relay
// issued on this socket, and the current time.
//
// expectedChallenge is compared in constant time by the caller's challenge
// store; here it is compared directly because a mismatch is reported the same
// way regardless of where it differs, and the value is already known to the
// relay. The device_id is recomputed from the key rather than trusted, so a
// request cannot claim one device's address with another device's key.
func (r *RegisterRequest) Verify(relayID string, expectedChallenge []byte, now time.Time) error {
	if err := r.validateShape(); err != nil {
		return err
	}
	if r.RelayID != relayID {
		return fmt.Errorf("%w: relay id %q, want %q", ErrMalformed, r.RelayID, relayID)
	}
	if !ConstantTimeEqual(r.Challenge, expectedChallenge) {
		return fmt.Errorf("%w: challenge does not match this connection", ErrMalformed)
	}
	wantID := DeviceIDFromKey(r.RegisterPublicKey)
	if !ConstantTimeEqual(r.DeviceID, wantID) {
		return fmt.Errorf("%w: device id does not match registration key", ErrMalformed)
	}
	if !now.Before(r.ExpiresAt) {
		return fmt.Errorf("%w: expired at %s", ErrExpired, r.ExpiresAt.UTC().Format(time.RFC3339))
	}
	if r.ExpiresAt.After(now.Add(MaxClockSkew)) {
		return fmt.Errorf("%w: expiry %s is too far ahead", ErrNotYetValid, r.ExpiresAt.UTC().Format(time.RFC3339))
	}
	msg, err := r.signingBytes()
	if err != nil {
		return err
	}
	if !ed25519.Verify(r.RegisterPublicKey, msg, r.Signature) {
		return ErrSignature
	}
	return nil
}

// PairingDescriptor is the content of the pairing QR code.
//
// It binds the device's two distinct identities — the Ed25519 registration key
// and the X25519 Noise key — into one structure signed by the registration
// key. The phone pins NoisePublicKey from a descriptor it has verified, so a
// relay that swapped the Noise key would be caught before any handshake.
type PairingDescriptor struct {
	// Version is the protocol version.
	Version uint16
	// RelayURL is where the phone should connect.
	RelayURL string
	// DeviceID is SHA-256 of RegisterPublicKey.
	DeviceID []byte
	// RegisterPublicKey is the device's Ed25519 relay identity and the key
	// that verifies Signature.
	RegisterPublicKey ed25519.PublicKey
	// NoisePublicKey is the device's long-term X25519 static key.
	NoisePublicKey []byte
	// InvitationHash is SHA-256 of the one-time invitation secret. The
	// secret itself is carried separately in the QR payload and never
	// stored, so a descriptor on its own grants no access.
	InvitationHash []byte
	// ExpiresAt is when the invitation stops being usable.
	ExpiresAt time.Time
	// Signature covers every field above under ContextPairingDescriptor.
	Signature []byte
}

func (p *PairingDescriptor) signingBytes() ([]byte, error) {
	return NewEncoder(ContextPairingDescriptor).
		AddUint16(p.Version).
		AddString(p.RelayURL).
		AddBytes(p.DeviceID).
		AddBytes(p.RegisterPublicKey).
		AddBytes(p.NoisePublicKey).
		AddBytes(p.InvitationHash).
		AddInt64(p.ExpiresAt.Unix()).
		Bytes()
}

// NoiseKeySize is the length of an X25519 public key.
const NoiseKeySize = 32

func (p *PairingDescriptor) validateShape() error {
	if p.Version != Version {
		return fmt.Errorf("%w: version %d, want %d", ErrMalformed, p.Version, Version)
	}
	if p.RelayURL == "" {
		return fmt.Errorf("%w: empty relay url", ErrMalformed)
	}
	if len(p.RegisterPublicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("%w: registration key is %d bytes, want %d", ErrMalformed, len(p.RegisterPublicKey), ed25519.PublicKeySize)
	}
	if len(p.DeviceID) != DeviceIDSize {
		return fmt.Errorf("%w: device id is %d bytes, want %d", ErrMalformed, len(p.DeviceID), DeviceIDSize)
	}
	if len(p.NoisePublicKey) != NoiseKeySize {
		return fmt.Errorf("%w: noise key is %d bytes, want %d", ErrMalformed, len(p.NoisePublicKey), NoiseKeySize)
	}
	if len(p.InvitationHash) != 32 {
		return fmt.Errorf("%w: invitation hash is %d bytes, want 32", ErrMalformed, len(p.InvitationHash))
	}
	return nil
}

// Sign fills in Signature using the device's registration private key.
func (p *PairingDescriptor) Sign(priv ed25519.PrivateKey) error {
	if len(priv) != ed25519.PrivateKeySize {
		return fmt.Errorf("%w: private key is %d bytes, want %d", ErrMalformed, len(priv), ed25519.PrivateKeySize)
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return fmt.Errorf("%w: private key has no Ed25519 public key", ErrMalformed)
	}
	if !pub.Equal(p.RegisterPublicKey) {
		return fmt.Errorf("%w: private key does not match RegisterPublicKey", ErrMalformed)
	}
	if err := p.validateShape(); err != nil {
		return err
	}
	msg, err := p.signingBytes()
	if err != nil {
		return err
	}
	p.Signature = ed25519.Sign(priv, msg)
	return nil
}

// Verify checks the descriptor's self-consistency, expiry, and signature.
//
// This establishes that whoever holds the registration private key published
// this pairing of keys. It does not establish that the device is one the user
// intends to pair with: that comes from the user scanning this specific QR
// code and confirming on the computer.
func (p *PairingDescriptor) Verify(now time.Time) error {
	if err := p.validateShape(); err != nil {
		return err
	}
	wantID := DeviceIDFromKey(p.RegisterPublicKey)
	if !ConstantTimeEqual(p.DeviceID, wantID) {
		return fmt.Errorf("%w: device id does not match registration key", ErrMalformed)
	}
	if !now.Before(p.ExpiresAt) {
		return fmt.Errorf("%w: invitation expired at %s", ErrExpired, p.ExpiresAt.UTC().Format(time.RFC3339))
	}
	msg, err := p.signingBytes()
	if err != nil {
		return err
	}
	if !ed25519.Verify(p.RegisterPublicKey, msg, p.Signature) {
		return ErrSignature
	}
	return nil
}
