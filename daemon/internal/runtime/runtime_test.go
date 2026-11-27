package runtime_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents/codex"
	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/pairing"
	"github.com/sergey-telpuk/agentik/daemon/internal/projects"
	"github.com/sergey-telpuk/agentik/daemon/internal/runtime"
	"github.com/sergey-telpuk/agentik/daemon/internal/secure"
	"github.com/sergey-telpuk/agentik/daemon/internal/storage"
)

// fakeAdapter implements codex.Adapter deterministically for runtime tests.
type fakeAdapter struct {
	status      codex.AgentStatus
	launchCount atomic.Int64
	mu          sync.Mutex
	handler     func(ctx context.Context, req codex.StartTurnRequest, cb codex.TurnCallbacks, turn *fakeTurn)
}

func (f *fakeAdapter) Name() string { return codex.AgentName }
func (f *fakeAdapter) Capabilities() codex.Capabilities {
	return codex.Capabilities{SupportsResume: true, SupportsCancel: true}
}
func (f *fakeAdapter) Diagnose(_ context.Context) codex.AgentStatus { return f.status }

func (f *fakeAdapter) StartTurn(ctx context.Context, req codex.StartTurnRequest, cb codex.TurnCallbacks) (codex.ActiveTurn, error) {
	f.launchCount.Add(1)
	turn := &fakeTurn{
		done:        make(chan codex.TurnResult, 1),
		interruptCh: make(chan struct{}),
	}
	f.mu.Lock()
	h := f.handler
	f.mu.Unlock()

	if cb.OnStarted != nil {
		cb.OnStarted("thr_test_1", "turn_test_1")
	}
	go h(ctx, req, cb, turn)
	return turn, nil
}

type fakeTurn struct {
	done        chan codex.TurnResult
	interruptCh chan struct{}
	once        sync.Once
}

func (t *fakeTurn) Interrupt(_ context.Context) error {
	t.once.Do(func() { close(t.interruptCh) })
	return nil
}

func (t *fakeTurn) Wait() codex.TurnResult { return <-t.done }

// wireHarness connects an in-memory Go Noise initiator to runtime.Hub via secure.Manager.
type wireHarness struct {
	t        *testing.T
	db       *storage.DB
	id       *identity.Identity
	pairing  *pairing.Service
	hub      *runtime.Hub
	projDirA string
	projDirB string
	adapter  *fakeAdapter

	mu      sync.Mutex
	toPhone map[string]*phoneClient
}

type phoneClient struct {
	connID  string
	key     *ecdh.PrivateKey
	session *secure.Session

	mu         sync.Mutex
	inbox      [][]byte
	seenEvents []runtime.OutboundEvent
	notify     chan struct{}
}

