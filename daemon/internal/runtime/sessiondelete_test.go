package runtime_test

import (
	"crypto/ecdh"
	"crypto/rand"
	"testing"

	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
)

// TestSessionDeleteRemovesTheConversation deletes one conversation and checks
// that it is gone from the list while the other one is untouched.
func TestSessionDeleteRemovesTheConversation(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	first := startTurn(t, h, pc, "req-1", "proj-a", nil, "first conversation")
	second := startTurn(t, h, pc, "req-2", "proj-a", nil, "second conversation")

	resp, _ := h.call(pc, "req-del", "session.delete", map[string]any{
		"project_id": "proj-a", "session_id": first.SessionID,
	})
	if !resp.OK {
		t.Fatalf("session.delete failed: %+v", resp.Error)
	}
	result := decodeInto[runtime.SessionDeleteResult](t, resp.Result)
	if result.SessionID != first.SessionID || !result.Deleted {
		t.Fatalf("unexpected result: %+v", result)
	}

	listed := listSessions(t, h, pc, "req-list", map[string]any{"project_id": "proj-a"})
	for _, s := range listed.Sessions {
		if s.SessionID == first.SessionID {
			t.Fatal("the deleted conversation is still listed")
		}
	}
	found := false
	for _, s := range listed.Sessions {
		if s.SessionID == second.SessionID {
			found = true
		}
	}
	if !found {
		t.Fatal("deleting one conversation removed another")
	}

	// The turns are gone too, not just the session row.
	opened, _ := h.call(pc, "req-open", "session.open", map[string]any{
		"project_id": "proj-a", "session_id": first.SessionID,
	})
	if opened.OK {
		t.Fatal("session.open still returns the deleted conversation")
	}
}

// TestSessionDeleteRejectsUnknownAndForeignSessions checks that a session id
// alone cannot reach a conversation outside the named project.
func TestSessionDeleteRejectsUnknownAndForeignSessions(t *testing.T) {
	adapter, _ := continuationAdapter()
	h := newHarness(t, adapter)
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, key)

	view := startTurn(t, h, pc, "req-1", "proj-a", nil, "a conversation")

	cases := []struct {
		name    string
		params  map[string]any
		wantErr string
	}{
		{"unknown session", map[string]any{"project_id": "proj-a", "session_id": "sess_missing"}, "not_found"},
		{"unknown project", map[string]any{"project_id": "proj-missing", "session_id": view.SessionID}, "not_found"},
		{"session of another project", map[string]any{"project_id": "proj-b", "session_id": view.SessionID}, "not_found"},
		{"empty session id", map[string]any{"project_id": "proj-a", "session_id": ""}, "bad_request"},
		{"unexpected parameter", map[string]any{"project_id": "proj-a", "session_id": view.SessionID, "surprise": true}, "bad_request"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, _ := h.call(pc, "req-"+tc.name, "session.delete", tc.params)
			if resp.OK {
				t.Fatal("expected the request to be refused")
			}
			if resp.Error.Code != tc.wantErr {
				t.Fatalf("got error %q, want %q", resp.Error.Code, tc.wantErr)
			}
		})
	}

	// The conversation survived every refused attempt.
	listed := listSessions(t, h, pc, "req-list", map[string]any{"project_id": "proj-a"})
	if len(listed.Sessions) != 1 {
		t.Fatalf("got %d sessions, want the original one", len(listed.Sessions))
	}
}
