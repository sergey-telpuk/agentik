// Command agentik is the local Agentik daemon.
//
// It manages device identity, SQLite persistence, relay connectivity, local
// pairing confirmation and revocation, and local Codex execution for explicitly
// permitted projects.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents"
	"github.com/sergey-telpuk/agentik/daemon/internal/agents/codex"
	"github.com/sergey-telpuk/agentik/daemon/internal/agents/discovery"
	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/pairing"
	"github.com/sergey-telpuk/agentik/daemon/internal/projects"
	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
	"github.com/sergey-telpuk/agentik/daemon/internal/storage"
	"github.com/sergey-telpuk/agentik/daemon/internal/terminal"
	"github.com/sergey-telpuk/agentik/daemon/internal/transport"
	"github.com/sergey-telpuk/agentik/daemon/internal/webrtc"
)

// version is the release identifier. Release builds override it with
// -ldflags "-X main.version=<version>".
var version = "dev"

const (
	defaultRelayURL = pairing.DefaultRelayURL
	defaultRelayID  = "agentik-relay"
	defaultPairTTL  = 10 * time.Minute
)

func main() {
	prepareConsole()
	// os.Interrupt is Ctrl+C on every platform. On Windows the Go runtime also
	// reports console close, logoff and shutdown as syscall.SIGTERM, so the
	// same list shuts the daemon down cleanly there.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		fmt.Fprintf(os.Stderr, "agentik: %v\n", err)
		os.Exit(1)
	}
}

type projectFlagList []projects.Project

func (p *projectFlagList) String() string { return fmt.Sprintf("%d projects", len(*p)) }

func (p *projectFlagList) Set(value string) error {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return errors.New("project value must not be empty")
	}
	id := ""
	path := raw
	if eq := strings.IndexByte(raw, '='); eq >= 0 {
		id = strings.TrimSpace(raw[:eq])
		path = strings.TrimSpace(raw[eq+1:])
	}
	if path == "" {
		return errors.New("project path must not be empty")
	}
	if id == "" {
		if len(*p) == 0 {
			id = "default"
		} else {
			id = fmt.Sprintf("project_%d", len(*p)+1)
		}
	}
	*p = append(*p, projects.Project{
		ID:           id,
		Name:         filepath.Base(path),
		Root:         path,
		AllowedAgent: codex.AgentName,
	})
	return nil
}

// lateSignaler lets the acceptor be built before the relay client exists.
type lateSignaler struct {
	mu sync.RWMutex
	fn func(ctx context.Context, connectionID, kind string, data []byte) error
}

func (l *lateSignaler) set(fn func(ctx context.Context, connectionID, kind string, data []byte) error) {
	l.mu.Lock()
	l.fn = fn
	l.mu.Unlock()
}

func (l *lateSignaler) SendSignal(ctx context.Context, connectionID, kind string, data []byte) error {
	l.mu.RLock()
	fn := l.fn
	l.mu.RUnlock()
	if fn == nil {
		return errors.New("signaling relay not initialized")
	}
	return fn(ctx, connectionID, kind, data)
}

