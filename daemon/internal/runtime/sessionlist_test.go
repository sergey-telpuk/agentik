package runtime_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"fmt"
	"strings"
	"testing"

	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
)

func listSessions(t *testing.T, h *wireHarness, pc *phoneClient, reqID string, params map[string]any) runtime.SessionListResult {
	t.Helper()
	resp, _ := h.call(pc, reqID, "session.list", params)
	if !resp.OK {
		t.Fatalf("session.list failed: %+v", resp.Error)
	}
	return decodeInto[runtime.SessionListResult](t, resp.Result)
}

func startTurn(t *testing.T, h *wireHarness, pc *phoneClient, reqID, project string, sessionID any, prompt string) runtime.TaskView {
	t.Helper()
	resp, _ := h.call(pc, reqID, "task.start", map[string]any{
		"project_id": project, "session_id": sessionID, "agent": "codex", "prompt": prompt,
	})
	if !resp.OK {
		t.Fatalf("task.start %s failed: %+v", reqID, resp.Error)
	}
	view := decodeInto[runtime.TaskResult](t, resp.Result).Task
	waitTaskCompleted(t, pc, view.TaskID)
	return view
}

func TestSessionListReportsTitleStateAndTurnCountNewestFirst(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	a1 := startTurn(t, h, pc, "req-a1", "proj-a", nil, "first question of A")
	a2 := startTurn(t, h, pc, "req-a2", "proj-a", a1.SessionID, "second question of A")
	b1 := startTurn(t, h, pc, "req-b1", "proj-a", nil, "only question of B")
	other := startTurn(t, h, pc, "req-o1", "proj-b", nil, "question in the other project")

	// Make the ordering deterministic: A was last active before B.
	ctx := context.Background()
	for _, q := range []struct {
		sql string
		id  string
	}{
		{`UPDATE tasks SET created_at = 100, updated_at = 110 WHERE id = ?`, a1.TaskID},
		{`UPDATE tasks SET created_at = 120, updated_at = 130 WHERE id = ?`, a2.TaskID},
		{`UPDATE tasks SET created_at = 200, updated_at = 210 WHERE id = ?`, b1.TaskID},
	} {
		if _, err := h.db.SQL().ExecContext(ctx, q.sql, q.id); err != nil {
			t.Fatal(err)
		}
	}

	got := listSessions(t, h, pc, "req-list", map[string]any{"project_id": "proj-a"})
	if got.SessionsTruncated || len(got.Sessions) != 2 {
		t.Fatalf("expected two sessions of proj-a, got %+v", got)
	}
	newest, older := got.Sessions[0], got.Sessions[1]
	if newest.SessionID != b1.SessionID || older.SessionID != a1.SessionID {
		t.Fatalf("sessions are not ordered by latest activity: %+v", got.Sessions)
	}
	if older.Title != "first question of A" || older.TurnCount != 2 || older.LatestState != runtime.TaskSucceeded {
		t.Fatalf("unexpected summary of the two-turn session: %+v", older)
	}
	if older.ProjectID != "proj-a" || older.Agent != "codex" || older.UpdatedAt != 130 {
		t.Fatalf("unexpected identity fields: %+v", older)
	}
	if newest.Title != "only question of B" || newest.TurnCount != 1 {
		t.Fatalf("unexpected summary of the one-turn session: %+v", newest)
	}

	// The other project's session is not mixed in, and is listed on its own.
	if otherList := listSessions(t, h, pc, "req-list-b", map[string]any{"project_id": "proj-b"}); len(otherList.Sessions) != 1 ||
		otherList.Sessions[0].SessionID != other.SessionID {
		t.Fatalf("unexpected proj-b listing: %+v", otherList)
	}
}

