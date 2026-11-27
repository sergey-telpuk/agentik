package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestHelperProcess emulates `codex` CLI and `codex app-server --listen stdio://`
// for deterministic subprocess tests without depending on network/API credits.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	mode := os.Getenv("AGENTIK_FAKE_CODEX_MODE")

	args := os.Args
	idx := 0
	for idx < len(args) && args[idx] != "--" {
		idx++
	}
	var sub []string
	if idx+1 < len(args) {
		sub = args[idx+1:]
	}

	if len(sub) > 0 && sub[0] == "--version" {
		fmt.Println("codex-cli 0.160.0")
		os.Exit(0)
	}
	if len(sub) >= 2 && sub[0] == "login" && sub[1] == "status" {
		if mode == "unauthenticated" {
			fmt.Println("Not logged in")
			os.Exit(1)
		}
		fmt.Println("Logged in using ChatGPT")
		os.Exit(0)
	}
	if len(sub) == 0 || sub[0] != "app-server" {
		os.Exit(2)
	}

	scanner := bufio.NewScanner(os.Stdin)
	writeMsg := func(v any) {
		b, _ := json.Marshal(v)
		fmt.Println(string(b))
	}

	var threadID = "thr_fake_1"
	var turnID = "turn_fake_1"

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal([]byte(line), &req) != nil {
			continue
		}

		switch req.Method {
		case "initialize":
			writeMsg(map[string]any{
				"id":     req.ID,
				"result": map[string]any{"userAgent": "codex-fake/0.160.0"},
			})
		case "initialized":
		case "thread/start":
			writeMsg(map[string]any{
				"id":     req.ID,
				"result": map[string]any{"thread": map[string]any{"id": threadID}},
			})
		case "thread/resume":
			var p struct {
				ThreadID string `json:"threadId"`
			}
			_ = json.Unmarshal(req.Params, &p)
			if p.ThreadID != "" {
				threadID = p.ThreadID
			}
			writeMsg(map[string]any{
				"id":     req.ID,
				"result": map[string]any{"thread": map[string]any{"id": threadID}},
			})
		case "model/list":
			var p struct {
				Cursor string `json:"cursor"`
			}
			_ = json.Unmarshal(req.Params, &p)
			if mode == "models_error" {
				writeMsg(map[string]any{"id": req.ID, "error": map[string]any{"code": -32601, "message": "unknown method"}})
				break
			}
			// A stray notification must not be mistaken for the response.
			writeMsg(map[string]any{"method": "remoteControl/status/changed", "params": map[string]any{}})
			if p.Cursor == "" {
				writeMsg(map[string]any{"id": req.ID, "result": map[string]any{
					"data": []map[string]any{
						{"id": "m-big", "model": "m-big", "displayName": "Big", "description": "Largest", "hidden": false, "isDefault": true},
						{"id": "m-hidden", "model": "m-hidden", "displayName": "Hidden", "hidden": true, "isDefault": false},
					},
					"nextCursor": "page2",
				}})
			} else {
				writeMsg(map[string]any{"id": req.ID, "result": map[string]any{
					"data": []map[string]any{
						{"id": "m-small", "model": "m-small", "displayName": "Small", "hidden": false, "isDefault": false},
					},
					"nextCursor": nil,
				}})
			}
		case "turn/start":
			var tp struct {
				Model string `json:"model"`
			}
			_ = json.Unmarshal(req.Params, &tp)
			helloText := "Hello world"
			if mode == "echo_model" {
				helloText = "model=" + tp.Model
			}
			writeMsg(map[string]any{
				"id":     req.ID,
				"result": map[string]any{"turn": map[string]any{"id": turnID}},
			})
			writeMsg(map[string]any{
				"method": "turn/started",
				"params": map[string]any{"threadId": threadID, "turn": map[string]any{"id": turnID}},
			})

			switch mode {
			case "crash":
				os.Exit(9)
			case "approval":
				writeMsg(map[string]any{
					"id":     "srv_apr_1",
					"method": "item/commandExecution/requestApproval",
					"params": map[string]any{
						"approvalId": "apr-cb-1",
						"kind":       "command",
						"threadId":   threadID,
						"turnId":     turnID,
						"itemId":     "item-cmd-1",
						"command":    "go test ./...",
						"reason":     "run unit tests",
					},
				})
				// Wait for response from daemon before completing turn.
				if scanner.Scan() {
					var resp struct {
						Result struct {
							Decision string `json:"decision"`
						} `json:"result"`
					}
					_ = json.Unmarshal([]byte(scanner.Text()), &resp)
					text := "declined"
					if resp.Result.Decision == "accept" {
						text = "tests passed after approval"
					}
					writeMsg(map[string]any{
						"method": "item/agentMessage/delta",
						"params": map[string]any{"threadId": threadID, "turnId": turnID, "itemId": "msg-1", "delta": text},
					})
					writeMsg(map[string]any{
						"method": "turn/completed",
						"params": map[string]any{
							"threadId": threadID,
							"turn": map[string]any{
								"id":     turnID,
								"status": "completed",
								"items": []map[string]any{
									{"type": "agentMessage", "text": text},
								},
							},
						},
					})
				}
			case "wait_interrupt":
				// Keep listening on stdin until turn/interrupt arrives.
			default:
				writeMsg(map[string]any{
					"method": "item/agentMessage/delta",
					"params": map[string]any{"threadId": threadID, "turnId": turnID, "itemId": "msg-1", "delta": "Hello "},
				})
				writeMsg(map[string]any{
					"method": "turn/diff/updated",
					"params": map[string]any{"threadId": threadID, "turnId": turnID, "diff": "--- a/x\n+++ b/x\n"},
				})
				writeMsg(map[string]any{
					"method": "item/completed",
					"params": map[string]any{
						"threadId": threadID,
						"turnId":   turnID,
						"item":     map[string]any{"type": "agentMessage", "id": "msg-1", "text": helloText},
					},
				})
				writeMsg(map[string]any{
					"method": "turn/completed",
					"params": map[string]any{
						"threadId": threadID,
						"turn": map[string]any{
							"id":     turnID,
							"status": "completed",
							"items": []map[string]any{
								{"type": "agentMessage", "text": helloText},
							},
						},
					},
				})
			}
		case "turn/interrupt":
			writeMsg(map[string]any{
				"id":     req.ID,
				"result": map[string]any{},
			})
			writeMsg(map[string]any{
				"method": "turn/completed",
				"params": map[string]any{
					"threadId": threadID,
					"turn":     map[string]any{"id": turnID, "status": "interrupted", "items": []any{}},
				},
			})
		}
	}
	os.Exit(0)
}

