package agents

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents/codex"
	"github.com/sergey-telpuk/agentik/daemon/internal/agents/discovery"
)

// fakeCodex is a supported adapter with a controllable model list.
type fakeCodex struct {
	mu         sync.Mutex
	catalog    codex.ModelCatalog
	modelCalls atomic.Int64
}

func (f *fakeCodex) Name() string { return "codex" }
func (f *fakeCodex) Capabilities() codex.Capabilities {
	return codex.Capabilities{SupportsResume: true, SupportsCancel: true}
}
func (f *fakeCodex) Diagnose(context.Context) codex.AgentStatus {
	return codex.AgentStatus{Name: "codex", Available: true, Authenticated: true, Version: "fake"}
}
func (f *fakeCodex) StartTurn(context.Context, codex.StartTurnRequest, codex.TurnCallbacks) (codex.ActiveTurn, error) {
	return nil, nil
}
func (f *fakeCodex) Models(context.Context) codex.ModelCatalog {
	f.modelCalls.Add(1)
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.catalog
}
func (f *fakeCodex) setModels(ids ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.catalog = liveCatalog(ids...)
}

func liveCatalog(ids ...string) codex.ModelCatalog {
	c := codex.ModelCatalog{Source: codex.ModelSourceLive, Models: []codex.Model{}}
	for i, id := range ids {
		c.Models = append(c.Models, codex.Model{ID: id, DisplayName: strings.ToUpper(id), IsDefault: i == 0})
	}
	return c
}

func script(t *testing.T, dir, name, body string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binaries need a POSIX shell")
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func newRegistry(t *testing.T, dir string, ad *fakeCodex) *Registry {
	t.Helper()
	return NewRegistry(Config{
		Adapters:   map[string]codex.Adapter{"codex": ad},
		Discoverer: discovery.New(discovery.Config{PathEnv: dir, Timeout: 5 * time.Second}),
	})
}

func entry(list []Entry, id string) *Entry {
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	return nil
}

func installAll(t *testing.T) string {
	dir := t.TempDir()
	script(t, dir, "codex", `case "$1" in --version) echo "codex-cli 1";; login) echo "Logged in using ChatGPT";; esac`)
	script(t, dir, "claude", `case "$1" in --version) echo "2.0.0";; auth) echo '{"loggedIn": true}';; esac`)
	script(t, dir, "cursor-agent", `case "$1" in --version) echo "1";; status) echo "Not logged in"; exit 1;; esac`)
	return dir
}

func TestListCombinesSupportedAndUnsupportedAgents(t *testing.T) {
	ad := &fakeCodex{catalog: liveCatalog("big", "small")}
	list := newRegistry(t, installAll(t), ad).List(context.Background())

	if len(list) != 3 || list[0].ID != "codex" {
		t.Fatalf("expected codex first of 3 agents, got %+v", list)
	}
	c := entry(list, "codex")
	if c.Status != StatusReady || !c.Supported || c.Version != "codex-cli 1" || c.DisplayName != "Codex" ||
		!c.Available || !c.Authenticated || !c.Capabilities.SupportsResume {
		t.Fatalf("unexpected codex entry: %+v", c)
	}
	if len(c.Models) != 2 || c.Models[0].ID != "big" || c.ModelsSource != codex.ModelSourceLive {
		t.Fatalf("unexpected codex models: %+v", c.Models)
	}

	// Detected but without an adapter: listed, disabled, with a reason, no
	// models, and even a signed-in CLI is not "ready".
	cl := entry(list, "claude")
	if cl.Status != StatusUnsupported || cl.Supported || len(cl.Models) != 0 || !strings.Contains(cl.StatusText, "not supported yet") {
		t.Fatalf("unexpected claude entry: %+v", cl)
	}
	cu := entry(list, "cursor-agent")
	if cu.Status != StatusUnsupported || !strings.Contains(cu.StatusText, "approval") {
		t.Fatalf("unexpected cursor-agent entry: %+v", cu)
	}
}

func TestListWireShapeKeepsLegacyFieldsAndHidesPaths(t *testing.T) {
	dir := installAll(t)
	list := newRegistry(t, dir, &fakeCodex{catalog: liveCatalog("m")}).List(context.Background())
	raw, err := json.Marshal(list[0])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"name", "available", "authenticated", "version", "detail", "capabilities",
		"id", "display_name", "status", "status_text", "supported", "models", "models_source"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("agent.list entry is missing %q: %s", k, raw)
		}
	}
	if m["name"] != "codex" {
		t.Fatalf("legacy name must stay the agent id, got %v", m["name"])
	}
	if strings.Contains(string(raw), dir) {
		t.Fatalf("local binary path leaked to the wire: %s", raw)
	}
}

func TestSupportedAgentStates(t *testing.T) {
	t.Run("not installed", func(t *testing.T) {
		list := newRegistry(t, t.TempDir(), &fakeCodex{}).List(context.Background())
		if len(list) != 1 || list[0].Status != StatusNotInstalled || list[0].Available || !list[0].Supported {
			t.Fatalf("unexpected: %+v", list)
		}
	})
	t.Run("not authenticated has no models", func(t *testing.T) {
		dir := t.TempDir()
		script(t, dir, "codex", `case "$1" in --version) echo v;; login) echo "Not logged in"; exit 1;; esac`)
		ad := &fakeCodex{catalog: liveCatalog("hidden-until-ready")}
		list := newRegistry(t, dir, ad).List(context.Background())
		if list[0].Status != StatusNotAuthenticated || len(list[0].Models) != 0 || ad.modelCalls.Load() != 0 {
			t.Fatalf("unexpected: %+v (model calls %d)", list[0], ad.modelCalls.Load())
		}
	})
	t.Run("unknown", func(t *testing.T) {
		dir := t.TempDir()
		script(t, dir, "codex", `echo what`)
		list := newRegistry(t, dir, &fakeCodex{}).List(context.Background())
		if list[0].Status != StatusUnknown || list[0].Supported != true {
			t.Fatalf("unexpected: %+v", list[0])
		}
	})
}