func TestSessionListLatestStateFollowsNewestTurn(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	one := startTurn(t, h, pc, "req-1", "proj-a", nil, "question")
	two := startTurn(t, h, pc, "req-2", "proj-a", one.SessionID, "follow-up")
	if _, err := h.db.SQL().ExecContext(context.Background(),
		`UPDATE tasks SET created_at = 10 WHERE id = ?`, one.TaskID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.SQL().ExecContext(context.Background(),
		`UPDATE tasks SET state = 'failed', created_at = 20 WHERE id = ?`, two.TaskID); err != nil {
		t.Fatal(err)
	}
	got := listSessions(t, h, pc, "req-list", map[string]any{"project_id": "proj-a"})
	if len(got.Sessions) != 1 || got.Sessions[0].LatestState != runtime.TaskFailed || got.Sessions[0].Title != "question" {
		t.Fatalf("latest state must follow the newest turn and title the first: %+v", got.Sessions)
	}
}

func TestSessionListEmptyProjectAndSessionsWithoutTurns(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	empty := listSessions(t, h, pc, "req-empty", map[string]any{"project_id": "proj-a"})
	if empty.Sessions == nil || len(empty.Sessions) != 0 || empty.SessionsTruncated {
		t.Fatalf("an empty project must list an empty array, got %+v", empty)
	}

	// A session created by session.open that never received a turn has no
	// title and is not listed.
	opened, _ := h.call(pc, "req-open", "session.open", map[string]any{"project_id": "proj-a"})
	if !opened.OK {
		t.Fatalf("session.open failed: %+v", opened.Error)
	}
	if got := listSessions(t, h, pc, "req-still-empty", map[string]any{"project_id": "proj-a"}); len(got.Sessions) != 0 {
		t.Fatalf("a session without turns must not be listed: %+v", got.Sessions)
	}
}

func TestSessionListUnknownProjectAndBadParams(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	unknown, _ := h.call(pc, "req-unknown", "session.list", map[string]any{"project_id": "proj-missing"})
	if unknown.OK || unknown.Error == nil || unknown.Error.Code != "not_found" {
		t.Fatalf("expected not_found for an unknown project, got %+v", unknown)
	}
	bad, _ := h.call(pc, "req-bad", "session.list", map[string]any{"project_id": "proj-a", "surprise": true})
	if bad.OK || bad.Error == nil || bad.Error.Code != "bad_request" {
		t.Fatalf("expected bad_request for an unknown parameter, got %+v", bad)
	}
}

func TestSessionListTruncatesAndBoundsTitles(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)
	ctx := context.Background()

	const total = 60
	longTitle := strings.Repeat("я", 5000) // multi-byte on purpose
	for i := 0; i < total; i++ {
		id := fmt.Sprintf("sess_bulk_%03d", i)
		if _, err := h.db.SQL().ExecContext(ctx,
			`INSERT INTO agent_sessions (id, project_id, adapter, created_at) VALUES (?, 'proj-a', 'codex', ?)`,
			id, 1000+i); err != nil {
			t.Fatal(err)
		}
		if _, err := h.db.SQL().ExecContext(ctx,
			`INSERT INTO tasks (id, session_id, client_id, prompt, state, created_at, updated_at)
			 VALUES (?, ?, 1, ?, 'succeeded', ?, ?)`,
			fmt.Sprintf("task_bulk_%03d", i), id, longTitle, 1000+i, 1000+i); err != nil {
			t.Fatal(err)
		}
	}

	got := listSessions(t, h, pc, "req-list", map[string]any{"project_id": "proj-a"})
	if !got.SessionsTruncated || len(got.Sessions) != 50 {
		t.Fatalf("expected 50 sessions and a truncation flag, got %d truncated=%v", len(got.Sessions), got.SessionsTruncated)
	}
	if got.Sessions[0].SessionID != "sess_bulk_059" || got.Sessions[49].SessionID != "sess_bulk_010" {
		t.Fatalf("truncation must keep the most recent sessions: first %s last %s",
			got.Sessions[0].SessionID, got.Sessions[49].SessionID)
	}
	for _, s := range got.Sessions {
		if len(s.Title) > 250 || !strings.HasPrefix(s.Title, "я") {
			t.Fatalf("title must be bounded and valid UTF-8, got %d bytes", len(s.Title))
		}
	}
}
