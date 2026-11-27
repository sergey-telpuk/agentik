package runtime_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents/codex"
	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
)

type turnCall struct {
	ThreadID string
	Prompt   string
}

// continuationAdapter answers every turn with "reply to <prompt>" and records
// which Codex thread each turn was started on.
func continuationAdapter() (*fakeAdapter, func() []turnCall) {
	var mu sync.Mutex
	var calls []turnCall
	adapter := &fakeAdapter{
		status: codex.AgentStatus{
			Name:          codex.AgentName,
			Available:     true,
			Authenticated: true,
			Capabilities:  codex.Capabilities{SupportsResume: true, SupportsCancel: true},
		},
		handler: func(_ context.Context, req codex.StartTurnRequest, cb codex.TurnCallbacks, turn *fakeTurn) {
			mu.Lock()
			calls = append(calls, turnCall{ThreadID: req.ThreadID, Prompt: req.Prompt})
			mu.Unlock()
			cb.OnEvent(codex.Event{Kind: codex.EventDelta, Text: "thinking about " + req.Prompt})
			turn.done <- codex.TurnResult{
				Status:     codex.OutcomeSucceeded,
				ThreadID:   "thr_test_1",
				TurnID:     "turn_test_1",
				ResultText: "reply to " + req.Prompt,
			}
		},
	}
	return adapter, func() []turnCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]turnCall(nil), calls...)
	}
}

func decodeInto[T any](t *testing.T, v any) T {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func waitTaskCompleted(t *testing.T, pc *phoneClient, taskID string) {
	t.Helper()
	pc.waitEvent(t, 2*time.Second, func(e runtime.OutboundEvent) bool {
		ev, ok := e.Data.(map[string]any)
		return ok && ev["task_id"] == taskID && ev["kind"] == "completed"
	})
}

func TestTaskStartContinuesSessionOnSameCodexThread(t *testing.T) {
	adapter, calls := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	first, _ := h.call(pc, "req-turn-1", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": nil, "agent": "codex", "prompt": "remember the word pineapple",
	})
	if !first.OK {
		t.Fatalf("first task.start failed: %+v", first.Error)
	}
	one := decodeInto[runtime.TaskResult](t, first.Result)
	waitTaskCompleted(t, pc, one.Task.TaskID)

	// session.open on the existing session lists the first turn.
	opened, _ := h.call(pc, "req-open-1", "session.open", map[string]any{
		"project_id": "proj-a", "session_id": one.Task.SessionID,
	})
	if !opened.OK {
		t.Fatalf("session.open failed: %+v", opened.Error)
	}
	open1 := decodeInto[runtime.SessionOpenResult](t, opened.Result)
	if open1.SessionID != one.Task.SessionID || len(open1.Tasks) != 1 || open1.Tasks[0].TaskID != one.Task.TaskID {
		t.Fatalf("unexpected session.open after first turn: %+v", open1)
	}

	second, _ := h.call(pc, "req-turn-2", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": one.Task.SessionID, "agent": "codex", "prompt": "what word did I ask you to remember?",
	})
	if !second.OK {
		t.Fatalf("continuation task.start failed: %+v", second.Error)
	}
	two := decodeInto[runtime.TaskResult](t, second.Result)
	if two.Deduplicated || two.Task.TaskID == one.Task.TaskID {
		t.Fatalf("continuation must be a new task: %+v", two)
	}
	if two.Task.SessionID != one.Task.SessionID {
		t.Fatalf("continuation changed session: %q vs %q", two.Task.SessionID, one.Task.SessionID)
	}
	waitTaskCompleted(t, pc, two.Task.TaskID)

	got := calls()
	if len(got) != 2 {
		t.Fatalf("expected 2 turns, got %+v", got)
	}
	if got[0].ThreadID != "" {
		t.Fatalf("first turn must start a new thread, got thread %q", got[0].ThreadID)
	}
	if got[1].ThreadID != "thr_test_1" {
		t.Fatalf("continuation must resume thread thr_test_1, got %q", got[1].ThreadID)
	}

	// Both turns are listed, oldest first, with their replies.
	opened, _ = h.call(pc, "req-open-2", "session.open", map[string]any{
		"project_id": "proj-a", "session_id": one.Task.SessionID,
	})
	open2 := decodeInto[runtime.SessionOpenResult](t, opened.Result)
	if len(open2.Tasks) != 2 || open2.TasksTruncated {
		t.Fatalf("expected two turns, got %+v", open2)
	}
	if open2.Tasks[0].TaskID != one.Task.TaskID || open2.Tasks[1].TaskID != two.Task.TaskID {
		t.Fatalf("turns are not oldest first: %+v", open2.Tasks)
	}
	if open2.Tasks[1].ResultText != "reply to what word did I ask you to remember?" || open2.Tasks[1].State != runtime.TaskSucceeded {
		t.Fatalf("unexpected second turn: %+v", open2.Tasks[1])
	}

	// The session event sequence continues monotonically across turns.
	resumed, _ := h.call(pc, "req-resume", "events.resume", map[string]any{
		"session_id": one.Task.SessionID, "after_seq": 0,
	})
	evs := decodeInto[runtime.EventsResumeResult](t, resumed.Result)
	seenTasks := map[string]bool{}
	for i, ev := range evs.Events {
		if ev.Seq != int64(i+1) {
			t.Fatalf("non-monotonic seq at %d: %d", i, ev.Seq)
		}
		seenTasks[ev.TaskID] = true
	}
	if !seenTasks[one.Task.TaskID] || !seenTasks[two.Task.TaskID] {
		t.Fatalf("events of both turns expected in one session: %v", seenTasks)
	}
}

