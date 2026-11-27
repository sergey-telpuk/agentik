package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/sergey-telpuk/agentik/daemon/internal/pairing"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
	"github.com/sergey-telpuk/agentik/daemon/internal/storage"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestRunStatusAndInvalidProject(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data")
	projDir := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	err := run(
		context.Background(),
		[]string{"--data-dir", dataDir, "--project", "app=" + projDir, "--codex-bin", "nonexistent-codex-xyz", "--agent-search-path", t.TempDir(), "--status"},
		strings.NewReader(""),
		&out,
		&errOut,
	)
	if err != nil {
		t.Fatalf("status failed: %v (stderr=%s)", err, errOut.String())
	}
	got := out.String()
	for _, want := range []string{"device id:", "data dir:", "database:", "projects:      1", "codex:         available=false"} {
		if !strings.Contains(got, want) {
			t.Fatalf("status output missing %q:\n%s", want, got)
		}
	}

	// Missing project directory must fail fast.
	err = run(
		context.Background(),
		[]string{"--data-dir", dataDir, "--project", "bad=" + filepath.Join(t.TempDir(), "missing"), "--status"},
		strings.NewReader(""),
		&out,
		&errOut,
	)
	if err == nil {
		t.Fatal("expected missing project directory error")
	}
}

func TestRunVersion(t *testing.T) {
	old := version
	t.Cleanup(func() { version = old })
	version = "sha-abc1234"

	var out, errOut bytes.Buffer
	if err := run(context.Background(), []string{"-version"}, strings.NewReader(""), &out, &errOut); err != nil {
		t.Fatalf("version failed: %v (stderr=%s)", err, errOut.String())
	}
	if got, want := out.String(), "agentik sha-abc1234\n"; got != want {
		t.Fatalf("version output = %q, want %q", got, want)
	}
}

func TestRunStatusListsDetectedAgents(t *testing.T) {
	if goruntime.GOOS == "windows" {
		t.Skip("shell-script fake binaries need a POSIX shell")
	}
	bin := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write("codex", `case "$1" in --version) echo "codex-cli 1.2.3";; login) echo "Logged in using ChatGPT";; esac`)
	write("claude", `case "$1" in --version) echo "2.0.0 (Claude Code)";; auth) echo '{"loggedIn": true}';; esac`)

	var out, errOut bytes.Buffer
	err := run(context.Background(), []string{
		"--data-dir", filepath.Join(t.TempDir(), "data"),
		"--agent-search-path", bin,
		"--status",
	}, strings.NewReader(""), &out, &errOut)
	if err != nil {
		t.Fatalf("status failed: %v (stderr=%s)", err, errOut.String())
	}
	got := out.String()
	for _, want := range []string{
		"agents:",
		`codex         status=ready supported=true version="codex-cli 1.2.3"`,
		`claude        status=unsupported supported=false version="2.0.0 (Claude Code)"`,
		"not supported yet",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("status output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, bin) {
		t.Fatalf("status output must not print binary paths:\n%s", got)
	}
}

// startFakeRelay serves the relay registration handshake and signals each
// time a daemon has registered.
func startFakeRelay(t *testing.T) (string, <-chan struct{}) {
	t.Helper()
	registered := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/connect" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()

		challenge := make([]byte, protocol.ChallengeSize)
		_, _ = rand.Read(challenge)
		chMsg, _ := json.Marshal(map[string]any{
			"type":      "challenge",
			"relayId":   "test-relay",
			"challenge": base64.StdEncoding.EncodeToString(challenge),
			"expiresAt": time.Now().Add(time.Minute).Unix(),
		})
		if err := ws.Write(r.Context(), websocket.MessageText, chMsg); err != nil {
			return
		}
		_, raw, err := ws.Read(r.Context())
		if err != nil {
			return
		}
		var reg map[string]any
		_ = json.Unmarshal(raw, &reg)
		ack, _ := json.Marshal(map[string]any{
			"type":        "registered",
			"deviceId":    r.URL.Query().Get("device"),
			"connections": []string{},
		})
		if err := ws.Write(r.Context(), websocket.MessageText, ack); err != nil {
			return
		}
		select {
		case registered <- struct{}{}:
		default:
		}
		for {
			if _, _, err := ws.Read(r.Context()); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http"), registered
}

// runDaemon starts the daemon against a fake relay, waits until it has
// registered, types input on stdin, and returns stdout and stderr once the
// daemon has exited. input must end with a quit command.
func runDaemon(t *testing.T, dataDir, input string, extraArgs ...string) (string, string) {
	t.Helper()
	relayURL, registered := startFakeRelay(t)
	projDir := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}

	inR, inW := io.Pipe()
	out := &syncBuffer{}
	errOut := &syncBuffer{}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	args := append([]string{
		"--data-dir", dataDir,
		"--agent-search-path", t.TempDir(),
		"--relay", relayURL,
		"--relay-id", "test-relay",
		"--project", projDir,
		"--codex-bin", "nonexistent-codex-xyz",
	}, extraArgs...)
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, args, inR, out, errOut)
	}()

	select {
	case <-registered:
	case err := <-done:
		t.Fatalf("daemon exited before registering: %v\nout:\n%s\nerr:\n%s", err, out.String(), errOut.String())
	case <-ctx.Done():
		t.Fatalf("timed out waiting for relay registration; out:\n%s\nerr:\n%s", out.String(), errOut.String())
	}

	_, _ = io.WriteString(inW, input)
	_ = inW.Close()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon run returned error: %v\nout:\n%s\nerr:\n%s", err, out.String(), errOut.String())
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for daemon exit")
	}
	return out.String(), errOut.String()
}

