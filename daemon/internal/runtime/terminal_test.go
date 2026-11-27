package runtime_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents/codex"
	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
	"github.com/sergey-telpuk/agentik/daemon/internal/secure"
	"github.com/sergey-telpuk/agentik/daemon/internal/terminal"
	"github.com/sergey-telpuk/agentik/daemon/internal/transport"
)

// quietTerminal runs zsh without the user's startup files and with a fixed prompt.
func quietTerminal(t *testing.T, idle time.Duration) func(*runtime.Config) {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("PROMPT='$ '\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return func(cfg *runtime.Config) {
		cfg.Terminal = terminal.Config{
			Shell:       "/bin/zsh",
			Env:         []string{"HOME=" + home, "ZDOTDIR=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin"},
			IdleTimeout: idle,
			Logf:        t.Logf,
		}
	}
}

func terminalHarness(t *testing.T, idle time.Duration) (*wireHarness, *phoneClient, *ecdh.PrivateKey) {
	t.Helper()
	adapter := &fakeAdapter{status: codex.AgentStatus{Name: codex.AgentName, Available: true, Authenticated: true}}
	h := newHarness(t, adapter, quietTerminal(t, idle))
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return h, pairPhone(t, h, key), key
}

func mustOK[T any](t *testing.T, resp runtime.OutboundResponse) T {
	t.Helper()
	if !resp.OK {
		t.Fatalf("request %s failed: %+v", resp.RequestID, resp.Error)
	}
	return decodeInto[T](t, resp.Result)
}

func wantError(t *testing.T, resp runtime.OutboundResponse, code string) {
	t.Helper()
	if resp.OK || resp.Error == nil || resp.Error.Code != code {
		t.Fatalf("expected error %q, got ok=%v error=%+v", code, resp.OK, resp.Error)
	}
}

// termClient drives one terminal session over the wire.
type termClient struct {
	t       *testing.T
	h       *wireHarness
	pc      *phoneClient
	id      string
	seq     int64
	n       int
	out     strings.Builder
	maxSize int
	last    runtime.TerminalReadResult
}

func openTerminal(t *testing.T, h *wireHarness, pc *phoneClient, project string) *termClient {
	t.Helper()
	tc := &termClient{t: t, h: h, pc: pc}
	opened := mustOK[runtime.TerminalOpenResult](t, tc.call("terminal.open", map[string]any{"project_id": project, "cols": 80, "rows": 24}))
	if opened.SessionID == "" || opened.ProjectID != project {
		t.Fatalf("terminal.open result = %+v", opened)
	}
	tc.id = opened.SessionID
	return tc
}

func (tc *termClient) call(method string, params any) runtime.OutboundResponse {
	tc.t.Helper()
	tc.n++
	resp, _ := tc.h.call(tc.pc, "term-"+strconv.Itoa(tc.n)+"-"+method, method, params)
	if b, err := json.Marshal(resp); err == nil && len(b) > tc.maxSize {
		tc.maxSize = len(b)
	}
	return resp
}

func (tc *termClient) input(text string) {
	tc.t.Helper()
	res := mustOK[runtime.TerminalInputResult](tc.t, tc.call("terminal.input", map[string]any{
		"session_id": tc.id,
		"data":       base64.StdEncoding.EncodeToString([]byte(text)),
	}))
	if res.Bytes != len(text) {
		tc.t.Fatalf("input accepted %d of %d bytes", res.Bytes, len(text))
	}
}

func (tc *termClient) read(waitMS int) runtime.TerminalReadResult {
	tc.t.Helper()
	res := mustOK[runtime.TerminalReadResult](tc.t, tc.call("terminal.read", map[string]any{
		"session_id": tc.id, "after_seq": tc.seq, "wait_ms": waitMS,
	}))
	for _, c := range res.Chunks {
		if c.Seq != tc.seq+1 {
			tc.t.Fatalf("chunk %d after cursor %d", c.Seq, tc.seq)
		}
		data, err := base64.StdEncoding.DecodeString(c.Data)
		if err != nil {
			tc.t.Fatal(err)
		}
		tc.out.Write(data)
		tc.seq = c.Seq
	}
	if res.NextSeq != tc.seq {
		tc.t.Fatalf("next_seq %d, cursor %d", res.NextSeq, tc.seq)
	}
	tc.last = res
	return res
}

func (tc *termClient) until(pattern string) []string {
	tc.t.Helper()
	re := regexp.MustCompile(pattern)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if m := re.FindStringSubmatch(tc.out.String()); m != nil {
			return m
		}
		if tc.read(300).Closed {
			break
		}
	}
	if m := re.FindStringSubmatch(tc.out.String()); m != nil {
		return m
	}
	tc.t.Fatalf("output never matched %q; got %q", pattern, tc.out.String())
	return nil
}

