//go:build windows

package discovery

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestDiscoversCmdShimOnPath checks that an npm-style codex.cmd on PATH is
// found by its bare name and that an extensionless shim next to it is not used.
func TestDiscoversCmdShimOnPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "codex.cmd"), []byte("@echo off\r\necho codex-cli 9.9\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	d := New(Config{PathEnv: dir, Timeout: 10 * time.Second, Candidates: []Candidate{{ID: "codex", DisplayName: "Codex", Binaries: []string{"codex"}}}})
	got := d.Discover(context.Background())
	if len(got) != 1 || filepath.Base(got[0].Path) != "codex.cmd" {
		t.Fatalf("unexpected result: %+v", got)
	}
}
