// Package codex integrates the local Codex App Server over stdio JSONL
// (AGENTIK.md section 8).
package codex

import "context"

// Capabilities declares what an agent adapter supports.
type Capabilities struct {
	SupportsResume bool `json:"supports_resume"`
	SupportsCancel bool `json:"supports_cancel"`
}

// AgentStatus describes availability and authentication state for diagnostics.
type AgentStatus struct {
	Name          string       `json:"name"`
	Available     bool         `json:"available"`
	Authenticated bool         `json:"authenticated"`
	Version       string       `json:"version,omitempty"`
	Detail        string       `json:"detail,omitempty"`
	Capabilities  Capabilities `json:"capabilities"`
}

// StartTurnRequest describes one turn to execute inside a permitted project.
type StartTurnRequest struct {
	// ProjectRoot is the locally resolved, symlink-checked directory path.
	ProjectRoot string
	// ThreadID optionally resumes an existing agent thread.
	ThreadID string
	// Prompt is the user task prompt.
	Prompt string
	// Model optionally selects the model for this turn. Empty means the
	// agent's own default. The runtime validates it against the agent's
	// model catalogue before it reaches an adapter.
	Model string
}

// Model describes one model an agent can run.
type Model struct {
	// ID is the value passed back as StartTurnRequest.Model.
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Description string `json:"description,omitempty"`
	// IsDefault marks the model the agent uses when none is selected.
	IsDefault bool `json:"is_default"`
}

// ModelSource says where a model list came from.
type ModelSource string

const (
	// ModelSourceLive means the list was read from the agent itself.
	ModelSourceLive ModelSource = "live"
	// ModelSourceStatic means the list is a built-in fallback because the
	// agent could not be queried.
	ModelSourceStatic ModelSource = "static"
)

// ModelCatalog is the set of models one agent can run.
type ModelCatalog struct {
	Models []Model     `json:"models"`
	Source ModelSource `json:"source"`
	// Detail explains a static fallback (why the live query failed).
	Detail string `json:"detail,omitempty"`
}

// ApprovalKind identifies the type of operation Codex asks to approve.
type ApprovalKind string

const (
	ApprovalCommand    ApprovalKind = "command"
	ApprovalFileChange ApprovalKind = "file_change"
)

// ApprovalRequest represents one interactive approval callback from Codex.
type ApprovalRequest struct {
	RequestID string
	Kind      ApprovalKind
	Summary   string
	Detail    string
}

// EventKind categorizes translated agent events.
type EventKind string

const (
	EventStarted EventKind = "started"
	EventDelta   EventKind = "delta"
	EventItem    EventKind = "item"
	EventDiff    EventKind = "diff"
	EventError   EventKind = "error"
)

// Event represents one incremental update emitted during a turn.
type Event struct {
	Kind     EventKind
	ThreadID string
	TurnID   string
	Text     string
	Payload  map[string]any
}

// OutcomeStatus distinguishes clean turn completion from cancellation,
// confirmed errors, and ambiguous transport/process termination.
type OutcomeStatus string

const (
	OutcomeSucceeded     OutcomeStatus = "succeeded"
	OutcomeFailed        OutcomeStatus = "failed"
	OutcomeCancelled     OutcomeStatus = "cancelled"
	OutcomeTransportLost OutcomeStatus = "transport_lost"
)

// TurnResult captures the final outcome of an active turn.
type TurnResult struct {
	Status     OutcomeStatus
	ThreadID   string
	TurnID     string
	ResultText string
	Diff       string
	Error      string
}

// TurnCallbacks receives streaming updates and blocking approval requests.
type TurnCallbacks struct {
	OnStarted  func(threadID, turnID string)
	OnEvent    func(Event)
	OnApproval func(ctx context.Context, req ApprovalRequest) (approved bool, err error)
}

// ActiveTurn controls an in-flight turn.
type ActiveTurn interface {
	Interrupt(ctx context.Context) error
	Wait() TurnResult
}

// Adapter is implemented by the real Codex App Server runner and test fakes.
type Adapter interface {
	Name() string
	Capabilities() Capabilities
	Diagnose(ctx context.Context) AgentStatus
	StartTurn(ctx context.Context, req StartTurnRequest, cb TurnCallbacks) (ActiveTurn, error)
}
