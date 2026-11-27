// Package terminal runs interactive login shells on pseudo-terminals for a
// paired phone (AGENTIK.md section 8.1).
//
// A session is one login shell in its own session and process group, started
// in a permitted project directory. Output is kept in a bounded buffer of
// numbered chunks that the phone reads and acknowledges with a sequence
// cursor; when the phone does not keep up the buffer fills, the reader stops
// draining the PTY, and the kernel blocks the shell. Input goes through a
// bounded queue so a shell that does not read cannot stall the caller.
//
// Only lifecycle facts are logged (session id, project id, pid, reason).
// Typed input and output never reach a log.
package terminal

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

const (
	// IdleTimeout closes a session after this long without input or output.
	IdleTimeout = 30 * time.Minute

	// MaxChunkBytes bounds one output chunk.
	MaxChunkBytes = 4 * 1024
	// MaxReadBytes bounds the raw output returned by one Read. Base64 and
	// the response envelope must still fit one 32 KiB relay frame.
	MaxReadBytes = 16 * 1024
	// MaxReadChunks bounds the number of chunks returned by one Read.
	MaxReadChunks = 64
	// MaxBufferedBytes bounds unacknowledged output held per session.
	MaxBufferedBytes = 256 * 1024
	// MaxReadWait bounds how long one Read may wait for new output.
	MaxReadWait = 25 * time.Second

	// MaxInputBytes bounds one Input call.
	MaxInputBytes = 4 * 1024
	// MaxCommandBytes bounds the optional command typed after the shell starts.
	MaxCommandBytes = 1024

	// MaxSessionsPerOwner and MaxSessions bound running sessions.
	MaxSessionsPerOwner = 4
	MaxSessions         = 16

	DefaultCols = 80
	DefaultRows = 24
	MaxCols     = 500
	MaxRows     = 300

	inputQueueDepth = 64
	// killGrace is how long a hung-up shell may take to exit before SIGKILL.
	killGrace = time.Second
	// drainGrace lets the reader collect the last output after the shell exits.
	drainGrace = 250 * time.Millisecond
	// endedRetention keeps a finished session readable so the phone can
	// collect the tail of its output and the reason it ended.
	endedRetention = 2 * time.Minute
)

// Reasons a session ends.
const (
	ReasonExited       = "exited"
	ReasonClosed       = "closed"
	ReasonIdle         = "idle"
	ReasonDisconnected = "disconnected"
	ReasonRevoked      = "revoked"
	ReasonShutdown     = "shutdown"
)

var (
	ErrNotFound     = errors.New("terminal: no such session")
	ErrClosed       = errors.New("terminal: session has ended")
	ErrInvalid      = errors.New("terminal: invalid request")
	ErrInputBusy    = errors.New("terminal: input queue is full")
	ErrTooMany      = errors.New("terminal: too many terminal sessions")
	ErrShuttingDown = errors.New("terminal: shutting down")
)

// Owner binds a session to the secure channel that opened it.
type Owner struct {
	ConnectionID string
	PeerKey      []byte
}

func (o Owner) matches(other Owner) bool {
	return o.ConnectionID == other.ConnectionID &&
		subtle.ConstantTimeCompare(o.PeerKey, other.PeerKey) == 1
}

// Config configures a Manager.
type Config struct {
	// Shell is the login shell; empty means $SHELL, falling back to /bin/zsh.
	Shell string
	// Env is the shell environment; nil means the daemon's own environment.
	Env []string
	// IdleTimeout overrides IdleTimeout when positive.
	IdleTimeout time.Duration
	// Logf receives lifecycle lines; nil discards them.
	Logf func(format string, args ...any)
}

// OpenRequest starts one session. Dir must already be a permitted,
// symlink-resolved project root; this package does not choose directories.
type OpenRequest struct {
	Owner     Owner
	ProjectID string
	Dir       string
	// Command, when set, is typed into the shell once it starts.
	Command string
	Cols    int
	Rows    int
}

// Info describes a started session.
type Info struct {
	ID        string
	ProjectID string
	PID       int
}

