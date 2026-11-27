// Package transport manages the daemon's outbound WebSocket connection to the
// Agentik relay.
//
// The relay is used for signaling only. This package owns the outer relay
// envelope: connection setup, challenge-response route registration,
// keepalive pings, exponential-backoff reconnection, and per-connectionId
// forwarding of WebRTC signaling payloads (SDP offers and answers, ICE
// candidates, the ICE server list). It never reads or interprets those bytes,
// and it has no way to send application data: Noise and RPC frames travel
// over the WebRTC DataChannel (package webrtc).
package transport

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// MaxSignalBytes matches the relay's maximum signaling payload size (32 KiB).
const MaxSignalBytes = 32 * 1024

// Signal kinds the relay forwards (relay/src/messages.ts). A device sends only
// the kinds in DeviceSignalKinds and receives only the ones a client may send.
const (
	SignalOffer      = "offer"
	SignalAnswer     = "answer"
	SignalICE        = "ice"
	SignalICEServers = "ice_servers"
)

// DeviceSignalKinds lists what the daemon may send; SendSignal refuses any
// other kind before it reaches the wire.
var DeviceSignalKinds = []string{SignalAnswer, SignalICE, SignalICEServers}

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
	// ErrNotConnected is returned when SendSignal is called while the relay
	// route is not registered. Signals are never queued across disconnects.
	ErrNotConnected = errors.New("transport: relay is not connected")
	// ErrSignalEmpty is returned when sending an empty payload.
	ErrSignalEmpty = errors.New("transport: signal payload is empty")
	// ErrSignalTooLarge is returned when a signal exceeds MaxSignalBytes.
	ErrSignalTooLarge = errors.New("transport: signal exceeds maximum payload size")
	// ErrSignalKind is returned when a signal kind is not one a device may send.
	ErrSignalKind = errors.New("transport: signal kind is not allowed for a device")
	// ErrInvalidConnectionID is returned when a device signal omits or passes a
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

type outboundSignal struct {
	Type         string `json:"type"`
	Kind         string `json:"kind"`
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
	Kind         string   `json:"kind"`
	Data         string   `json:"data"`
	ConnectionID string   `json:"connectionId"`
	Code         string   `json:"code"`
	Message      string   `json:"message"`

	// TURN credentials, minted by the relay so no user configures a key.
	ICEServers []InboundICEServer `json:"iceServers"`
	ExpiresIn  int                `json:"expiresIn"`
}

// InboundICEServer is one STUN or TURN server from the relay.
type InboundICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
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
