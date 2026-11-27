package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// AgentName is the canonical adapter identifier in projects and tasks.
	AgentName = "codex"

	defaultDiagnoseTimeout = 5 * time.Second
	defaultInitTimeout     = 15 * time.Second
	defaultInterruptGrace  = 5 * time.Second
	maxJSONLLineBytes      = 8 * 1024 * 1024
)

// Config configures the local Codex App Server adapter.
type Config struct {
	// Binary overrides lookup of "codex" in PATH.
	Binary string
	// ExtraArgs optionally prepends flags before the Codex subcommand (used in tests).
	ExtraArgs []string
	// ExtraEnv optionally appends environment variables to child processes (used in tests).
	ExtraEnv []string
	// ClientVersion is reported in initialize clientInfo.
	ClientVersion string
}

// AppServerAdapter runs the local `codex app-server --listen stdio://` child process.
type AppServerAdapter struct {
	binary        string
	extraArgs     []string
	extraEnv      []string
	clientVersion string
}

// NewAdapter constructs a Codex App Server adapter.
func NewAdapter(cfg Config) *AppServerAdapter {
	bin := strings.TrimSpace(cfg.Binary)
	if bin == "" {
		bin = "codex"
	}
	ver := strings.TrimSpace(cfg.ClientVersion)
	if ver == "" {
		ver = "0.1.0"
	}
	return &AppServerAdapter{
		binary:        bin,
		extraArgs:     append([]string(nil), cfg.ExtraArgs...),
		extraEnv:      append([]string(nil), cfg.ExtraEnv...),
		clientVersion: ver,
	}
}

func (a *AppServerAdapter) Name() string { return AgentName }

func (a *AppServerAdapter) Capabilities() Capabilities {
	return Capabilities{
		SupportsResume: true,
		SupportsCancel: true,
	}
}

// Diagnose inspects local binary availability, version, and authentication state
// without starting a task.
func (a *AppServerAdapter) Diagnose(ctx context.Context) AgentStatus {
	status := AgentStatus{
		Name:         AgentName,
		Capabilities: a.Capabilities(),
	}

	path, err := exec.LookPath(a.binary)
	if err != nil {
		status.Detail = fmt.Sprintf("codex binary not found (%v)", err)
		return status
	}
	status.Available = true

	verCtx, cancelVer := context.WithTimeout(ctx, defaultDiagnoseTimeout)
	defer cancelVer()
	verOut, err := a.runCommand(verCtx, path, "--version")
	if err == nil {
		status.Version = strings.TrimSpace(verOut)
	}

	loginCtx, cancelLogin := context.WithTimeout(ctx, defaultDiagnoseTimeout)
	defer cancelLogin()
	loginOut, err := a.runCommand(loginCtx, path, "login", "status")
	trimmed := strings.TrimSpace(loginOut)
	if err != nil {
		if trimmed == "" {
			status.Detail = fmt.Sprintf("codex login status failed: %v", err)
		} else {
			status.Detail = trimmed
		}
		return status
	}

	lower := strings.ToLower(trimmed)
	if strings.Contains(lower, "not logged in") || strings.Contains(lower, "logged out") {
		status.Detail = trimmed
		return status
	}
	status.Authenticated = true
	status.Detail = trimmed
	return status
}

func (a *AppServerAdapter) runCommand(ctx context.Context, path string, args ...string) (string, error) {
	fullArgs := append(append([]string(nil), a.extraArgs...), args...)
	cmd := exec.CommandContext(ctx, path, fullArgs...)
	if len(a.extraEnv) > 0 {
		cmd.Env = append(cmd.Environ(), a.extraEnv...)
	}
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

// StartTurn spawns `codex app-server --listen stdio://` in req.ProjectRoot,
// initializes the session, starts or resumes a thread, and starts a turn.
func (a *AppServerAdapter) StartTurn(ctx context.Context, req StartTurnRequest, cb TurnCallbacks) (ActiveTurn, error) {
	if strings.TrimSpace(req.ProjectRoot) == "" {
		return nil, errors.New("codex: project root is required")
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, errors.New("codex: prompt is required")
	}

	path, err := exec.LookPath(a.binary)
	if err != nil {
		return nil, fmt.Errorf("codex: binary unavailable: %w", err)
	}

	fullArgs := append(append([]string(nil), a.extraArgs...), "app-server", "--listen", "stdio://")
	cmd := exec.Command(path, fullArgs...)
	cmd.Dir = req.ProjectRoot
	if len(a.extraEnv) > 0 {
		cmd.Env = append(cmd.Environ(), a.extraEnv...)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("codex: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("codex: stdout pipe: %w", err)
	}
	var stderrBuf bytes.Buffer
	cmd.Stderr = &limitedWriter{w: &stderrBuf, limit: 16 * 1024}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("codex: start app-server: %w", err)
	}

	turnCtx, cancelTurn := context.WithCancel(context.Background())
	t := &appServerTurn{
		cmd:        cmd,
		stdin:      stdin,
		stdout:     stdout,
		stderr:     &stderrBuf,
		cb:         cb,
		turnCtx:    turnCtx,
		cancelTurn: cancelTurn,
		pending:    make(map[string]chan rpcResponse),
		doneCh:     make(chan TurnResult, 1),
	}
	go t.readLoop()

	initCtx, cancelInit := context.WithTimeout(ctx, defaultInitTimeout)
	defer cancelInit()

	if err := t.handshakeAndStart(initCtx, a.clientVersion, req); err != nil {
		t.forceStop()
		return nil, err
	}

	return t, nil
}

type rpcResponse struct {
	Result json.RawMessage
	Error  *rpcErrorObj
}

type rpcErrorObj struct {
	Code    int64  `json:"code"`
	Message string `json:"message"`
}

type wireMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcErrorObj    `json:"error,omitempty"`
}