// Chunk is one numbered piece of output.
type Chunk struct {
	Seq  int64
	Data []byte
}

// ReadResult is the output after a cursor.
type ReadResult struct {
	Chunks []Chunk
	// NextSeq is the cursor to pass to the next Read.
	NextSeq int64
	// Closed is set once the session has ended and every chunk was returned.
	Closed   bool
	Reason   string
	ExitCode *int
	// Truncated is set when the cursor pointed at output already dropped.
	Truncated bool
}

// Manager owns every terminal session of the daemon.
type Manager struct {
	shell string
	env   []string
	idle  time.Duration
	logf  func(format string, args ...any)

	// live counts sessions whose processes may still be running.
	live sync.WaitGroup

	mu       sync.Mutex
	sessions map[string]*session
	shutdown bool
}

// NewManager creates a Manager.
func NewManager(cfg Config) *Manager {
	shell := cfg.Shell
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" || !filepath.IsAbs(shell) {
		shell = "/bin/zsh"
	}
	env := cfg.Env
	if env == nil {
		env = os.Environ()
	}
	idle := cfg.IdleTimeout
	if idle <= 0 {
		idle = IdleTimeout
	}
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Manager{
		shell:    shell,
		env:      append([]string(nil), env...),
		idle:     idle,
		logf:     logf,
		sessions: make(map[string]*session),
	}
}

// ValidateCommand checks the optional command typed after the shell starts:
// one line of printable text.
func ValidateCommand(command string) error {
	if len(command) > MaxCommandBytes {
		return fmt.Errorf("%w: command is longer than %d bytes", ErrInvalid, MaxCommandBytes)
	}
	for _, r := range command {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%w: command must be a single line without control characters", ErrInvalid)
		}
	}
	return nil
}

func clampSize(cols, rows int) (uint16, uint16, error) {
	if cols == 0 {
		cols = DefaultCols
	}
	if rows == 0 {
		rows = DefaultRows
	}
	if cols < 1 || rows < 1 || cols > MaxCols || rows > MaxRows {
		return 0, 0, fmt.Errorf("%w: terminal size must be 1..%d columns and 1..%d rows", ErrInvalid, MaxCols, MaxRows)
	}
	return uint16(cols), uint16(rows), nil
}

// Open starts a login shell for req.Owner in req.Dir.
func (m *Manager) Open(req OpenRequest) (Info, error) {
	if req.Owner.ConnectionID == "" || len(req.Owner.PeerKey) == 0 {
		return Info{}, fmt.Errorf("%w: missing owner", ErrInvalid)
	}
	if !filepath.IsAbs(req.Dir) {
		return Info{}, fmt.Errorf("%w: directory must be absolute", ErrInvalid)
	}
	if err := ValidateCommand(req.Command); err != nil {
		return Info{}, err
	}
	cols, rows, err := clampSize(req.Cols, req.Rows)
	if err != nil {
		return Info{}, err
	}

	m.mu.Lock()
	if m.shutdown {
		m.mu.Unlock()
		return Info{}, ErrShuttingDown
	}
	running, mine := 0, 0
	for _, s := range m.sessions {
		if s.isEnded() {
			continue
		}
		running++
		if s.owner.matches(req.Owner) {
			mine++
		}
	}
	if running >= MaxSessions || mine >= MaxSessionsPerOwner {
		m.mu.Unlock()
		return Info{}, ErrTooMany
	}
	id, err := newSessionID()
	if err != nil {
		m.mu.Unlock()
		return Info{}, err
	}
	s, err := m.start(id, req, cols, rows)
	if err != nil {
		m.mu.Unlock()
		return Info{}, err
	}
	m.sessions[id] = s
	m.mu.Unlock()

	m.logf("terminal: open session=%s project=%s pid=%d", id, req.ProjectID, s.pid)
	if req.Command != "" {
		s.input <- []byte(req.Command + "\r")
	}
	return Info{ID: id, ProjectID: req.ProjectID, PID: s.pid}, nil
}

