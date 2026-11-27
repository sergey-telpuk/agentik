// Package pairing implements device invitation creation, QR/text encoding,
// local confirmation on the computer, trusted client persistence, and client
// revocation (AGENTIK.md section 5.3-5.5).
package pairing

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

// InvitationPrefix starts every pairing invitation text. It is uppercase so the
// whole text stays inside the QR alphanumeric character set, the densest text
// mode a QR code has. Must match INVITATION_PREFIX in miniapp.
const InvitationPrefix = "AGENTIK1:"

// DefaultRelayURL is the hosted relay. An invitation for this relay carries a
// one-byte selector instead of the URL. Must match DEFAULT_RELAY_URL in miniapp.
const DefaultRelayURL = "wss://agentik-relay.agentikcl.workers.dev"

// MaxInvitationTextLength bounds untrusted pasted/scanned pairing text. A
// real invitation is roughly 280 characters.
const MaxInvitationTextLength = 1024

// InvitationSecretSize is the size in bytes of the one-time high-entropy secret.
const InvitationSecretSize = 32

// Relay selector values in byte 1 of the binary invitation.
const (
	relayDefault byte = 0 // DefaultRelayURL, nothing follows
	relayWSS     byte = 1 // "wss://" + the remaining bytes
	relayWS      byte = 2 // "ws://" + the remaining bytes (loopback only)
)

// invitationFixedSize is the size of the binary invitation without a custom
// relay: version, relay selector, register key, Noise key, secret, expiry,
// signature.
const invitationFixedSize = 1 + 1 + ed25519.PublicKeySize + protocol.NoiseKeySize +
	InvitationSecretSize + 4 + ed25519.SignatureSize

var invitationBase32 = base32.StdEncoding.WithPadding(base32.NoPadding)

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
// one-time invitation secret into the compact invitation text
// `AGENTIK1:<base32>` (AGENTIK.md section 5.3).
//
// The binary payload, all integers big-endian:
//
//	1   version (1)
//	1   relay selector: 0 default relay, 1 wss:// custom, 2 ws:// custom
//	32  register public key (Ed25519; device_id is its SHA-256, not carried)
//	32  Noise public key (X25519)
//	32  invitation secret (the invitation id is its SHA-256, not carried)
//	4   expiry, Unix seconds
//	64  Ed25519 signature of the PairingDescriptor
//	..  custom relay: host[:port][/path] without scheme, to the end
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
	if desc.Version == 0 || desc.Version > 0xff {
		return "", fmt.Errorf("pairing: version %d does not fit the invitation", desc.Version)
	}
	if len(desc.RegisterPublicKey) != ed25519.PublicKeySize ||
		len(desc.NoisePublicKey) != protocol.NoiseKeySize ||
		len(desc.Signature) != ed25519.SignatureSize {
		return "", errors.New("pairing: descriptor has wrongly sized keys or signature")
	}
	if !protocol.ConstantTimeEqual(desc.DeviceID, protocol.DeviceIDFromKey(desc.RegisterPublicKey)) {
		return "", errors.New("pairing: device id does not match registration key")
	}
	exp := desc.ExpiresAt.Unix()
	if exp <= 0 || exp > math.MaxUint32 {
		return "", fmt.Errorf("pairing: expiry %d does not fit 32 bits", exp)
	}
	relayURL, err := NormalizeRelayURL(desc.RelayURL)
	if err != nil {
		return "", err
	}
	if relayURL != desc.RelayURL {
		// The signature covers desc.RelayURL; the phone rebuilds the normalised form.
		return "", fmt.Errorf("pairing: relay URL %q is not normalised", desc.RelayURL)
	}

	selector, relayRest := relayDefault, ""
	if relayURL != DefaultRelayURL {
		switch {
		case strings.HasPrefix(relayURL, "wss://"):
			selector, relayRest = relayWSS, strings.TrimPrefix(relayURL, "wss://")
		default:
			selector, relayRest = relayWS, strings.TrimPrefix(relayURL, "ws://")
		}
	}

	buf := make([]byte, 0, invitationFixedSize+len(relayRest))
	buf = append(buf, byte(desc.Version), selector)
	buf = append(buf, desc.RegisterPublicKey...)
	buf = append(buf, desc.NoisePublicKey...)
	buf = append(buf, secret...)
	buf = binary.BigEndian.AppendUint32(buf, uint32(exp))
	buf = append(buf, desc.Signature...)
	buf = append(buf, relayRest...)
	return InvitationPrefix + invitationBase32.EncodeToString(buf), nil
}