type appServerTurn struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	stdout     io.ReadCloser
	stderr     *bytes.Buffer
	cb         TurnCallbacks
	turnCtx    context.Context
	cancelTurn context.CancelFunc

	writeMu sync.Mutex
	nextID  atomic.Int64

	pendMu  sync.Mutex
	pending map[string]chan rpcResponse

	stateMu     sync.Mutex
	threadID    string
	turnID      string
	deltaText   strings.Builder
	finalText   string
	latestDiff  string
	lastErrText string
	completed   *TurnResult

	approvalWG sync.WaitGroup
	doneCh     chan TurnResult
}

func (t *appServerTurn) handshakeAndStart(ctx context.Context, clientVersion string, req StartTurnRequest) error {
	if _, err := t.call(ctx, "initialize", map[string]any{
		"clientInfo": map[string]any{
			"name":    "agentik-daemon",
			"title":   "Agentik",
			"version": clientVersion,
		},
		"capabilities": map[string]any{
			"experimentalApi": false,
		},
	}); err != nil {
		return fmt.Errorf("codex initialize: %w", err)
	}

	if err := t.writeJSON(map[string]any{"method": "initialized"}); err != nil {
		return fmt.Errorf("codex initialized notification: %w", err)
	}

	var threadRaw json.RawMessage
	var err error
	if strings.TrimSpace(req.ThreadID) == "" {
		threadRaw, err = t.call(ctx, "thread/start", map[string]any{
			"cwd":            req.ProjectRoot,
			"approvalPolicy": "on-request",
			"sandbox":        "workspace-write",
		})
	} else {
		threadRaw, err = t.call(ctx, "thread/resume", map[string]any{
			"threadId":       req.ThreadID,
			"cwd":            req.ProjectRoot,
			"approvalPolicy": "on-request",
			"sandbox":        "workspace-write",
			"excludeTurns":   true,
		})
	}
	if err != nil {
		return fmt.Errorf("codex thread setup: %w", err)
	}

	var threadResp struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(threadRaw, &threadResp); err != nil || threadResp.Thread.ID == "" {
		return fmt.Errorf("codex thread setup: missing thread id")
	}

	t.stateMu.Lock()
	t.threadID = threadResp.Thread.ID
	t.stateMu.Unlock()

	turnParams := map[string]any{
		"threadId":       threadResp.Thread.ID,
		"cwd":            req.ProjectRoot,
		"approvalPolicy": "on-request",
		"input": []map[string]any{
			{
				"type":          "text",
				"text":          req.Prompt,
				"text_elements": []any{},
			},
		},
	}
	if model := strings.TrimSpace(req.Model); model != "" {
		turnParams["model"] = model
	}
	turnRaw, err := t.call(ctx, "turn/start", turnParams)
	if err != nil {
		return fmt.Errorf("codex turn/start: %w", err)
	}

	var turnResp struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := json.Unmarshal(turnRaw, &turnResp); err != nil || turnResp.Turn.ID == "" {
		return fmt.Errorf("codex turn/start: missing turn id")
	}

	t.stateMu.Lock()
	t.turnID = turnResp.Turn.ID
	t.stateMu.Unlock()

	if t.cb.OnStarted != nil {
		t.cb.OnStarted(threadResp.Thread.ID, turnResp.Turn.ID)
	}
	return nil
}

