package runtime

// TerminalOpenResult confirms a started terminal session.
type TerminalOpenResult struct {
	SessionID string `json:"session_id"`
	ProjectID string `json:"project_id"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

// TerminalInputResult confirms queued input.
type TerminalInputResult struct {
	SessionID string `json:"session_id"`
	Bytes     int    `json:"bytes"`
}

// TerminalResizeResult confirms a new terminal size.
type TerminalResizeResult struct {
	SessionID string `json:"session_id"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

// TerminalChunk is one numbered piece of output; Data is standard base64.
type TerminalChunk struct {
	Seq  int64  `json:"seq"`
	Data string `json:"data"`
}

// TerminalReadResult returns output after the caller's cursor. Closed is set
// once the session has ended and no output is left; Reason and ExitCode then
// say why.
type TerminalReadResult struct {
	SessionID string          `json:"session_id"`
	Chunks    []TerminalChunk `json:"chunks"`
	NextSeq   int64           `json:"next_seq"`
	Closed    bool            `json:"closed"`
	Reason    string          `json:"reason,omitempty"`
	ExitCode  *int            `json:"exit_code,omitempty"`
	Truncated bool            `json:"truncated,omitempty"`
}

// TerminalCloseResult confirms that a session and its processes are gone.
type TerminalCloseResult struct {
	SessionID string `json:"session_id"`
	Closed    bool   `json:"closed"`
	Reason    string `json:"reason"`
	ExitCode  *int   `json:"exit_code,omitempty"`
}
