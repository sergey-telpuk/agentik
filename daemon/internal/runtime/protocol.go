// Package runtime implements Agentik Stage 2 local execution: idempotent
// command deduplication, project-scoped sessions, SQLite task state machines,
// monotonic session event sequences, bounded approvals, and crash recovery.
package runtime

import (
	"encoding/json"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents"
)

// ProtocolVersion is the inner JSON protocol version carried inside Noise.
const ProtocolVersion = 1

// TaskState enumerates all allowed SQLite task states (AGENTIK.md section 7.1).
type TaskState string

const (
	TaskAccepted         TaskState = "accepted"
	TaskStarting         TaskState = "starting"
	TaskRunning          TaskState = "running"
	TaskAwaitingApproval TaskState = "awaiting_approval"
	TaskCancelRequested  TaskState = "cancel_requested"
	TaskSucceeded        TaskState = "succeeded"
	TaskFailed           TaskState = "failed"
	TaskCancelled        TaskState = "cancelled"
	TaskRecoveryRequired TaskState = "recovery_required"
)

func (s TaskState) Active() bool {
	switch s {
	case TaskAccepted, TaskStarting, TaskRunning, TaskAwaitingApproval, TaskCancelRequested:
		return true
	default:
		return false
	}
}

// InboundRequest is a command sent by a phone over a Noise session.
type InboundRequest struct {
	V         int             `json:"v"`
	RequestID string          `json:"request_id"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
}

// ErrorBody is a structured error returned in a response envelope.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// OutboundResponse correlates to an InboundRequest via RequestID.
type OutboundResponse struct {
	V         int        `json:"v"`
	Type      string     `json:"type"`
	RequestID string     `json:"request_id"`
	OK        bool       `json:"ok"`
	Result    any        `json:"result,omitempty"`
	Error     *ErrorBody `json:"error,omitempty"`
}

// OutboundEvent pushes an asynchronous notification to an authenticated phone.
type OutboundEvent struct {
	V     int    `json:"v"`
	Type  string `json:"type"`
	Event string `json:"event"`
	Data  any    `json:"data"`
}

// PendingApprovalView describes an active single-operation approval prompt.
type PendingApprovalView struct {
	ApprovalID string `json:"approval_id"`
	Kind       string `json:"kind"`
	Summary    string `json:"summary"`
	ExpiresAt  int64  `json:"expires_at"`
}

// TaskView is the serialized task summary returned to the Mini App.
type TaskView struct {
	TaskID          string               `json:"task_id"`
	SessionID       string               `json:"session_id"`
	ProjectID       string               `json:"project_id"`
	Agent           string               `json:"agent"`
	Prompt          string               `json:"prompt"`
	State           TaskState            `json:"state"`
	ResultText      string               `json:"result_text"`
	ErrorMessage    string               `json:"error_message"`
	PendingApproval *PendingApprovalView `json:"pending_approval"`
	CreatedAt       int64                `json:"created_at"`
	UpdatedAt       int64                `json:"updated_at"`

	// Model is the model the task was started with; empty means the agent's
	// own default model.
	Model string `json:"model"`
}

// ProjectInfo is the wire view of a configured local project. Paths are
// intentionally omitted: clients select projects solely by project_id.
type ProjectInfo struct {
	ProjectID string   `json:"project_id"`
	Name      string   `json:"name"`
	Agents    []string `json:"agents"`
}

// SessionSummary describes a local agent session stored in SQLite.
type SessionSummary struct {
	SessionID string `json:"session_id"`
	ProjectID string `json:"project_id"`
	Agent     string `json:"agent"`
	ThreadID  string `json:"thread_id,omitempty"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	// Title is the first prompt of the session, bounded in length.
	Title string `json:"title,omitempty"`
	// LatestState is the state of the newest turn.
	LatestState TaskState `json:"latest_state,omitempty"`
	// TurnCount is the number of turns (tasks) in the session.
	TurnCount int `json:"turn_count"`
}

// SessionEventView represents one ordered event in a session.
type SessionEventView struct {
	SessionID string         `json:"session_id"`
	TaskID    string         `json:"task_id"`
	Seq       int64          `json:"seq"`
	Kind      string         `json:"kind"`
	Payload   map[string]any `json:"payload"`
	CreatedAt int64          `json:"created_at"`
}

// DeviceInfoResult describes the connected daemon and pairing state.
type DeviceInfoResult struct {
	DeviceID     string   `json:"device_id"`
	Paired       bool     `json:"paired"`
	PairingState string   `json:"pairing_state"`
	Capabilities []string `json:"capabilities"`
}

// PairSubmitResult confirms a pending pairing submission awaiting local PC approval.
type PairSubmitResult struct {
	State            string `json:"state"`
	DeviceID         string `json:"device_id"`
	VerificationCode string `json:"verification_code,omitempty"`
}

// TaskResult wraps a task response and whether it was satisfied via idempotency dedup.
type TaskResult struct {
	Task         TaskView `json:"task"`
	Deduplicated bool     `json:"deduplicated"`
}

// ApprovalResolveResult confirms the recorded decision on one approval.
type ApprovalResolveResult struct {
	ApprovalID string `json:"approval_id"`
	Status     string `json:"status"`
}

// EventsResumeResult returns ordered session events after a caller's sequence cursor.
type EventsResumeResult struct {
	SessionID string             `json:"session_id"`
	Events    []SessionEventView `json:"events"`
	NextSeq   int64              `json:"next_seq"`
	Truncated bool               `json:"truncated,omitempty"`
}

// ChangesResult returns a bounded unified diff for a task.
type ChangesResult struct {
	TaskID    string `json:"task_id"`
	Diff      string `json:"diff"`
	Truncated bool   `json:"truncated"`
}

// AgentListResult reports every detected agent with its readiness and models.
// Each entry still carries the original name/available/authenticated/version/
// detail/capabilities fields.
type AgentListResult struct {
	Agents []agents.Entry `json:"agents"`
}

// PairUpdatedEventData is pushed when a local operator confirms or rejects a pairing.
type PairUpdatedEventData struct {
	DeviceID string `json:"device_id"`
	State    string `json:"state"`
}
