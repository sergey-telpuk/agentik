// Package discovery finds AI coding agent CLIs installed on this computer and
// reports their version and readiness.
//
// Discovery only runs the CLIs' own read-only `--version` and login-status
// commands, each under a short timeout, and never reads credential or key
// files. The output of a status command is reduced to a fixed readiness value
// and is not retained, because some CLIs print the account name there.
package discovery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultCommandTimeout bounds every subprocess run during discovery.
	DefaultCommandTimeout = 8 * time.Second

	maxCommandOutput = 64 * 1024
	maxVersionLen    = 120
)

// Auth is the sign-in state of an agent as far as discovery can tell.
type Auth string

const (
	// AuthReady means the agent's own status command reported a signed-in user.
	AuthReady Auth = "ready"
	// AuthNotAuthenticated means the agent's own status command reported that
	// nobody is signed in.
	AuthNotAuthenticated Auth = "not_authenticated"
	// AuthUnknown means the state could not be determined: the CLI has no
	// known non-interactive status command, the command failed, or it timed out.
	AuthUnknown Auth = "unknown"
)

// Agent is one detected agent CLI.
type Agent struct {
	ID          string
	DisplayName string
	// Path is the resolved binary location. It is for local diagnostics only
	// and is never sent to a phone.
	Path    string
	Version string
	Auth    Auth
	// AuthDetail is a fixed, credential-free sentence explaining Auth.
	AuthDetail string
}

// AuthProbe describes how to ask one CLI whether it is signed in.
type AuthProbe struct {
	// Args is the CLI's own non-interactive status command.
	Args []string
	// Interpret maps the exit error (nil on success) and the raw output to a
	// readiness value. It must not return any part of the output.
	Interpret func(runErr error, output string) (Auth, string)
}

// Candidate describes one agent CLI to look for.
type Candidate struct {
	ID          string
	DisplayName string
	// Binaries are executable names tried in order.
	Binaries []string
	// Probe is nil when the CLI has no known non-interactive status command;
	// its readiness is then reported as unknown.
	Probe *AuthProbe
}

// Config configures a Discoverer.
type Config struct {
	// PathEnv is the PATH to search. Empty uses the process PATH.
	PathEnv string
	// ExtraDirs are searched after PATH for CLIs installed in well-known
	// places that a service environment may not have on PATH.
	ExtraDirs []string
	// Overrides maps a candidate ID to an explicit binary path or command name
	// that replaces the candidate's default binary names.
	Overrides map[string]string
	// Timeout bounds each subprocess. Zero uses DefaultCommandTimeout.
	Timeout time.Duration
	// Candidates replaces the built-in list (used in tests).
	Candidates []Candidate
}

// Discoverer detects installed agent CLIs.
type Discoverer struct {
	pathEnv    string
	extraDirs  []string
	overrides  map[string]string
	timeout    time.Duration
	candidates []Candidate
}

// New returns a Discoverer. The zero Config searches the process PATH for the
// built-in candidates.
func New(cfg Config) *Discoverer {
	d := &Discoverer{
		pathEnv:    cfg.PathEnv,
		extraDirs:  append([]string(nil), cfg.ExtraDirs...),
		overrides:  cfg.Overrides,
		timeout:    cfg.Timeout,
		candidates: cfg.Candidates,
	}
	if d.pathEnv == "" {
		d.pathEnv = os.Getenv("PATH")
	}
	if d.timeout <= 0 {
		d.timeout = DefaultCommandTimeout
	}
	if d.candidates == nil {
		d.candidates = DefaultCandidates()
	}
	return d
}

// WellKnownDirs lists directories where agent CLIs are commonly installed,
// for a service whose PATH is shorter than the user's shell PATH.
func WellKnownDirs(home string) []string {
	dirs := []string{"/opt/homebrew/bin", "/usr/local/bin"}
	if home != "" {
		dirs = append(dirs,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".claude", "local"),
			filepath.Join(home, ".npm-global", "bin"),
			filepath.Join(home, ".bun", "bin"),
			filepath.Join(home, ".volta", "bin"),
		)
	}
	return dirs
}

// Discover looks for every candidate and returns the detected ones in the
// candidate order. Candidates whose binary cannot be found are omitted.
// Subprocesses of different agents run concurrently.
func (d *Discoverer) Discover(ctx context.Context) []Agent {
	results := make([]*Agent, len(d.candidates))
	var wg sync.WaitGroup
	for i, c := range d.candidates {
		path := d.locate(c)
		if path == "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			a := Agent{ID: c.ID, DisplayName: c.DisplayName, Path: path}
			a.Version = d.version(ctx, path)
			a.Auth, a.AuthDetail = d.auth(ctx, path, c.Probe)
			results[i] = &a
		}()
	}
	wg.Wait()

	out := make([]Agent, 0, len(results))
	for _, r := range results {
		if r != nil {
			out = append(out, *r)
		}
	}
	return out
}