func (tc *termClient) shellPID() int {
	tc.t.Helper()
	tc.input("echo PID:$$\r")
	pid, _ := strconv.Atoi(tc.until(`PID:(\d+)`)[1])
	return pid
}

func waitProcessGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d is still running", pid)
}

func TestTerminalOpenInputResizeReadClose(t *testing.T) {
	h, pc, _ := terminalHarness(t, 0)
	tc := openTerminal(t, h, pc, "proj-a")
	want, err := filepath.EvalSymlinks(h.projDirA)
	if err != nil {
		t.Fatal(err)
	}

	tc.input(`printf 'CWD:%s\n' "$(pwd -P)"` + "\r")
	if got := tc.until(`CWD:(\S+)\r?\n`)[1]; got != want {
		t.Fatalf("cwd = %q, want %q", got, want)
	}

	tc.input("echo hi\r")
	tc.until(`(?m)^hi\r?$`)

	resized := mustOK[runtime.TerminalResizeResult](t, tc.call("terminal.resize", map[string]any{"session_id": tc.id, "cols": 100, "rows": 40}))
	if resized.Cols != 100 || resized.Rows != 40 {
		t.Fatalf("resize result = %+v", resized)
	}
	tc.input("stty size\r")
	tc.until(`(?m)^40 100\r?$`)

	pid := tc.shellPID()
	closed := mustOK[runtime.TerminalCloseResult](t, tc.call("terminal.close", map[string]any{"session_id": tc.id}))
	if !closed.Closed || closed.Reason != terminal.ReasonClosed {
		t.Fatalf("close result = %+v", closed)
	}
	waitProcessGone(t, pid)

	for !tc.last.Closed {
		tc.read(300)
	}
	if tc.last.Reason != terminal.ReasonClosed {
		t.Fatalf("read after close = %+v", tc.last)
	}
	wantError(t, tc.call("terminal.input", map[string]any{"session_id": tc.id, "data": "eA=="}), "terminal_closed")
}

func TestTerminalOptionalCommand(t *testing.T) {
	h, pc, _ := terminalHarness(t, 0)
	tc := &termClient{t: t, h: h, pc: pc}
	opened := mustOK[runtime.TerminalOpenResult](t, tc.call("terminal.open", map[string]any{
		"project_id": "proj-b", "command": "echo CMD$((20+22))",
	}))
	tc.id = opened.SessionID
	tc.until(`CMD42`)
}