func newHarness(t *testing.T, adapter *fakeAdapter, opts ...func(*runtime.Config)) *wireHarness {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, storage.InMemory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	id, err := identity.Generate()
	if err != nil {
		t.Fatal(err)
	}
	pairSvc, err := pairing.NewService(pairing.Config{
		DB:       db,
		Identity: id,
	})
	if err != nil {
		t.Fatal(err)
	}

	dirA := t.TempDir()
	dirB := t.TempDir()
	cat, err := projects.NewCatalogue([]projects.Project{
		{ID: "proj-a", Name: "Alpha", Root: dirA, AllowedAgent: codex.AgentName},
		{ID: "proj-b", Name: "Beta", Root: dirB, AllowedAgent: codex.AgentName},
	})
	if err != nil {
		t.Fatal(err)
	}

	h := &wireHarness{
		t:        t,
		db:       db,
		id:       id,
		pairing:  pairSvc,
		projDirA: dirA,
		projDirB: dirB,
		adapter:  adapter,
		toPhone:  make(map[string]*phoneClient),
	}

	sender := frameSenderFunc(func(_ context.Context, connID string, data []byte) error {
		h.mu.Lock()
		pc := h.toPhone[connID]
		h.mu.Unlock()
		if pc == nil {
			return errors.New("phone disconnected")
		}
		cp := append([]byte(nil), data...)
		pc.mu.Lock()
		pc.inbox = append(pc.inbox, cp)
		pc.mu.Unlock()
		select {
		case pc.notify <- struct{}{}:
		default:
		}
		return nil
	})

	rtCfg := runtime.Config{
		DB:       db,
		Identity: id,
		Pairing:  pairSvc,
		Projects: cat,
		Agents:   map[string]codex.Adapter{codex.AgentName: adapter},
	}
	for _, o := range opts {
		o(&rtCfg)
	}

	hub, err := runtime.NewHub(id, pairSvc, rtCfg, sender, devicePrologue(id), func(connID string, err error) {
		t.Logf("secure error [%s]: %v", connID, err)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(hub.Close)
	h.hub = hub
	return h
}

// devicePrologue gives every connection the base prologue. The WebRTC
// acceptor supplies a fingerprint-bound one in production.
func devicePrologue(id *identity.Identity) func(string) ([]byte, error) {
	return func(string) ([]byte, error) { return secure.DevicePrologue(id.DeviceID()), nil }
}

type frameSenderFunc func(ctx context.Context, connID string, data []byte) error

func (f frameSenderFunc) SendFrame(ctx context.Context, connID string, data []byte) error {
	return f(ctx, connID, data)
}

func (h *wireHarness) connectPhone(key *ecdh.PrivateKey) (*phoneClient, error) {
	h.t.Helper()
	if key == nil {
		var err error
		key, err = ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
	}
	connID := fmt.Sprintf("conn-%d-%d", time.Now().UnixNano(), len(h.toPhone)+1)
	pc := &phoneClient{
		connID: connID,
		key:    key,
		notify: make(chan struct{}, 64),
	}
	h.mu.Lock()
	h.toPhone[connID] = pc
	h.mu.Unlock()

	ctx := context.Background()
	h.hub.Manager().HandlePeerState(ctx, connID, true)

	hs, err := secure.NewHandshake(secure.Config{
		Initiator: true,
		StaticKey: key,
		Prologue:  secure.DevicePrologue(h.id.DeviceID()),
		VerifyPeer: func(peerStatic []byte) error {
			if !equalSlice(peerStatic, h.id.NoisePublicKey()) {
				return errors.New("pin mismatch")
			}
			return nil
		},
	})
	if err != nil {
		return nil, err
	}

	msg1, err := hs.WriteMessage(nil)
	if err != nil {
		return nil, err
	}
	h.hub.Manager().HandleFrame(ctx, connID, msg1)

	msg2, err := pc.popRaw(time.Second)
	if err != nil {
		return nil, err
	}
	if _, err := hs.ReadMessage(msg2); err != nil {
		return nil, err
	}
	msg3, err := hs.WriteMessage(nil)
	if err != nil {
		return nil, err
	}
	h.hub.Manager().HandleFrame(ctx, connID, msg3)

	if _, ok := h.hub.Manager().Session(connID); !ok {
		return nil, errors.New("daemon rejected phone handshake")
	}
	sess, err := hs.Session()
	if err != nil {
		return nil, err
	}
	pc.session = sess
	return pc, nil
}

func (pc *phoneClient) popRaw(timeout time.Duration) ([]byte, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		pc.mu.Lock()
		if len(pc.inbox) > 0 {
			msg := pc.inbox[0]
			pc.inbox = pc.inbox[1:]
			pc.mu.Unlock()
			return msg, nil
		}
		pc.mu.Unlock()
		select {
		case <-pc.notify:
		case <-deadline.C:
			return nil, errors.New("timed out waiting for frame")
		}
	}
}

func (h *wireHarness) call(pc *phoneClient, reqID, method string, params any) (runtime.OutboundResponse, []runtime.OutboundEvent) {
	h.t.Helper()
	rawParams, _ := json.Marshal(params)
	reqBytes, _ := json.Marshal(runtime.InboundRequest{
		V:         1,
		RequestID: reqID,
		Method:    method,
		Params:    rawParams,
	})
	ct, err := pc.session.Encrypt(reqBytes)
	if err != nil {
		h.t.Fatal(err)
	}
	h.hub.Manager().HandleFrame(context.Background(), pc.connID, ct)

	var events []runtime.OutboundEvent
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := pc.popRaw(time.Until(deadline))
		if err != nil {
			h.t.Fatalf("call %s (%s): %v", method, reqID, err)
		}
		pt, err := pc.session.Decrypt(raw)
		if err != nil {
			h.t.Fatal(err)
		}
		var probe struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(pt, &probe)
		if probe.Type == "event" {
			var ev runtime.OutboundEvent
			_ = json.Unmarshal(pt, &ev)
			events = append(events, ev)
			pc.mu.Lock()
			pc.seenEvents = append(pc.seenEvents, ev)
			pc.mu.Unlock()
			continue
		}
		var resp runtime.OutboundResponse
		if err := json.Unmarshal(pt, &resp); err != nil {
			h.t.Fatal(err)
		}
		if resp.RequestID == reqID {
			return resp, events
		}
	}
	h.t.Fatalf("no response for %s", reqID)
	return runtime.OutboundResponse{}, nil
}

