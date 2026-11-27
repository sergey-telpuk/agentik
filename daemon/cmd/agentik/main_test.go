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

func TestRunDaemonLifecycleWithFakeRelay(t *testing.T) {
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
	defer srv.Close()

	dataDir := filepath.Join(t.TempDir(), "data")
	projDir := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}

	inR, inW := io.Pipe()
	out := &syncBuffer{}
	errOut := &syncBuffer{}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- run(
			ctx,
			[]string{
				"--data-dir", dataDir,
				"--agent-search-path", t.TempDir(),
				"--relay", "ws" + strings.TrimPrefix(srv.URL, "http"),
				"--relay-id", "test-relay",
				"--project", projDir,
				"--pair",
				"--codex-bin", "nonexistent-codex-xyz",
			},
			inR,
			out,
			errOut,
		)
	}()

	select {
	case <-registered:
	case <-ctx.Done():
		t.Fatalf("timed out waiting for relay registration; out:\n%s", out.String())
	}

	// Send commands to stdin and quit cleanly.
	_, _ = io.WriteString(inW, "clients\nquit\n")
	_ = inW.Close()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon run returned error: %v\nout:\n%s\nerr:\n%s", err, out.String(), errOut.String())
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for daemon exit")
	}

	output := out.String()
	if !strings.Contains(output, pairing.InvitationPrefix) {
		t.Fatalf("expected pairing invitation prefix in output:\n%s", output)
	}
	if !strings.Contains(output, "No paired clients.") {
		t.Fatalf("expected clients output in stdout:\n%s", output)
	}
}
