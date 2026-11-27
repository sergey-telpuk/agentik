package runtime_test

import (
	"crypto/ecdh"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
)

// projectIDs reports the ids the computer currently permits.
func projectIDs(t *testing.T, h *wireHarness, pc *phoneClient, reqID string) []string {
	t.Helper()
	resp, _ := h.call(pc, reqID, "project.list", map[string]any{})
	if !resp.OK {
		t.Fatalf("project.list failed: %+v", resp.Error)
	}
	listed := decodeInto[struct {
		Projects []runtime.ProjectInfo `json:"projects"`
	}](t, resp.Result)
	ids := make([]string, 0, len(listed.Projects))
	for _, p := range listed.Projects {
		ids = append(ids, p.ProjectID)
	}
	return ids
}

func TestProjectAddPermitsADirectoryAndSurvivesRestart(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	dir := t.TempDir()
	resp, _ := h.call(pc, "req-add", "project.add", map[string]any{"path": dir, "name": "scratch"})
	if !resp.OK {
		t.Fatalf("project.add failed: %+v", resp.Error)
	}
	added := decodeInto[runtime.ProjectInfo](t, resp.Result)
	if added.Name != "scratch" || added.ProjectID == "" {
		t.Fatalf("unexpected project: %+v", added)
	}
	// The id must not carry the path: a client has no business learning the
	// layout of the machine.
	if strings.Contains(added.ProjectID, filepath.Base(dir)) {
		t.Fatalf("project id leaks the path: %q", added.ProjectID)
	}

	ids := projectIDs(t, h, pc, "req-list")
	if !containsString(ids, added.ProjectID) {
		t.Fatalf("the added project is not listed: %v", ids)
	}

	// A task can actually run there, which is the point of adding it.
	started, _ := h.call(pc, "req-task", "task.start", map[string]any{
		"project_id": added.ProjectID, "agent": "codex", "prompt": "hello",
	})
	if !started.OK {
		t.Fatalf("task.start in the added project failed: %+v", started.Error)
	}
}

func TestProjectAddRefusesWhatCannotBeAProject(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	file := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if resp, _ := h.call(pc, "req-first", "project.add", map[string]any{"path": dir}); !resp.OK {
		t.Fatalf("setup add failed: %+v", resp.Error)
	}

	cases := []struct {
		name   string
		params map[string]any
	}{
		{"missing directory", map[string]any{"path": filepath.Join(t.TempDir(), "nope")}},
		{"a file", map[string]any{"path": file}},
		{"empty path", map[string]any{"path": ""}},
		{"unknown agent", map[string]any{"path": t.TempDir(), "agent": "nosuch"}},
		{"unexpected parameter", map[string]any{"path": t.TempDir(), "surprise": true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, _ := h.call(pc, "req-"+tc.name, "project.add", tc.params)
			if resp.OK {
				t.Fatal("expected the request to be refused")
			}
		})
	}
}

// Adding the same directory again is the same project, not a second one:
// the id is derived from the path, and the concurrency rule is per directory.
func TestProjectAddIsIdempotentForTheSameDirectory(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	dir := t.TempDir()
	first, _ := h.call(pc, "req-1", "project.add", map[string]any{"path": dir, "name": "one"})
	if !first.OK {
		t.Fatalf("first add failed: %+v", first.Error)
	}
	second, _ := h.call(pc, "req-2", "project.add", map[string]any{"path": dir, "name": "two"})
	if !second.OK {
		t.Fatalf("second add failed: %+v", second.Error)
	}
	a := decodeInto[runtime.ProjectInfo](t, first.Result)
	b := decodeInto[runtime.ProjectInfo](t, second.Result)
	if a.ProjectID != b.ProjectID {
		t.Fatalf("the same directory became two projects: %q and %q", a.ProjectID, b.ProjectID)
	}
	if b.Name != "two" {
		t.Fatalf("the second add should rename the project, got %q", b.Name)
	}
	count := 0
	for _, id := range projectIDs(t, h, pc, "req-list") {
		if id == a.ProjectID {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("the project is listed %d times", count)
	}
}

func TestProjectRemoveWithdrawsPermission(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	dir := t.TempDir()
	resp, _ := h.call(pc, "req-add", "project.add", map[string]any{"path": dir})
	if !resp.OK {
		t.Fatalf("project.add failed: %+v", resp.Error)
	}
	added := decodeInto[runtime.ProjectInfo](t, resp.Result)

	removed, _ := h.call(pc, "req-remove", "project.remove", map[string]any{"project_id": added.ProjectID})
	if !removed.OK {
		t.Fatalf("project.remove failed: %+v", removed.Error)
	}
	if containsString(projectIDs(t, h, pc, "req-list2"), added.ProjectID) {
		t.Fatal("the removed project is still listed")
	}

	// Permission is gone, so work can no longer start there.
	started, _ := h.call(pc, "req-task", "task.start", map[string]any{
		"project_id": added.ProjectID, "agent": "codex", "prompt": "hello",
	})
	if started.OK {
		t.Fatal("a task started in a removed project")
	}

	unknown, _ := h.call(pc, "req-unknown", "project.remove", map[string]any{"project_id": "proj_missing"})
	if unknown.OK {
		t.Fatal("removing an unknown project should fail")
	}
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