func (t *appServerTurn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := t.nextID.Add(1)
	idKey := strconv.FormatInt(id, 10)
	ch := make(chan rpcResponse, 1)

	t.pendMu.Lock()
	t.pending[idKey] = ch
	t.pendMu.Unlock()

	defer func() {
		t.pendMu.Lock()
		delete(t.pending, idKey)
		t.pendMu.Unlock()
	}()

	if err := t.writeJSON(map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}); err != nil {
		return nil, err
	}

	select {
	case resp, ok := <-ch:
		if !ok {
			return nil, errors.New("app-server closed before response")
		}
		if resp.Error != nil {
			return nil, fmt.Errorf("rpc %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (t *appServerTurn) writeJSON(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	_, err = t.stdin.Write(data)
	return err
}

func (t *appServerTurn) Interrupt(ctx context.Context) error {
	t.stateMu.Lock()
	threadID := t.threadID
	turnID := t.turnID
	done := t.completed != nil
	t.stateMu.Unlock()
	if done {
		return nil
	}
	if threadID != "" && turnID != "" {
		callCtx, cancel := context.WithTimeout(ctx, defaultInterruptGrace)
		defer cancel()
		if _, err := t.call(callCtx, "turn/interrupt", map[string]any{
			"threadId": threadID,
			"turnId":   turnID,
		}); err == nil {
			return nil
		}
	}
	t.forceStop()
	return nil
}

func (t *appServerTurn) Wait() TurnResult {
	return <-t.doneCh
}

func (t *appServerTurn) forceStop() {
	t.cancelTurn()
	t.writeMu.Lock()
	_ = t.stdin.Close()
	t.writeMu.Unlock()
	killProcessTree(t.cmd.Process)
}

func (t *appServerTurn) readLoop() {
	defer t.cancelTurn()

	reader := bufio.NewReaderSize(t.stdout, 64*1024)
	var readErr error
	for {
		line, err := readBoundedLine(reader, maxJSONLLineBytes)
		if len(line) > 0 {
			t.handleLine(line)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				readErr = err
			}
			break
		}
	}

	// Close any in-flight approval goroutines and wait for them before finalizing.
	t.cancelTurn()
	t.approvalWG.Wait()

	t.writeMu.Lock()
	_ = t.stdin.Close()
	t.writeMu.Unlock()

	waitErr := cmdWaitQuiet(t.cmd)

	// Unblock any pending RPC callers if stdout ended unexpectedly.
	t.pendMu.Lock()
	for id, ch := range t.pending {
		close(ch)
		delete(t.pending, id)
	}
	t.pendMu.Unlock()

	t.stateMu.Lock()
	if t.completed != nil {
		res := *t.completed
		t.stateMu.Unlock()
		t.doneCh <- res
		close(t.doneCh)
		return
	}
	threadID := t.threadID
	turnID := t.turnID
	diff := t.latestDiff
	lastErr := t.lastErrText
	t.stateMu.Unlock()

	// Process exited or transport broke before turn/completed arrived:
	// explicitly report OutcomeTransportLost so the runtime marks recovery_required.
	msg := "codex app-server terminated before turn completion"
	if readErr != nil {
		msg = fmt.Sprintf("codex stdout error before turn completion: %v", readErr)
	} else if waitErr != nil {
		detail := strings.TrimSpace(t.stderr.String())
		if detail != "" {
			msg = fmt.Sprintf("codex exited (%v): %s", waitErr, detail)
		} else {
			msg = fmt.Sprintf("codex exited before turn completion: %v", waitErr)
		}
	} else if lastErr != "" {
		msg = lastErr
	}

	t.doneCh <- TurnResult{
		Status:   OutcomeTransportLost,
		ThreadID: threadID,
		TurnID:   turnID,
		Diff:     diff,
		Error:    msg,
	}
	close(t.doneCh)
}

func (t *appServerTurn) handleLine(line []byte) {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return
	}
	var msg wireMessage
	if err := json.Unmarshal(trimmed, &msg); err != nil {
		return
	}

	// Response to our RPC request.
	if msg.Method == "" && len(msg.ID) > 0 {
		key := canonicalIDKey(msg.ID)
		t.pendMu.Lock()
		ch, ok := t.pending[key]
		if ok {
			delete(t.pending, key)
		}
		t.pendMu.Unlock()
		if ok {
			ch <- rpcResponse{Result: msg.Result, Error: msg.Error}
		}
		return
	}

	// Server request requiring a JSON-RPC response (e.g. approval).
	if msg.Method != "" && len(msg.ID) > 0 {
		t.handleServerRequest(msg)
		return
	}

	// Server notification.
	if msg.Method != "" {
		t.handleNotification(msg.Method, msg.Params)
	}
}

