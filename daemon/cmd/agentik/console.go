package main

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/pairing"
	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
	"github.com/sergey-telpuk/agentik/daemon/internal/webrtc"
)

// --- console status display ---------------------------------------------

// statusSource is the live state the status display reads. The console asks
// for it on demand rather than holding counters of its own.
type statusSource struct {
	peers    func() []webrtc.PeerStat
	stats    func() runtime.Stats
	clients  func(context.Context) ([]pairing.TrustedClient, error)
	deviceID string
	relay    string
	started  time.Time
	version  string
}

// humanSince formats an age the way a glance wants it: a running agent is
// interesting by the second, an hours-old connection is not.
func humanSince(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dd%02dh", int(d.Hours())/24, int(d.Hours())%24)
}

// printStatus writes the status display: what this computer is, who is
// connected, and what the agents are doing.
func printStatus(out io.Writer, src statusSource, now time.Time) {
	peers := src.peers()
	stats := src.stats()

	open := 0
	for _, p := range peers {
		if p.Open {
			open++
		}
	}

	fmt.Fprintf(out, "\nAgentik %s  ·  up %s\n", src.version, humanSince(now.Sub(src.started)))
	fmt.Fprintf(out, "  computer  %s\n", src.deviceID)
	fmt.Fprintf(out, "  relay     %s\n", src.relay)

	// Connections: what is actually carrying data right now.
	fmt.Fprintf(out, "\n  Connected phones: %d\n", open)
	if len(peers) == 0 {
		fmt.Fprintf(out, "    none\n")
	}
	for _, p := range peers {
		state := "connecting"
		if p.Open {
			state = "connected"
		}
		fmt.Fprintf(out, "    %-10s %s  (%s)\n", state, p.ConnectionID, humanSince(now.Sub(p.Since)))
	}

	// Work: the numbers that say whether the computer is busy.
	fmt.Fprintf(out, "\n  Agents running:    %d\n", stats.ActiveTurns)
	if stats.PendingApprovals > 0 {
		fmt.Fprintf(out, "  Waiting for you:   %d  (decide on the phone)\n", stats.PendingApprovals)
	}
	if stats.Terminals > 0 {
		fmt.Fprintf(out, "  Open terminals:    %d\n", stats.Terminals)
	}

	if clients, err := src.clients(context.Background()); err == nil {
		active := 0
		for _, c := range clients {
			if c.RevokedAt == nil {
				active++
			}
		}
		fmt.Fprintf(out, "  Paired phones:     %d\n", active)
	}
	fmt.Fprintln(out)
}
