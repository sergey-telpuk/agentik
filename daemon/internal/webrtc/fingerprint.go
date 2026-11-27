package webrtc

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

// ErrNoFingerprint is returned when an SDP carries no usable DTLS fingerprint.
var ErrNoFingerprint = errors.New("webrtc: SDP has no sha-256 DTLS fingerprint")

// ExtractFingerprint returns the SHA-256 DTLS certificate fingerprint declared
// in an SDP.
//
// Only sha-256 is accepted: the Noise prologue binds a fixed 32-byte value,
// and a peer that offers only a weaker algorithm is refused rather than
// downgraded. Every sha-256 fingerprint line in the SDP (session level and
// per media section) must agree; two different values are an error, because
// which one DTLS would verify against would then be ambiguous.
func ExtractFingerprint(sdp string) ([]byte, error) {
	var found []byte
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		rest, ok := strings.CutPrefix(line, "a=fingerprint:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) != 2 {
			return nil, fmt.Errorf("webrtc: malformed fingerprint line")
		}
		if !strings.EqualFold(fields[0], "sha-256") {
			continue
		}
		fp, err := parseFingerprint(fields[1])
		if err != nil {
			return nil, err
		}
		if found != nil && !protocol.ConstantTimeEqual(found, fp) {
			return nil, errors.New("webrtc: SDP declares more than one distinct DTLS fingerprint")
		}
		found = fp
	}
	if found == nil {
		return nil, ErrNoFingerprint
	}
	return found, nil
}

// parseFingerprint decodes "AB:CD:..." (case-insensitive) into 32 bytes.
func parseFingerprint(text string) ([]byte, error) {
	parts := strings.Split(text, ":")
	if len(parts) != protocol.DTLSFingerprintSize {
		return nil, fmt.Errorf("webrtc: fingerprint has %d octets, want %d", len(parts), protocol.DTLSFingerprintSize)
	}
	out := make([]byte, 0, len(parts))
	for _, p := range parts {
		if len(p) != 2 {
			return nil, errors.New("webrtc: malformed fingerprint octet")
		}
		b, err := hex.DecodeString(p)
		if err != nil {
			return nil, errors.New("webrtc: malformed fingerprint octet")
		}
		out = append(out, b[0])
	}
	return out, nil
}
