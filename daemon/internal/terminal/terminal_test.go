package terminal

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// quietEnv is a shell environment without user startup files and with a fixed prompt.
func quietEnv(t *testing.T) []string {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("PROMPT='$ '\nunsetopt BEEP\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return []string{
		"HOME=" + home,
		"ZDOTDIR=" + home,
		"PATH=/usr/bin:/bin:/usr/sbin:/sbin",
		"LANG=en_US.UTF-8",
	}
}

func newTestManager(t *testing.T, idle time.Duration) *Manager {
	t.Helper()
	m := NewManager(Config{Shell: "/bin/zsh", Env: quietEnv(t), IdleTimeout: idle, Logf: t.Logf})
	t.Cleanup(func() { m.CloseAll(ReasonShutdown) })
	return m
}

var testOwner = Owner{ConnectionID: "conn-1", PeerKey: []byte("phone-key-1")}

func realDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func openShell(t *testing.T, m *Manager, owner Owner, dir string) Info {
	t.Helper()
	info, err := m.Open(OpenRequest{Owner: owner, ProjectID: "proj", Dir: dir})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return info
}

// reader accumulates a session's output and keeps the read cursor.
type reader struct {
	t     *testing.T
	m     *Manager
	owner Owner
	id    string
	seq   int64
	out   strings.Builder
	last  ReadResult
}

func newReader(t *testing.T, m *Manager, owner Owner, id string) *reader {
	return &reader{t: t, m: m, owner: owner, id: id}
}

func (r *reader) step(wait time.Duration) ReadResult {
	r.t.Helper()
	res, err := r.m.Read(nil, r.owner, r.id, r.seq, wait)
	if err != nil {
		r.t.Fatalf("read: %v", err)
	}
	for i, c := range res.Chunks {
		if c.Seq <= r.seq || (i > 0 && c.Seq != res.Chunks[i-1].Seq+1) {
			r.t.Fatalf("chunks out of order: cursor %d, chunk %d", r.seq, c.Seq)
		}
		r.out.Write(c.Data)
	}
	r.seq = res.NextSeq
	r.last = res
	return res
}

func (r *reader) until(pattern string, timeout time.Duration) []string {
	r.t.Helper()
	re := regexp.MustCompile(pattern)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if m := re.FindStringSubmatch(r.out.String()); m != nil {
			return m
		}
		if r.step(200 * time.Millisecond).Closed {
			break
		}
	}
	if m := re.FindStringSubmatch(r.out.String()); m != nil {
		return m
	}
	r.t.Fatalf("output never matched %q; got %q", pattern, r.out.String())
	return nil
}

func (r *reader) untilClosed(timeout time.Duration) ReadResult {
	r.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if res := r.step(200 * time.Millisecond); res.Closed {
			return res
		}
	}
	r.t.Fatalf("session did not close; output %q", r.out.String())
	return ReadResult{}
}

func typeLine(t *testing.T, m *Manager, owner Owner, id, line string) {
	t.Helper()
	if err := m.Input(owner, id, []byte(line+"\r")); err != nil {
		t.Fatalf("input: %v", err)
	}
}

