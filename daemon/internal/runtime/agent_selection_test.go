package runtime_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents"
	"github.com/sergey-telpuk/agentik/daemon/internal/agents/codex"
	"github.com/sergey-telpuk/agentik/daemon/internal/agents/discovery"
	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
)

// modelAdapter is the fake Codex adapter plus a controllable model list, and
// it records the model each turn was started with.
type modelAdapter struct {
	*fakeAdapter
	mu     sync.Mutex
	models []codex.Model
	turns  []string
}

func (m *modelAdapter) Models(context.Context) codex.ModelCatalog {
	m.mu.Lock()
	defer m.mu.Unlock()
	return codex.ModelCatalog{Models: append([]codex.Model{}, m.models...), Source: codex.ModelSourceLive}
}

func (m *modelAdapter) setModels(ids ...string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.models = nil
	for i, id := range ids {
		m.models = append(m.models, codex.Model{ID: id, DisplayName: strings.ToUpper(id), IsDefault: i == 0})
	}
}

func (m *modelAdapter) startedModels() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.turns...)
}

func newModelAdapter(ids ...string) *modelAdapter {
	m := &modelAdapter{}
	m.setModels(ids...)
	m.fakeAdapter = &fakeAdapter{
		status: codex.AgentStatus{
			Name: codex.AgentName, Available: true, Authenticated: true,
			Capabilities: codex.Capabilities{SupportsResume: true, SupportsCancel: true},
		},
		handler: func(_ context.Context, req codex.StartTurnRequest, _ codex.TurnCallbacks, turn *fakeTurn) {
			m.mu.Lock()
			m.turns = append(m.turns, req.Model)
			m.mu.Unlock()
			turn.done <- codex.TurnResult{
				Status: codex.OutcomeSucceeded, ThreadID: "thr_test_1", TurnID: "turn_test_1", ResultText: "done",
			}
		},
	}
	return m
}

// withCatalog wires the harness to a catalogue over the model adapter. A
// non-nil binDir adds discovery of fake agent CLIs in that directory.
func withCatalog(m *modelAdapter, binDir string) func(*runtime.Config) {
	return func(cfg *runtime.Config) {
		cfg.Agents = map[string]codex.Adapter{codex.AgentName: m}
		ac := agents.Config{
			Adapters: map[string]codex.Adapter{codex.AgentName: m},
			// Always rebuild: a changed model list is seen immediately.
			TTL: time.Nanosecond,
		}
		if binDir != "" {
			ac.Discoverer = discovery.New(discovery.Config{PathEnv: binDir, Timeout: 5 * time.Second})
		}
		cfg.Catalog = agents.NewRegistry(ac)
	}
}

func fakeCLIs(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write("codex", `case "$1" in --version) echo "codex-cli 1";; login) echo "Logged in using ChatGPT";; esac`)
	write("claude", `case "$1" in --version) echo "2.0.0";; auth) echo '{"loggedIn": true}';; esac`)
	return dir
}

func selectionHarness(t *testing.T, m *modelAdapter, binDir string) (*wireHarness, *phoneClient) {
	t.Helper()
	h := newHarness(t, m.fakeAdapter, withCatalog(m, binDir))
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	return h, pairPhone(t, h, key)
}

func TestAgentListReturnsDetectedAgentsWithModelsAndLegacyFields(t *testing.T) {
	m := newModelAdapter("big", "small")
	h, pc := selectionHarness(t, m, fakeCLIs(t))

	resp, _ := h.call(pc, "req-agents", "agent.list", map[string]any{})
	if !resp.OK {
		t.Fatalf("agent.list failed: %+v", resp.Error)
	}
	// Decode through a generic map to assert the wire field names, which is
	// what existing clients depend on.
	raw := decodeInto[struct {
		Agents []map[string]any `json:"agents"`
	}](t, resp.Result)
	if len(raw.Agents) != 2 {
		t.Fatalf("expected codex and claude, got %+v", raw.Agents)
	}
	cx, cl := raw.Agents[0], raw.Agents[1]
	if cx["name"] != "codex" || cx["id"] != "codex" || cx["available"] != true || cx["authenticated"] != true ||
		cx["status"] != "ready" || cx["supported"] != true || cx["models_source"] != "live" || cx["version"] != "codex-cli 1" {
		t.Fatalf("unexpected codex entry: %+v", cx)
	}
	models, _ := cx["models"].([]any)
	if len(models) != 2 || models[0].(map[string]any)["id"] != "big" || models[0].(map[string]any)["is_default"] != true {
		t.Fatalf("unexpected models: %+v", cx["models"])
	}
	if _, ok := cx["capabilities"]; !ok {
		t.Fatalf("legacy capabilities field missing: %+v", cx)
	}
	if cl["id"] != "claude" || cl["status"] != "unsupported" || cl["supported"] != false {
		t.Fatalf("unexpected claude entry: %+v", cl)
	}
	if s, _ := cl["status_text"].(string); !strings.Contains(s, "not supported yet") {
		t.Fatalf("unsupported agent needs a reason, got %q", s)
	}
}

