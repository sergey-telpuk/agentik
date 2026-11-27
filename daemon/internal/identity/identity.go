// Package identity creates and stores the computer's two long-term
// cryptographic identities.
//
// The two keys are deliberately not interchangeable:
//
//   - the Ed25519 registration key proves ownership of the device's relay
//     route, and never encrypts anything;
//   - the X25519 Noise static key secures the channel with the phone, and
//     never signs anything.
//
// Keeping them separate means a compromise or a protocol flaw in one role
// cannot be turned into authority in the other.
package identity

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

// ErrInvalidKey is returned when stored key material has the wrong size or
// cannot be parsed.
var ErrInvalidKey = errors.New("identity: invalid key material")

// Identity holds the device's private keys and derived identifier.
//
// It is created once per computer and persisted. The private halves never
// leave the machine: not to the phone, and not to the relay.
type Identity struct {
	// registerPriv signs relay registration and pairing descriptors.
	registerPriv ed25519.PrivateKey
	// noisePriv is the long-term X25519 static key for Noise.
	noisePriv *ecdh.PrivateKey
	// deviceID is SHA-256 of the registration public key.
	deviceID []byte
}

// Generate creates a fresh device identity from the system CSPRNG.
func Generate() (*Identity, error) {
	_, registerPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("identity: generate registration key: %w", err)
	}
	noisePriv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("identity: generate noise key: %w", err)
	}
	return newIdentity(registerPriv, noisePriv), nil
}

func newIdentity(registerPriv ed25519.PrivateKey, noisePriv *ecdh.PrivateKey) *Identity {
	pub, _ := registerPriv.Public().(ed25519.PublicKey)
	return &Identity{
		registerPriv: registerPriv,
		noisePriv:    noisePriv,
		deviceID:     protocol.DeviceIDFromKey(pub),
	}
}

// FromSeeds reconstructs an identity from stored private key material.
//
// registerSeed is the 32-byte Ed25519 seed rather than the expanded private
// key, because the seed is the canonical thing to persist and the expanded
// form is derivable from it.
func FromSeeds(registerSeed, noiseScalar []byte) (*Identity, error) {
	if len(registerSeed) != ed25519.SeedSize {
		return nil, fmt.Errorf("%w: registration seed is %d bytes, want %d", ErrInvalidKey, len(registerSeed), ed25519.SeedSize)
	}
	noisePriv, err := ecdh.X25519().NewPrivateKey(noiseScalar)
	if err != nil {
		return nil, fmt.Errorf("%w: noise key: %v", ErrInvalidKey, err)
	}
	return newIdentity(ed25519.NewKeyFromSeed(registerSeed), noisePriv), nil
}

// DeviceID returns the device identifier: SHA-256 of the registration public
// key. The returned slice is a copy, so a caller cannot mutate the identity.
func (i *Identity) DeviceID() []byte {
	return append([]byte(nil), i.deviceID...)
}

// DeviceIDString returns the device identifier in its text form.
func (i *Identity) DeviceIDString() string {
	return protocol.FormatDeviceID(i.deviceID)
}

// RegisterPublicKey returns the Ed25519 public key used for relay
// registration.
func (i *Identity) RegisterPublicKey() ed25519.PublicKey {
	pub, _ := i.registerPriv.Public().(ed25519.PublicKey)
	return pub
}

// NoisePublicKey returns the X25519 static public key, which the phone pins
// during pairing.
func (i *Identity) NoisePublicKey() []byte {
	return i.noisePriv.PublicKey().Bytes()
}

// RegisterPrivateKey returns the signing key.
//
// It is exposed for the transport layer to sign registration requests. It is
// never serialised by this package except through Seeds.
func (i *Identity) RegisterPrivateKey() ed25519.PrivateKey {
	return i.registerPriv
}

// NoisePrivateKey returns the X25519 static private key for the Noise layer.
func (i *Identity) NoisePrivateKey() *ecdh.PrivateKey {
	return i.noisePriv
}

// Seeds returns the private material to persist: the Ed25519 seed and the
// X25519 scalar.
//
// Callers must write these only to a secure store, and must not log them.
func (i *Identity) Seeds() (registerSeed, noiseScalar []byte) {
	return i.registerPriv.Seed(), i.noisePriv.Bytes()
}