func run(ctx context.Context, args []string, in io.Reader, out, errOut io.Writer) error {
	fs := flag.NewFlagSet("agentik", flag.ContinueOnError)
	fs.SetOutput(errOut)

	dataDir := fs.String("data-dir", "", "directory for identity and database (default: platform data directory)")
	showVersion := fs.Bool("version", false, "print the daemon version and exit")
	showStatus := fs.Bool("status", false, "print the device identity, diagnostics, and exit")
	relayURL := fs.String("relay", envOr(envRelayURL, defaultRelayURL),
		"signaling relay WSS base URL; the relay carries WebRTC signaling only, never application data (env "+envRelayURL+")")
	relayID := fs.String("relay-id", defaultRelayID, "expected relay identifier")
	pairOnStart := fs.Bool("pair", false, "always print a pairing invitation and QR code on startup "+
		"(by default one is printed only while no phone is paired)")
	pairTTL := fs.Duration("pair-ttl", defaultPairTTL, "lifetime of newly issued pairing invitations")
	telegramBotID := fs.Int64("telegram-bot-id", 0, "expected Telegram bot id for initData verification (0 disables)")
	codexBin := fs.String("codex-bin", "codex", "path or command name for codex CLI")
	agentSearchPath := fs.String("agent-search-path", "", "PATH-style list of directories to search for agent CLIs, "+
		"instead of PATH and the usual install locations")

	rtcFlags := registerWebRTCFlags(fs)

	var configuredProjects projectFlagList
	fs.Var(&configuredProjects, "project", "permitted project as id=path or path (repeatable)")

	if err := fs.Parse(args); err != nil {
		return err
	}
	if *showVersion {
		_, err := fmt.Fprintf(out, "agentik %s\n", version)
		return err
	}

	store, err := identity.NewStore(*dataDir)
	if err != nil {
		return err
	}
	id, created, err := store.LoadOrCreate()
	if err != nil {
		return err
	}

	db, err := storage.Open(ctx, storage.DefaultPath(store.Dir()))
	if err != nil {
		return err
	}
	defer db.Close()

	schemaVersion, err := db.SchemaVersion(ctx)
	if err != nil {
		return err
	}

	// Projects live in the database, so they survive a restart and can be
	// managed from the phone. --project still works: it adds to what is
	// stored, which is how an existing setup keeps running unchanged.
	storedProjects, err := loadProjects(ctx, db)
	if err != nil {
		return err
	}
	cat, err := projects.NewCatalogue(mergeProjects(storedProjects, configuredProjects))
	if err != nil {
		return err
	}

	codexAdapter := codex.NewAdapter(codex.Config{Binary: *codexBin})
	codexDiag := codexAdapter.Diagnose(ctx)

	discCfg := discovery.Config{Overrides: map[string]string{codex.AgentName: *codexBin}}
	if *agentSearchPath != "" {
		discCfg.PathEnv = *agentSearchPath
	} else {
		home, _ := os.UserHomeDir()
		discCfg.ExtraDirs = discovery.WellKnownDirs(home)
	}
	catalog := agents.NewRegistry(agents.Config{
		Adapters:   map[string]codex.Adapter{codex.AgentName: codexAdapter},
		Discoverer: discovery.New(discCfg),
	})

	// Diagnostics are the answer with -status; otherwise they are logs, and
	// stdout stays reserved for what the user has to read or act on.
	diag := errOut
	if *showStatus {
		diag = out
	}
	if created {
		fmt.Fprintln(diag, "Created a new device identity.")
	}
	// Paths and versions answer "is this set up right", which is what -status
	// is for. A normal run keeps the terminal for what is happening instead;
	// the status display repeats the identity on demand.
	if *showStatus {
		fmt.Fprintf(diag, "device id:     %s\n", id.DeviceIDString())
		fmt.Fprintf(diag, "data dir:      %s\n", store.Dir())
		fmt.Fprintf(diag, "database:      %s (schema v%d)\n", db.Path(), schemaVersion)
		fmt.Fprintf(diag, "projects:      %d\n", cat.Len())
		fmt.Fprintf(diag, "codex:         available=%v authenticated=%v", codexDiag.Available, codexDiag.Authenticated)
		if codexDiag.Version != "" {
			fmt.Fprintf(diag, " version=%q", codexDiag.Version)
		}
		fmt.Fprintln(diag)
	} else if !codexDiag.Available || !codexDiag.Authenticated {
		// Worth saying unprompted: no agent means no task can start.
		fmt.Fprintln(diag, "codex: not ready; tasks cannot start until it is installed and signed in")
	}

	if *showStatus {
		fmt.Fprintln(out, "agents:")
		for _, e := range catalog.List(ctx) {
			fmt.Fprintf(out, "  %-13s status=%s supported=%v", e.ID, e.Status, e.Supported)
			if e.Version != "" {
				fmt.Fprintf(out, " version=%q", e.Version)
			}
			if len(e.Models) > 0 {
				fmt.Fprintf(out, " models=%d (%s)", len(e.Models), e.ModelsSource)
			}
			fmt.Fprintln(out)
			if e.Status == agents.StatusUnsupported {
				fmt.Fprintf(out, "                %s\n", e.StatusText)
			}
		}
		return nil
	}

	// Warm the agent cache in the background so the first agent.list from a
	// phone is not the one that pays for running the CLIs.
	go catalog.List(ctx)

	normalizedRelay, err := pairing.NormalizeRelayURL(*relayURL)
	if err != nil {
		return err
	}
	iceCfg, err := rtcFlags.iceConfig()
	if err != nil {
		return err
	}
	turnProvider, err := rtcFlags.turnProvider()
	if err != nil {
		return err
	}
	// Credentials from the relay need no configuration at all, so they are
	// the default. An explicitly configured provider wins: someone who set
	// one up means to use it.
	relayTURN := &webrtc.RelayTURN{}
	if turnProvider == nil {
		turnProvider = relayTURN
	}

	// One mutex for both streams keeps lines whole when they share a terminal.
	var outMu sync.Mutex
	logLine := func(format string, a ...any) {
		outMu.Lock()
		defer outMu.Unlock()
		fmt.Fprintf(out, format+"\n", a...)
	}
	logf := func(format string, a ...any) {
		outMu.Lock()
		defer outMu.Unlock()
		fmt.Fprintf(errOut, format+"\n", a...)
	}

	pendingNotify := make(chan struct{}, 4)
	pairSvc, err := pairing.NewService(pairing.Config{
		DB:            db,
		Identity:      id,
		TelegramBotID: *telegramBotID,
		OnPendingChange: func() {
			select {
			case pendingNotify <- struct{}{}:
			default:
			}
		},
	})
	if err != nil {
		return err
	}

	// The relay carries signaling only. Application data goes over the WebRTC
	// DataChannel, through the acceptor.
	signaler := &lateSignaler{}
	acceptor, err := webrtc.NewAcceptor(webrtc.Config{
		DeviceID:       id.DeviceID(),
		Signaler:       signaler,
		ICE:            iceCfg,
		TURNProvider:   turnProvider,
		ConnectTimeout: *rtcFlags.connectTimeout,
		OnEvent: func(connID, event string) {
			logLine("webrtc[%s]: %s", connID, event)
		},
	})
	if err != nil {
		return err
	}
	defer acceptor.Close()

	hub, err := runtime.NewHub(
		id,
		pairSvc,
		runtime.Config{
			DB:       db,
			Identity: id,
			Pairing:  pairSvc,
			Projects: cat,
			Agents:   map[string]codex.Adapter{codex.AgentName: codexAdapter},
			Catalog:  catalog,
			Terminal: terminal.Config{Logf: logLine},
		},
		acceptor,
		acceptor.Prologue,
		func(connID string, secErr error) {
			logf("secure[%s]: %v", connID, secErr)
		},
	)
	if err != nil {
		return err
	}
	defer hub.Close()
	acceptor.SetSessions(hub.Manager())
	hub.SetOnSessionClosed(acceptor.CloseConnection)

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	tClient, err := transport.NewClient(transport.Config{
		RelayURL:        normalizedRelay,
		Identity:        id,
		ExpectedRelayID: *relayID,
		Handlers: transport.Handlers{
			OnStatus: func(st transport.Status) {
				if st.LastError != "" {
					logf("relay: %s (attempt=%d error=%s)", st.State, st.Attempt, st.LastError)
				} else {
					logf("relay: %s (attempt=%d)", st.State, st.Attempt)
				}
			},
			OnRegistered: func(_ string, connections []string) {
				acceptor.HandleRegistered(runCtx, connections)
			},
			OnTURN: func(servers []transport.InboundICEServer, expiresIn int) {
				ice := make([]webrtc.ICEServer, 0, len(servers))
				for _, s := range servers {
					ice = append(ice, webrtc.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
				}
				// Renew a little early, so a credential handed to a phone is
				// still valid while ICE is negotiating.
				ttl := time.Duration(expiresIn) * time.Second
				if ttl > time.Minute {
					ttl -= time.Minute
				}
				relayTURN.Store(ice, ttl)
				logf("relay: TURN credentials received (%d servers, %s)", len(ice), ttl.Round(time.Minute))
			},
			// No OnDisconnected: a DataChannel that is already open does not
			// depend on the relay, so losing the relay does not end it.
			OnPeerState: func(connectionID string, present bool) {
				acceptor.HandlePeerState(runCtx, connectionID, present)
			},
			OnSignal: func(connectionID, kind string, data []byte) {
				acceptor.HandleSignal(runCtx, connectionID, kind, data)
			},
			OnRelayError: func(code, message, connectionID string) {
				if connectionID != "" {
					logf("relay error[%s]: %s (%s)", connectionID, code, message)
				} else {
					logf("relay error: %s (%s)", code, message)
				}
			},
		},
	})
	if err != nil {
		return err
	}
	signaler.set(tClient.SendSignal)

	paired, err := pairSvc.PairedClientCount(runCtx)
	if err != nil {
		return err
	}
	outMu.Lock()
	printStartup(out, paired)
	outMu.Unlock()
	if paired == 0 || *pairOnStart {
		inv, err := printInvitation(runCtx, pairSvc, normalizedRelay, *pairTTL, &outMu, out)
		if err != nil {
			return err
		}
		if paired == 0 {
			go refreshInvitation(runCtx, pairSvc, normalizedRelay, *pairTTL, inv.ExpiresAt, &outMu, out)
		}
	}
	status := statusSource{
		peers:    acceptor.Peers,
		stats:    hub.Runtime().Stats,
		clients:  pairSvc.ListTrustedClients,
		deviceID: id.DeviceIDString(),
		relay:    normalizedRelay,
		started:  time.Now(),
		version:  version,
	}
	logf("Commands: status, pair, clients, revoke <id>, quit")

	var transportWg sync.WaitGroup
	transportErrCh := make(chan error, 1)
	transportWg.Add(1)
	go func() {
		defer transportWg.Done()
		transportErrCh <- tClient.Run(runCtx)
	}()
	defer func() {
		cancelRun()
		transportWg.Wait()
	}()

	lineCh := make(chan string)
	go func() {
		scanner := bufio.NewScanner(in)
		for scanner.Scan() {
			select {
			case lineCh <- scanner.Text():
			case <-runCtx.Done():
				return
			}
		}
		close(lineCh)
	}()

	var currentPending *pairing.PendingConfirmation
	showPrompt := func() {
		if currentPending != nil {
			return
		}
		list := pairSvc.ListPending()
		if len(list) == 0 {
			return
		}
		p := list[0]
		currentPending = &p
		logLine(
			"\nPending pairing confirmation:\n  id:          %s\n  fingerprint: %s\n  telegram:    %d (%s)\n  label:       %s\nConfirm this phone? [y/N]: ",
			p.ID, p.Fingerprint, p.TelegramUserID, p.TelegramUsername, p.Label,
		)
	}

	for {
		showPrompt()
		select {
		case <-runCtx.Done():
			logLine("Shutting down.")
			return nil
		case tErr := <-transportErrCh:
			if tErr != nil && !errors.Is(tErr, context.Canceled) {
				return tErr
			}
			return nil
		case <-pendingNotify:
			showPrompt()
		case line, ok := <-lineCh:
			if !ok {
				// EOF on stdin (e.g. non-interactive run): stay alive until ctx.Done().
				lineCh = nil
				continue
			}
			cmd := strings.TrimSpace(line)
			if currentPending != nil {
				switch strings.ToLower(cmd) {
				case "y", "yes":
					trusted, err := pairSvc.ConfirmPairing(runCtx, currentPending.ID, "")
					if err != nil {
						logLine("pair confirm failed: %v", err)
					} else {
						hub.NotifyPeerPaired(runCtx, trusted.NoisePublicKey, "paired")
						logLine("Paired client #%d (%s).", trusted.ID, trusted.Fingerprint)
					}
					currentPending = nil
					continue
				case "n", "no", "":
					if err := pairSvc.RejectPairing(runCtx, currentPending.ID); err != nil {
						logLine("pair reject failed: %v", err)
					} else {
						hub.NotifyPeerPaired(runCtx, currentPending.ClientNoisePublicKey, "rejected")
						logLine("Rejected pending pairing %s.", currentPending.ID)
					}
					currentPending = nil
					continue
				}
			}

			switch {
			case cmd == "" || cmd == "status":
				// An empty line is the quickest way to ask "what is going on",
				// so it shows the status rather than repeating the help.
				outMu.Lock()
				printStatus(out, status, time.Now())
				outMu.Unlock()
			case cmd == "help":
				logLine("Commands: status (or Enter), pair, clients, revoke <id>, quit")
			case cmd == "quit" || cmd == "exit":
				logLine("Shutting down.")
				return nil
			case cmd == "pair":
				if _, err := printInvitation(runCtx, pairSvc, normalizedRelay, *pairTTL, &outMu, out); err != nil {
					logLine("pair error: %v", err)
				}
			case cmd == "clients":
				clients, err := pairSvc.ListTrustedClients(runCtx)
				if err != nil {
					logLine("clients error: %v", err)
					continue
				}
				if len(clients) == 0 {
					logLine("No paired clients.")
					continue
				}
				for _, c := range clients {
					status := "active"
					if c.RevokedAt != nil {
						status = "revoked"
					}
					logLine("#%d %s (%s) label=%q telegram=%d", c.ID, c.Fingerprint, status, c.Label, c.TelegramUserID)
				}
			case strings.HasPrefix(cmd, "revoke "):
				idStr := strings.TrimSpace(strings.TrimPrefix(cmd, "revoke "))
				clientID, err := strconv.ParseInt(idStr, 10, 64)
				if err != nil {
					logLine("invalid client id %q", idStr)
					continue
				}
				clients, err := pairSvc.ListTrustedClients(runCtx)
				if err != nil {
					logLine("revoke error: %v", err)
					continue
				}
				var target []byte
				for _, c := range clients {
					if c.ID == clientID {
						target = c.NoisePublicKey
						break
					}
				}
				if len(target) == 0 {
					logLine("client #%d not found", clientID)
					continue
				}
				if err := hub.RevokePeer(runCtx, target); err != nil {
					logLine("revoke failed: %v", err)
				} else {
					logLine("Revoked client #%d.", clientID)
				}
			default:
				logLine("Unknown command %q. Try: pair, clients, revoke <id>, quit", cmd)
			}
		}
	}
}

// welcomeParagraphs introduce Agentik on a start with no paired phone. The
// last one must match the confirmation prompt, which accepts y.
var welcomeParagraphs = []string{
	"Agentik runs your AI coding agents on this computer and lets you control them from your phone.",
	"This program (the daemon) runs on this computer, starts agents such as Codex in your project folders, " +
		"and keeps the connection to your phone encrypted. It makes no incoming connections.",
	"Scan the code below with the Agentik app in Telegram to pair this computer. " +
		"You confirm the pairing here with y.",
}

// terminalWidth is the narrowest terminal the startup output is laid out for.
const terminalWidth = 80

// printStartup prints the welcome banner while no phone is paired, and a
// single status line once one is.
func printStartup(out io.Writer, paired int) {
	if paired > 0 {
		// Already set up: say what it is, what it is doing, and how to look
		// closer or stop. The full explanation is only useful the first time.
		fmt.Fprintf(out, "Agentik daemon is running.\n")
		fmt.Fprintf(out, "Paired phones: %d. Press Enter for status, type help for commands, Ctrl+C to stop.\n", paired)
		return
	}
	for i, p := range welcomeParagraphs {
		if i > 0 {
			fmt.Fprintln(out)
		}
		fmt.Fprint(out, wrapWords(p, terminalWidth))
	}
}

// wrapWords breaks text at spaces into lines of at most width columns, each
// ending in a newline. A single word longer than width gets a line of its own.
func wrapWords(text string, width int) string {
	var b strings.Builder
	line := 0
	for _, word := range strings.Fields(text) {
		n := utf8.RuneCountInString(word)
		switch {
		case line == 0:
		case line+1+n > width:
			b.WriteByte('\n')
			line = 0
		default:
			b.WriteByte(' ')
			line++
		}
		b.WriteString(word)
		line += n
	}
	b.WriteByte('\n')
	return b.String()
}

// printInvitation issues an invitation and prints its QR code with the
// invitation text underneath, for the case where the camera cannot read it.
func printInvitation(
	ctx context.Context,
	pairSvc *pairing.Service,
	relayURL string,
	ttl time.Duration,
	mu *sync.Mutex,
	out io.Writer,
) (*pairing.IssuedInvitation, error) {
	inv, err := pairSvc.CreateInvitation(ctx, relayURL, ttl)
	if err != nil {
		return nil, err
	}
	mu.Lock()
	defer mu.Unlock()
	// Without this the terminal goes quiet after the code, and it is not
	// obvious that the next move is on the phone, nor that this window has to
	// stay open to confirm it.
	fmt.Fprintf(out, "\nPairing invitation (valid until %s):\n%s\nOr paste this text in the Mini App:\n%s\n\n",
		inv.ExpiresAt.Local().Format("15:04"), inv.QR, inv.InvitationText)
	fmt.Fprintf(out, "Waiting for a phone to scan it. Keep this window open: the phone appears\nhere and you confirm it with y. The code expires at %s; a new one is printed\nthen, or type pair for one now.\n\n",
		inv.ExpiresAt.Local().Format("15:04"))
	return inv, nil
}

// refreshInvitation prints a new invitation each time the previous one has
// expired, for as long as no phone is paired. It stops when a phone pairs or
// the context ends, and waits while a pairing confirmation is pending so a
// new QR code does not scroll the confirmation prompt away.
func refreshInvitation(
	ctx context.Context,
	pairSvc *pairing.Service,
	relayURL string,
	ttl time.Duration,
	expiresAt time.Time,
	mu *sync.Mutex,
	out io.Writer,
) {
	const pendingRecheck = 5 * time.Second
	wait := time.Until(expiresAt)
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if paired, err := pairSvc.PairedClientCount(ctx); err != nil || paired > 0 {
			return
		}
		if len(pairSvc.ListPending()) > 0 {
			wait = pendingRecheck
			continue
		}
		inv, err := printInvitation(ctx, pairSvc, relayURL, ttl, mu, out)
		if err != nil {
			return
		}
		wait = time.Until(inv.ExpiresAt)
	}
}