func TestTaskStartSelectsAgentAndModel(t *testing.T) {
	m := newModelAdapter("big", "small")
	h, pc := selectionHarness(t, m, "")

	resp, _ := h.call(pc, "req-m", "task.start", map[string]any{
		"project_id": "proj-a", "agent_id": "codex", "model": "small", "prompt": "hi",
	})
	if !resp.OK {
		t.Fatalf("task.start failed: %+v", resp.Error)
	}
	res := decodeInto[runtime.TaskResult](t, resp.Result)
	if res.Task.Agent != "codex" || res.Task.Model != "small" {
		t.Fatalf("task view lost agent or model: %+v", res.Task)
	}
	waitTaskCompleted(t, pc, res.Task.TaskID)
	if got := m.startedModels(); len(got) != 1 || got[0] != "small" {
		t.Fatalf("adapter started with models %v, want [small]", got)
	}

	// The model is part of the stored task and is returned on later reads.
	get, _ := h.call(pc, "req-get", "task.get", map[string]any{"task_id": res.Task.TaskID})
	if !get.OK {
		t.Fatalf("task.get failed: %+v", get.Error)
	}
	if got := decodeInto[runtime.TaskResult](t, get.Result); got.Task.Model != "small" || got.Task.Agent != "codex" {
		t.Fatalf("task.get lost the agent or model: %+v", got.Task)
	}
}

func TestTaskStartDefaultsToAgentDefaultModel(t *testing.T) {
	m := newModelAdapter("big")
	h, pc := selectionHarness(t, m, "")

	// Neither agent_id nor model: the project's agent and its own default.
	resp, _ := h.call(pc, "req-d", "task.start", map[string]any{"project_id": "proj-a", "prompt": "hi"})
	if !resp.OK {
		t.Fatalf("task.start failed: %+v", resp.Error)
	}
	res := decodeInto[runtime.TaskResult](t, resp.Result)
	waitTaskCompleted(t, pc, res.Task.TaskID)
	if res.Task.Model != "" {
		t.Fatalf("default model must stay empty, got %q", res.Task.Model)
	}
	if got := m.startedModels(); len(got) != 1 || got[0] != "" {
		t.Fatalf("adapter must receive no model override, got %v", got)
	}
}

func TestTaskStartRejectsUnknownAgentOrModel(t *testing.T) {
	m := newModelAdapter("big")
	h, pc := selectionHarness(t, m, fakeCLIs(t))

	cases := []struct {
		name   string
		params map[string]any
		code   string
		text   string
	}{
		{"unknown model", map[string]any{"agent_id": "codex", "model": "gpt-nope"}, "unknown_model", "gpt-nope"},
		{"unknown agent", map[string]any{"agent_id": "nosuch"}, "bad_request", "nosuch"},
		{"unsupported agent", map[string]any{"agent_id": "claude"}, "agent_unsupported", "not supported yet"},
		{"unsupported agent via legacy field", map[string]any{"agent": "claude"}, "agent_unsupported", "not supported yet"},
		{"disagreeing fields", map[string]any{"agent": "codex", "agent_id": "claude"}, "bad_request", "disagree"},
		{"oversized model", map[string]any{"agent_id": "codex", "model": strings.Repeat("m", 500)}, "bad_request", "exceeds"},
	}
	for i, c := range cases {
		params := map[string]any{"project_id": "proj-a", "prompt": "hi"}
		for k, v := range c.params {
			params[k] = v
		}
		resp, _ := h.call(pc, "req-rej-"+string(rune('a'+i)), "task.start", params)
		if resp.OK || resp.Error == nil || resp.Error.Code != c.code || !strings.Contains(resp.Error.Message, c.text) {
			t.Fatalf("%s: want %s containing %q, got %+v", c.name, c.code, c.text, resp)
		}
	}
	if n := m.launchCount.Load(); n != 0 {
		t.Fatalf("a rejected request launched the agent %d times", n)
	}
	// Nothing was persisted for rejected requests.
	var tasks int
	if err := h.db.SQL().QueryRow(`SELECT COUNT(*) FROM tasks`).Scan(&tasks); err != nil || tasks != 0 {
		t.Fatalf("rejected requests left %d tasks (err=%v)", tasks, err)
	}
}