func TestListIsCachedForTheTTL(t *testing.T) {
	now := time.Unix(1_000, 0)
	ad := &fakeCodex{catalog: liveCatalog("m")}
	reg := NewRegistry(Config{
		Adapters:   map[string]codex.Adapter{"codex": ad},
		Discoverer: discovery.New(discovery.Config{PathEnv: installAll(t)}),
		TTL:        time.Minute,
		Now:        func() time.Time { return now },
	})
	reg.List(context.Background())
	reg.List(context.Background())
	if n := ad.modelCalls.Load(); n != 1 {
		t.Fatalf("model list queried %d times within the TTL, want 1", n)
	}
	now = now.Add(2 * time.Minute)
	reg.List(context.Background())
	if n := ad.modelCalls.Load(); n != 2 {
		t.Fatalf("model list queried %d times after the TTL, want 2", n)
	}
}

func TestResolveRejectsAndAccepts(t *testing.T) {
	ad := &fakeCodex{catalog: liveCatalog("big", "small")}
	reg := newRegistry(t, installAll(t), ad)
	ctx := context.Background()

	code := func(err error) string {
		t.Helper()
		se, ok := err.(*SelectionError)
		if !ok {
			t.Fatalf("expected *SelectionError, got %T %v", err, err)
		}
		return se.Code
	}

	if sel, err := reg.Resolve(ctx, "codex", ""); err != nil || sel != (Selection{AgentID: "codex"}) {
		t.Fatalf("default model: %+v %v", sel, err)
	}
	if sel, err := reg.Resolve(ctx, "codex", " small "); err != nil || sel.Model != "small" {
		t.Fatalf("listed model: %+v %v", sel, err)
	}
	if _, err := reg.Resolve(ctx, "codex", "nope"); err == nil || code(err) != ErrCodeUnknownModel {
		t.Fatalf("unknown model must be rejected, got %v", err)
	}
	if _, err := reg.Resolve(ctx, "nosuch", ""); err == nil || code(err) != ErrCodeUnknownAgent {
		t.Fatalf("unknown agent must be rejected, got %v", err)
	}
	// A detected but unsupported agent is rejected with its own reason, not
	// as "unknown".
	if _, err := reg.Resolve(ctx, "claude", ""); err == nil || code(err) != ErrCodeUnsupported ||
		!strings.Contains(err.Error(), "not supported yet") {
		t.Fatalf("unsupported agent must be rejected with a reason, got %v", err)
	}
}

func TestResolveNotReadyAndStaticFallback(t *testing.T) {
	dir := t.TempDir()
	script(t, dir, "codex", `case "$1" in --version) echo v;; login) echo "Not logged in"; exit 1;; esac`)
	reg := newRegistry(t, dir, &fakeCodex{catalog: liveCatalog("m")})
	_, err := reg.Resolve(context.Background(), "codex", "m")
	if se, ok := err.(*SelectionError); !ok || se.Code != ErrCodeNotReady {
		t.Fatalf("model on a signed-out agent must be rejected as not ready, got %v", err)
	}
	// Starting on the agent default is still allowed; the launch check then
	// reports the authentication problem.
	if _, err := reg.Resolve(context.Background(), "codex", ""); err != nil {
		t.Fatalf("default model should not need a model list: %v", err)
	}

	static := &fakeCodex{catalog: codex.ModelCatalog{Models: []codex.Model{}, Source: codex.ModelSourceStatic, Detail: "boom"}}
	reg = newRegistry(t, installAll(t), static)
	_, err = reg.Resolve(context.Background(), "codex", "m")
	if se, ok := err.(*SelectionError); !ok || se.Code != ErrCodeUnknownModel || !strings.Contains(se.Message, "could not be read") {
		t.Fatalf("static fallback must explain itself, got %v", err)
	}
}

func TestResolveRefreshesOnceForANewModel(t *testing.T) {
	now := time.Unix(1_000, 0)
	ad := &fakeCodex{catalog: liveCatalog("old")}
	reg := NewRegistry(Config{
		Adapters:   map[string]codex.Adapter{"codex": ad},
		Discoverer: discovery.New(discovery.Config{PathEnv: installAll(t)}),
		TTL:        time.Hour,
		Now:        func() time.Time { return now },
	})
	ctx := context.Background()
	if _, err := reg.Resolve(ctx, "codex", "old"); err != nil {
		t.Fatal(err)
	}
	ad.setModels("old", "fresh")
	// Within the rate limit the cached list is authoritative.
	if _, err := reg.Resolve(ctx, "codex", "fresh"); err == nil {
		t.Fatal("a refresh inside minForcedRefresh must not happen")
	}
	now = now.Add(minForcedRefresh + time.Second)
	if _, err := reg.Resolve(ctx, "codex", "fresh"); err != nil {
		t.Fatalf("a newly available model must be accepted after a refresh: %v", err)
	}
}

func TestRegistryWithoutDiscovererUsesAdapterDiagnose(t *testing.T) {
	ad := &fakeCodex{catalog: liveCatalog("m")}
	reg := NewRegistry(Config{Adapters: map[string]codex.Adapter{"codex": ad}})
	list := reg.List(context.Background())
	if len(list) != 1 || list[0].Status != StatusReady || len(list[0].Models) != 1 {
		t.Fatalf("unexpected: %+v", list)
	}
}
