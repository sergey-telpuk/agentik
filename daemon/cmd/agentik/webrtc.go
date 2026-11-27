package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/webrtc"
)

// Environment variables that supply defaults for the signaling and ICE flags.
// A flag given on the command line wins over its variable.
const (
	envRelayURL       = "AGENTIK_RELAY_URL"
	envSTUNURLs       = "AGENTIK_STUN_URLS"
	envTURNURLs       = "AGENTIK_TURN_URLS"
	envTURNSecretFile = "AGENTIK_TURN_SECRET_FILE"
	envTURNSecret     = "AGENTIK_TURN_SECRET"
	envTURNTTL        = "AGENTIK_TURN_TTL"
	envConnectTimeout = "AGENTIK_CONNECT_TIMEOUT"
)

// listFlag is a repeatable flag that also accepts comma-separated values.
type listFlag []string

func (l *listFlag) String() string { return strings.Join(*l, ",") }

func (l *listFlag) Set(v string) error {
	for _, part := range strings.Split(v, ",") {
		if part = strings.TrimSpace(part); part != "" {
			*l = append(*l, part)
		}
	}
	return nil
}

func envOr(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}

// webrtcFlags are the daemon options for the WebRTC data path.
type webrtcFlags struct {
	stun           listFlag
	turn           listFlag
	turnSecretFile *string
	turnTTL        *time.Duration
	connectTimeout *time.Duration
}

func registerWebRTCFlags(fs *flag.FlagSet) *webrtcFlags {
	f := &webrtcFlags{}
	_ = f.stun.Set(os.Getenv(envSTUNURLs))
	_ = f.turn.Set(os.Getenv(envTURNURLs))
	fs.Var(&f.stun, "stun", "STUN server URL handed to phones and used by the daemon, e.g. stun:turn.example.org:3478 "+
		"(repeatable or comma-separated; env "+envSTUNURLs+")")
	fs.Var(&f.turn, "turn", "TURN server URL, e.g. turn:turn.example.org:3478?transport=udp "+
		"(repeatable or comma-separated; env "+envTURNURLs+"); needs a TURN secret")
	f.turnSecretFile = fs.String("turn-secret-file", envOr(envTURNSecretFile, ""),
		"file holding the TURN shared secret (coturn static-auth-secret); env "+envTURNSecretFile+" or "+envTURNSecret)
	f.turnTTL = fs.Duration("turn-ttl", envDuration(envTURNTTL, webrtc.DefaultTURNTTL),
		"lifetime of time-limited TURN credentials; env "+envTURNTTL)
	f.connectTimeout = fs.Duration("connect-timeout", envDuration(envConnectTimeout, webrtc.DefaultConnectTimeout),
		"how long a phone has to open its DataChannel before it is dropped; env "+envConnectTimeout)
	return f
}

// iceConfig builds and validates the ICE configuration. The TURN secret is
// read from a file or from the environment, never from a command-line value,
// so it does not appear in the process list.
func (f *webrtcFlags) iceConfig() (webrtc.ICEConfig, error) {
	cfg := webrtc.ICEConfig{
		STUNURLs: append([]string(nil), f.stun...),
		TURNURLs: append([]string(nil), f.turn...),
		TURNTTL:  *f.turnTTL,
	}
	switch {
	case *f.turnSecretFile != "":
		raw, err := os.ReadFile(*f.turnSecretFile)
		if err != nil {
			return cfg, fmt.Errorf("read TURN secret file: %w", err)
		}
		cfg.TURNSecret = []byte(strings.TrimSpace(string(raw)))
	case os.Getenv(envTURNSecret) != "":
		cfg.TURNSecret = []byte(strings.TrimSpace(os.Getenv(envTURNSecret)))
	}
	if len(cfg.TURNURLs) > 0 && len(cfg.TURNSecret) == 0 {
		return cfg, errors.New("--turn needs a secret: set --turn-secret-file or " + envTURNSecret)
	}
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	return cfg, nil
}
