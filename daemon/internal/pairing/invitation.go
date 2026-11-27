// Package pairing implements device invitation creation, QR/text encoding,
// local confirmation on the computer, trusted client persistence, and client
// revocation (AGENTIK.md section 5.3-5.5).
package pairing

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
	"rsc.io/qr"
)

// InvitationPrefix identifies an Agentik v1 pairing payload when encoded as a
// compact QR/text string. Must match INVITATION_PREFIX in miniapp.
const InvitationPrefix = "agentik-pair-v1:"

// MaxInvitationTextLength bounds untrusted pasted/scanned pairing text.
const MaxInvitationTextLength = 4096

// InvitationSecretSize is the size in bytes of the one-time high-entropy secret.
const InvitationSecretSize = 32

// InvitationWire is the canonical JSON wire representation of a pairing
// invitation shared between the Go daemon and the TypeScript Mini App.
//
// All binary fields use unpadded base64url except device_id, which uses
// lowercase unpadded base32 (matching protocol.FormatDeviceID).
type InvitationWire struct {
	V                 uint16 `json:"v"`
	Relay             string `json:"relay"`
	DeviceID          string `json:"device_id"`
	RegisterPublicKey string `json:"register_public_key"`
	NoisePublicKey    string `json:"noise_public_key"`
	InvitationID      string `json:"invitation_id"`
	InvitationSecret  string `json:"invitation_secret"`
	ExpiresAt         int64  `json:"expires_at"`
	Signature         string `json:"signature"`
}

// ParsedInvitation is a structurally validated and descriptor-verified
// invitation decoded from QR or text.
type ParsedInvitation struct {
	Descriptor       *protocol.PairingDescriptor
	InvitationSecret []byte
	DeviceIDText     string
}

// NormalizeRelayURL validates and normalises a relay URL for inclusion in a
// pairing invitation. Only wss:// is allowed, except ws:// on loopback hosts
// for local development.
func NormalizeRelayURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("pairing: invalid relay URL: %w", err)
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "wss" && !(u.Scheme == "ws" && loopback) {
		return "", fmt.Errorf("pairing: relay URL scheme %q must be wss (or ws on loopback)", u.Scheme)
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("pairing: relay URL must have a host and no credentials, query, or fragment")
	}
	path := strings.TrimRight(u.Path, "/")
	return fmt.Sprintf("%s://%s%s", u.Scheme, u.Host, path), nil
}

// EncodeInvitation serializes a signed PairingDescriptor together with the
// one-time invitation secret using the agentik-pair-v1:<base64url(json)> format.
func EncodeInvitation(desc *protocol.PairingDescriptor, secret []byte) (string, error) {
	if desc == nil {
		return "", errors.New("pairing: descriptor is nil")
	}
	if len(secret) != InvitationSecretSize {
		return "", fmt.Errorf("pairing: invitation secret is %d bytes, want %d", len(secret), InvitationSecretSize)
	}
	sum := sha256.Sum256(secret)
	if !protocol.ConstantTimeEqual(sum[:], desc.InvitationHash) {
		return "", errors.New("pairing: invitation secret does not match descriptor hash")
	}
	relayURL, err := NormalizeRelayURL(desc.RelayURL)
	if err != nil {
		return "", err
	}
	wire := InvitationWire{
		V:                 desc.Version,
		Relay:             relayURL,
		DeviceID:          protocol.FormatDeviceID(desc.DeviceID),
		RegisterPublicKey: base64.RawURLEncoding.EncodeToString(desc.RegisterPublicKey),
		NoisePublicKey:    base64.RawURLEncoding.EncodeToString(desc.NoisePublicKey),
		InvitationID:      base64.RawURLEncoding.EncodeToString(desc.InvitationHash),
		InvitationSecret:  base64.RawURLEncoding.EncodeToString(secret),
		ExpiresAt:         desc.ExpiresAt.Unix(),
		Signature:         base64.RawURLEncoding.EncodeToString(desc.Signature),
	}
	rawJSON, err := json.Marshal(wire)
	if err != nil {
		return "", fmt.Errorf("pairing: encode invitation JSON: %w", err)
	}
	return InvitationPrefix + base64.RawURLEncoding.EncodeToString(rawJSON), nil
}