// ParseInvitation decodes an invitation text, verifies the secret binding,
// expiry, and Ed25519 PairingDescriptor signature. Whitespace anywhere in the
// text (line wraps from a terminal) and letter case are ignored.
func ParseInvitation(text string, now time.Time) (*ParsedInvitation, error) {
	compact := strings.ToUpper(strings.Join(strings.Fields(text), ""))
	if compact == "" {
		return nil, fmt.Errorf("%w: empty invitation", protocol.ErrMalformed)
	}
	if len(compact) > MaxInvitationTextLength {
		return nil, fmt.Errorf("%w: invitation exceeds %d chars", protocol.ErrMalformed, MaxInvitationTextLength)
	}
	if !strings.HasPrefix(compact, InvitationPrefix) {
		return nil, fmt.Errorf("%w: missing %s prefix", protocol.ErrMalformed, InvitationPrefix)
	}
	encoded := strings.TrimPrefix(compact, InvitationPrefix)
	raw, err := invitationBase32.DecodeString(encoded)
	if err != nil || invitationBase32.EncodeToString(raw) != encoded {
		return nil, fmt.Errorf("%w: invalid base32 payload", protocol.ErrMalformed)
	}
	if len(raw) < invitationFixedSize {
		return nil, fmt.Errorf("%w: invitation is %d bytes, want at least %d", protocol.ErrMalformed, len(raw), invitationFixedSize)
	}

	version := raw[0]
	if uint16(version) != protocol.Version {
		return nil, fmt.Errorf("%w: unsupported invitation version %d", protocol.ErrMalformed, version)
	}
	selector := raw[1]
	off := 2
	next := func(n int) []byte {
		field := raw[off : off+n]
		off += n
		return field
	}
	regPub := next(ed25519.PublicKeySize)
	noisePub := next(protocol.NoiseKeySize)
	secret := next(InvitationSecretSize)
	expiresAt := int64(binary.BigEndian.Uint32(next(4)))
	sig := next(ed25519.SignatureSize)
	rest := string(raw[off:])

	var relayURL string
	switch selector {
	case relayDefault:
		if rest != "" {
			return nil, fmt.Errorf("%w: default relay carries trailing bytes", protocol.ErrMalformed)
		}
		relayURL = DefaultRelayURL
	case relayWSS:
		relayURL = "wss://" + rest
	case relayWS:
		relayURL = "ws://" + rest
	default:
		return nil, fmt.Errorf("%w: unknown relay selector %d", protocol.ErrMalformed, selector)
	}
	normalized, err := NormalizeRelayURL(relayURL)
	if err != nil || normalized != relayURL || (selector != relayDefault && relayURL == DefaultRelayURL) {
		return nil, fmt.Errorf("%w: invalid relay", protocol.ErrMalformed)
	}
	if expiresAt <= 0 {
		return nil, fmt.Errorf("%w: expiry must be positive", protocol.ErrMalformed)
	}

	deviceID := protocol.DeviceIDFromKey(regPub)
	sum := sha256.Sum256(secret)
	desc := &protocol.PairingDescriptor{
		Version:           uint16(version),
		RelayURL:          relayURL,
		DeviceID:          deviceID,
		RegisterPublicKey: ed25519.PublicKey(append([]byte(nil), regPub...)),
		NoisePublicKey:    append([]byte(nil), noisePub...),
		InvitationHash:    sum[:],
		ExpiresAt:         time.Unix(expiresAt, 0),
		Signature:         append([]byte(nil), sig...),
	}
	if err := desc.Verify(now); err != nil {
		return nil, err
	}
	return &ParsedInvitation{
		Descriptor:       desc,
		InvitationSecret: append([]byte(nil), secret...),
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

// Fingerprint renders a human-readable short verification display of a 32-byte
// public key. It is for local visual verification only, never an access secret.
func Fingerprint(pub []byte) string {
	sum := sha256.Sum256(pub)
	return fmt.Sprintf("%02X%02X-%02X%02X-%02X%02X", sum[0], sum[1], sum[2], sum[3], sum[4], sum[5])
}
