package runtime

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/secure"
	"github.com/sergey-telpuk/agentik/daemon/internal/terminal"
)

// The terminal RPCs (AGENTIK.md section 8.1) reach HandleMessage only after
// the per-request paired-phone check. A session belongs to the Noise session
// that opened it: other channels, even of the same phone, cannot reach it.

func terminalOwner(sess *secure.ManagedSession) terminal.Owner {
	return terminal.Owner{ConnectionID: sess.ConnectionID, PeerKey: sess.PeerStatic()}
}

func (s *Service) handleTerminal(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	switch req.Method {
	case "terminal.open":
		s.handleTerminalOpen(ctx, sess, req)
	case "terminal.input":
		s.handleTerminalInput(ctx, sess, req)
	case "terminal.resize":
		s.handleTerminalResize(ctx, sess, req)
	case "terminal.read":
		s.handleTerminalRead(ctx, sess, req)
	case "terminal.close":
		s.handleTerminalClose(ctx, sess, req)
	}
}

func (s *Service) sendTerminalError(ctx context.Context, sess *secure.ManagedSession, requestID string, err error) {
	code := "internal"
	switch {
	case errors.Is(err, terminal.ErrNotFound):
		code = "not_found"
	case errors.Is(err, terminal.ErrInvalid):
		code = "bad_request"
	case errors.Is(err, terminal.ErrClosed):
		code = "terminal_closed"
	case errors.Is(err, terminal.ErrInputBusy):
		code = "terminal_busy"
	case errors.Is(err, terminal.ErrTooMany):
		code = "too_many_terminals"
	case errors.Is(err, terminal.ErrShuttingDown):
		code = "unavailable"
	}
	s.sendError(ctx, sess, requestID, code, err.Error())
}

func (s *Service) handleTerminalOpen(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		ProjectID string `json:"project_id"`
		Command   string `json:"command"`
		Cols      int    `json:"cols"`
		Rows      int    `json:"rows"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(params.ProjectID) == "" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "project_id is required")
		return
	}
	// The working directory is always a permitted project root, never a
	// path from the network.
	proj, err := s.projects.Get(params.ProjectID)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "not_found", "project not found")
		return
	}
	if real, err := filepath.EvalSymlinks(proj.Root); err != nil || real != proj.Root {
		s.sendError(ctx, sess, req.RequestID, "not_found", "project directory is no longer available")
		return
	}
	if info, err := os.Stat(proj.Root); err != nil || !info.IsDir() {
		s.sendError(ctx, sess, req.RequestID, "not_found", "project directory is no longer available")
		return
	}

	cols, rows := params.Cols, params.Rows
	if cols == 0 {
		cols = terminal.DefaultCols
	}
	if rows == 0 {
		rows = terminal.DefaultRows
	}
	info, err := s.terminals.Open(terminal.OpenRequest{
		Owner:     terminalOwner(sess),
		ProjectID: proj.ID,
		Dir:       proj.Root,
		Command:   params.Command,
		Cols:      cols,
		Rows:      rows,
	})
	if err != nil {
		s.sendTerminalError(ctx, sess, req.RequestID, err)
		return
	}
	s.sendResult(ctx, sess, req.RequestID, TerminalOpenResult{
		SessionID: info.ID,
		ProjectID: info.ProjectID,
		Cols:      cols,
		Rows:      rows,
	})
}

func (s *Service) handleTerminalInput(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		SessionID string `json:"session_id"`
		Data      string `json:"data"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if len(params.Data) > base64.StdEncoding.EncodedLen(terminal.MaxInputBytes) {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "input exceeds the size limit")
		return
	}
	data, err := base64.StdEncoding.DecodeString(params.Data)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "data must be standard base64")
		return
	}
	if err := s.terminals.Input(terminalOwner(sess), params.SessionID, data); err != nil {
		s.sendTerminalError(ctx, sess, req.RequestID, err)
		return
	}
	s.sendResult(ctx, sess, req.RequestID, TerminalInputResult{SessionID: params.SessionID, Bytes: len(data)})
}

func (s *Service) handleTerminalResize(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		SessionID string `json:"session_id"`
		Cols      int    `json:"cols"`
		Rows      int    `json:"rows"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if err := s.terminals.Resize(terminalOwner(sess), params.SessionID, params.Cols, params.Rows); err != nil {
		s.sendTerminalError(ctx, sess, req.RequestID, err)
		return
	}
	s.sendResult(ctx, sess, req.RequestID, TerminalResizeResult{SessionID: params.SessionID, Cols: params.Cols, Rows: params.Rows})
}

// handleTerminalRead answers from a goroutine when it may wait, because
// frames are dispatched one at a time and a waiting read must not hold up
// the input that will produce its output.
func (s *Service) handleTerminalRead(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		SessionID string `json:"session_id"`
		AfterSeq  int64  `json:"after_seq"`
		WaitMS    int64  `json:"wait_ms"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if params.WaitMS < 0 || params.WaitMS > terminal.MaxReadWait.Milliseconds() {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "wait_ms is out of range")
		return
	}
	owner := terminalOwner(sess)
	read := func(ctx context.Context) {
		res, err := s.terminals.Read(s.baseCtx.Done(), owner, params.SessionID, params.AfterSeq, time.Duration(params.WaitMS)*time.Millisecond)
		if err != nil {
			s.sendTerminalError(ctx, sess, req.RequestID, err)
			return
		}
		out := TerminalReadResult{
			SessionID: params.SessionID,
			Chunks:    make([]TerminalChunk, 0, len(res.Chunks)),
			NextSeq:   res.NextSeq,
			Closed:    res.Closed,
			Reason:    res.Reason,
			ExitCode:  res.ExitCode,
			Truncated: res.Truncated,
		}
		for _, c := range res.Chunks {
			out.Chunks = append(out.Chunks, TerminalChunk{Seq: c.Seq, Data: base64.StdEncoding.EncodeToString(c.Data)})
		}
		s.sendResult(ctx, sess, req.RequestID, out)
	}
	if params.WaitMS == 0 {
		read(ctx)
		return
	}
	if s.baseCtx.Err() != nil {
		s.sendError(ctx, sess, req.RequestID, "unavailable", "the daemon is shutting down")
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		read(s.baseCtx)
	}()
}

func (s *Service) handleTerminalClose(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		SessionID string `json:"session_id"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if s.baseCtx.Err() != nil {
		s.sendError(ctx, sess, req.RequestID, "unavailable", "the daemon is shutting down")
		return
	}
	owner := terminalOwner(sess)
	// Closing waits for the processes to exit, so it does not hold up the
	// frame loop either.
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		res, err := s.terminals.Close(owner, params.SessionID)
		if err != nil {
			s.sendTerminalError(s.baseCtx, sess, req.RequestID, err)
			return
		}
		s.sendResult(s.baseCtx, sess, req.RequestID, TerminalCloseResult{
			SessionID: params.SessionID,
			Closed:    true,
			Reason:    res.Reason,
			ExitCode:  res.ExitCode,
		})
	}()
}

// CloseTerminalsForConnection ends the terminal sessions of a secure channel
// that went away. It does not wait for the processes to exit.
func (s *Service) CloseTerminalsForConnection(connectionID string) {
	s.terminals.CloseConnection(connectionID, terminal.ReasonDisconnected)
}

// CloseTerminalsForPeer ends every terminal session of a phone and waits
// until their processes are gone.
func (s *Service) CloseTerminalsForPeer(peerStatic []byte) {
	s.terminals.ClosePeer(peerStatic, terminal.ReasonRevoked)
}
