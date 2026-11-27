package protocol

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"fmt"
	"strings"
)

// DeviceIDFromKey derives a device identifier from its relay registration key.
//
// The identifier is SHA-256 of the raw public key. Deriving rather than
// assigning it means the relay can recompute the identifier from the key a
// peer presents, so a device cannot register under an address that belongs to
// a different key.
func DeviceIDFromKey(pub ed25519.PublicKey) []byte {
	sum := sha256.Sum256(pub)
	return sum[:]
}

// deviceIDEncoding renders a device identifier for display and for URLs.
//
// Unpadded lowercase base32 is used because the identifier appears in QR
// codes and in Durable Object names: it survives case-insensitive handling
// and contains no characters that need escaping.
var deviceIDEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// FormatDeviceID renders a device identifier as text.
func FormatDeviceID(id []byte) string {
	return strings.ToLower(deviceIDEncoding.EncodeToString(id))
}

// ParseDeviceID parses a device identifier produced by FormatDeviceID.
func ParseDeviceID(s string) ([]byte, error) {
	raw, err := deviceIDEncoding.DecodeString(strings.ToUpper(strings.TrimSpace(s)))
	if err != nil {
		return nil, fmt.Errorf("%w: device id is not valid base32: %v", ErrMalformed, err)
	}
	if len(raw) != DeviceIDSize {
		return nil, fmt.Errorf("%w: device id is %d bytes, want %d", ErrMalformed, len(raw), DeviceIDSize)
	}
	return raw, nil
}

// ConstantTimeEqual reports whether a and b are equal, without leaking where
// they first differ through timing.
//
// It is used for identifiers, challenges, and invitation hashes: values an
// attacker supplies and could otherwise probe byte by byte.
func ConstantTimeEqual(a, b []byte) bool {
	return subtle.ConstantTimeCompare(a, b) == 1
}

// NoisePrologue returns the prologue both peers mix into a Noise handshake.
//
// Noise authenticates the prologue: if the two sides disagree on any byte of
// it, the handshake fails rather than completing with mismatched assumptions.
// Binding the protocol version, both roles, and the target device here is what
// stops a handshake captured for one device or direction from being replayed
// against another.
func NoisePrologue(version uint16, initiator, responder Role, deviceID []byte) []byte {
	return NewEncoder(ContextNoisePrologue).
		AddUint16(version).
		AddString(string(initiator)).
		AddString(string(responder)).
		AddBytes(deviceID).
		MustBytes()
}

// DTLSFingerprintSize is the length of a SHA-256 DTLS certificate fingerprint.
const DTLSFingerprintSize = 32

// NoiseWebRTCPrologue returns the prologue for a Noise handshake run over a
// WebRTC DataChannel.
//
// It is NoisePrologue plus the DTLS certificate fingerprints of both peers,
// each peer taking its own from the SDP it produced and the other's from the
// SDP it received through signaling. If anyone on the signaling path swaps a
// fingerprint, the two peers derive different prologues and the Noise
// handshake fails. The fingerprints are length-checked so a truncated or
// padded value cannot yield an ambiguous encoding.
func NoiseWebRTCPrologue(
	version uint16,
	initiator, responder Role,
	deviceID, initiatorFingerprint, responderFingerprint []byte,
) ([]byte, error) {
	if len(initiatorFingerprint) != DTLSFingerprintSize || len(responderFingerprint) != DTLSFingerprintSize {
		return nil, fmt.Errorf("%w: DTLS fingerprints must be %d bytes", ErrMalformed, DTLSFingerprintSize)
	}
	return NewEncoder(ContextNoiseWebRTCPrologue).
		AddUint16(version).
		AddString(string(initiator)).
		AddString(string(responder)).
		AddBytes(deviceID).
		AddBytes(initiatorFingerprint).
		AddBytes(responderFingerprint).
		Bytes()
}