func (t *appServerTurn) handleServerRequest(msg wireMessage) {
	idCopy := append(json.RawMessage(nil), msg.ID...)
	paramsCopy := append(json.RawMessage(nil), msg.Params...)
	method := msg.Method

	t.approvalWG.Add(1)
	go func() {
		defer t.approvalWG.Done()
		var req ApprovalRequest
		switch method {
		case "item/commandExecution/requestApproval":
			var p struct {
				ApprovalID string `json:"approvalId"`
				ItemID     string `json:"itemId"`
				Kind       string `json:"kind"`
				Command    string `json:"command"`
				Reason     string `json:"reason"`
				Cwd        string `json:"cwd"`
			}
			_ = json.Unmarshal(paramsCopy, &p)
			reqID := p.ApprovalID
			if reqID == "" {
				reqID = p.ItemID
			}
			summary := p.Command
			if summary == "" {
				summary = p.Reason
			}
			if summary == "" {
				summary = "Command execution approval"
			}
			req = ApprovalRequest{
				RequestID: reqID,
				Kind:      ApprovalCommand,
				Summary:   truncateStr(summary, 512),
				Detail:    truncateStr(strings.TrimSpace(p.Reason), 512),
			}
		case "item/fileChange/requestApproval":
			var p struct {
				ItemID    string `json:"itemId"`
				Reason    string `json:"reason"`
				GrantRoot string `json:"grantRoot"`
			}
			_ = json.Unmarshal(paramsCopy, &p)
			summary := p.Reason
			if summary == "" && p.GrantRoot != "" {
				summary = "Allow file changes under " + p.GrantRoot
			}
			if summary == "" {
				summary = "File change approval"
			}
			req = ApprovalRequest{
				RequestID: p.ItemID,
				Kind:      ApprovalFileChange,
				Summary:   truncateStr(summary, 512),
				Detail:    truncateStr(strings.TrimSpace(p.Reason), 512),
			}
		default:
			_ = t.writeJSON(map[string]any{
				"id": idCopy,
				"error": map[string]any{
					"code":    -32601,
					"message": "unsupported server request",
				},
			})
			return
		}

		decision := "decline"
		if t.cb.OnApproval != nil {
			approved, err := t.cb.OnApproval(t.turnCtx, req)
			if err == nil && approved {
				decision = "accept"
			}
		}
		_ = t.writeJSON(map[string]any{
			"id": idCopy,
			"result": map[string]any{
				"decision": decision,
			},
		})
	}()
}