func waitGone(t *testing.T, pid int) {
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

func TestOpenStartsLoginShellInProjectDir(t *testing.T) {
	m := newTestManager(t, 0)
	dir := realDir(t)
	info := openShell(t, m, testOwner, dir)
	r := newReader(t, m, testOwner, info.ID)

	typeLine(t, m, testOwner, info.ID, `printf 'CWD:%s\n' "$(pwd -P)"; [[ -o login ]] && echo LOGIN:yes`)
	got := r.until(`CWD:(\S+)\r?\n`, 5*time.Second)
	if got[1] != dir {
		t.Fatalf("cwd = %q, want %q", got[1], dir)
	}
	r.until(`LOGIN:yes`, 5*time.Second)
}

func TestInputEchoesOutput(t *testing.T) {
	m := newTestManager(t, 0)
	info := openShell(t, m, testOwner, realDir(t))
	r := newReader(t, m, testOwner, info.ID)
	typeLine(t, m, testOwner, info.ID, "echo hi")
	r.until(`(?m)^hi\r?$`, 5*time.Second)
}

func TestOptionalCommandRunsAfterShellStarts(t *testing.T) {
	m := newTestManager(t, 0)
	info, err := m.Open(OpenRequest{Owner: testOwner, ProjectID: "proj", Dir: realDir(t), Command: "echo OPT$((40+2))"})
	if err != nil {
		t.Fatal(err)
	}
	newReader(t, m, testOwner, info.ID).until(`OPT42`, 5*time.Second)
}

func TestResizeChangesTerminalSize(t *testing.T) {
	m := newTestManager(t, 0)
	info := openShell(t, m, testOwner, realDir(t))
	r := newReader(t, m, testOwner, info.ID)
	if err := m.Resize(testOwner, info.ID, 100, 40); err != nil {
		t.Fatal(err)
	}
	typeLine(t, m, testOwner, info.ID, "stty size")
	r.until(`(?m)^40 100\r?$`, 5*time.Second)

	if err := m.Resize(testOwner, info.ID, MaxCols+1, 10); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized resize: %v", err)
	}
}

func TestCloseKillsProcessGroupAndFreesPTY(t *testing.T) {
	m := newTestManager(t, 0)
	info := openShell(t, m, testOwner, realDir(t))
	r := newReader(t, m, testOwner, info.ID)

	// A child started without job control stays in the shell's own process
	// group; a foreground job gets the terminal's foreground group.
	typeLine(t, m, testOwner, info.ID, `setopt nomonitor; sleep 300 & echo BG:$!; setopt monitor`)
	bg := r.until(`BG:(\d+)`, 5*time.Second)
	typeLine(t, m, testOwner, info.ID, `sh -c 'echo FG:$$; exec sleep 300'`)
	fg := r.until(`FG:(\d+)`, 5*time.Second)
	bgPID, _ := strconv.Atoi(bg[1])
	fgPID, _ := strconv.Atoi(fg[1])

	res, err := m.Close(testOwner, info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Closed || res.Reason != ReasonClosed {
		t.Fatalf("close result = %+v", res)
	}
	waitGone(t, info.PID)
	waitGone(t, fgPID)
	waitGone(t, bgPID)

	if m.Running() != 0 {
		t.Fatalf("running sessions = %d", m.Running())
	}
	// The PTY is closed: the descriptor is gone.
	m.mu.Lock()
	closed := m.sessions[info.ID]
	m.mu.Unlock()
	if _, err := closed.ptmx.Write([]byte("x")); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("pty still open: %v", err)
	}
	if err := m.Input(testOwner, info.ID, []byte("x")); !errors.Is(err, ErrClosed) {
		t.Fatalf("input after close: %v", err)
	}
	if final := r.untilClosed(2 * time.Second); final.Reason != ReasonClosed {
		t.Fatalf("read after close = %+v", final)
	}
}

func TestShellExitReportsExitCode(t *testing.T) {
	m := newTestManager(t, 0)
	info := openShell(t, m, testOwner, realDir(t))
	r := newReader(t, m, testOwner, info.ID)
	typeLine(t, m, testOwner, info.ID, "exit 3")
	res := r.untilClosed(5 * time.Second)
	if res.Reason != ReasonExited || res.ExitCode == nil || *res.ExitCode != 3 {
		t.Fatalf("closed result = %+v", res)
	}
	waitGone(t, info.PID)
}

func TestIdleTimeoutClosesSession(t *testing.T) {
	m := newTestManager(t, 300*time.Millisecond)
	info := openShell(t, m, testOwner, realDir(t))
	r := newReader(t, m, testOwner, info.ID)
	res := r.untilClosed(5 * time.Second)
	if res.Reason != ReasonIdle {
		t.Fatalf("reason = %q, want %q", res.Reason, ReasonIdle)
	}
	waitGone(t, info.PID)
}

