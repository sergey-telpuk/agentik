package discovery

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// writeScript installs an executable shell script named name in dir.
func writeScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binaries need a POSIX shell")
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func byID(list []Agent, id string) *Agent {
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	return nil
}

func discoverIn(t *testing.T, dir string, timeout time.Duration) []Agent {
	t.Helper()
	return New(Config{PathEnv: dir, Timeout: timeout}).Discover(context.Background())
}

func TestDiscoverReadyAgents(t *testing.T) {
	dir := t.TempDir()
	writeScript(t, dir, "codex", `case "$1" in --version) echo "codex-cli 9.9.9";; login) echo "Logged in using ChatGPT";; esac`)
	writeScript(t, dir, "claude", `case "$1" in --version) echo "2.0.0 (Claude Code)";; auth) echo '{"loggedIn": true, "email": "secret.person@example.com", "orgName": "Secret Org"}';; esac`)
	writeScript(t, dir, "cursor-agent", `case "$1" in --version) echo "2026.01.01-abc";; status) echo "✓ Logged in as secret.person@example.com"; echo "Team: Secret Org";; esac`)

	got := discoverIn(t, dir, 5*time.Second)
	if len(got) != 3 {
		t.Fatalf("detected %d agents, want 3: %+v", len(got), got)
	}
	want := map[string]struct{ name, version string }{
		"codex":        {"Codex", "codex-cli 9.9.9"},
		"claude":       {"Claude Code", "2.0.0 (Claude Code)"},
		"cursor-agent": {"Cursor Agent", "2026.01.01-abc"},
	}
	for id, w := range want {
		a := byID(got, id)
		if a == nil {
			t.Fatalf("%s not detected", id)
		}
		if a.DisplayName != w.name || a.Version != w.version || a.Auth != AuthReady || a.Path != filepath.Join(dir, id) {
			t.Fatalf("%s: unexpected result %+v", id, *a)
		}
		// Nothing from the status output may leak into what discovery keeps.
		for _, field := range []string{a.AuthDetail, a.Version, a.DisplayName} {
			if strings.Contains(field, "secret") || strings.Contains(field, "Secret") {
				t.Fatalf("%s: account data leaked into %q", id, field)
			}
		}
	}
	// Candidate order is stable.
	if got[0].ID != "codex" || got[1].ID != "claude" || got[2].ID != "cursor-agent" {
		t.Fatalf("unstable order: %v %v %v", got[0].ID, got[1].ID, got[2].ID)
	}
}

func TestDiscoverMissingBinariesAreOmitted(t *testing.T) {
	if got := discoverIn(t, t.TempDir(), time.Second); len(got) != 0 {
		t.Fatalf("expected nothing detected, got %+v", got)
	}
}

func TestDiscoverNotAuthenticated(t *testing.T) {
	dir := t.TempDir()
	writeScript(t, dir, "codex", `case "$1" in --version) echo "codex-cli 1";; login) echo "Not logged in"; exit 1;; esac`)
	writeScript(t, dir, "claude", `case "$1" in --version) echo "2.0.0";; auth) echo '{"loggedIn": false}'; exit 1;; esac`)
	writeScript(t, dir, "cursor-agent", `case "$1" in --version) echo "1";; status) echo "Not logged in"; exit 1;; esac`)

	got := discoverIn(t, dir, 5*time.Second)
	for _, id := range []string{"codex", "claude", "cursor-agent"} {
		a := byID(got, id)
		if a == nil || a.Auth != AuthNotAuthenticated || a.Version == "" {
			t.Fatalf("%s: want not_authenticated with a version, got %+v", id, a)
		}
	}
}

func TestDiscoverUnknownWhenStatusIsUnrecognizedOrFails(t *testing.T) {
	dir := t.TempDir()
	// Status command exists but gives an answer discovery cannot interpret.
	writeScript(t, dir, "codex", `case "$1" in --version) echo "codex-cli 1";; login) echo "something unexpected"; exit 3;; esac`)
	// Malformed JSON from claude.
	writeScript(t, dir, "claude", `case "$1" in --version) echo "2.0.0";; auth) echo "not json";; esac`)
	// A CLI with no known status command at all.
	writeScript(t, dir, "gemini", `echo "gemini 0.1"`)

	got := discoverIn(t, dir, 5*time.Second)
	for _, id := range []string{"codex", "claude", "gemini"} {
		a := byID(got, id)
		if a == nil || a.Auth != AuthUnknown {
			t.Fatalf("%s: want unknown, got %+v", id, a)
		}
	}
	if g := byID(got, "gemini"); g.AuthDetail == "" {
		t.Fatalf("gemini should explain why readiness is unknown: %+v", g)
	}
}