func TestTaskStartRejectsModelWhenAgentNotReady(t *testing.T) {
	m := newModelAdapter("big")
	m.status.Authenticated = false
	m.status.Detail = "Not logged in"
	h, pc := selectionHarness(t, m, "")

	resp, _ := h.call(pc, "req-nr", "task.start", map[string]any{
		"project_id": "proj-a", "agent_id": "codex", "model": "big", "prompt": "hi",
	})
	if resp.OK || resp.Error == nil || resp.Error.Code != "agent_not_ready" {
		t.Fatalf("expected agent_not_ready, got %+v", resp)
	}
}

func TestIdempotentRetryKeepsOriginalAgentAndModel(t *testing.T) {
	m := newModelAdapter("big", "small")
	h, pc := selectionHarness(t, m, "")

	params := map[string]any{"project_id": "proj-a", "agent_id": "codex", "model": "small", "prompt": "hi"}
	first, _ := h.call(pc, "req-idem", "task.start", params)
	if !first.OK {
		t.Fatalf("first start failed: %+v", first.Error)
	}
	one := decodeInto[runtime.TaskResult](t, first.Result)
	waitTaskCompleted(t, pc, one.Task.TaskID)

	// The model disappears from the list (the catalogue is rebuilt on every
	// call in this test). A retry of the accepted request must still return
	// the original task with its original agent and model.
	m.setModels("big")
	retry, _ := h.call(pc, "req-idem", "task.start", params)
	if !retry.OK {
		t.Fatalf("retry failed: %+v", retry.Error)
	}
	again := decodeInto[runtime.TaskResult](t, retry.Result)
	if !again.Deduplicated || again.Task.TaskID != one.Task.TaskID ||
		again.Task.Agent != "codex" || again.Task.Model != "small" {
		t.Fatalf("retry must return the original task: %+v", again)
	}
	if got := m.startedModels(); len(got) != 1 {
		t.Fatalf("retry must not launch again, got %v", got)
	}

	// The same request id with another model is a different request.
	other := map[string]any{"project_id": "proj-a", "agent_id": "codex", "model": "big", "prompt": "hi"}
	resp, _ := h.call(pc, "req-idem", "task.start", other)
	if resp.OK || resp.Error == nil || resp.Error.Code != "request_id_conflict" {
		t.Fatalf("a different model under the same request id must conflict, got %+v", resp)
	}
	// Dropping the model entirely is a different request too.
	noModel := map[string]any{"project_id": "proj-a", "agent_id": "codex", "prompt": "hi"}
	resp, _ = h.call(pc, "req-idem", "task.start", noModel)
	if resp.OK || resp.Error == nil || resp.Error.Code != "request_id_conflict" {
		t.Fatalf("dropping the model under the same request id must conflict, got %+v", resp)
	}
}

func TestRequestWithoutModelKeepsItsPreModelHash(t *testing.T) {
	// A task accepted by an older daemon (no model in the hash) must still be
	// recognised as the same request. The hash of a modelless request must
	// therefore not change: agent_id is only another spelling of agent.
	m := newModelAdapter("big")
	h, pc := selectionHarness(t, m, "")

	first, _ := h.call(pc, "req-legacy", "task.start", map[string]any{
		"project_id": "proj-a", "agent": "codex", "prompt": "hi",
	})
	one := decodeInto[runtime.TaskResult](t, first.Result)
	waitTaskCompleted(t, pc, one.Task.TaskID)

	retry, _ := h.call(pc, "req-legacy", "task.start", map[string]any{
		"project_id": "proj-a", "agent_id": "codex", "prompt": "hi",
	})
	if !retry.OK || !decodeInto[runtime.TaskResult](t, retry.Result).Deduplicated {
		t.Fatalf("agent and agent_id must be interchangeable for dedup: %+v", retry)
	}
}

// continueSession starts a first turn and returns it once it has completed.
func continueSession(t *testing.T, h *wireHarness, pc *phoneClient, m *modelAdapter) runtime.TaskView {
	t.Helper()
	first, _ := h.call(pc, "req-c1", "task.start", map[string]any{
		"project_id": "proj-a", "agent_id": "codex", "model": "big", "prompt": "one",
	})
	if !first.OK {
		t.Fatalf("first turn failed: %+v", first.Error)
	}
	one := decodeInto[runtime.TaskResult](t, first.Result)
	waitTaskCompleted(t, pc, one.Task.TaskID)
	return one.Task
}