func TestTerminalRequiresPairedPhone(t *testing.T) {
	h, _, _ := terminalHarness(t, 0)
	// An unknown phone can finish the handshake only while an invitation is
	// active; it still must not get a shell.
	if _, err := h.pairing.CreateInvitation(context.Background(), "wss://relay.example.com", 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	stranger, err := h.connectPhone(nil)
	if err != nil {
		t.Fatal(err)
	}
	tc := &termClient{t: t, h: h, pc: stranger, id: "term_000000000000000000000000"}
	wantError(t, tc.call("terminal.open", map[string]any{"project_id": "proj-a"}), "unauthorized")
	wantError(t, tc.call("terminal.input", map[string]any{"session_id": tc.id, "data": "eA=="}), "unauthorized")
	wantError(t, tc.call("terminal.read", map[string]any{"session_id": tc.id, "after_seq": 0}), "unauthorized")
	wantError(t, tc.call("terminal.resize", map[string]any{"session_id": tc.id, "cols": 80, "rows": 24}), "unauthorized")
	wantError(t, tc.call("terminal.close", map[string]any{"session_id": tc.id}), "unauthorized")
}

func TestTerminalOnlyOpensInPermittedProjects(t *testing.T) {
	h, pc, _ := terminalHarness(t, 0)
	tc := &termClient{t: t, h: h, pc: pc}
	for _, id := range []string{"nope", "../proj-a", "/", h.projDirA} {
		wantError(t, tc.call("terminal.open", map[string]any{"project_id": id}), "not_found")
	}
	wantError(t, tc.call("terminal.open", map[string]any{}), "bad_request")
	for _, extra := range []string{"cwd", "dir", "path", "shell", "env"} {
		wantError(t, tc.call("terminal.open", map[string]any{"project_id": "proj-a", extra: "/"}), "bad_request")
	}
	wantError(t, tc.call("terminal.open", map[string]any{"project_id": "proj-a", "command": "cd /\nrm -rf x"}), "bad_request")
	wantError(t, tc.call("terminal.open", map[string]any{"project_id": "proj-a", "cols": 100000}), "bad_request")
}

func TestTerminalInputAndReadLimits(t *testing.T) {
	h, pc, _ := terminalHarness(t, 0)
	tc := openTerminal(t, h, pc, "proj-a")
	big := base64.StdEncoding.EncodeToString(make([]byte, terminal.MaxInputBytes+1))
	wantError(t, tc.call("terminal.input", map[string]any{"session_id": tc.id, "data": big}), "bad_request")
	wantError(t, tc.call("terminal.input", map[string]any{"session_id": tc.id, "data": "%%%"}), "bad_request")
	wantError(t, tc.call("terminal.input", map[string]any{"session_id": tc.id, "data": ""}), "bad_request")
	wantError(t, tc.call("terminal.read", map[string]any{"session_id": tc.id, "after_seq": 0, "wait_ms": 60000}), "bad_request")
	wantError(t, tc.call("terminal.read", map[string]any{"session_id": tc.id, "after_seq": -1}), "bad_request")
	wantError(t, tc.call("terminal.read", map[string]any{"session_id": "term_unknown", "after_seq": 0}), "not_found")
}

func TestTerminalSessionBelongsToItsChannel(t *testing.T) {
	h, pc, key := terminalHarness(t, 0)
	tc := openTerminal(t, h, pc, "proj-a")
	second, err := h.connectPhone(key)
	if err != nil {
		t.Fatal(err)
	}
	other := &termClient{t: t, h: h, pc: second, id: tc.id}
	wantError(t, other.call("terminal.read", map[string]any{"session_id": tc.id, "after_seq": 0}), "not_found")
	wantError(t, other.call("terminal.input", map[string]any{"session_id": tc.id, "data": "eA=="}), "not_found")
	wantError(t, other.call("terminal.close", map[string]any{"session_id": tc.id}), "not_found")
}

func TestTerminalDisconnectEndsSessions(t *testing.T) {
	h, pc, _ := terminalHarness(t, 0)
	pids := []int{openTerminal(t, h, pc, "proj-a").shellPID(), openTerminal(t, h, pc, "proj-b").shellPID()}

	h.hub.Manager().HandlePeerState(context.Background(), pc.connID, false)
	for _, pid := range pids {
		waitProcessGone(t, pid)
	}
}

func TestTerminalRevokeEndsSessions(t *testing.T) {
	h, pc, key := terminalHarness(t, 0)
	pid := openTerminal(t, h, pc, "proj-a").shellPID()

	if err := h.hub.RevokePeer(context.Background(), key.PublicKey().Bytes()); err != nil {
		t.Fatal(err)
	}
	// Revocation waits for the processes, so the shell is already gone.
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("shell %d survived revocation: %v", pid, err)
	}
}

func TestTerminalShutdownEndsSessions(t *testing.T) {
	h, pc, _ := terminalHarness(t, 0)
	pid := openTerminal(t, h, pc, "proj-a").shellPID()
	h.hub.Close()
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("shell %d survived shutdown: %v", pid, err)
	}
}

func TestTerminalIdleTimeoutClosesSession(t *testing.T) {
	h, pc, _ := terminalHarness(t, 400*time.Millisecond)
	tc := openTerminal(t, h, pc, "proj-a")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !tc.last.Closed {
		tc.read(300)
	}
	if !tc.last.Closed || tc.last.Reason != terminal.ReasonIdle {
		t.Fatalf("last read = %+v", tc.last)
	}
}

func TestTerminalReadResponsesFitOneFrame(t *testing.T) {
	h, pc, _ := terminalHarness(t, 0)
	tc := openTerminal(t, h, pc, "proj-a")
	tc.until(`\$ `)
	before := tc.out.Len()

	const total = 512 * 1024
	// The command line has no "x" and no "END7", so its echo is not counted.
	tc.input("head -c " + strconv.Itoa(total) + " /dev/zero | tr '\\0' '\\170'; echo; echo END$((3+4))\r")
	tc.until(`END7`)

	if got := strings.Count(tc.out.String()[before:], "x"); got != total {
		t.Fatalf("received %d of %d bytes", got, total)
	}
	// The response sent on the wire is the encrypted form of this JSON; the
	// harness re-encodes it, so allow for field order but not for size.
	if tc.maxSize > secure.MaxRelayPlaintextSize || tc.maxSize+16 > transport.MaxFrameBytes {
		t.Fatalf("largest response is %d bytes, frame budget is %d", tc.maxSize, secure.MaxRelayPlaintextSize)
	}
	if tc.maxSize < terminal.MaxReadBytes {
		t.Fatalf("largest response is only %d bytes; reads were not batched", tc.maxSize)
	}
}