func (pc *phoneClient) waitEvent(t *testing.T, timeout time.Duration, pred func(runtime.OutboundEvent) bool) runtime.OutboundEvent {
	t.Helper()
	pc.mu.Lock()
	for _, ev := range pc.seenEvents {
		if pred(ev) {
			pc.mu.Unlock()
			return ev
		}
	}
	pc.mu.Unlock()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		raw, err := pc.popRaw(time.Until(deadline))
		if err != nil {
			t.Fatalf("waitEvent: %v", err)
		}
		pt, err := pc.session.Decrypt(raw)
		if err != nil {
			t.Fatal(err)
		}
		var ev runtime.OutboundEvent
		if json.Unmarshal(pt, &ev) == nil && ev.Type == "event" {
			pc.mu.Lock()
			pc.seenEvents = append(pc.seenEvents, ev)
			pc.mu.Unlock()
			if pred(ev) {
				return ev
			}
		}
	}
	t.Fatal("timed out waiting for matching event")
	return runtime.OutboundEvent{}
}

func pairPhone(t *testing.T, h *wireHarness, key *ecdh.PrivateKey) *phoneClient {
	t.Helper()
	inv, err := h.pairing.CreateInvitation(context.Background(), "wss://relay.example.com", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := pairing.ParseInvitation(inv.InvitationText, time.Now())
	if err != nil {
		t.Fatal(err)
	}

	pc, err := h.connectPhone(key)
	if err != nil {
		t.Fatal(err)
	}

	sum := sha256.Sum256(parsed.InvitationSecret)
	resp, _ := h.call(pc, "req-pair", "pair.submit", map[string]any{
		"invitation_id":     base64.RawURLEncoding.EncodeToString(sum[:]),
		"invitation_secret": base64.RawURLEncoding.EncodeToString(parsed.InvitationSecret),
		"label":             "Test Phone",
	})
	if !resp.OK {
		t.Fatalf("pair.submit failed: %+v", resp.Error)
	}

	// While awaiting_local_approval, project.list must be refused.
	unauthResp, _ := h.call(pc, "req-proj-unauth", "project.list", map[string]any{})
	if unauthResp.OK || unauthResp.Error == nil || unauthResp.Error.Code != "unauthorized" {
		t.Fatalf("expected unauthorized before local confirmation, got %+v", unauthResp)
	}

	pending := h.pairing.ListPending()
	if len(pending) != 1 {
		t.Fatalf("expected 1 pending confirmation, got %d", len(pending))
	}
	trusted, err := h.pairing.ConfirmPairing(context.Background(), pending[0].ID, "")
	if err != nil {
		t.Fatal(err)
	}
	h.hub.NotifyPeerPaired(context.Background(), trusted.NoisePublicKey, "paired")

	ev := pc.waitEvent(t, time.Second, func(e runtime.OutboundEvent) bool { return e.Event == "pair.updated" })
	b, _ := json.Marshal(ev.Data)
	var data runtime.PairUpdatedEventData
	_ = json.Unmarshal(b, &data)
	if data.State != "paired" {
		t.Fatalf("expected pair.updated state=paired, got %+v", data)
	}
	return pc
}

func equalSlice(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestPairingTaskIdempotencyEventsResumeAndChanges(t *testing.T) {
	adapter := &fakeAdapter{
		status: codex.AgentStatus{
			Name:          codex.AgentName,
			Available:     true,
			Authenticated: true,
			Version:       "codex-cli 0.160.0",
			Capabilities:  codex.Capabilities{SupportsResume: true, SupportsCancel: true},
		},
		handler: func(_ context.Context, req codex.StartTurnRequest, cb codex.TurnCallbacks, turn *fakeTurn) {
			cb.OnEvent(codex.Event{Kind: codex.EventDelta, Text: "Working on " + req.Prompt})
			cb.OnEvent(codex.Event{
				Kind:    codex.EventDiff,
				Text:    "--- a/main.go\n+++ b/main.go\n",
				Payload: map[string]any{"diff": "--- a/main.go\n+++ b/main.go\n"},
			})
			turn.done <- codex.TurnResult{
				Status:     codex.OutcomeSucceeded,
				ThreadID:   "thr_test_1",
				TurnID:     "turn_test_1",
				ResultText: "All checks green",
				Diff:       "--- a/main.go\n+++ b/main.go\n",
			}
		},
	}

	h := newHarness(t, adapter)

	// Unknown phone cannot connect when no invitation exists.
	if _, err := h.connectPhone(nil); err == nil {
		t.Fatal("expected unknown phone handshake rejection when no invitation exists")
	}

	phoneKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, phoneKey)

	// project.list returns project IDs only (never filesystem paths).
	projResp, _ := h.call(pc, "req-proj", "project.list", map[string]any{})
	if !projResp.OK {
		t.Fatalf("project.list failed: %+v", projResp.Error)
	}
	rawProj, _ := json.Marshal(projResp.Result)
	if contains(string(rawProj), h.projDirA) {
		t.Fatalf("project.list leaked filesystem path %q in %s", h.projDirA, rawProj)
	}

	// Start task with request_id "req-task-1".
	startResp, _ := h.call(pc, "req-task-1", "task.start", map[string]any{
		"project_id": "proj-a",
		"session_id": nil,
		"agent":      "codex",
		"prompt":     "Run tests",
	})
	if !startResp.OK {
		t.Fatalf("task.start failed: %+v", startResp.Error)
	}
	var startRes runtime.TaskResult
	b, _ := json.Marshal(startResp.Result)
	_ = json.Unmarshal(b, &startRes)
	if startRes.Deduplicated || startRes.Task.TaskID == "" || startRes.Task.State != runtime.TaskAccepted {
		t.Fatalf("unexpected task.start result: %+v", startRes)
	}

	// Wait for completed event.
	pc.waitEvent(t, 2*time.Second, func(e runtime.OutboundEvent) bool {
		m, _ := json.Marshal(e.Data)
		return contains(string(m), `"completed"`) && contains(string(m), `"succeeded"`)
	})

	// Duplicate task.start with same request_id + same params returns same task without second launch.
	dupResp, _ := h.call(pc, "req-task-1", "task.start", map[string]any{
		"project_id": "proj-a",
		"session_id": nil,
		"agent":      "codex",
		"prompt":     "Run tests",
	})
	if !dupResp.OK {
		t.Fatalf("deduplicated task.start failed: %+v", dupResp.Error)
	}
	var dupRes runtime.TaskResult
	b, _ = json.Marshal(dupResp.Result)
	_ = json.Unmarshal(b, &dupRes)
	if !dupRes.Deduplicated || dupRes.Task.TaskID != startRes.Task.TaskID || dupRes.Task.State != runtime.TaskSucceeded {
		t.Fatalf("expected deduplicated succeeded task %s, got %+v", startRes.Task.TaskID, dupRes)
	}
	if adapter.launchCount.Load() != 1 {
		t.Fatalf("expected exactly 1 launch, got %d", adapter.launchCount.Load())
	}

	// Same request_id with changed content -> request_id_conflict.
	conflictResp, _ := h.call(pc, "req-task-1", "task.start", map[string]any{
		"project_id": "proj-a",
		"session_id": nil,
		"agent":      "codex",
		"prompt":     "Run DIFFERENT prompt",
	})
	if conflictResp.OK || conflictResp.Error == nil || conflictResp.Error.Code != "request_id_conflict" {
		t.Fatalf("expected request_id_conflict, got %+v", conflictResp)
	}

	// events.resume returns ordered monotonic sequence numbers.
	resEv, _ := h.call(pc, "req-ev", "events.resume", map[string]any{
		"session_id": startRes.Task.SessionID,
		"after_seq":  0,
	})
	if !resEv.OK {
		t.Fatalf("events.resume failed: %+v", resEv.Error)
	}
	var evRes runtime.EventsResumeResult
	b, _ = json.Marshal(resEv.Result)
	_ = json.Unmarshal(b, &evRes)
	if len(evRes.Events) < 4 {
		t.Fatalf("expected >=4 events, got %d", len(evRes.Events))
	}
	for i, ev := range evRes.Events {
		if ev.Seq != int64(i+1) {
			t.Fatalf("non-monotonic seq at %d: got %d", i, ev.Seq)
		}
	}

	// changes.get returns the bounded diff.
	diffResp, _ := h.call(pc, "req-diff", "changes.get", map[string]any{"task_id": startRes.Task.TaskID})
	if !diffResp.OK {
		t.Fatalf("changes.get failed: %+v", diffResp.Error)
	}
	var chRes runtime.ChangesResult
	b, _ = json.Marshal(diffResp.Result)
	_ = json.Unmarshal(b, &chRes)
	if !contains(chRes.Diff, "+++ b/main.go") {
		t.Fatalf("expected diff, got %+v", chRes)
	}
}

func TestProjectBusyApprovalsCancelAndRevocation(t *testing.T) {
	gate := make(chan struct{})
	adapter := &fakeAdapter{
		status: codex.AgentStatus{
			Name:          codex.AgentName,
			Available:     true,
			Authenticated: true,
			Capabilities:  codex.Capabilities{SupportsResume: true, SupportsCancel: true},
		},
		handler: func(ctx context.Context, req codex.StartTurnRequest, cb codex.TurnCallbacks, turn *fakeTurn) {
			if req.Prompt == "needs-approval" {
				ok, err := cb.OnApproval(ctx, codex.ApprovalRequest{
					RequestID: "r1",
					Kind:      codex.ApprovalCommand,
					Summary:   "go test ./...",
				})
				if err != nil || !ok {
					turn.done <- codex.TurnResult{Status: codex.OutcomeFailed, Error: "declined"}
					return
				}
				turn.done <- codex.TurnResult{Status: codex.OutcomeSucceeded, ResultText: "approved ok"}
				return
			}
			select {
			case <-turn.interruptCh:
				turn.done <- codex.TurnResult{Status: codex.OutcomeCancelled}
			case <-gate:
				turn.done <- codex.TurnResult{Status: codex.OutcomeSucceeded}
			}
		},
	}

	h := newHarness(t, adapter)
	phoneKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, phoneKey)

	// Start task 1 in proj-a waiting on approval.
	resp1, _ := h.call(pc, "req-apr-task", "task.start", map[string]any{
		"project_id": "proj-a",
		"session_id": nil,
		"agent":      "codex",
		"prompt":     "needs-approval",
	})
	if !resp1.OK {
		t.Fatalf("task.start failed: %+v", resp1.Error)
	}

	// Wait for approval_requested event.
	ev := pc.waitEvent(t, 2*time.Second, func(e runtime.OutboundEvent) bool {
		m, _ := json.Marshal(e.Data)
		return contains(string(m), `"approval_requested"`)
	})
	var evView runtime.SessionEventView
	b, _ := json.Marshal(ev.Data)
	_ = json.Unmarshal(b, &evView)
	aprID, _ := evView.Payload["approval_id"].(string)
	if aprID == "" {
		t.Fatalf("missing approval_id in %+v", evView)
	}

	// Second task in proj-a while active -> project_busy.
	busyResp, _ := h.call(pc, "req-busy", "task.start", map[string]any{
		"project_id": "proj-a",
		"session_id": nil,
		"agent":      "codex",
		"prompt":     "second",
	})
	if busyResp.OK || busyResp.Error == nil || busyResp.Error.Code != "project_busy" {
		t.Fatalf("expected project_busy, got %+v", busyResp)
	}

	// Second task in proj-b succeeds concurrently and can be cancelled cleanly.
	bResp, _ := h.call(pc, "req-b-start", "task.start", map[string]any{
		"project_id": "proj-b",
		"session_id": nil,
		"agent":      "codex",
		"prompt":     "wait-for-cancel",
	})
	if !bResp.OK {
		t.Fatalf("proj-b task.start failed: %+v", bResp.Error)
	}
	var bTaskRes runtime.TaskResult
	b, _ = json.Marshal(bResp.Result)
	_ = json.Unmarshal(b, &bTaskRes)

	cancelResp, _ := h.call(pc, "req-b-cancel", "task.cancel", map[string]any{"task_id": bTaskRes.Task.TaskID})
	if !cancelResp.OK {
		t.Fatalf("task.cancel failed: %+v", cancelResp.Error)
	}
	pc.waitEvent(t, 2*time.Second, func(e runtime.OutboundEvent) bool {
		m, _ := json.Marshal(e.Data)
		return contains(string(m), bTaskRes.Task.TaskID) && contains(string(m), `"cancelled"`)
	})

	// Approve task 1 once -> succeeds.
	aprResp, _ := h.call(pc, "req-apr-1", "approval.resolve", map[string]any{
		"approval_id": aprID,
		"decision":    "accept",
	})
	if !aprResp.OK {
		t.Fatalf("approval.resolve failed: %+v", aprResp.Error)
	}
	// Replay approval -> rejected!
	aprReplay, _ := h.call(pc, "req-apr-2", "approval.resolve", map[string]any{
		"approval_id": aprID,
		"decision":    "accept",
	})
	if aprReplay.OK || aprReplay.Error == nil || aprReplay.Error.Code != "approval_already_resolved" {
		t.Fatalf("expected approval_already_resolved, got %+v", aprReplay)
	}
	pc.waitEvent(t, 2*time.Second, func(e runtime.OutboundEvent) bool {
		m, _ := json.Marshal(e.Data)
		return contains(string(m), `"succeeded"`)
	})

	// Revoke phone -> active session closes and reconnect is refused.
	if err := h.hub.RevokePeer(context.Background(), phoneKey.PublicKey().Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.hub.Manager().Session(pc.connID); ok {
		t.Fatal("expected active session to be closed on revocation")
	}
	if _, err := h.connectPhone(phoneKey); err == nil {
		t.Fatal("expected revoked phone reconnect to be rejected")
	}
	close(gate)
}

func TestMissingCodexAndCrashRecoveryRequired(t *testing.T) {
	// 1. Missing Codex reports failed without entering running.
	missingAdapter := &fakeAdapter{
		status: codex.AgentStatus{
			Name:      codex.AgentName,
			Available: false,
			Detail:    "codex binary not found",
		},
		handler: func(_ context.Context, _ codex.StartTurnRequest, _ codex.TurnCallbacks, _ *fakeTurn) {
			t.Error("StartTurn must not be called when binary is missing")
		},
	}
	h1 := newHarness(t, missingAdapter)
	k1, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc1 := pairPhone(t, h1, k1)
	r1, _ := h1.call(pc1, "req-missing", "task.start", map[string]any{
		"project_id": "proj-a",
		"session_id": nil,
		"agent":      "codex",
		"prompt":     "hello",
	})
	var tr1 runtime.TaskResult
	b, _ := json.Marshal(r1.Result)
	_ = json.Unmarshal(b, &tr1)
	pc1.waitEvent(t, 2*time.Second, func(e runtime.OutboundEvent) bool {
		m, _ := json.Marshal(e.Data)
		return contains(string(m), `"failed"`)
	})
	// Check SQLite events never recorded "running".
	evResp, _ := h1.call(pc1, "req-m-ev", "events.resume", map[string]any{
		"session_id": tr1.Task.SessionID,
		"after_seq":  0,
	})
	rawEvs, _ := json.Marshal(evResp.Result)
	if contains(string(rawEvs), `"running"`) {
		t.Fatalf("missing codex must never enter running state: %s", rawEvs)
	}

	// 2. Indeterminate crash between SQLite 'starting' write and launch -> recovery_required on restart, never auto-retried.
	ctx := context.Background()
	db, err := storage.Open(ctx, storage.InMemory)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	id, _ := identity.Generate()
	pairSvc, _ := pairing.NewService(pairing.Config{DB: db, Identity: id})
	cat, _ := projects.NewCatalogue([]projects.Project{
		{ID: "proj-a", Name: "Alpha", Root: t.TempDir(), AllowedAgent: codex.AgentName},
	})
	crashAdapter := &fakeAdapter{
		status: codex.AgentStatus{Name: codex.AgentName, Available: true, Authenticated: true},
		handler: func(_ context.Context, _ codex.StartTurnRequest, _ codex.TurnCallbacks, _ *fakeTurn) {
			t.Error("crashed launch must not auto-retry on restart")
		},
	}

	crashed := make(chan string, 1)
	svc1, err := runtime.NewService(ctx, runtime.Config{
		DB:       db,
		Identity: id,
		Pairing:  pairSvc,
		Projects: cat,
		Agents:   map[string]codex.Adapter{codex.AgentName: crashAdapter},
		BeforeLaunchHook: func(_ context.Context, taskID string) error {
			crashed <- taskID
			return runtime.ErrSimulatedCrash
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	inv, _ := pairSvc.CreateInvitation(ctx, "wss://relay.example.com", time.Minute)
	parsed, _ := pairing.ParseInvitation(inv.InvitationText, time.Now())
	k2, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pend, _ := pairSvc.SubmitPairing(ctx, pairing.SubmitRequest{
		ClientNoisePublicKey: k2.PublicKey().Bytes(),
		InvitationSecret:     parsed.InvitationSecret,
	})
	_, _ = pairSvc.ConfirmPairing(ctx, pend.ID, "")

	svc1.Close()
	hub, err := runtime.NewHub(id, pairSvc, runtime.Config{
		DB:       db,
		Identity: id,
		Pairing:  pairSvc,
		Projects: cat,
		Agents:   map[string]codex.Adapter{codex.AgentName: crashAdapter},
		BeforeLaunchHook: func(_ context.Context, taskID string) error {
			select {
			case crashed <- taskID:
			default:
			}
			return runtime.ErrSimulatedCrash
		},
	}, frameSenderFunc(func(_ context.Context, _ string, _ []byte) error { return nil }), devicePrologue(id), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = crashed

	_, err = db.SQL().ExecContext(ctx,
		`INSERT INTO agent_sessions (id, project_id, adapter, created_at) VALUES ('sess_crash', 'proj-a', 'codex', 100)`,
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.SQL().ExecContext(ctx,
		`INSERT INTO tasks (id, session_id, client_id, prompt, state, created_at, updated_at)
		 VALUES ('task_crash', 'sess_crash', 1, 'crash test', 'starting', 100, 100)`,
	)
	if err != nil {
		t.Fatal(err)
	}
	hub.Close()

	svc2, err := runtime.NewService(ctx, runtime.Config{
		DB:       db,
		Identity: id,
		Pairing:  pairSvc,
		Projects: cat,
		Agents:   map[string]codex.Adapter{codex.AgentName: crashAdapter},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer svc2.Close()

	var state string
	if err := db.SQL().QueryRowContext(ctx, `SELECT state FROM tasks WHERE id = 'task_crash'`).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(runtime.TaskRecoveryRequired) {
		t.Fatalf("expected recovery_required after restart, got %q", state)
	}
	if crashAdapter.launchCount.Load() != 0 {
		t.Fatalf("crashed task must never auto-retry, got %d launches", crashAdapter.launchCount.Load())
	}
}

func TestFaultInjectionBeforeLaunchAndApprovalExpiry(t *testing.T) {
	crashedID := make(chan string, 1)
	crashAdapter := &fakeAdapter{
		status: codex.AgentStatus{Name: codex.AgentName, Available: true, Authenticated: true},
		handler: func(_ context.Context, _ codex.StartTurnRequest, _ codex.TurnCallbacks, _ *fakeTurn) {
			t.Error("StartTurn must not run after BeforeLaunchHook simulated crash")
		},
	}
	h := newHarness(t, crashAdapter, func(cfg *runtime.Config) {
		cfg.BeforeLaunchHook = func(_ context.Context, taskID string) error {
			crashedID <- taskID
			return runtime.ErrSimulatedCrash
		}
	})
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pc := pairPhone(t, h, k)
	resp, _ := h.call(pc, "req-crash-start", "task.start", map[string]any{
		"project_id": "proj-a",
		"session_id": nil,
		"agent":      "codex",
		"prompt":     "crash during launch",
	})
	if !resp.OK {
		t.Fatalf("task.start failed: %+v", resp.Error)
	}
	tid := <-crashedID

	restarted, err := runtime.NewService(context.Background(), runtime.Config{
		DB:       h.db,
		Identity: h.id,
		Pairing:  h.pairing,
		Projects: func() *projects.Catalogue {
			c, _ := projects.NewCatalogue([]projects.Project{
				{ID: "proj-a", Name: "Alpha", Root: h.projDirA, AllowedAgent: codex.AgentName},
			})
			return c
		}(),
		Agents: map[string]codex.Adapter{codex.AgentName: crashAdapter},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()

	var state string
	if err := h.db.SQL().QueryRow(`SELECT state FROM tasks WHERE id = ?`, tid).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != string(runtime.TaskRecoveryRequired) {
		t.Fatalf("expected recovery_required after crash, got %q", state)
	}

	var gotApproved atomic.Bool
	expAdapter := &fakeAdapter{
		status: codex.AgentStatus{Name: codex.AgentName, Available: true, Authenticated: true},
		handler: func(ctx context.Context, _ codex.StartTurnRequest, cb codex.TurnCallbacks, turn *fakeTurn) {
			ok, _ := cb.OnApproval(ctx, codex.ApprovalRequest{
				RequestID: "r-exp",
				Kind:      codex.ApprovalFileChange,
				Summary:   "modify file",
			})
			gotApproved.Store(ok)
			if !ok {
				turn.done <- codex.TurnResult{Status: codex.OutcomeFailed, Error: "approval expired"}
				return
			}
			turn.done <- codex.TurnResult{Status: codex.OutcomeSucceeded}
		},
	}
	hExp := newHarness(t, expAdapter, func(cfg *runtime.Config) {
		cfg.ApprovalTTL = 40 * time.Millisecond
	})
	kExp, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pcExp := pairPhone(t, hExp, kExp)
	_, _ = hExp.call(pcExp, "req-exp-task", "task.start", map[string]any{
		"project_id": "proj-a",
		"session_id": nil,
		"agent":      "codex",
		"prompt":     "expire approval",
	})
	pcExp.waitEvent(t, 2*time.Second, func(e runtime.OutboundEvent) bool {
		m, _ := json.Marshal(e.Data)
		return contains(string(m), `"failed"`)
	})
	if gotApproved.Load() {
		t.Fatal("expired approval must never auto-approve")
	}
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