// locate returns the executable path for a candidate, or "" when not found.
func (d *Discoverer) locate(c Candidate) string {
	names := c.Binaries
	if o := strings.TrimSpace(d.overrides[c.ID]); o != "" {
		names = []string{o}
	}
	for _, name := range names {
		if strings.ContainsRune(name, filepath.Separator) {
			if isExecutableFile(name) {
				return name
			}
			continue
		}
		dirs := append(filepath.SplitList(d.pathEnv), d.extraDirs...)
		for _, dir := range dirs {
			if dir == "" || !filepath.IsAbs(dir) {
				// A relative or empty PATH entry means "current directory":
				// never run a binary from there.
				continue
			}
			p := filepath.Join(dir, name)
			if isExecutableFile(p) {
				return p
			}
		}
	}
	return ""
}

func isExecutableFile(path string) bool {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	return fi.Mode().Perm()&0o111 != 0
}

func (d *Discoverer) version(ctx context.Context, path string) string {
	out, err := d.run(ctx, path, "--version")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			if len(line) > maxVersionLen {
				line = line[:maxVersionLen]
			}
			return strings.ToValidUTF8(line, "")
		}
	}
	return ""
}

func (d *Discoverer) auth(ctx context.Context, path string, probe *AuthProbe) (Auth, string) {
	if probe == nil || len(probe.Args) == 0 || probe.Interpret == nil {
		return AuthUnknown, "no known non-interactive status command"
	}
	out, err := d.run(ctx, path, probe.Args...)
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errTimeout) {
		return AuthUnknown, "status check timed out"
	}
	if ctx.Err() != nil {
		return AuthUnknown, "status check was cancelled"
	}
	return probe.Interpret(err, out)
}

var errTimeout = errors.New("discovery: command timed out")

// run executes path with args under the discovery timeout and returns its
// combined, size-bounded output. stdin is closed so a CLI cannot wait for input.
func (d *Discoverer) run(ctx context.Context, path string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, d.timeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, path, args...)
	// Without WaitDelay a child that inherited the pipes could keep Wait
	// blocked after the process was killed.
	cmd.WaitDelay = time.Second
	// Run from a neutral directory: some CLIs read settings from the working
	// directory, and the daemon's own may be anything.
	cmd.Dir = os.TempDir()
	var buf boundedBuffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	if cctx.Err() != nil && errors.Is(cctx.Err(), context.DeadlineExceeded) {
		return buf.String(), errTimeout
	}
	return buf.String(), err
}

type boundedBuffer struct{ b bytes.Buffer }

func (w *boundedBuffer) Write(p []byte) (int, error) {
	if remain := maxCommandOutput - w.b.Len(); remain > 0 {
		if len(p) > remain {
			w.b.Write(p[:remain])
		} else {
			w.b.Write(p)
		}
	}
	return len(p), nil
}

func (w *boundedBuffer) String() string { return w.b.String() }

// DefaultCandidates is the built-in list of agent CLIs to look for.
func DefaultCandidates() []Candidate {
	return []Candidate{
		{
			ID:          "codex",
			DisplayName: "Codex",
			Binaries:    []string{"codex"},
			Probe:       &AuthProbe{Args: []string{"login", "status"}, Interpret: interpretCodexLogin},
		},
		{
			ID:          "claude",
			DisplayName: "Claude Code",
			Binaries:    []string{"claude"},
			Probe:       &AuthProbe{Args: []string{"auth", "status"}, Interpret: interpretClaudeAuth},
		},
		{
			ID:          "cursor-agent",
			DisplayName: "Cursor Agent",
			Binaries:    []string{"cursor-agent"},
			Probe:       &AuthProbe{Args: []string{"status"}, Interpret: interpretCursorStatus},
		},
		{
			// Reported only when a gemini CLI exists. No status command has
			// been verified for it, so its readiness stays unknown.
			ID:          "gemini",
			DisplayName: "Gemini CLI",
			Binaries:    []string{"gemini"},
		},
	}
}

const (
	detailSignedIn  = "Signed in"
	detailSignedOut = "Not signed in"
	detailNoAnswer  = "Status command gave no recognizable answer"
)

func interpretCodexLogin(runErr error, output string) (Auth, string) {
	lower := strings.ToLower(output)
	if strings.Contains(lower, "not logged in") || strings.Contains(lower, "logged out") {
		return AuthNotAuthenticated, detailSignedOut
	}
	if runErr == nil && strings.Contains(lower, "logged in") {
		return AuthReady, detailSignedIn
	}
	return AuthUnknown, detailNoAnswer
}

// interpretClaudeAuth reads only the boolean `loggedIn` field of
// `claude auth status` (JSON). Other fields, which can name the account, are
// decoded into nothing and discarded.
func interpretClaudeAuth(runErr error, output string) (Auth, string) {
	var parsed struct {
		LoggedIn *bool `json:"loggedIn"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &parsed); err == nil && parsed.LoggedIn != nil {
		if *parsed.LoggedIn {
			return AuthReady, detailSignedIn
		}
		return AuthNotAuthenticated, detailSignedOut
	}
	return AuthUnknown, detailNoAnswer
}

func interpretCursorStatus(runErr error, output string) (Auth, string) {
	lower := strings.ToLower(output)
	if strings.Contains(lower, "not logged in") || strings.Contains(lower, "not authenticated") ||
		strings.Contains(lower, "logged out") {
		return AuthNotAuthenticated, detailSignedOut
	}
	if runErr == nil && strings.Contains(lower, "logged in") {
		return AuthReady, detailSignedIn
	}
	return AuthUnknown, detailNoAnswer
}