func TestDiscoverTimeoutDoesNotHang(t *testing.T) {
	dir := t.TempDir()
	// Both commands hang; exec replaces the shell so the kill reaches sleep.
	writeScript(t, dir, "codex", `exec sleep 30`)

	start := time.Now()
	got := discoverIn(t, dir, 300*time.Millisecond)
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("discovery took %v despite 300ms timeouts", elapsed)
	}
	a := byID(got, "codex")
	if a == nil {
		t.Fatalf("a hanging binary is still a detected binary: %+v", got)
	}
	if a.Auth != AuthUnknown || a.Version != "" || !strings.Contains(a.AuthDetail, "timed out") {
		t.Fatalf("expected unknown/timed out with no version, got %+v", *a)
	}
}

func TestDiscoverIgnoresRelativeAndNonExecutablePathEntries(t *testing.T) {
	dir := t.TempDir()
	p := writeScript(t, dir, "codex", `echo "codex-cli 1"`)
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	// Not executable: not detected.
	if got := discoverIn(t, dir, time.Second); len(got) != 0 {
		t.Fatalf("non-executable file detected: %+v", got)
	}
	// A relative PATH entry (including the empty one) must never be searched.
	t.Chdir(dir)
	if err := os.Chmod(p, 0o755); err != nil {
		t.Fatal(err)
	}
	got := New(Config{PathEnv: ".:" + string(filepath.ListSeparator) + "relative"}).Discover(context.Background())
	if len(got) != 0 {
		t.Fatalf("binary found through a relative PATH entry: %+v", got)
	}
}

func TestDiscoverExtraDirsAndOverrides(t *testing.T) {
	pathDir := t.TempDir()
	extra := t.TempDir()
	custom := t.TempDir()
	writeScript(t, extra, "claude", `case "$1" in --version) echo "2.0.0";; auth) echo '{"loggedIn": true}';; esac`)
	writeScript(t, custom, "my-codex", `case "$1" in --version) echo "custom 1";; login) echo "Logged in using API key";; esac`)

	got := New(Config{
		PathEnv:   pathDir,
		ExtraDirs: []string{extra},
		Overrides: map[string]string{"codex": filepath.Join(custom, "my-codex")},
	}).Discover(context.Background())

	if a := byID(got, "claude"); a == nil || a.Path != filepath.Join(extra, "claude") || a.Auth != AuthReady {
		t.Fatalf("claude not found through extra dirs: %+v", a)
	}
	if a := byID(got, "codex"); a == nil || a.Version != "custom 1" || a.Auth != AuthReady {
		t.Fatalf("codex override not used: %+v", a)
	}
}

func TestVersionIsFirstLineAndBounded(t *testing.T) {
	dir := t.TempDir()
	writeScript(t, dir, "gemini", `case "$1" in --version) echo; echo "`+strings.Repeat("v", 500)+`"; echo "second line";; esac`)
	a := byID(discoverIn(t, dir, 5*time.Second), "gemini")
	if a == nil || len(a.Version) != maxVersionLen || strings.Contains(a.Version, "second") {
		t.Fatalf("version not bounded to first line: %+v", a)
	}
}

func TestExecutableNames(t *testing.T) {
	if got := executableNames("darwin", "codex"); len(got) != 1 || got[0] != "codex" {
		t.Errorf("darwin: %v", got)
	}
	got := executableNames("windows", "codex")
	if len(got) != 2 || got[0] != "codex.exe" || got[1] != "codex.cmd" {
		t.Errorf("windows bare name: %v", got)
	}
	for _, n := range []string{"codex.exe", "codex.CMD", "codex.bat"} {
		if got := executableNames("windows", n); len(got) != 1 || got[0] != n {
			t.Errorf("windows %s: %v", n, got)
		}
	}
}

func TestWellKnownDirsWindows(t *testing.T) {
	home := filepath.Join("C:", "Users", "me")
	got := wellKnownDirsFor("windows", home, filepath.Join(home, "AppData", "Roaming"), "")
	want := []string{
		filepath.Join(home, "AppData", "Roaming", "npm"),
		filepath.Join(home, "AppData", "Local", "Programs"),
	}
	for _, w := range want {
		found := false
		for _, g := range got {
			if g == w {
				found = true
			}
		}
		if !found {
			t.Errorf("missing %q in %v", w, got)
		}
	}
	for _, g := range wellKnownDirsFor("windows", home, "", "") {
		if g == "/usr/local/bin" || g == "/opt/homebrew/bin" {
			t.Errorf("Unix directory %q listed for windows", g)
		}
	}
	if got := wellKnownDirsFor("darwin", home, "", ""); got[0] != "/opt/homebrew/bin" {
		t.Errorf("darwin list changed: %v", got)
	}
}
