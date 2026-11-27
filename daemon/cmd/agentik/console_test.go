package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/pairing"
	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
	"github.com/sergey-telpuk/agentik/daemon/internal/webrtc"
)

func TestPrintStatusShowsConnectionsAndWork(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	revoked := now.Add(-time.Hour)
	src := statusSource{
		peers: func() []webrtc.PeerStat {
			return []webrtc.PeerStat{
				{ConnectionID: "conn-open", Open: true, Since: now.Add(-90 * time.Second)},
				{ConnectionID: "conn-new", Open: false, Since: now.Add(-5 * time.Second)},
			}
		},
		stats: func() runtime.Stats {
			return runtime.Stats{ActiveTurns: 2, PendingApprovals: 1, Terminals: 3}
		},
		clients: func(context.Context) ([]pairing.TrustedClient, error) {
			return []pairing.TrustedClient{{ID: 1}, {ID: 2, RevokedAt: &revoked}}, nil
		},
		deviceID: "device-abc",
		relay:    "wss://relay.example",
		started:  now.Add(-2 * time.Hour),
		version:  "1.2.3",
	}

	var b bytes.Buffer
	printStatus(&b, src, now)
	out := b.String()

	for _, want := range []string{
		"Agentik 1.2.3",
		"up 2h00m",
		"device-abc",
		"wss://relay.example",
		"Connected phones: 1", // only the open one carries data
		"connected  conn-open",
		"connecting conn-new",
		"1m", // the open peer's age
		"Agents running:    2",
		"Waiting for you:   1",
		"Open terminals:    3",
		"Paired phones:     1", // the revoked one is not counted
	} {
		if !strings.Contains(out, want) {
			t.Errorf("status is missing %q:\n%s", want, out)
		}
	}
}

func TestPrintStatusWithNothingConnected(t *testing.T) {
	now := time.Now()
	src := statusSource{
		peers:    func() []webrtc.PeerStat { return nil },
		stats:    func() runtime.Stats { return runtime.Stats{} },
		clients:  func(context.Context) ([]pairing.TrustedClient, error) { return nil, nil },
		deviceID: "device-abc",
		relay:    "wss://relay.example",
		started:  now,
		version:  "dev",
	}

	var b bytes.Buffer
	printStatus(&b, src, now)
	out := b.String()

	if !strings.Contains(out, "Connected phones: 0") || !strings.Contains(out, "none") {
		t.Fatalf("an idle daemon should say so plainly:\n%s", out)
	}
	// Counts that are zero are noise, not information.
	if strings.Contains(out, "Waiting for you") || strings.Contains(out, "Open terminals") {
		t.Fatalf("zero counts should be left out:\n%s", out)
	}
}

func TestHumanSince(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{30 * time.Second, "30s"},
		{90 * time.Second, "1m"},
		{2*time.Hour + 5*time.Minute, "2h05m"},
		{50 * time.Hour, "2d02h"},
	}
	for _, tc := range cases {
		if got := humanSince(tc.d); got != tc.want {
			t.Errorf("humanSince(%v) = %q, want %q", tc.d, got, tc.want)
		}
	}
}