// addPairedPhone records a trusted phone directly in the daemon database.
func addPairedPhone(t *testing.T, dataDir string, n byte) {
	t.Helper()
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(t.Context(), storage.DefaultPath(dataDir))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	key := bytes.Repeat([]byte{n}, 32)
	if _, err := db.SQL().ExecContext(t.Context(),
		`INSERT INTO trusted_clients (noise_public_key, telegram_user_id, paired_at) VALUES (?, 1, 1)`, key); err != nil {
		t.Fatal(err)
	}
}

func TestRunDaemonLifecycleWithFakeRelay(t *testing.T) {
	out, _ := runDaemon(t, filepath.Join(t.TempDir(), "data"), "clients\nquit\n", "--pair")
	if !strings.Contains(out, pairing.InvitationPrefix) {
		t.Fatalf("expected pairing invitation prefix in output:\n%s", out)
	}
	if !strings.Contains(out, "No paired clients.") {
		t.Fatalf("expected clients output in stdout:\n%s", out)
	}
}

const pairedLinePrefix = "Agentik daemon is running. Paired phones:"

func TestRunFirstStartPrintsBannerAndQR(t *testing.T) {
	out, errOut := runDaemon(t, filepath.Join(t.TempDir(), "data"), "quit\n")
	if !strings.HasPrefix(out, wrapWords(welcomeParagraphs[0], terminalWidth)) {
		t.Fatalf("stdout should open with the welcome banner:\n%s", out)
	}
	banner := strings.Index(out, "confirm the pairing here with y.")
	qr := strings.Index(out, "Pairing invitation")
	text := strings.Index(out, pairing.InvitationPrefix)
	if banner < 0 || qr < banner || text < qr {
		t.Fatalf("want banner, then QR code, then invitation text:\n%s", out)
	}
	if strings.Contains(out, pairedLinePrefix) {
		t.Fatalf("status line printed while nothing is paired:\n%s", out)
	}
	// Logs go to stderr, not between the banner and the QR code.
	for _, log := range []string{"device id:", "relay:"} {
		if strings.Contains(out, log) {
			t.Errorf("stdout carries log %q:\n%s", log, out)
		}
		if !strings.Contains(errOut, log) {
			t.Errorf("stderr is missing log %q:\n%s", log, errOut)
		}
	}
}

func TestRunWithPairedPhonePrintsOneLine(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data")
	addPairedPhone(t, dataDir, 1)
	addPairedPhone(t, dataDir, 2)

	out, _ := runDaemon(t, dataDir, "quit\n")
	want := "Agentik daemon is running. Paired phones: 2. Stop with Ctrl+C.\n"
	if !strings.HasPrefix(out, want) {
		t.Fatalf("stdout should start with %q:\n%s", want, out)
	}
	if strings.Contains(out, welcomeParagraphs[0][:20]) || strings.Contains(out, pairing.InvitationPrefix) {
		t.Fatalf("banner or QR code printed with a paired phone:\n%s", out)
	}

	out, _ = runDaemon(t, dataDir, "quit\n", "--pair")
	if !strings.HasPrefix(out, want) || !strings.Contains(out, pairing.InvitationPrefix) {
		t.Fatalf("--pair with a paired phone should print the status line and a QR code:\n%s", out)
	}
	if strings.Contains(out, welcomeParagraphs[0][:20]) {
		t.Fatalf("banner printed with a paired phone:\n%s", out)
	}
}

func TestPrintStartup(t *testing.T) {
	var b bytes.Buffer
	printStartup(&b, 0)
	banner := b.String()
	for i, line := range strings.Split(strings.TrimSuffix(banner, "\n"), "\n") {
		if n := len([]rune(line)); n > terminalWidth {
			t.Errorf("banner line %d is %d columns: %q", i, n, line)
		}
	}
	paragraphs := strings.Split(strings.TrimSuffix(banner, "\n"), "\n\n")
	if len(paragraphs) != len(welcomeParagraphs) {
		t.Fatalf("banner has %d paragraphs, want %d:\n%s", len(paragraphs), len(welcomeParagraphs), banner)
	}
	for i, p := range paragraphs {
		if got := strings.Join(strings.Fields(p), " "); got != welcomeParagraphs[i] {
			t.Errorf("paragraph %d = %q, want %q", i, got, welcomeParagraphs[i])
		}
	}

	b.Reset()
	printStartup(&b, 1)
	if got, want := b.String(), "Agentik daemon is running. Paired phones: 1. Stop with Ctrl+C.\n"; got != want {
		t.Fatalf("paired output = %q, want %q", got, want)
	}
}

func TestWrapWords(t *testing.T) {
	cases := []struct {
		in    string
		width int
		want  string
	}{
		{"", 10, "\n"},
		{"one two three", 7, "one two\nthree\n"},
		{"one two three", 13, "one two three\n"},
		{"averyveryverylongword x", 5, "averyveryverylongword\nx\n"},
	}
	for _, c := range cases {
		if got := wrapWords(c.in, c.width); got != c.want {
			t.Errorf("wrapWords(%q, %d) = %q, want %q", c.in, c.width, got, c.want)
		}
	}
}