func TestIdleTimerIsResetByActivity(t *testing.T) {
	m := newTestManager(t, 600*time.Millisecond)
	info := openShell(t, m, testOwner, realDir(t))
	r := newReader(t, m, testOwner, info.ID)
	for range 4 {
		time.Sleep(300 * time.Millisecond)
		typeLine(t, m, testOwner, info.ID, "true")
	}
	if r.step(0).Closed {
		t.Fatal("session closed while active")
	}
	if res := r.untilClosed(5 * time.Second); res.Reason != ReasonIdle {
		t.Fatalf("reason = %q", res.Reason)
	}
}

func TestOutputIsChunkedAndBounded(t *testing.T) {
	m := newTestManager(t, 0)
	info := openShell(t, m, testOwner, realDir(t))
	r := newReader(t, m, testOwner, info.ID)
	r.until(`\$ `, 5*time.Second)

	const total = 1 << 20
	// The command line has no "x" and no "DONE2", so its echo cannot be mistaken for output.
	typeLine(t, m, testOwner, info.ID, "head -c "+strconv.Itoa(total)+" /dev/zero | tr '\\0' '\\170'; echo; echo DONE$((1+1))")

	// Nobody reads: the buffer fills and the reader blocks instead of growing.
	m.mu.Lock()
	s := m.sessions[info.ID]
	m.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		full := s.buffered >= MaxBufferedBytes
		s.mu.Unlock()
		if full {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	s.mu.Lock()
	buffered := s.buffered
	s.mu.Unlock()
	if buffered < MaxBufferedBytes || buffered > MaxBufferedBytes+MaxChunkBytes {
		t.Fatalf("buffered %d bytes, want about %d", buffered, MaxBufferedBytes)
	}

	before := r.out.Len()
	for !strings.Contains(r.out.String(), "DONE2") {
		res := r.step(time.Second)
		size := 0
		for _, c := range res.Chunks {
			if len(c.Data) > MaxChunkBytes {
				t.Fatalf("chunk of %d bytes", len(c.Data))
			}
			size += len(c.Data)
		}
		if size > MaxReadBytes || len(res.Chunks) > MaxReadChunks {
			t.Fatalf("read returned %d bytes in %d chunks", size, len(res.Chunks))
		}
		if res.Closed {
			t.Fatal("session closed early")
		}
	}
	if got := strings.Count(r.out.String()[before:], "x"); got != total {
		t.Fatalf("received %d of %d bytes", got, total)
	}
}

func TestReadRetryReturnsSameChunksUntilAcknowledged(t *testing.T) {
	m := newTestManager(t, 0)
	info := openShell(t, m, testOwner, realDir(t))
	r := newReader(t, m, testOwner, info.ID)
	r.until(`\$ `, 5*time.Second)
	typeLine(t, m, testOwner, info.ID, "echo AGAIN")
	r.until(`AGAIN\r?\n`, 5*time.Second)

	r.step(0)
	if behind, err := m.Read(nil, testOwner, info.ID, 0, 0); err != nil || !behind.Truncated {
		t.Fatalf("cursor behind acknowledged output: %+v, %v", behind, err)
	}
	if _, err := m.Read(nil, testOwner, info.ID, r.seq+100, 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cursor ahead of output: %v", err)
	}

	typeLine(t, m, testOwner, info.ID, "echo ONCE")
	var a, b ReadResult
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		a, _ = m.Read(nil, testOwner, info.ID, r.seq, time.Second)
		if len(a.Chunks) > 0 {
			break
		}
	}
	b, _ = m.Read(nil, testOwner, info.ID, r.seq, 0)
	if len(a.Chunks) == 0 || len(b.Chunks) < len(a.Chunks) || a.Chunks[0].Seq != b.Chunks[0].Seq ||
		string(a.Chunks[0].Data) != string(b.Chunks[0].Data) {
		t.Fatalf("retry differs: %+v vs %+v", a, b)
	}
}

