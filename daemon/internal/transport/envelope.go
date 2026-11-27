// Package transport manages the daemon's outbound WebSocket connection to the
// Agentik relay.
//
// It owns only the outer relay envelope: connection setup, challenge-response
// route registration, keepalive pings, exponential-backoff reconnection, and
// per-connectionId frame forwarding. It never reads or interprets frame bytes,
// which carry Noise handshake and encrypted transport messages.
package transport

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// MaxFrameBytes matches the relay's maximum opaque frame payload size (32 KiB).
const MaxFrameBytes = 32 * 1024

// KeepalivePing is the exact JSON text frame the Cloudflare Durable Object
// hibernation auto-response matches without waking the object or counting
// against rate limits.
const KeepalivePing = `{"type":"ping"}`

// Close codes used by the relay (relay/src/messages.ts).
const (
	CloseReplaced      = 4000
	CloseProtocolError = 4001
	CloseSlowReceiver  = 4002
	CloseEvicted       = 4003
)

var (
	// ErrNotConnected is returned when SendFrame is called while the relay
	// route is not registered. Frames are never queued across disconnects
	// because a new socket requires a fresh Noise handshake.
	ErrNotConnected = errors.New("transport: relay is not connected")
	// ErrFrameEmpty is returned when sending an empty payload.
	ErrFrameEmpty = errors.New("transport: frame payload is empty")
	// ErrFrameTooLarge is returned when a frame exceeds MaxFrameBytes.
	ErrFrameTooLarge = errors.New("transport: frame exceeds maximum payload size")
	// ErrInvalidConnectionID is returned when a device frame omits or passes a
	// malformed relay connection ID.
	ErrInvalidConnectionID = errors.New("transport: invalid connection id")
)

var connectionIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ValidConnectionID reports whether id matches the relay's 32-hex-character
// connection identifier format.
func ValidConnectionID(id string) bool {
	return connectionIDPattern.MatchString(id)
}

type outboundRegister struct {
	Type              string `json:"type"`
	Version           uint16 `json:"version"`
	Role              string `json:"role"`
	RelayID           string `json:"relay_id"`
	DeviceID          string `json:"device_id"`
	RegisterPublicKey string `json:"register_public_key"`
	Challenge         string `json:"challenge"`
	ExpiresAt         int64  `json:"expires_at"`
	Signature         string `json:"signature"`
}

type outboundFrame struct {
	Type         string `json:"type"`
	Data         string `json:"data"`
	ConnectionID string `json:"connection_id"`
}

type inboundEnvelope struct {
	Type         string   `json:"type"`
	Challenge    string   `json:"challenge"`
	RelayID      string   `json:"relayId"`
	ExpiresAt    int64    `json:"expiresAt"`
	DeviceID     string   `json:"deviceId"`
	Connections  []string `json:"connections"`
	Present      *bool    `json:"present"`
	Data         string   `json:"data"`
	ConnectionID string   `json:"connectionId"`
	Code         string   `json:"code"`
	Message      string   `json:"message"`
}

func decodeInbound(raw []byte) (*inboundEnvelope, error) {
	var msg inboundEnvelope
	if err := json.Unmarshal(raw, &msg); err != nil {
		return nil, fmt.Errorf("transport: invalid relay JSON: %w", err)
	}
	if msg.Type == "" {
		return nil, errors.New("transport: missing relay message type")
	}
	return &msg, nil
}

func decodeStdBase64(s string) ([]byte, error) {
	if s == "" || strings.ContainsAny(s, "\r\n") {
		return nil, errors.New("invalid base64")
	}
	return base64.StdEncoding.DecodeString(s)
}