func TestTaskStartRejectsUnknownAndForeignSession(t *testing.T) {
	adapter, calls := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	unknown, _ := h.call(pc, "req-unknown", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": "sess_does_not_exist", "agent": "codex", "prompt": "hello",
	})
	if unknown.OK || unknown.Error == nil || unknown.Error.Code != "not_found" {
		t.Fatalf("expected not_found for an unknown session, got %+v", unknown)
	}

	first, _ := h.call(pc, "req-own", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": nil, "agent": "codex", "prompt": "hello",
	})
	one := decodeInto[runtime.TaskResult](t, first.Result)
	waitTaskCompleted(t, pc, one.Task.TaskID)

	// A session of project A cannot be continued through project B.
	foreign, _ := h.call(pc, "req-foreign", "task.start", map[string]any{
		"project_id": "proj-b", "session_id": one.Task.SessionID, "agent": "codex", "prompt": "hello",
	})
	if foreign.OK || foreign.Error == nil || foreign.Error.Code != "bad_request" {
		t.Fatalf("expected bad_request for a session of another project, got %+v", foreign)
	}

	// session.open applies the same rules.
	openUnknown, _ := h.call(pc, "req-open-unknown", "session.open", map[string]any{
		"project_id": "proj-a", "session_id": "sess_does_not_exist",
	})
	if openUnknown.OK || openUnknown.Error == nil || openUnknown.Error.Code != "not_found" {
		t.Fatalf("expected not_found from session.open, got %+v", openUnknown)
	}

	if got := calls(); len(got) != 1 {
		t.Fatalf("rejected continuations must not launch the agent, got %+v", got)
	}
}

func TestContinuationIsIdempotentByRequestID(t *testing.T) {
	adapter, calls := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	first, _ := h.call(pc, "req-a", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": nil, "agent": "codex", "prompt": "one",
	})
	one := decodeInto[runtime.TaskResult](t, first.Result)
	waitTaskCompleted(t, pc, one.Task.TaskID)

	params := map[string]any{
		"project_id": "proj-a", "session_id": one.Task.SessionID, "agent": "codex", "prompt": "two",
	}
	second, _ := h.call(pc, "req-b", "task.start", params)
	two := decodeInto[runtime.TaskResult](t, second.Result)
	waitTaskCompleted(t, pc, two.Task.TaskID)

	// A retry with the same request id and content returns the same turn and
	// does not start another one.
	retry, _ := h.call(pc, "req-b", "task.start", params)
	if !retry.OK {
		t.Fatalf("retry failed: %+v", retry.Error)
	}
	again := decodeInto[runtime.TaskResult](t, retry.Result)
	if !again.Deduplicated || again.Task.TaskID != two.Task.TaskID || again.Task.State != runtime.TaskSucceeded {
		t.Fatalf("expected deduplicated continuation %s, got %+v", two.Task.TaskID, again)
	}
	if got := calls(); len(got) != 2 {
		t.Fatalf("retry must not launch again, got %+v", got)
	}

	// The same request id with another prompt, or aimed at another session, conflicts.
	for name, changed := range map[string]map[string]any{
		"prompt":  {"project_id": "proj-a", "session_id": one.Task.SessionID, "agent": "codex", "prompt": "other"},
		"session": {"project_id": "proj-a", "session_id": nil, "agent": "codex", "prompt": "two"},
	} {
		resp, _ := h.call(pc, "req-b", "task.start", changed)
		if resp.OK || resp.Error == nil || resp.Error.Code != "request_id_conflict" {
			t.Fatalf("%s change: expected request_id_conflict, got %+v", name, resp)
		}
	}

	third, _ := h.call(pc, "req-c", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": one.Task.SessionID, "agent": "codex", "prompt": "three",
	})
	if !third.OK {
		t.Fatalf("third turn failed: %+v", third.Error)
	}
	three := decodeInto[runtime.TaskResult](t, third.Result)
	waitTaskCompleted(t, pc, three.Task.TaskID)
	if three.Task.SessionID != one.Task.SessionID {
		t.Fatalf("third turn left the session")
	}
}

func TestContinuationWhileTurnActiveIsBusy(t *testing.T) {
	gate := make(chan struct{})
	adapter, _ := continuationAdapter()
	inner := adapter.handler
	adapter.handler = func(ctx context.Context, req codex.StartTurnRequest, cb codex.TurnCallbacks, turn *fakeTurn) {
		if strings.HasPrefix(req.Prompt, "slow") {
			<-gate
		}
		inner(ctx, req, cb, turn)
	}
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	first, _ := h.call(pc, "req-slow", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": nil, "agent": "codex", "prompt": "slow one",
	})
	one := decodeInto[runtime.TaskResult](t, first.Result)

	busy, _ := h.call(pc, "req-next", "task.start", map[string]any{
		"project_id": "proj-a", "session_id": one.Task.SessionID, "agent": "codex", "prompt": "next",
	})
	if busy.OK || busy.Error == nil || busy.Error.Code != "project_busy" {
		t.Fatalf("expected project_busy while the previous turn is active, got %+v", busy)
	}
	close(gate)
	waitTaskCompleted(t, pc, one.Task.TaskID)
}