// ParseInvitation decodes either `agentik-pair-v1:<base64url>` or raw JSON,
// verifies the secret binding, expiry, and Ed25519 PairingDescriptor signature.
func ParseInvitation(text string, now time.Time) (*ParsedInvitation, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, fmt.Errorf("%w: empty invitation", protocol.ErrMalformed)
	}
	if len(trimmed) > MaxInvitationTextLength {
		return nil, fmt.Errorf("%w: invitation exceeds %d chars", protocol.ErrMalformed, MaxInvitationTextLength)
	}

	rawJSON := []byte(trimmed)
	if strings.HasPrefix(trimmed, InvitationPrefix) {
		decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(trimmed, InvitationPrefix))
		if err != nil {
			return nil, fmt.Errorf("%w: invalid base64url payload", protocol.ErrMalformed)
		}
		rawJSON = decoded
	}

	var wire InvitationWire
	if err := json.Unmarshal(rawJSON, &wire); err != nil {
		return nil, fmt.Errorf("%w: invalid invitation JSON: %v", protocol.ErrMalformed, err)
	}
	if wire.V != protocol.Version {
		return nil, fmt.Errorf("%w: unsupported invitation version %d", protocol.ErrMalformed, wire.V)
	}
	relayURL, err := NormalizeRelayURL(wire.Relay)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", protocol.ErrMalformed, err)
	}
	deviceID, err := protocol.ParseDeviceID(wire.DeviceID)
	if err != nil {
		return nil, err
	}
	regPub, err := decodeExactBase64URL(wire.RegisterPublicKey, ed25519.PublicKeySize)
	if err != nil {
		return nil, fmt.Errorf("%w: register_public_key: %v", protocol.ErrMalformed, err)
	}
	noisePub, err := decodeExactBase64URL(wire.NoisePublicKey, protocol.NoiseKeySize)
	if err != nil {
		return nil, fmt.Errorf("%w: noise_public_key: %v", protocol.ErrMalformed, err)
	}
	invID, err := decodeExactBase64URL(wire.InvitationID, 32)
	if err != nil {
		return nil, fmt.Errorf("%w: invitation_id: %v", protocol.ErrMalformed, err)
	}
	secret, err := decodeExactBase64URL(wire.InvitationSecret, InvitationSecretSize)
	if err != nil {
		return nil, fmt.Errorf("%w: invitation_secret: %v", protocol.ErrMalformed, err)
	}
	sig, err := decodeExactBase64URL(wire.Signature, ed25519.SignatureSize)
	if err != nil {
		return nil, fmt.Errorf("%w: signature: %v", protocol.ErrMalformed, err)
	}
	if wire.ExpiresAt <= 0 {
		return nil, fmt.Errorf("%w: expires_at must be positive", protocol.ErrMalformed)
	}

	sum := sha256.Sum256(secret)
	if !protocol.ConstantTimeEqual(sum[:], invID) {
		return nil, fmt.Errorf("%w: invitation_id does not match invitation_secret", protocol.ErrMalformed)
	}

	desc := &protocol.PairingDescriptor{
		Version:           wire.V,
		RelayURL:          relayURL,
		DeviceID:          deviceID,
		RegisterPublicKey: ed25519.PublicKey(regPub),
		NoisePublicKey:    noisePub,
		InvitationHash:    invID,
		ExpiresAt:         time.Unix(wire.ExpiresAt, 0),
		Signature:         sig,
	}
	if err := desc.Verify(now); err != nil {
		return nil, err
	}
	return &ParsedInvitation{
		Descriptor:       desc,
		InvitationSecret: secret,
		DeviceIDText:     protocol.FormatDeviceID(deviceID),
	}, nil
}

func decodeExactBase64URL(s string, want int) ([]byte, error) {
	if s == "" || strings.ContainsRune(s, '=') {
		return nil, errors.New("must be unpadded base64url")
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(b) != want {
		return nil, fmt.Errorf("got %d bytes, want %d", len(b), want)
	}
	return b, nil
}

// RenderQR encodes payload as a compact UTF-8 half-block QR code suitable for
// display in a terminal.
func RenderQR(payload string) (string, error) {
	code, err := qr.Encode(payload, qr.L)
	if err != nil {
		return "", fmt.Errorf("pairing: encode QR code: %w", err)
	}
	const quiet = 2
	total := code.Size + 2*quiet
	black := func(x, y int) bool {
		qx := x - quiet
		qy := y - quiet
		if qx < 0 || qy < 0 || qx >= code.Size || qy >= code.Size {
			return false
		}
		return code.Black(qx, qy)
	}

	var b strings.Builder
	for y := 0; y < total; y += 2 {
		for x := range total {
			top := black(x, y)
			bottom := y+1 < total && black(x, y+1)
			switch {
			case top && bottom:
				b.WriteRune(' ')
			case top && !bottom:
				b.WriteRune('▄')
			case !top && bottom:
				b.WriteRune('▀')
			default:
				b.WriteRune('█')
			}
		}
		b.WriteByte('\n')
	}
	return b.String(), nil
}

// Fingerprint renders a human-readable short verification display of a 32-byte
// public key. It is for local visual verification only, never an access secret.
func Fingerprint(pub []byte) string {
	sum := sha256.Sum256(pub)
	return fmt.Sprintf("%02X%02X-%02X%02X-%02X%02X", sum[0], sum[1], sum[2], sum[3], sum[4], sum[5])
}
