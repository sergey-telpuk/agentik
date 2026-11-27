package webrtc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/sergey-telpuk/agentik/daemon/internal/transport"
)

// Signal kinds, as the relay carries them.
const (
	KindOffer      = transport.SignalOffer
	KindAnswer     = transport.SignalAnswer
	KindICE        = transport.SignalICE
	KindICEServers = transport.SignalICEServers
)

// SignalVersion is the version of the signaling payloads below.
const SignalVersion = 1

// Signaler sends one signaling payload to the phone behind connectionID. The
// relay-backed implementation is transport.Client.SendSignal.
type Signaler interface {
	SendSignal(ctx context.Context, connectionID, kind string, data []byte) error
}

// SDPMessage is the payload of an offer or an answer.
type SDPMessage struct {
	V   int    `json:"v"`
	SDP string `json:"sdp"`
}

// ICEMessage is the payload of one ICE candidate, in RTCIceCandidateInit form.
type ICEMessage struct {
	V                int     `json:"v"`
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// ICEServersMessage is the payload of an ice_servers signal.
type ICEServersMessage struct {
	V       int         `json:"v"`
	Servers []ICEServer `json:"servers"`
}

// DataChannelLabel names the one DataChannel the phone opens.
const DataChannelLabel = "agentik"

var errBadSignal = errors.New("webrtc: malformed signaling payload")

func decodeSDP(data []byte) (string, error) {
	var m SDPMessage
	if err := json.Unmarshal(data, &m); err != nil || m.V != SignalVersion || m.SDP == "" {
		return "", errBadSignal
	}
	return m.SDP, nil
}

func decodeICE(data []byte) (ICEMessage, error) {
	var m ICEMessage
	if err := json.Unmarshal(data, &m); err != nil || m.V != SignalVersion {
		return ICEMessage{}, errBadSignal
	}
	return m, nil
}

func encodeSignal(v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("webrtc: encode signal: %w", err)
	}
	if len(b) > transport.MaxSignalBytes {
		return nil, transport.ErrSignalTooLarge
	}
	return b, nil
}