func fakeAdapter(mode string) *AppServerAdapter {
	exe, _ := os.Executable()
	return NewAdapter(Config{
		Binary:    exe,
		ExtraArgs: []string{"-test.run=TestHelperProcess", "--"},
		ExtraEnv: []string{
			"GO_WANT_HELPER_PROCESS=1",
			"AGENTIK_FAKE_CODEX_MODE=" + mode,
		},
	})
}

func TestDiagnoseMissingAndAuthStates(t *testing.T) {
	missing := NewAdapter(Config{Binary: "/nonexistent/agentik-codex-binary"})
	st := missing.Diagnose(context.Background())
	if st.Available || st.Authenticated {
		t.Fatalf("expected missing binary to be unavailable: %+v", st)
	}

	unauth := fakeAdapter("unauthenticated")
	st = unauth.Diagnose(context.Background())
	if !st.Available || st.Authenticated || st.Version != "codex-cli 0.160.0" {
		t.Fatalf("unexpected unauth status: %+v", st)
	}

	ok := fakeAdapter("normal")
	st = ok.Diagnose(context.Background())
	if !st.Available || !st.Authenticated || !st.Capabilities.SupportsResume || !st.Capabilities.SupportsCancel {
		t.Fatalf("unexpected ready status: %+v", st)
	}
}