func TestNewerReadEndsWaitingRead(t *testing.T) {
	m := newTestManager(t, 0)
	info := openShell(t, m, testOwner, realDir(t))
	r := newReader(t, m, testOwner, info.ID)
	r.until(`\$ `, 5*time.Second)

	done := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		_, _ = m.Read(nil, testOwner, info.ID, r.seq, 10*time.Second)
		done <- time.Since(start)
	}()
	time.Sleep(100 * time.Millisecond)
	go func() { _, _ = m.Read(nil, testOwner, info.ID, r.seq, 200*time.Millisecond) }()
	select {
	case d := <-done:
		if d > 5*time.Second {
			t.Fatalf("waiting read took %v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("older waiting read was not ended")
	}
}

func TestSessionsAreBoundToTheirOwner(t *testing.T) {
	m := newTestManager(t, 0)
	info := openShell(t, m, testOwner, realDir(t))

	others := []Owner{
		{ConnectionID: "conn-2", PeerKey: testOwner.PeerKey},
		{ConnectionID: testOwner.ConnectionID, PeerKey: []byte("other-phone")},
	}
	for _, o := range others {
		if err := m.Input(o, info.ID, []byte("x")); !errors.Is(err, ErrNotFound) {
			t.Fatalf("input by %+v: %v", o, err)
		}
		if _, err := m.Read(nil, o, info.ID, 0, 0); !errors.Is(err, ErrNotFound) {
			t.Fatalf("read by %+v: %v", o, err)
		}
		if err := m.Resize(o, info.ID, 80, 24); !errors.Is(err, ErrNotFound) {
			t.Fatalf("resize by %+v: %v", o, err)
		}
		if _, err := m.Close(o, info.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("close by %+v: %v", o, err)
		}
	}
}

func TestCloseConnectionAndPeerEndSessions(t *testing.T) {
	m := newTestManager(t, 0)
	a := openShell(t, m, testOwner, realDir(t))
	other := Owner{ConnectionID: "conn-9", PeerKey: []byte("phone-key-9")}
	b := openShell(t, m, other, realDir(t))

	if n := m.CloseConnection(testOwner.ConnectionID, ReasonDisconnected); n != 1 {
		t.Fatalf("closed %d sessions", n)
	}
	waitGone(t, a.PID)
	if _, err := m.Read(nil, testOwner, a.ID, 0, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("closed session still reachable: %v", err)
	}

	if n := m.ClosePeer(other.PeerKey, ReasonRevoked); n != 1 {
		t.Fatalf("closed %d sessions", n)
	}
	waitGone(t, b.PID)
}

func TestCloseAllTerminatesEverySessionAndRefusesNew(t *testing.T) {
	m := newTestManager(t, 0)
	a := openShell(t, m, testOwner, realDir(t))
	b := openShell(t, m, Owner{ConnectionID: "conn-2", PeerKey: []byte("k2")}, realDir(t))
	// A session closed without waiting is still waited for on shutdown.
	m.CloseConnection("conn-2", ReasonDisconnected)

	m.CloseAll(ReasonShutdown)
	for _, pid := range []int{a.PID, b.PID} {
		if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
			t.Fatalf("process %d survived shutdown: %v", pid, err)
		}
	}
	if _, err := m.Open(OpenRequest{Owner: testOwner, ProjectID: "proj", Dir: realDir(t)}); !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("open after shutdown: %v", err)
	}
}

func TestLimits(t *testing.T) {
	m := newTestManager(t, 0)
	dir := realDir(t)
	info := openShell(t, m, testOwner, dir)

	if err := m.Input(testOwner, info.ID, make([]byte, MaxInputBytes+1)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized input: %v", err)
	}
	if err := m.Input(testOwner, info.ID, nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty input: %v", err)
	}
	for _, cmd := range []string{"codex\nrm -rf x", "a\rb", "\x1b[A", strings.Repeat("a", MaxCommandBytes+1)} {
		if _, err := m.Open(OpenRequest{Owner: testOwner, ProjectID: "proj", Dir: dir, Command: cmd}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("command %q: %v", cmd, err)
		}
	}
	if _, err := m.Open(OpenRequest{Owner: testOwner, ProjectID: "proj", Dir: "relative"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("relative dir: %v", err)
	}
	for range MaxSessionsPerOwner - 1 {
		openShell(t, m, testOwner, dir)
	}
	if _, err := m.Open(OpenRequest{Owner: testOwner, ProjectID: "proj", Dir: dir}); !errors.Is(err, ErrTooMany) {
		t.Fatalf("session over the limit: %v", err)
	}
}