func (m *Manager) start(id string, req OpenRequest, cols, rows uint16) (*session, error) {
	master, tty, err := pty.Open()
	if err != nil {
		return nil, fmt.Errorf("terminal: open pty: %w", err)
	}
	ptmx, err := pollable(master)
	if err != nil {
		_ = tty.Close()
		return nil, err
	}
	if err := pty.Setsize(tty, &pty.Winsize{Cols: cols, Rows: rows}); err != nil {
		_ = tty.Close()
		_ = ptmx.Close()
		return nil, fmt.Errorf("terminal: set size: %w", err)
	}

	// A leading dash in argv[0] makes the shell a login shell.
	cmd := &exec.Cmd{
		Path:   m.shell,
		Args:   []string{"-" + filepath.Base(m.shell)},
		Dir:    req.Dir,
		Env:    shellEnv(m.env, req.Dir),
		Stdin:  tty,
		Stdout: tty,
		Stderr: tty,
		// A new session makes the shell a process group leader with the PTY
		// as its controlling terminal.
		SysProcAttr: &syscall.SysProcAttr{Setsid: true, Setctty: true},
	}
	if err := cmd.Start(); err != nil {
		_ = tty.Close()
		_ = ptmx.Close()
		return nil, fmt.Errorf("terminal: start shell: %w", err)
	}
	_ = tty.Close()

	s := &session{
		id:        id,
		projectID: req.ProjectID,
		owner:     Owner{ConnectionID: req.Owner.ConnectionID, PeerKey: append([]byte(nil), req.Owner.PeerKey...)},
		m:         m,
		cmd:       cmd,
		ptmx:      ptmx,
		pid:       cmd.Process.Pid,
		input:     make(chan []byte, inputQueueDepth),
		stop:      make(chan struct{}),
		exited:    make(chan struct{}),
		readDone:  make(chan struct{}),
		writeDone: make(chan struct{}),
		done:      make(chan struct{}),
		notify:    make(chan struct{}),
		lastSeen:  time.Now(),
	}
	s.cond = sync.NewCond(&s.mu)
	m.live.Add(1)
	s.idleTimer = time.AfterFunc(m.idle, s.checkIdle)
	go s.readLoop()
	go s.writeLoop()
	go s.waitLoop()
	return s, nil
}

// pollable returns the PTY master as a non-blocking file registered with the
// runtime poller, so that Close interrupts a pending Read or Write. A blocking
// descriptor would keep a reader stuck for as long as any process still holds
// the terminal open, and the PTY would never be freed.
func pollable(master *os.File) (*os.File, error) {
	raw, err := master.SyscallConn()
	if err != nil {
		_ = master.Close()
		return nil, fmt.Errorf("terminal: pty descriptor: %w", err)
	}
	dup := -1
	var dupErr error
	if err := raw.Control(func(fd uintptr) {
		dup, dupErr = unix.Dup(int(fd))
	}); err != nil {
		dupErr = err
	}
	_ = master.Close()
	if dupErr != nil {
		return nil, fmt.Errorf("terminal: duplicate pty descriptor: %w", dupErr)
	}
	unix.CloseOnExec(dup)
	if err := unix.SetNonblock(dup, true); err != nil {
		_ = unix.Close(dup)
		return nil, fmt.Errorf("terminal: non-blocking pty: %w", err)
	}
	return os.NewFile(uintptr(dup), "/dev/ptmx"), nil
}

// shellEnv is the daemon's environment with the terminal type xterm.js
// emulates and the working directory the shell starts in.
func shellEnv(base []string, dir string) []string {
	out := make([]string, 0, len(base)+3)
	for _, kv := range base {
		if strings.HasPrefix(kv, "TERM=") || strings.HasPrefix(kv, "COLORTERM=") || strings.HasPrefix(kv, "PWD=") {
			continue
		}
		out = append(out, kv)
	}
	return append(out, "TERM=xterm-256color", "COLORTERM=truecolor", "PWD="+dir)
}

func newSessionID() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "term_" + hex.EncodeToString(b), nil
}

func (m *Manager) lookup(owner Owner, id string) (*session, error) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok || !s.owner.matches(owner) {
		return nil, ErrNotFound
	}
	return s, nil
}