func TestContinuationPassesChosenModelToTurnStart(t *testing.T) {
	m := newModelAdapter("big", "small")
	h, pc := selectionHarness(t, m, "")
	one := continueSession(t, h, pc, m)

	resp, _ := h.call(pc, "req-c2", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": one.SessionID, "agent_id": "codex", "model": "small", "prompt": "two",
	})
	if !resp.OK {
		t.Fatalf("continuation failed: %+v", resp.Error)
	}
	two := decodeInto[runtime.TaskResult](t, resp.Result)
	if two.Task.SessionID != one.SessionID || two.Task.Model != "small" {
		t.Fatalf("continuation lost the session or model: %+v", two.Task)
	}
	waitTaskCompleted(t, pc, two.Task.TaskID)
	if got := m.startedModels(); len(got) != 2 || got[0] != "big" || got[1] != "small" {
		t.Fatalf("turns started with models %v, want [big small]", got)
	}

	// Each turn keeps the model it ran with.
	opened, _ := h.call(pc, "req-c-open", "session.open", map[string]any{
		"project_id": "proj-a", "session_id": one.SessionID,
	})
	open := decodeInto[runtime.SessionOpenResult](t, opened.Result)
	if len(open.Tasks) != 2 || open.Tasks[0].Model != "big" || open.Tasks[1].Model != "small" {
		t.Fatalf("session.open lost per-turn models: %+v", open.Tasks)
	}
}

func TestContinuationRejectsUnknownModelWithoutLaunching(t *testing.T) {
	m := newModelAdapter("big", "small")
	h, pc := selectionHarness(t, m, "")
	one := continueSession(t, h, pc, m)

	resp, _ := h.call(pc, "req-c2", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": one.SessionID, "agent_id": "codex", "model": "gpt-nope", "prompt": "two",
	})
	if resp.OK || resp.Error == nil || resp.Error.Code != "unknown_model" || !strings.Contains(resp.Error.Message, "gpt-nope") {
		t.Fatalf("expected unknown_model, got %+v", resp)
	}
	if n := m.launchCount.Load(); n != 1 {
		t.Fatalf("a rejected continuation launched the agent: %d launches", n)
	}
	var tasks int
	if err := h.db.SQL().QueryRow(`SELECT COUNT(*) FROM tasks`).Scan(&tasks); err != nil || tasks != 1 {
		t.Fatalf("rejected continuation left %d tasks (err=%v)", tasks, err)
	}
}

func TestContinuationWithoutModelKeepsAgentDefault(t *testing.T) {
	m := newModelAdapter("big", "small")
	h, pc := selectionHarness(t, m, "")
	one := continueSession(t, h, pc, m)

	resp, _ := h.call(pc, "req-c2", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": one.SessionID, "agent_id": "codex", "prompt": "two",
	})
	if !resp.OK {
		t.Fatalf("continuation failed: %+v", resp.Error)
	}
	two := decodeInto[runtime.TaskResult](t, resp.Result)
	waitTaskCompleted(t, pc, two.Task.TaskID)
	if two.Task.Model != "" {
		t.Fatalf("default model must stay empty, got %q", two.Task.Model)
	}
	if got := m.startedModels(); len(got) != 2 || got[1] != "" {
		t.Fatalf("continuation without a model must send no override, got %v", got)
	}
}

func TestContinuationModelIsPartOfIdempotencyHash(t *testing.T) {
	m := newModelAdapter("big", "small")
	h, pc := selectionHarness(t, m, "")
	one := continueSession(t, h, pc, m)

	params := map[string]any{
		"project_id": "proj-a", "session_id": one.SessionID, "agent_id": "codex", "model": "small", "prompt": "two",
	}
	resp, _ := h.call(pc, "req-c2", "task.start", params)
	if !resp.OK {
		t.Fatalf("continuation failed: %+v", resp.Error)
	}
	two := decodeInto[runtime.TaskResult](t, resp.Result)
	waitTaskCompleted(t, pc, two.Task.TaskID)

	retry, _ := h.call(pc, "req-c2", "task.start", params)
	if !retry.OK || !decodeInto[runtime.TaskResult](t, retry.Result).Deduplicated {
		t.Fatalf("identical continuation must deduplicate: %+v", retry)
	}
	params["model"] = "big"
	other, _ := h.call(pc, "req-c2", "task.start", params)
	if other.OK || other.Error == nil || other.Error.Code != "request_id_conflict" {
		t.Fatalf("another model under the same request id must conflict, got %+v", other)
	}
	if got := m.startedModels(); len(got) != 2 {
		t.Fatalf("retries must not launch again, got %v", got)
	}
}