func TestStartTurnApprovalCancelAndCrash(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()

	// 1. Normal completion with delta, diff, item, and turn/completed.
	var events []Event
	turn, err := fakeAdapter("normal").StartTurn(ctx, StartTurnRequest{
		ProjectRoot: dir,
		Prompt:      "say hi",
	}, TurnCallbacks{
		OnEvent: func(ev Event) { events = append(events, ev) },
	})
	if err != nil {
		t.Fatal(err)
	}
	res := turn.Wait()
	if res.Status != OutcomeSucceeded || res.ResultText != "Hello world" || !strings.Contains(res.Diff, "--- a/x") {
		t.Fatalf("unexpected result: %+v", res)
	}
	if len(events) < 3 {
		t.Fatalf("expected streaming events, got %d", len(events))
	}

	// 2. Approval request routed strictly with single-operation decision.
	var gotReq ApprovalRequest
	turn, err = fakeAdapter("approval").StartTurn(ctx, StartTurnRequest{
		ProjectRoot: dir,
		ThreadID:    "thr_resumed_9",
		Prompt:      "run tests",
	}, TurnCallbacks{
		OnApproval: func(_ context.Context, req ApprovalRequest) (bool, error) {
			gotReq = req
			return true, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	res = turn.Wait()
	if gotReq.Kind != ApprovalCommand || gotReq.Summary != "go test ./..." {
		t.Fatalf("unexpected approval request: %+v", gotReq)
	}
	if res.Status != OutcomeSucceeded || res.ThreadID != "thr_resumed_9" || res.ResultText != "tests passed after approval" {
		t.Fatalf("unexpected approval turn result: %+v", res)
	}

	// 3. Interrupt distinguishes interrupted turn from transport loss.
	turn, err = fakeAdapter("wait_interrupt").StartTurn(ctx, StartTurnRequest{
		ProjectRoot: dir,
		Prompt:      "long task",
	}, TurnCallbacks{})
	if err != nil {
		t.Fatal(err)
	}
	if err := turn.Interrupt(ctx); err != nil {
		t.Fatalf("interrupt failed: %v", err)
	}
	res = turn.Wait()
	if res.Status != OutcomeCancelled {
		t.Fatalf("expected OutcomeCancelled, got %+v", res)
	}

	// 4. Child crash before turn/completed reports OutcomeTransportLost.
	turn, err = fakeAdapter("crash").StartTurn(ctx, StartTurnRequest{
		ProjectRoot: dir,
		Prompt:      "crash mid turn",
	}, TurnCallbacks{})
	if err != nil {
		t.Fatal(err)
	}
	res = turn.Wait()
	if res.Status != OutcomeTransportLost {
		t.Fatalf("expected OutcomeTransportLost on crash, got %+v", res)
	}
}

func TestModelsLiveListSkipsHiddenAndFollowsPages(t *testing.T) {
	cat := fakeAdapter("normal").Models(context.Background())
	if cat.Source != ModelSourceLive {
		t.Fatalf("source = %q (%s), want live", cat.Source, cat.Detail)
	}
	if len(cat.Models) != 2 || cat.Models[0].ID != "m-big" || !cat.Models[0].IsDefault ||
		cat.Models[0].DisplayName != "Big" || cat.Models[1].ID != "m-small" {
		t.Fatalf("unexpected models: %+v", cat.Models)
	}
}

func TestModelsFallBackToLabelledStaticWhenQueryFails(t *testing.T) {
	cat := fakeAdapter("models_error").Models(context.Background())
	if cat.Source != ModelSourceStatic || len(cat.Models) != 0 || cat.Detail == "" {
		t.Fatalf("expected empty static fallback with a reason, got %+v", cat)
	}
	missing := NewAdapter(Config{Binary: "/nonexistent/agentik-codex-binary"}).Models(context.Background())
	if missing.Source != ModelSourceStatic || len(missing.Models) != 0 {
		t.Fatalf("missing binary: %+v", missing)
	}
}

func TestStartTurnPassesSelectedModel(t *testing.T) {
	run := func(model string) TurnResult {
		turn, err := fakeAdapter("echo_model").StartTurn(context.Background(), StartTurnRequest{
			ProjectRoot: t.TempDir(), Prompt: "hi", Model: model,
		}, TurnCallbacks{})
		if err != nil {
			t.Fatal(err)
		}
		return turn.Wait()
	}
	if res := run("m-small"); res.ResultText != "model=m-small" {
		t.Fatalf("selected model not forwarded: %+v", res)
	}
	if res := run(""); res.ResultText != "model=" {
		t.Fatalf("empty model must not be forwarded: %+v", res)
	}
}

// TestRealCodexDiagnoseAndInitialize verifies the adapter against the locally
// installed codex CLI when AGENTIK_TEST_REAL_CODEX=1 is set.
func TestRealCodexDiagnoseAndInitialize(t *testing.T) {
	if os.Getenv("AGENTIK_TEST_REAL_CODEX") != "1" {
		t.Skip("set AGENTIK_TEST_REAL_CODEX=1 to run against local codex CLI")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	adapter := NewAdapter(Config{})
	st := adapter.Diagnose(ctx)
	if !st.Available || !st.Authenticated {
		t.Fatalf("expected real local codex to be available and logged in: %+v", st)
	}
}

// TestRealCodexAppServerTurn runs one short real turn against the local
// `codex app-server` when AGENTIK_TEST_REAL_CODEX_TURN=1 is set.
func TestRealCodexAppServerTurn(t *testing.T) {
	if os.Getenv("AGENTIK_TEST_REAL_CODEX_TURN") != "1" {
		t.Skip("set AGENTIK_TEST_REAL_CODEX_TURN=1 to run a live turn against local codex")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	dir := t.TempDir()
	var mu sync.Mutex
	var eventCount int
	adapter := NewAdapter(Config{})
	turn, err := adapter.StartTurn(ctx, StartTurnRequest{
		ProjectRoot: dir,
		Prompt:      "Reply with exactly the two letters OK and do not run any shell commands.",
	}, TurnCallbacks{
		OnEvent: func(ev Event) {
			mu.Lock()
			eventCount++
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatalf("StartTurn: %v", err)
	}
	res := turn.Wait()
	if res.Status != OutcomeSucceeded {
		t.Fatalf("expected succeeded real codex turn, got %+v", res)
	}
	if res.ThreadID == "" || res.TurnID == "" {
		t.Fatalf("expected threadId and turnId from real codex, got %+v", res)
	}
	if !strings.Contains(res.ResultText, "OK") {
		t.Fatalf("expected OK in result text, got %q", res.ResultText)
	}
	mu.Lock()
	defer mu.Unlock()
	if eventCount == 0 {
		t.Fatalf("expected streaming events from real codex")
	}
}


// TestRealCodexAppServerContinuation starts a thread, then resumes it with a
// second turn and checks that the agent remembers the first one. It runs only
// when AGENTIK_TEST_REAL_CODEX_TURN=1 is set.
func TestRealCodexAppServerContinuation(t *testing.T) {
	if os.Getenv("AGENTIK_TEST_REAL_CODEX_TURN") != "1" {
		t.Skip("set AGENTIK_TEST_REAL_CODEX_TURN=1 to run a live continuation against local codex")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	dir := t.TempDir()
	adapter := NewAdapter(Config{})
	run := func(threadID, prompt string) TurnResult {
		t.Helper()
		turn, err := adapter.StartTurn(ctx, StartTurnRequest{ProjectRoot: dir, ThreadID: threadID, Prompt: prompt}, TurnCallbacks{
			OnEvent: func(Event) {},
		})
		if err != nil {
			t.Fatalf("StartTurn(thread=%q): %v", threadID, err)
		}
		return turn.Wait()
	}

	first := run("", "Remember the code word PINEAPPLE-42. Reply with exactly OK and do not run any shell commands.")
	if first.Status != OutcomeSucceeded || first.ThreadID == "" {
		t.Fatalf("first turn: %+v", first)
	}
	second := run(first.ThreadID, "What was the code word I asked you to remember? Reply with the word only and do not run any shell commands.")
	if second.Status != OutcomeSucceeded {
		t.Fatalf("second turn: %+v", second)
	}
	if second.ThreadID != first.ThreadID {
		t.Fatalf("continuation changed thread: %q -> %q", first.ThreadID, second.ThreadID)
	}
	if !strings.Contains(strings.ToUpper(second.ResultText), "PINEAPPLE-42") {
		t.Fatalf("agent did not remember the first turn: %q", second.ResultText)
	}
}