// Input queues bytes typed on the phone.
func (m *Manager) Input(owner Owner, id string, data []byte) error {
	if len(data) == 0 || len(data) > MaxInputBytes {
		return fmt.Errorf("%w: input must be 1..%d bytes", ErrInvalid, MaxInputBytes)
	}
	s, err := m.lookup(owner, id)
	if err != nil {
		return err
	}
	if s.isStopping() {
		return ErrClosed
	}
	select {
	case s.input <- append([]byte(nil), data...):
		s.touch()
		return nil
	default:
		return ErrInputBusy
	}
}

// Resize changes the terminal size.
func (m *Manager) Resize(owner Owner, id string, cols, rows int) error {
	if cols == 0 || rows == 0 {
		return fmt.Errorf("%w: cols and rows are required", ErrInvalid)
	}
	c, r, err := clampSize(cols, rows)
	if err != nil {
		return err
	}
	s, err := m.lookup(owner, id)
	if err != nil {
		return err
	}
	if s.isStopping() {
		return ErrClosed
	}
	return s.setSize(c, r)
}

// Read acknowledges every chunk up to afterSeq and returns the chunks after
// it. With nothing to return it waits up to wait for output or the end of the
// session; a newer Read on the same session ends an older waiting one.
func (m *Manager) Read(done <-chan struct{}, owner Owner, id string, afterSeq int64, wait time.Duration) (ReadResult, error) {
	if afterSeq < 0 {
		return ReadResult{}, fmt.Errorf("%w: after_seq must not be negative", ErrInvalid)
	}
	if wait > MaxReadWait {
		wait = MaxReadWait
	}
	s, err := m.lookup(owner, id)
	if err != nil {
		return ReadResult{}, err
	}
	return s.read(done, afterSeq, wait)
}

// Close ends one session and waits until its processes are gone.
func (m *Manager) Close(owner Owner, id string) (ReadResult, error) {
	s, err := m.lookup(owner, id)
	if err != nil {
		return ReadResult{}, err
	}
	s.terminate(ReasonClosed)
	<-s.done
	s.mu.Lock()
	defer s.mu.Unlock()
	return ReadResult{NextSeq: s.lastSeq, Closed: true, Reason: s.reason, ExitCode: s.exitCode}, nil
}

// CloseConnection ends every session opened over connectionID. The sessions
// become unreachable at once; it does not wait for their processes to exit.
func (m *Manager) CloseConnection(connectionID, reason string) int {
	return len(m.closeMatching(func(s *session) bool { return s.owner.ConnectionID == connectionID }, reason))
}

// ClosePeer ends every session opened by the phone with peerKey and waits
// until their processes are gone.
func (m *Manager) ClosePeer(peerKey []byte, reason string) int {
	targets := m.closeMatching(func(s *session) bool {
		return subtle.ConstantTimeCompare(s.owner.PeerKey, peerKey) == 1
	}, reason)
	for _, s := range targets {
		<-s.done
	}
	return len(targets)
}

// CloseAll ends every session, refuses new ones, and waits until every
// session process is gone, including sessions closed earlier without waiting.
// Count reports how many sessions are open, for the status display.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

func (m *Manager) CloseAll(reason string) {
	m.mu.Lock()
	m.shutdown = true
	m.mu.Unlock()
	m.closeMatching(func(*session) bool { return true }, reason)
	m.live.Wait()
}

// closeMatching removes matching sessions, so they can no longer be reached,
// and starts their termination.
func (m *Manager) closeMatching(match func(*session) bool, reason string) []*session {
	m.mu.Lock()
	var targets []*session
	for id, s := range m.sessions {
		if match(s) {
			targets = append(targets, s)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, s := range targets {
		s.terminate(reason)
	}
	return targets
}

// Running reports how many sessions have not ended yet.
func (m *Manager) Running() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, s := range m.sessions {
		if !s.isEnded() {
			n++
		}
	}
	return n
}

func (m *Manager) forget(s *session) {
	m.mu.Lock()
	if m.sessions[s.id] == s {
		delete(m.sessions, s.id)
	}
	m.mu.Unlock()
}