func (t *appServerTurn) handleNotification(method string, params json.RawMessage) {
	switch method {
	case "turn/started":
		var p struct {
			ThreadID string `json:"threadId"`
			Turn     struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if json.Unmarshal(params, &p) == nil {
			t.emitEvent(Event{
				Kind:     EventStarted,
				ThreadID: p.ThreadID,
				TurnID:   p.Turn.ID,
				Payload:  map[string]any{"thread_id": p.ThreadID, "turn_id": p.Turn.ID},
			})
		}

	case "item/agentMessage/delta":
		var p struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			ItemID   string `json:"itemId"`
			Delta    string `json:"delta"`
		}
		if json.Unmarshal(params, &p) == nil && p.Delta != "" {
			t.stateMu.Lock()
			t.deltaText.WriteString(p.Delta)
			t.stateMu.Unlock()
			t.emitEvent(Event{
				Kind:     EventDelta,
				ThreadID: p.ThreadID,
				TurnID:   p.TurnID,
				Text:     p.Delta,
				Payload:  map[string]any{"item_id": p.ItemID, "text": p.Delta},
			})
		}

	case "item/completed":
		var p struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			Item     struct {
				Type    string `json:"type"`
				ID      string `json:"id"`
				Text    string `json:"text"`
				Command string `json:"command"`
				Status  string `json:"status"`
			} `json:"item"`
		}
		if json.Unmarshal(params, &p) == nil {
			if p.Item.Type == "agentMessage" && p.Item.Text != "" {
				t.stateMu.Lock()
				t.finalText = p.Item.Text
				t.stateMu.Unlock()
			}
			payload := map[string]any{
				"item_type": p.Item.Type,
				"item_id":   p.Item.ID,
			}
			if p.Item.Text != "" {
				payload["text"] = truncateStr(p.Item.Text, 8*1024)
			}
			if p.Item.Command != "" {
				payload["command"] = truncateStr(p.Item.Command, 512)
			}
			if p.Item.Status != "" {
				payload["status"] = p.Item.Status
			}
			t.emitEvent(Event{
				Kind:     EventItem,
				ThreadID: p.ThreadID,
				TurnID:   p.TurnID,
				Text:     p.Item.Text,
				Payload:  payload,
			})
		}

	case "turn/diff/updated":
		var p struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			Diff     string `json:"diff"`
		}
		if json.Unmarshal(params, &p) == nil {
			t.stateMu.Lock()
			t.latestDiff = p.Diff
			t.stateMu.Unlock()
			t.emitEvent(Event{
				Kind:     EventDiff,
				ThreadID: p.ThreadID,
				TurnID:   p.TurnID,
				Text:     p.Diff,
				Payload:  map[string]any{"diff": truncateStr(p.Diff, 16*1024)},
			})
		}

	case "error":
		var p struct {
			ThreadID  string `json:"threadId"`
			TurnID    string `json:"turnId"`
			WillRetry bool   `json:"willRetry"`
			Error     struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(params, &p) == nil && p.Error.Message != "" {
			if !p.WillRetry {
				t.stateMu.Lock()
				t.lastErrText = p.Error.Message
				t.stateMu.Unlock()
			}
			t.emitEvent(Event{
				Kind:     EventError,
				ThreadID: p.ThreadID,
				TurnID:   p.TurnID,
				Text:     p.Error.Message,
				Payload:  map[string]any{"message": p.Error.Message, "will_retry": p.WillRetry},
			})
		}

	case "turn/completed":
		var p struct {
			ThreadID string `json:"threadId"`
			Turn     struct {
				ID     string `json:"id"`
				Status string `json:"status"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
				Items []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"items"`
			} `json:"turn"`
		}
		if json.Unmarshal(params, &p) != nil {
			return
		}

		t.stateMu.Lock()
		resultText := t.finalText
		if resultText == "" {
			resultText = t.deltaText.String()
		}
		if resultText == "" {
			for _, it := range p.Turn.Items {
				if it.Type == "agentMessage" && it.Text != "" {
					resultText = it.Text
				}
			}
		}
		diff := t.latestDiff
		lastErr := t.lastErrText
		threadID := p.ThreadID
		if threadID == "" {
			threadID = t.threadID
		}
		turnID := p.Turn.ID
		if turnID == "" {
			turnID = t.turnID
		}

		var status OutcomeStatus
		var errMsg string
		switch p.Turn.Status {
		case "completed":
			status = OutcomeSucceeded
		case "interrupted":
			status = OutcomeCancelled
		case "failed":
			status = OutcomeFailed
			if p.Turn.Error != nil && p.Turn.Error.Message != "" {
				errMsg = p.Turn.Error.Message
			} else if lastErr != "" {
				errMsg = lastErr
			} else {
				errMsg = "codex turn failed"
			}
		default:
			status = OutcomeTransportLost
			errMsg = fmt.Sprintf("unexpected turn status %q", p.Turn.Status)
		}

		res := TurnResult{
			Status:     status,
			ThreadID:   threadID,
			TurnID:     turnID,
			ResultText: resultText,
			Diff:       diff,
			Error:      errMsg,
		}
		t.completed = &res
		t.stateMu.Unlock()

		// Signal clean EOF to app-server stdin after turn/completed.
		t.writeMu.Lock()
		_ = t.stdin.Close()
		t.writeMu.Unlock()
	}
}

func (t *appServerTurn) emitEvent(ev Event) {
	if t.cb.OnEvent != nil {
		t.cb.OnEvent(ev)
	}
}

func canonicalIDKey(raw json.RawMessage) string {
	var n int64
	if json.Unmarshal(raw, &n) == nil {
		return strconv.FormatInt(n, 10)
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return strings.TrimSpace(string(raw))
}

func readBoundedLine(r *bufio.Reader, maxBytes int) ([]byte, error) {
	var out []byte
	for {
		frag, err := r.ReadSlice('\n')
		if len(out)+len(frag) > maxBytes {
			return nil, fmt.Errorf("line exceeds %d bytes", maxBytes)
		}
		out = append(out, frag...)
		if !errors.Is(err, bufio.ErrBufferFull) {
			return out, err
		}
	}
}

func cmdWaitQuiet(cmd *exec.Cmd) error {
	return cmd.Wait()
}

func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

type limitedWriter struct {
	w     *bytes.Buffer
	limit int
}

func (lw *limitedWriter) Write(p []byte) (int, error) {
	if lw.w.Len() < lw.limit {
		remain := lw.limit - lw.w.Len()
		if len(p) > remain {
			lw.w.Write(p[:remain])
		} else {
			lw.w.Write(p)
		}
	}
	return len(p), nil
}
