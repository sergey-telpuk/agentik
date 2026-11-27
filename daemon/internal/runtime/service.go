package runtime

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents"
	"github.com/sergey-telpuk/agentik/daemon/internal/agents/codex"
	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/pairing"
	"github.com/sergey-telpuk/agentik/daemon/internal/projects"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
	"github.com/sergey-telpuk/agentik/daemon/internal/secure"
	"github.com/sergey-telpuk/agentik/daemon/internal/storage"
)

const (
	defaultApprovalTTL  = 5 * time.Minute
	maxPromptBytes      = 16 * 1024
	maxModelIDBytes     = 128
	maxRequestIDLen     = 128
	maxResumeBatch      = 100
	maxEventsPageBytes  = 20 * 1024
	maxDiffReturnBytes  = 24 * 1024
	maxResultFieldBytes = 20 * 1024

	// session.open returns the turns of a session inline, so the listing is
	// bounded well below the 32 KiB frame limit.
	maxSessionTurns         = 50
	maxSessionTurnsBytes    = 24 * 1024
	maxSessionTurnTextBytes = 6 * 1024
)

// EventSink pushes asynchronous inner JSON events (such as session.event or
// pair.updated) to connected authenticated sessions.
type EventSink func(eventName string, data any)

// Config configures the Stage 2 local runtime service.
type Config struct {
	DB          *storage.DB
	Identity    *identity.Identity
	Pairing     *pairing.Service
	Projects    *projects.Catalogue
	Agents      map[string]codex.Adapter
	ApprovalTTL time.Duration
	Now         func() time.Time
	// Publish broadcasts session events to connected trusted clients.
	Publish EventSink
	// BeforeLaunchHook is an optional test seam invoked after committing
	// state='starting' to SQLite and before starting the external agent.
	BeforeLaunchHook func(ctx context.Context, taskID string) error

	// Catalog lists detected agents and validates agent and model choices.
	// When nil, a catalogue over Agents (without CLI discovery) is used.
	Catalog *agents.Registry
}

type approvalWaiter struct {
	taskID    string
	sessionID string
	expiresAt time.Time
	ch        chan bool
	once      sync.Once
}

func (w *approvalWaiter) resolve(decision bool) {
	w.once.Do(func() {
		w.ch <- decision
		close(w.ch)
	})
}

// Service coordinates projects, sessions, tasks, approvals, events, and
// startup crash recovery on the local computer.
type Service struct {
	db               *storage.DB
	identity         *identity.Identity
	pairing          *pairing.Service
	projects         *projects.Catalogue
	agents           map[string]codex.Adapter
	catalog          *agents.Registry
	approvalTTL      time.Duration
	now              func() time.Time
	publish          EventSink
	beforeLaunchHook func(ctx context.Context, taskID string) error

	baseCtx context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup

	mu          sync.Mutex
	activeTurns map[string]codex.ActiveTurn
	approvals   map[string]*approvalWaiter
}

// NewService constructs the runtime, syncs the configured projects into SQLite,
// and reconciles any active tasks left over from a prior daemon crash into
// recovery_required.
func NewService(ctx context.Context, cfg Config) (*Service, error) {
	if cfg.DB == nil {
		return nil, errors.New("runtime: database is required")
	}
	if cfg.Identity == nil {
		return nil, errors.New("runtime: device identity is required")
	}
	if cfg.Pairing == nil {
		return nil, errors.New("runtime: pairing service is required")
	}
	if cfg.Projects == nil {
		return nil, errors.New("runtime: project catalogue is required")
	}
	nowFn := cfg.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	ttl := cfg.ApprovalTTL
	if ttl <= 0 {
		ttl = defaultApprovalTTL
	}
	adapters := make(map[string]codex.Adapter, len(cfg.Agents))
	for k, v := range cfg.Agents {
		if v != nil {
			adapters[k] = v
		}
	}

	catalog := cfg.Catalog
	if catalog == nil {
		catalog = agents.NewRegistry(agents.Config{Adapters: adapters})
	}

	baseCtx, cancel := context.WithCancel(context.Background())
	svc := &Service{
		db:               cfg.DB,
		identity:         cfg.Identity,
		pairing:          cfg.Pairing,
		projects:         cfg.Projects,
		agents:           adapters,
		catalog:          catalog,
		approvalTTL:      ttl,
		now:              nowFn,
		publish:          cfg.Publish,
		beforeLaunchHook: cfg.BeforeLaunchHook,
		baseCtx:          baseCtx,
		cancel:           cancel,
		activeTurns:      make(map[string]codex.ActiveTurn),
		approvals:        make(map[string]*approvalWaiter),
	}

	if err := svc.syncProjects(ctx); err != nil {
		cancel()
		return nil, err
	}
	if _, err := svc.Reconcile(ctx); err != nil {
		cancel()
		return nil, err
	}
	return svc, nil
}

// Close cancels in-flight runtime work and waits for active task goroutines.
func (s *Service) Close() {
	s.cancel()

	s.mu.Lock()
	for _, w := range s.approvals {
		w.resolve(false)
	}
	turns := make([]codex.ActiveTurn, 0, len(s.activeTurns))
	for _, t := range s.activeTurns {
		turns = append(turns, t)
	}
	s.mu.Unlock()

	for _, t := range turns {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = t.Interrupt(ctx)
		cancel()
	}

	s.wg.Wait()
}

// Reconcile marks any unfinished tasks from a previous process lifetime as
// recovery_required and expires any lingering pending approvals. Incomplete
// launches are never auto-retried (AGENTIK.md section 7.2).
func (s *Service) Reconcile(ctx context.Context) (int, error) {
	nowUnix := s.now().Unix()
	tx, err := s.db.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("runtime: begin reconcile: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	type staleTask struct {
		id        string
		sessionID string
		state     string
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT id, session_id, state FROM tasks
		 WHERE state IN ('accepted','starting','running','awaiting_approval','cancel_requested')`,
	)
	if err != nil {
		return 0, fmt.Errorf("runtime: query stale tasks: %w", err)
	}
	var stale []staleTask
	for rows.Next() {
		var st staleTask
		if err := rows.Scan(&st.id, &st.sessionID, &st.state); err != nil {
			rows.Close()
			return 0, fmt.Errorf("runtime: scan stale task: %w", err)
		}
		stale = append(stale, st)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	if len(stale) == 0 {
		return 0, tx.Commit()
	}

	for _, st := range stale {
		errMsg := fmt.Sprintf("daemon restarted while task was %s; outcome unknown and not auto-retried", st.state)
		if _, err := tx.ExecContext(ctx,
			`UPDATE tasks SET state = 'recovery_required', error = ?, updated_at = ? WHERE id = ?`,
			errMsg, nowUnix, st.id,
		); err != nil {
			return 0, fmt.Errorf("runtime: mark task recovery_required: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE approvals SET state = 'expired', resolved_at = ? WHERE task_id = ? AND state = 'pending'`,
			nowUnix, st.id,
		); err != nil {
			return 0, fmt.Errorf("runtime: expire stale approvals: %w", err)
		}
		if _, err := s.appendEventTx(ctx, tx, st.sessionID, st.id, "status", map[string]any{
			"state": string(TaskRecoveryRequired),
			"error": errMsg,
		}, nowUnix); err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("runtime: commit reconcile: %w", err)
	}
	return len(stale), nil
}

func (s *Service) syncProjects(ctx context.Context) error {
	nowUnix := s.now().Unix()
	tx, err := s.db.SQL().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("runtime: begin syncProjects: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	list := s.projects.List()
	activeIDs := make(map[string]struct{}, len(list))
	for _, p := range list {
		activeIDs[p.ID] = struct{}{}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO projects (id, name, path, allowed_agent, created_at, removed_at)
			 VALUES (?, ?, ?, ?, ?, NULL)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   path = excluded.path,
			   allowed_agent = excluded.allowed_agent,
			   removed_at = NULL`,
			p.ID, p.Name, p.Root, p.AllowedAgent, nowUnix,
		); err != nil {
			return fmt.Errorf("runtime: upsert project %q: %w", p.ID, err)
		}
	}

	// Mark projects no longer in the local catalogue as removed without breaking historical FK rows.
	rows, err := tx.QueryContext(ctx, `SELECT id FROM projects WHERE removed_at IS NULL`)
	if err != nil {
		return fmt.Errorf("runtime: list stored projects: %w", err)
	}
	var toRemove []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		if _, ok := activeIDs[id]; !ok {
			toRemove = append(toRemove, id)
		}
	}
	rows.Close()
	for _, id := range toRemove {
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET removed_at = ? WHERE id = ?`, nowUnix, id); err != nil {
			return fmt.Errorf("runtime: mark removed project %q: %w", id, err)
		}
	}
	return tx.Commit()
}

// HandleMessage decodes, authorizes, and executes one inner JSON request from
// an authenticated Noise session.
func (s *Service) HandleMessage(ctx context.Context, sess *secure.ManagedSession, plaintext []byte) {
	if len(plaintext) == 0 || len(plaintext) > secure.MaxRelayPlaintextSize {
		return
	}

	var req InboundRequest
	if err := json.Unmarshal(plaintext, &req); err != nil {
		s.sendError(ctx, sess, "", "bad_request", "request is not valid JSON")
		return
	}
	if req.V != ProtocolVersion {
		s.sendError(ctx, sess, req.RequestID, "unsupported_version", fmt.Sprintf("unsupported protocol version %d", req.V))
		return
	}
	if req.RequestID == "" || len(req.RequestID) > maxRequestIDLen {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "request_id is required")
		return
	}
	if strings.TrimSpace(req.Method) == "" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "method is required")
		return
	}

	peerStatic := sess.PeerStatic()

	switch req.Method {
	case "pair.submit":
		s.handlePairSubmit(ctx, sess, peerStatic, req)
		return
	case "auth.telegram":
		s.handleAuthTelegram(ctx, sess, peerStatic, req)
		return
	case "device.info":
		s.handleDeviceInfo(ctx, sess, peerStatic, req)
		return
	}

	// All commands beyond pairing/device.info require an explicitly paired,
	// non-revoked phone (checked on every operation, not just at connect).
	client, err := s.pairing.VerifyTrustedClient(ctx, peerStatic)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "unauthorized", err.Error())
		return
	}

	_, _ = s.db.SQL().ExecContext(ctx, `UPDATE trusted_clients SET last_seen_at = ? WHERE id = ?`, s.now().Unix(), client.ID)

	switch req.Method {
	case "project.list":
		s.handleProjectList(ctx, sess, req)
	case "agent.list":
		s.handleAgentList(ctx, sess, req)
	case "session.list":
		s.handleSessionList(ctx, sess, req)
	case "session.open":
		s.handleSessionOpen(ctx, sess, req)
	case "task.start":
		s.handleTaskStart(ctx, sess, client, req)
	case "task.get":
		s.handleTaskGet(ctx, sess, req)
	case "task.cancel":
		s.handleTaskCancel(ctx, sess, req)
	case "approval.resolve":
		s.handleApprovalResolve(ctx, sess, req)
	case "events.resume":
		s.handleEventsResume(ctx, sess, req)
	case "changes.get":
		s.handleChangesGet(ctx, sess, req)
	default:
		s.sendError(ctx, sess, req.RequestID, "bad_request", fmt.Sprintf("unknown method %q", req.Method))
	}
}

func (s *Service) handlePairSubmit(ctx context.Context, sess *secure.ManagedSession, peerStatic []byte, req InboundRequest) {
	var params struct {
		InvitationID     string `json:"invitation_id"`
		InvitationSecret string `json:"invitation_secret"`
		Label            string `json:"label"`
		InitData         string `json:"init_data"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	secret, err := base64.RawURLEncoding.DecodeString(params.InvitationSecret)
	if err != nil || len(secret) != pairing.InvitationSecretSize {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "invitation_secret must be 32 base64url bytes")
		return
	}
	if params.InvitationID != "" {
		invID, err := base64.RawURLEncoding.DecodeString(params.InvitationID)
		if err != nil || len(invID) != 32 {
			s.sendError(ctx, sess, req.RequestID, "bad_request", "invitation_id must be 32 base64url bytes")
			return
		}
		sum := sha256.Sum256(secret)
		if !protocol.ConstantTimeEqual(sum[:], invID) {
			s.sendError(ctx, sess, req.RequestID, "bad_request", "invitation_id does not match invitation_secret")
			return
		}
	}

	pending, err := s.pairing.SubmitPairing(ctx, pairing.SubmitRequest{
		ClientNoisePublicKey: peerStatic,
		PinnedDeviceNoiseKey: s.identity.NoisePublicKey(),
		InvitationSecret:     secret,
		InitData:             params.InitData,
		Label:                params.Label,
	})
	if err != nil {
		if errors.Is(err, pairing.ErrAlreadyPaired) {
			s.sendResult(ctx, sess, req.RequestID, PairSubmitResult{
				State:    "paired",
				DeviceID: s.identity.DeviceIDString(),
			})
			return
		}
		code := "unauthorized"
		switch {
		case errors.Is(err, pairing.ErrInvitationExpired):
			code = "invitation_expired"
		case errors.Is(err, pairing.ErrInvitationReplayed):
			code = "invitation_replayed"
		case errors.Is(err, pairing.ErrInvitationRejected):
			code = "invitation_rejected"
		case errors.Is(err, pairing.ErrInvalidInvitation):
			code = "invalid_invitation"
		case errors.Is(err, pairing.ErrPinMismatch):
			code = "pin_mismatch"
		}
		s.sendError(ctx, sess, req.RequestID, code, err.Error())
		return
	}

	s.sendResult(ctx, sess, req.RequestID, PairSubmitResult{
		State:            "awaiting_local_approval",
		DeviceID:         s.identity.DeviceIDString(),
		VerificationCode: pending.Fingerprint,
	})
}

func (s *Service) handleAuthTelegram(ctx context.Context, sess *secure.ManagedSession, peerStatic []byte, req InboundRequest) {
	var params struct {
		InitData string `json:"init_data"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(params.InitData) == "" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "init_data is required")
		return
	}

	client, err := s.pairing.VerifyTrustedClient(ctx, peerStatic)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "unauthorized", err.Error())
		return
	}
	tgID, err := s.pairing.VerifyTelegramSession(ctx, client.ID, params.InitData)
	if err != nil {
		if errors.Is(err, pairing.ErrTelegramNotConfigured) {
			s.sendError(ctx, sess, req.RequestID, "telegram_not_configured", err.Error())
			return
		}
		s.sendError(ctx, sess, req.RequestID, "unauthorized", err.Error())
		return
	}

	s.sendResult(ctx, sess, req.RequestID, map[string]any{
		"telegram_user_id": tgID.UserID,
		"auth_date":        tgID.AuthDate.Unix(),
	})
}

func (s *Service) handleDeviceInfo(ctx context.Context, sess *secure.ManagedSession, peerStatic []byte, req InboundRequest) {
	_, err := s.pairing.VerifyTrustedClient(ctx, peerStatic)
	if err == nil {
		caps := make([]string, 0, len(s.agents))
		for name := range s.agents {
			caps = append(caps, name)
		}
		s.sendResult(ctx, sess, req.RequestID, DeviceInfoResult{
			DeviceID:     s.identity.DeviceIDString(),
			Paired:       true,
			PairingState: "paired",
			Capabilities: caps,
		})
		return
	}

	state := "unpaired"
	if errors.Is(err, pairing.ErrClientRevoked) {
		state = "revoked"
	} else {
		for _, p := range s.pairing.ListPending() {
			if protocol.ConstantTimeEqual(p.ClientNoisePublicKey, peerStatic) {
				state = "awaiting_local_approval"
				break
			}
		}
	}
	s.sendResult(ctx, sess, req.RequestID, DeviceInfoResult{
		DeviceID:     s.identity.DeviceIDString(),
		Paired:       false,
		PairingState: state,
		Capabilities: []string{},
	})
}

func (s *Service) handleProjectList(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	list := s.projects.List()
	out := make([]ProjectInfo, 0, len(list))
	for _, p := range list {
		out = append(out, ProjectInfo{
			ProjectID: p.ID,
			Name:      p.Name,
			Agents:    []string{p.AllowedAgent},
		})
	}
	s.sendResult(ctx, sess, req.RequestID, map[string]any{"projects": out})
}

func (s *Service) handleAgentList(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	s.sendResult(ctx, sess, req.RequestID, AgentListResult{Agents: s.catalog.List(ctx)})
}

func (s *Service) handleSessionList(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		ProjectID string `json:"project_id"`
	}
	if len(bytes.TrimSpace(req.Params)) > 0 {
		if err := decodeStrictParams(req.Params, &params); err != nil {
			s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
			return
		}
	}

	query := `SELECT s.id, s.project_id, s.adapter, COALESCE(s.agent_thread_id, ''), s.created_at,
	          COALESCE((SELECT MAX(t.updated_at) FROM tasks t WHERE t.session_id = s.id), s.created_at)
	          FROM agent_sessions s WHERE s.closed_at IS NULL`
	var args []any
	if params.ProjectID != "" {
		if _, err := s.projects.Get(params.ProjectID); err != nil {
			s.sendError(ctx, sess, req.RequestID, "not_found", err.Error())
			return
		}
		query += ` AND s.project_id = ?`
		args = append(args, params.ProjectID)
	}
	query += ` ORDER BY s.created_at DESC LIMIT 50`

	rows, err := s.db.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to list sessions")
		return
	}
	defer rows.Close()

	sessions := make([]SessionSummary, 0)
	for rows.Next() {
		var item SessionSummary
		if err := rows.Scan(&item.SessionID, &item.ProjectID, &item.Agent, &item.ThreadID, &item.CreatedAt, &item.UpdatedAt); err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to scan session")
			return
		}
		sessions = append(sessions, item)
	}
	s.sendResult(ctx, sess, req.RequestID, map[string]any{"sessions": sessions})
}

func (s *Service) handleSessionOpen(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		ProjectID string `json:"project_id"`
		SessionID string `json:"session_id"`
		Agent     string `json:"agent"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	proj, err := s.projects.Get(params.ProjectID)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "not_found", err.Error())
		return
	}

	agentName := params.Agent
	if agentName == "" {
		agentName = proj.AllowedAgent
	}
	if !proj.AllowsAgent(agentName) {
		s.sendError(ctx, sess, req.RequestID, "bad_request", fmt.Sprintf("agent %q is not permitted in project %q", agentName, proj.ID))
		return
	}
	if _, ok := s.agents[agentName]; !ok {
		s.sendError(ctx, sess, req.RequestID, "agent_unavailable", fmt.Sprintf("agent %q is not registered", agentName))
		return
	}

	if params.SessionID != "" {
		var pid, adp string
		var lastSeq int64
		err := s.db.SQL().QueryRowContext(ctx,
			`SELECT s.project_id, s.adapter, COALESCE((SELECT MAX(e.seq) FROM events e WHERE e.session_id = s.id), 0)
			 FROM agent_sessions s WHERE s.id = ? AND s.closed_at IS NULL`,
			params.SessionID,
		).Scan(&pid, &adp, &lastSeq)
		if errors.Is(err, sql.ErrNoRows) {
			s.sendError(ctx, sess, req.RequestID, "not_found", "session not found")
			return
		}
		if err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to load session")
			return
		}
		if pid != proj.ID || adp != agentName {
			s.sendError(ctx, sess, req.RequestID, "bad_request", "session does not match project or agent")
			return
		}
		turns, truncated, err := s.sessionTurns(ctx, params.SessionID)
		if err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to load session turns")
			return
		}
		s.sendResult(ctx, sess, req.RequestID, SessionOpenResult{
			SessionID:      params.SessionID,
			ProjectID:      pid,
			Agent:          adp,
			LastSeq:        lastSeq,
			Tasks:          turns,
			TasksTruncated: truncated,
		})
		return
	}

	sessionID, err := randomID("sess")
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to allocate session id")
		return
	}
	nowUnix := s.now().Unix()
	if _, err := s.db.SQL().ExecContext(ctx,
		`INSERT INTO agent_sessions (id, project_id, adapter, agent_thread_id, created_at)
		 VALUES (?, ?, ?, NULL, ?)`,
		sessionID, proj.ID, agentName, nowUnix,
	); err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to create session")
		return
	}

	s.sendResult(ctx, sess, req.RequestID, SessionOpenResult{
		SessionID: sessionID,
		ProjectID: proj.ID,
		Agent:     agentName,
		LastSeq:   0,
		Tasks:     []TaskView{},
	})
}

// SessionOpenResult is the result of session.open. Tasks are the turns of the
// session, oldest first, so a client can render the conversation after a
// reconnect without knowing task ids in advance.
type SessionOpenResult struct {
	SessionID string `json:"session_id"`
	ProjectID string `json:"project_id"`
	Agent     string `json:"agent"`
	LastSeq   int64  `json:"last_seq"`
	// Tasks holds the most recent turns that fit the frame budget, oldest
	// first. Prompt and result text are bounded per entry; task.get returns
	// the full stored text of one turn.
	Tasks []TaskView `json:"tasks"`
	// TasksTruncated is true when older turns of the session were left out.
	TasksTruncated bool `json:"tasks_truncated,omitempty"`
}

// sessionTurns loads the newest turns of a session within the frame budget
// and returns them oldest first.
func (s *Service) sessionTurns(ctx context.Context, sessionID string) ([]TaskView, bool, error) {
	tx, err := s.db.SQL().BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback() //nolint:errcheck

	rows, err := tx.QueryContext(ctx,
		`SELECT id FROM tasks WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
		sessionID, maxSessionTurns+1,
	)
	if err != nil {
		return nil, false, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, false, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, false, err
	}
	rows.Close()

	truncated := len(ids) > maxSessionTurns
	if truncated {
		ids = ids[:maxSessionTurns]
	}

	newestFirst := make([]TaskView, 0, len(ids))
	budget := maxSessionTurnsBytes
	for _, id := range ids {
		view, err := s.loadTaskTx(ctx, tx, id)
		if err != nil {
			return nil, false, err
		}
		view.Prompt = truncateUTF8(view.Prompt, maxSessionTurnTextBytes)
		view.ResultText = truncateUTF8(view.ResultText, maxSessionTurnTextBytes)
		view.ErrorMessage = truncateUTF8(view.ErrorMessage, maxSessionTurnTextBytes)
		raw, err := json.Marshal(view)
		if err != nil {
			return nil, false, err
		}
		if len(raw) > budget {
			truncated = true
			break
		}
		budget -= len(raw)
		newestFirst = append(newestFirst, view)
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}

	turns := make([]TaskView, 0, len(newestFirst))
	for i := len(newestFirst) - 1; i >= 0; i-- {
		turns = append(turns, newestFirst[i])
	}
	return turns, truncated, nil
}

func (s *Service) handleTaskStart(ctx context.Context, sess *secure.ManagedSession, client *pairing.TrustedClient, req InboundRequest) {
	var params struct {
		ProjectID string  `json:"project_id"`
		SessionID *string `json:"session_id"`
		Agent     string  `json:"agent"`
		// AgentID is the preferred name of Agent; if both are sent they
		// must agree.
		AgentID string `json:"agent_id"`
		// Model optionally selects a model from the agent's model list.
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(params.ProjectID) == "" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "project_id is required")
		return
	}
	if strings.TrimSpace(params.Prompt) == "" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "prompt is required")
		return
	}
	if len(params.Prompt) > maxPromptBytes {
		s.sendError(ctx, sess, req.RequestID, "bad_request", fmt.Sprintf("prompt exceeds %d bytes", maxPromptBytes))
		return
	}

	proj, err := s.projects.Get(params.ProjectID)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "not_found", err.Error())
		return
	}
	agentName := strings.TrimSpace(params.Agent)
	if id := strings.TrimSpace(params.AgentID); id != "" {
		if agentName != "" && agentName != id {
			s.sendError(ctx, sess, req.RequestID, "bad_request", "agent and agent_id disagree")
			return
		}
		agentName = id
	}
	if agentName == "" {
		agentName = proj.AllowedAgent
	}
	requestedModel := strings.TrimSpace(params.Model)
	if len(requestedModel) > maxModelIDBytes {
		s.sendError(ctx, sess, req.RequestID, "bad_request", fmt.Sprintf("model exceeds %d bytes", maxModelIDBytes))
		return
	}
	// A detected agent that Agentik cannot drive yet gets its own error
	// rather than a generic "not permitted".
	if _, registered := s.agents[agentName]; !registered {
		if _, selErr := s.catalog.Resolve(ctx, agentName, ""); selErr != nil {
			var se *agents.SelectionError
			if errors.As(selErr, &se) && se.Code == agents.ErrCodeUnsupported {
				s.sendError(ctx, sess, req.RequestID, "agent_unsupported", se.Message)
				return
			}
		}
	}
	if !proj.AllowsAgent(agentName) {
		s.sendError(ctx, sess, req.RequestID, "bad_request", fmt.Sprintf("agent %q is not permitted in project %q", agentName, proj.ID))
		return
	}
	adapter, ok := s.agents[agentName]
	if !ok {
		s.sendError(ctx, sess, req.RequestID, "agent_unavailable", fmt.Sprintf("agent %q is not registered", agentName))
		return
	}

	reqSessionID := ""
	if params.SessionID != nil {
		reqSessionID = strings.TrimSpace(*params.SessionID)
	}

	enc := protocol.NewEncoder("agentik-task-start-v1").
		AddString(proj.ID).
		AddString(reqSessionID).
		AddString(agentName).
		AddString(params.Prompt)
	if requestedModel != "" {
		// Added only when set, so the hash of a request without a model is
		// the same as before model selection existed.
		enc = enc.AddString(requestedModel)
	}
	encBytes, err := enc.Bytes()
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	contentHash := sha256.Sum256(encBytes)

	// Validate the model only for a request that has not been accepted yet:
	// a retry of an accepted request returns the original task whatever the
	// model list looks like now. This runs before the transaction because it
	// may start the agent CLI.
	if !s.alreadyAccepted(ctx, client.ID, req.RequestID, contentHash[:]) {
		sel, selErr := s.catalog.Resolve(ctx, agentName, requestedModel)
		if selErr != nil {
			code := "bad_request"
			var se *agents.SelectionError
			if errors.As(selErr, &se) {
				switch se.Code {
				case agents.ErrCodeUnsupported:
					code = "agent_unsupported"
				case agents.ErrCodeNotReady:
					code = "agent_not_ready"
				case agents.ErrCodeUnknownModel:
					code = "unknown_model"
				default:
					code = "agent_unavailable"
				}
			}
			s.sendError(ctx, sess, req.RequestID, code, selErr.Error())
			return
		}
		requestedModel = sel.Model
	}

	tx, err := s.db.SQL().BeginTx(ctx, nil)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to begin task transaction")
		return
	}
	defer tx.Rollback() //nolint:errcheck

	// 1. Idempotency check by (client_id, request_id).
	var existingMethod string
	var existingHash []byte
	var existingTaskID sql.NullString
	err = tx.QueryRowContext(ctx,
		`SELECT method, content_hash, task_id FROM commands WHERE client_id = ? AND request_id = ?`,
		client.ID, req.RequestID,
	).Scan(&existingMethod, &existingHash, &existingTaskID)
	if err == nil {
		if existingMethod != "task.start" || !protocol.ConstantTimeEqual(existingHash, contentHash[:]) {
			s.sendError(ctx, sess, req.RequestID, "request_id_conflict", "request_id was already used with different content")
			return
		}
		if !existingTaskID.Valid {
			s.sendError(ctx, sess, req.RequestID, "internal", "deduplicated command has no task")
			return
		}
		taskView, err := s.loadTaskTx(ctx, tx, existingTaskID.String)
		if err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to load deduplicated task")
			return
		}
		if err := tx.Commit(); err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to commit lookup")
			return
		}
		s.sendResult(ctx, sess, req.RequestID, TaskResult{Task: taskView, Deduplicated: true})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to check command deduplication")
		return
	}

	// 2. One active task per project directory (AGENTIK.md section 7.1).
	var activeCount int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM tasks t
		 JOIN agent_sessions a ON t.session_id = a.id
		 WHERE a.project_id = ?
		   AND t.state IN ('accepted','starting','running','awaiting_approval','cancel_requested')`,
		proj.ID,
	).Scan(&activeCount); err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to check project concurrency")
		return
	}
	if activeCount > 0 {
		s.sendError(ctx, sess, req.RequestID, "project_busy", "another task is already active in this project")
		return
	}

	nowUnix := s.now().Unix()

	// 3. Resolve or create session.
	sessionID := reqSessionID
	var agentThreadID string
	if sessionID != "" {
		var pid, adp string
		var thr sql.NullString
		err := tx.QueryRowContext(ctx,
			`SELECT project_id, adapter, agent_thread_id FROM agent_sessions WHERE id = ? AND closed_at IS NULL`,
			sessionID,
		).Scan(&pid, &adp, &thr)
		if errors.Is(err, sql.ErrNoRows) {
			s.sendError(ctx, sess, req.RequestID, "not_found", "session not found")
			return
		}
		if err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to load session")
			return
		}
		if pid != proj.ID || adp != agentName {
			s.sendError(ctx, sess, req.RequestID, "bad_request", "session does not belong to this project or agent")
			return
		}
		if thr.Valid {
			agentThreadID = thr.String
		}
	} else {
		sessionID, err = randomID("sess")
		if err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to allocate session id")
			return
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO agent_sessions (id, project_id, adapter, agent_thread_id, created_at)
			 VALUES (?, ?, ?, NULL, ?)`,
			sessionID, proj.ID, agentName, nowUnix,
		); err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to create session")
			return
		}
	}

	taskID, err := randomID("task")
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to allocate task id")
		return
	}

	// 4. Write task='accepted', command dedup record, and initial event atomically.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO tasks (id, session_id, client_id, prompt, model, state, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`,
		taskID, sessionID, client.ID, params.Prompt, requestedModel, nowUnix, nowUnix,
	); err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to persist task")
		return
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO commands (client_id, request_id, method, content_hash, task_id, created_at)
		 VALUES (?, ?, 'task.start', ?, ?, ?)`,
		client.ID, req.RequestID, contentHash[:], taskID, nowUnix,
	); err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to persist command idempotency record")
		return
	}

	initEvent, err := s.appendEventTx(ctx, tx, sessionID, taskID, "status", map[string]any{
		"state": string(TaskAccepted),
	}, nowUnix)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to persist initial task event")
		return
	}

	taskView, err := s.loadTaskTx(ctx, tx, taskID)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to load task")
		return
	}

	if err := tx.Commit(); err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to commit task")
		return
	}

	s.sendResult(ctx, sess, req.RequestID, TaskResult{Task: taskView, Deduplicated: false})
	s.emitLiveEvent("session.event", initEvent)

	s.wg.Add(1)
	go s.executeTask(taskID, sessionID, proj, adapter, agentThreadID, params.Prompt, requestedModel)
}

// alreadyAccepted reports whether a task.start with this client, request id
// and content hash has already been recorded.
func (s *Service) alreadyAccepted(ctx context.Context, clientID int64, requestID string, hash []byte) bool {
	var method string
	var stored []byte
	err := s.db.SQL().QueryRowContext(ctx,
		`SELECT method, content_hash FROM commands WHERE client_id = ? AND request_id = ?`,
		clientID, requestID,
	).Scan(&method, &stored)
	return err == nil && method == "task.start" && protocol.ConstantTimeEqual(stored, hash)
}

func (s *Service) executeTask(
	taskID string,
	sessionID string,
	proj projects.Project,
	adapter codex.Adapter,
	agentThreadID string,
	prompt string,
	model string,
) {
	defer s.wg.Done()

	if s.isCancelRequested(taskID) {
		s.finishTask(taskID, sessionID, TaskCancelled, "", "", "cancelled before launch")
		return
	}

	// Check binary availability and auth before entering running.
	diag := adapter.Diagnose(s.baseCtx)
	if !diag.Available {
		msg := diag.Detail
		if msg == "" {
			msg = fmt.Sprintf("agent %q is not installed", adapter.Name())
		}
		s.finishTask(taskID, sessionID, TaskFailed, "", "", msg)
		return
	}
	if !diag.Authenticated {
		msg := diag.Detail
		if msg == "" {
			msg = fmt.Sprintf("agent %q is not authenticated", adapter.Name())
		}
		s.finishTask(taskID, sessionID, TaskFailed, "", "", msg)
		return
	}

	if !s.transitionTask(taskID, sessionID, TaskStarting, "starting agent process") {
		return
	}

	if s.beforeLaunchHook != nil {
		if err := s.beforeLaunchHook(s.baseCtx, taskID); err != nil {
			// Leave state as starting (if fault simulated a crash before spawn)
			// when hook returns ErrSimulatedCrash, or fail cleanly.
			if errors.Is(err, ErrSimulatedCrash) {
				return
			}
			s.finishTask(taskID, sessionID, TaskFailed, "", "", err.Error())
			return
		}
	}

	if s.isCancelRequested(taskID) {
		s.finishTask(taskID, sessionID, TaskCancelled, "", "", "cancelled before process spawn")
		return
	}

	turn, err := adapter.StartTurn(s.baseCtx, codex.StartTurnRequest{
		ProjectRoot: proj.Root,
		ThreadID:    agentThreadID,
		Prompt:      prompt,
		Model:       model,
	}, codex.TurnCallbacks{
		OnStarted: func(threadID, turnID string) {
			if threadID != "" {
				_, _ = s.db.SQL().ExecContext(s.baseCtx,
					`UPDATE agent_sessions SET agent_thread_id = ? WHERE id = ? AND (agent_thread_id IS NULL OR agent_thread_id = '')`,
					threadID, sessionID,
				)
			}
			if !s.isCancelRequested(taskID) {
				_ = s.transitionTask(taskID, sessionID, TaskRunning, "")
			}
		},
		OnEvent: func(ev codex.Event) {
			kind := string(ev.Kind)
			payload := ev.Payload
			if payload == nil {
				payload = map[string]any{}
			}
			if ev.Text != "" && payload["text"] == nil && ev.Kind != codex.EventDiff {
				payload["text"] = truncateUTF8(ev.Text, 8*1024)
			}
			s.recordAndPublishEvent(sessionID, taskID, kind, payload)
		},
		OnApproval: func(apCtx context.Context, req codex.ApprovalRequest) (bool, error) {
			return s.waitForApproval(apCtx, taskID, sessionID, req)
		},
	})
	if err != nil {
		s.finishTask(taskID, sessionID, TaskFailed, "", "", err.Error())
		return
	}

	s.mu.Lock()
	s.activeTurns[taskID] = turn
	s.mu.Unlock()

	if s.isCancelRequested(taskID) {
		_ = turn.Interrupt(s.baseCtx)
	}

	res := turn.Wait()

	s.mu.Lock()
	delete(s.activeTurns, taskID)
	s.mu.Unlock()

	if res.ThreadID != "" {
		_, _ = s.db.SQL().ExecContext(s.baseCtx,
			`UPDATE agent_sessions SET agent_thread_id = ? WHERE id = ? AND (agent_thread_id IS NULL OR agent_thread_id = '')`,
			res.ThreadID, sessionID,
		)
	}

	switch res.Status {
	case codex.OutcomeSucceeded:
		s.finishTask(taskID, sessionID, TaskSucceeded, res.ResultText, res.Diff, "")
	case codex.OutcomeCancelled:
		s.finishTask(taskID, sessionID, TaskCancelled, res.ResultText, res.Diff, "")
	case codex.OutcomeFailed:
		s.finishTask(taskID, sessionID, TaskFailed, res.ResultText, res.Diff, res.Error)
	case codex.OutcomeTransportLost:
		if errors.Is(s.baseCtx.Err(), context.Canceled) {
			// Daemon is shutting down; leave SQLite active/recovery state to startup Reconcile.
			return
		}
		errMsg := res.Error
		if errMsg == "" {
			errMsg = "agent process exited before confirming turn outcome"
		}
		s.finishTask(taskID, sessionID, TaskRecoveryRequired, res.ResultText, res.Diff, errMsg)
	default:
		s.finishTask(taskID, sessionID, TaskRecoveryRequired, res.ResultText, res.Diff, "unknown agent turn outcome")
	}
}

// ErrSimulatedCrash can be returned from Config.BeforeLaunchHook in tests to
// simulate a daemon crash between committing state='starting' and spawning.
var ErrSimulatedCrash = errors.New("runtime: simulated crash")

func (s *Service) waitForApproval(
	apCtx context.Context,
	taskID string,
	sessionID string,
	req codex.ApprovalRequest,
) (bool, error) {
	if s.isCancelRequested(taskID) {
		return false, nil
	}

	approvalID, err := randomID("apr")
	if err != nil {
		return false, err
	}
	now := s.now()
	expiresAt := now.Add(s.approvalTTL)

	actionObj := map[string]any{
		"kind":    string(req.Kind),
		"summary": req.Summary,
		"detail":  req.Detail,
	}
	actionJSON, _ := json.Marshal(actionObj)

	tx, err := s.db.SQL().BeginTx(s.baseCtx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.ExecContext(s.baseCtx,
		`INSERT INTO approvals (id, task_id, session_id, action, state, created_at, expires_at)
		 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
		approvalID, taskID, sessionID, string(actionJSON), now.Unix(), expiresAt.Unix(),
	); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(s.baseCtx,
		`UPDATE tasks SET state = 'awaiting_approval', updated_at = ? WHERE id = ?`,
		now.Unix(), taskID,
	); err != nil {
		return false, err
	}
	ev, err := s.appendEventTx(s.baseCtx, tx, sessionID, taskID, "approval_requested", map[string]any{
		"approval_id": approvalID,
		"kind":        string(req.Kind),
		"summary":     req.Summary,
		"expires_at":  expiresAt.Unix(),
	}, now.Unix())
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}

	waiter := &approvalWaiter{
		taskID:    taskID,
		sessionID: sessionID,
		expiresAt: expiresAt,
		ch:        make(chan bool, 1),
	}
	s.mu.Lock()
	s.approvals[approvalID] = waiter
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.approvals, approvalID)
		s.mu.Unlock()
	}()

	s.emitLiveEvent("session.event", ev)

	timer := time.NewTimer(s.approvalTTL)
	defer timer.Stop()

	select {
	case approved, ok := <-waiter.ch:
		return ok && approved, nil
	case <-timer.C:
		s.expireApproval(approvalID, taskID, sessionID)
		return false, nil
	case <-apCtx.Done():
		s.expireApproval(approvalID, taskID, sessionID)
		return false, apCtx.Err()
	case <-s.baseCtx.Done():
		return false, s.baseCtx.Err()
	}
}

func (s *Service) expireApproval(approvalID, taskID, sessionID string) {
	nowUnix := s.now().Unix()
	tx, err := s.db.SQL().BeginTx(context.Background(), nil)
	if err != nil {
		return
	}
	defer tx.Rollback() //nolint:errcheck

	res, err := tx.Exec(
		`UPDATE approvals SET state = 'expired', resolved_at = ? WHERE id = ? AND state = 'pending'`,
		nowUnix, approvalID,
	)
	if err != nil {
		return
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return
	}
	_, _ = tx.Exec(
		`UPDATE tasks SET state = 'running', updated_at = ? WHERE id = ? AND state = 'awaiting_approval'`,
		nowUnix, taskID,
	)
	ev, err := s.appendEventTx(context.Background(), tx, sessionID, taskID, "approval_resolved", map[string]any{
		"approval_id": approvalID,
		"status":      "expired",
	}, nowUnix)
	if err != nil {
		return
	}
	if tx.Commit() == nil {
		s.emitLiveEvent("session.event", ev)
	}
}

func (s *Service) handleApprovalResolve(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		ApprovalID string `json:"approval_id"`
		Decision   string `json:"decision"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(params.ApprovalID) == "" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "approval_id is required")
		return
	}
	if params.Decision != "accept" && params.Decision != "decline" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "decision must be accept or decline")
		return
	}

	now := s.now()
	nowUnix := now.Unix()
	dbState := "rejected"
	statusOut := "declined"
	approved := false
	if params.Decision == "accept" {
		dbState = "approved"
		statusOut = "accepted"
		approved = true
	}

	tx, err := s.db.SQL().BeginTx(ctx, nil)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to begin approval tx")
		return
	}
	defer tx.Rollback() //nolint:errcheck

	var taskID, sessionID, currentState string
	var expiresAtUnix int64
	err = tx.QueryRowContext(ctx,
		`SELECT task_id, session_id, state, expires_at FROM approvals WHERE id = ?`,
		params.ApprovalID,
	).Scan(&taskID, &sessionID, &currentState, &expiresAtUnix)
	if errors.Is(err, sql.ErrNoRows) {
		s.sendError(ctx, sess, req.RequestID, "not_found", "approval not found")
		return
	}
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to load approval")
		return
	}

	if currentState != "pending" {
		s.sendError(ctx, sess, req.RequestID, "approval_already_resolved", fmt.Sprintf("approval is already %s", currentState))
		return
	}
	if nowUnix >= expiresAtUnix {
		_, _ = tx.ExecContext(ctx,
			`UPDATE approvals SET state = 'expired', resolved_at = ? WHERE id = ? AND state = 'pending'`,
			nowUnix, params.ApprovalID,
		)
		_ = tx.Commit()
		s.sendError(ctx, sess, req.RequestID, "approval_expired", "approval request expired")
		return
	}

	res, err := tx.ExecContext(ctx,
		`UPDATE approvals SET state = ?, resolved_at = ? WHERE id = ? AND state = 'pending'`,
		dbState, nowUnix, params.ApprovalID,
	)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to update approval")
		return
	}
	if n, _ := res.RowsAffected(); n != 1 {
		s.sendError(ctx, sess, req.RequestID, "approval_already_resolved", "approval already resolved")
		return
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE tasks SET state = 'running', updated_at = ? WHERE id = ? AND state = 'awaiting_approval'`,
		nowUnix, taskID,
	); err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to update task state")
		return
	}

	ev, err := s.appendEventTx(ctx, tx, sessionID, taskID, "approval_resolved", map[string]any{
		"approval_id": params.ApprovalID,
		"status":      statusOut,
	}, nowUnix)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to append approval event")
		return
	}
	if err := tx.Commit(); err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to commit approval")
		return
	}

	s.mu.Lock()
	waiter := s.approvals[params.ApprovalID]
	s.mu.Unlock()
	if waiter != nil {
		waiter.resolve(approved)
	}

	s.emitLiveEvent("session.event", ev)
	s.sendResult(ctx, sess, req.RequestID, ApprovalResolveResult{
		ApprovalID: params.ApprovalID,
		Status:     statusOut,
	})
}

func (s *Service) handleTaskGet(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		TaskID string `json:"task_id"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(params.TaskID) == "" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "task_id is required")
		return
	}
	tx, err := s.db.SQL().BeginTx(ctx, nil)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to read task")
		return
	}
	defer tx.Rollback() //nolint:errcheck

	view, err := s.loadTaskTx(ctx, tx, params.TaskID)
	if errors.Is(err, sql.ErrNoRows) {
		s.sendError(ctx, sess, req.RequestID, "not_found", "task not found")
		return
	}
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to load task")
		return
	}
	_ = tx.Commit()
	s.sendResult(ctx, sess, req.RequestID, TaskResult{Task: view})
}

func (s *Service) handleTaskCancel(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		TaskID string `json:"task_id"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(params.TaskID) == "" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "task_id is required")
		return
	}

	nowUnix := s.now().Unix()
	tx, err := s.db.SQL().BeginTx(ctx, nil)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to begin cancel tx")
		return
	}
	defer tx.Rollback() //nolint:errcheck

	view, err := s.loadTaskTx(ctx, tx, params.TaskID)
	if errors.Is(err, sql.ErrNoRows) {
		s.sendError(ctx, sess, req.RequestID, "not_found", "task not found")
		return
	}
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to load task")
		return
	}

	var ev *SessionEventView
	if view.State.Active() && view.State != TaskCancelRequested {
		if _, err := tx.ExecContext(ctx,
			`UPDATE tasks SET state = 'cancel_requested', updated_at = ? WHERE id = ?`,
			nowUnix, params.TaskID,
		); err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to update task state")
			return
		}
		_, _ = tx.ExecContext(ctx,
			`UPDATE approvals SET state = 'rejected', resolved_at = ? WHERE task_id = ? AND state = 'pending'`,
			nowUnix, params.TaskID,
		)
		e, err := s.appendEventTx(ctx, tx, view.SessionID, params.TaskID, "status", map[string]any{
			"state": string(TaskCancelRequested),
		}, nowUnix)
		if err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to append cancel event")
			return
		}
		ev = &e
		view.State = TaskCancelRequested
		view.PendingApproval = nil
		view.UpdatedAt = nowUnix
	}
	if err := tx.Commit(); err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to commit cancel")
		return
	}
	if ev != nil {
		s.emitLiveEvent("session.event", *ev)
	}

	s.mu.Lock()
	for _, w := range s.approvals {
		if w.taskID == params.TaskID {
			w.resolve(false)
		}
	}
	turn := s.activeTurns[params.TaskID]
	s.mu.Unlock()
	if turn != nil {
		go func() {
			iCtx, cancel := context.WithTimeout(s.baseCtx, 5*time.Second)
			defer cancel()
			_ = turn.Interrupt(iCtx)
		}()
	}

	s.sendResult(ctx, sess, req.RequestID, TaskResult{Task: view})
}

func (s *Service) handleEventsResume(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		SessionID string `json:"session_id"`
		AfterSeq  int64  `json:"after_seq"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(params.SessionID) == "" || params.AfterSeq < 0 {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "valid session_id and non-negative after_seq are required")
		return
	}

	var exists int
	if err := s.db.SQL().QueryRowContext(ctx,
		`SELECT COUNT(1) FROM agent_sessions WHERE id = ?`,
		params.SessionID,
	).Scan(&exists); err != nil || exists == 0 {
		s.sendError(ctx, sess, req.RequestID, "not_found", "session not found")
		return
	}

	rows, err := s.db.SQL().QueryContext(ctx,
		`SELECT session_id, seq, COALESCE(task_id, ''), kind, payload, created_at
		 FROM events WHERE session_id = ? AND seq > ?
		 ORDER BY seq ASC LIMIT ?`,
		params.SessionID, params.AfterSeq, maxResumeBatch,
	)
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to query events")
		return
	}
	defer rows.Close()

	events := make([]SessionEventView, 0)
	nextSeq := params.AfterSeq
	totalBytes := 0
	truncated := false
	for rows.Next() {
		var ev SessionEventView
		var payloadStr string
		if err := rows.Scan(&ev.SessionID, &ev.Seq, &ev.TaskID, &ev.Kind, &payloadStr, &ev.CreatedAt); err != nil {
			s.sendError(ctx, sess, req.RequestID, "internal", "failed to scan event")
			return
		}
		if totalBytes+len(payloadStr) > maxEventsPageBytes && len(events) > 0 {
			truncated = true
			break
		}
		totalBytes += len(payloadStr)
		var p map[string]any
		if json.Unmarshal([]byte(payloadStr), &p) == nil {
			ev.Payload = p
		} else {
			ev.Payload = map[string]any{}
		}
		events = append(events, ev)
		nextSeq = ev.Seq
	}
	if err := rows.Err(); err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to read events")
		return
	}

	s.sendResult(ctx, sess, req.RequestID, EventsResumeResult{
		SessionID: params.SessionID,
		Events:    events,
		NextSeq:   nextSeq,
		Truncated: truncated,
	})
}

func (s *Service) handleChangesGet(ctx context.Context, sess *secure.ManagedSession, req InboundRequest) {
	var params struct {
		TaskID string `json:"task_id"`
	}
	if err := decodeStrictParams(req.Params, &params); err != nil {
		s.sendError(ctx, sess, req.RequestID, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(params.TaskID) == "" {
		s.sendError(ctx, sess, req.RequestID, "bad_request", "task_id is required")
		return
	}

	var exists int
	if err := s.db.SQL().QueryRowContext(ctx, `SELECT COUNT(1) FROM tasks WHERE id = ?`, params.TaskID).Scan(&exists); err != nil || exists == 0 {
		s.sendError(ctx, sess, req.RequestID, "not_found", "task not found")
		return
	}

	var payloadStr string
	err := s.db.SQL().QueryRowContext(ctx,
		`SELECT payload FROM events WHERE task_id = ? AND kind = 'diff' ORDER BY seq DESC LIMIT 1`,
		params.TaskID,
	).Scan(&payloadStr)
	if errors.Is(err, sql.ErrNoRows) {
		s.sendResult(ctx, sess, req.RequestID, ChangesResult{TaskID: params.TaskID, Diff: "", Truncated: false})
		return
	}
	if err != nil {
		s.sendError(ctx, sess, req.RequestID, "internal", "failed to load task diff")
		return
	}

	var p map[string]any
	diff := ""
	if json.Unmarshal([]byte(payloadStr), &p) == nil {
		if d, ok := p["diff"].(string); ok {
			diff = d
		}
	}
	truncated := len(diff) > maxDiffReturnBytes
	if truncated {
		diff = truncateUTF8(diff, maxDiffReturnBytes)
	}
	s.sendResult(ctx, sess, req.RequestID, ChangesResult{
		TaskID:    params.TaskID,
		Diff:      diff,
		Truncated: truncated,
	})
}

func (s *Service) isCancelRequested(taskID string) bool {
	var state string
	if err := s.db.SQL().QueryRowContext(context.Background(), `SELECT state FROM tasks WHERE id = ?`, taskID).Scan(&state); err != nil {
		return false
	}
	return state == string(TaskCancelRequested)
}

func (s *Service) transitionTask(taskID, sessionID string, next TaskState, message string) bool {
	nowUnix := s.now().Unix()
	tx, err := s.db.SQL().BeginTx(context.Background(), nil)
	if err != nil {
		return false
	}
	defer tx.Rollback() //nolint:errcheck

	res, err := tx.Exec(
		`UPDATE tasks SET state = ?, updated_at = ?
		 WHERE id = ? AND state IN ('accepted','starting','running','awaiting_approval')`,
		string(next), nowUnix, taskID,
	)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return false
	}
	payload := map[string]any{"state": string(next)}
	if message != "" {
		payload["message"] = message
	}
	ev, err := s.appendEventTx(context.Background(), tx, sessionID, taskID, "status", payload, nowUnix)
	if err != nil {
		return false
	}
	if err := tx.Commit(); err != nil {
		return false
	}
	s.emitLiveEvent("session.event", ev)
	return true
}

func (s *Service) finishTask(taskID, sessionID string, finalState TaskState, resultText, diff, errText string) {
	nowUnix := s.now().Unix()
	boundedResult := truncateUTF8(resultText, maxResultFieldBytes)

	tx, err := s.db.SQL().BeginTx(context.Background(), nil)
	if err != nil {
		return
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.Exec(
		`UPDATE tasks SET state = ?, result = ?, error = ?, updated_at = ? WHERE id = ?`,
		string(finalState), nullIfEmpty(boundedResult), nullIfEmpty(errText), nowUnix, taskID,
	); err != nil {
		return
	}
	_, _ = tx.Exec(
		`UPDATE approvals SET state = 'expired', resolved_at = ? WHERE task_id = ? AND state = 'pending'`,
		nowUnix, taskID,
	)

	var events []SessionEventView
	if diff != "" {
		var existingDiffCount int
		_ = tx.QueryRow(`SELECT COUNT(1) FROM events WHERE task_id = ? AND kind = 'diff'`, taskID).Scan(&existingDiffCount)
		if existingDiffCount == 0 {
			ev, err := s.appendEventTx(context.Background(), tx, sessionID, taskID, "diff", map[string]any{
				"diff": truncateUTF8(diff, maxDiffReturnBytes),
			}, nowUnix)
			if err == nil {
				events = append(events, ev)
			}
		}
	}

	kind := "completed"
	payload := map[string]any{"state": string(finalState)}
	if boundedResult != "" {
		payload["result_text"] = boundedResult
	}
	if errText != "" {
		payload["error"] = errText
		if finalState == TaskFailed || finalState == TaskRecoveryRequired {
			kind = "error"
		}
	}
	ev, err := s.appendEventTx(context.Background(), tx, sessionID, taskID, kind, payload, nowUnix)
	if err != nil {
		return
	}
	events = append(events, ev)

	if err := tx.Commit(); err != nil {
		return
	}
	for _, item := range events {
		s.emitLiveEvent("session.event", item)
	}
}

func (s *Service) recordAndPublishEvent(sessionID, taskID, kind string, payload map[string]any) {
	nowUnix := s.now().Unix()
	tx, err := s.db.SQL().BeginTx(context.Background(), nil)
	if err != nil {
		return
	}
	defer tx.Rollback() //nolint:errcheck

	ev, err := s.appendEventTx(context.Background(), tx, sessionID, taskID, kind, payload, nowUnix)
	if err != nil {
		return
	}
	if err := tx.Commit(); err != nil {
		return
	}
	s.emitLiveEvent("session.event", ev)
}

func (s *Service) appendEventTx(
	ctx context.Context,
	tx *sql.Tx,
	sessionID string,
	taskID string,
	kind string,
	payload map[string]any,
	nowUnix int64,
) (SessionEventView, error) {
	var nextSeq int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?`,
		sessionID,
	).Scan(&nextSeq); err != nil {
		return SessionEventView{}, err
	}
	if payload == nil {
		payload = map[string]any{}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return SessionEventView{}, err
	}
	var nullableTask any
	if taskID != "" {
		nullableTask = taskID
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO events (session_id, seq, task_id, kind, payload, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		sessionID, nextSeq, nullableTask, kind, string(raw), nowUnix,
	); err != nil {
		return SessionEventView{}, err
	}
	return SessionEventView{
		SessionID: sessionID,
		TaskID:    taskID,
		Seq:       nextSeq,
		Kind:      kind,
		Payload:   payload,
		CreatedAt: nowUnix,
	}, nil
}

func (s *Service) loadTaskTx(ctx context.Context, tx *sql.Tx, taskID string) (TaskView, error) {
	var v TaskView
	var stateStr string
	var resultText, errText sql.NullString
	err := tx.QueryRowContext(ctx,
		`SELECT t.id, t.session_id, a.project_id, a.adapter, t.model, t.prompt, t.state,
		        t.result, t.error, t.created_at, t.updated_at
		 FROM tasks t
		 JOIN agent_sessions a ON t.session_id = a.id
		 WHERE t.id = ?`,
		taskID,
	).Scan(&v.TaskID, &v.SessionID, &v.ProjectID, &v.Agent, &v.Model, &v.Prompt, &stateStr, &resultText, &errText, &v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		return TaskView{}, err
	}
	v.State = TaskState(stateStr)
	if resultText.Valid {
		v.ResultText = resultText.String
	}
	if errText.Valid {
		v.ErrorMessage = errText.String
	}

	if v.State == TaskAwaitingApproval {
		var apID, actionStr string
		var expiresUnix int64
		err := tx.QueryRowContext(ctx,
			`SELECT id, action, expires_at FROM approvals WHERE task_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1`,
			taskID,
		).Scan(&apID, &actionStr, &expiresUnix)
		if err == nil {
			var action map[string]any
			_ = json.Unmarshal([]byte(actionStr), &action)
			kind, _ := action["kind"].(string)
			summary, _ := action["summary"].(string)
			v.PendingApproval = &PendingApprovalView{
				ApprovalID: apID,
				Kind:       kind,
				Summary:    summary,
				ExpiresAt:  expiresUnix,
			}
		}
	}
	return v, nil
}

func (s *Service) emitLiveEvent(eventName string, data any) {
	if s.publish != nil {
		s.publish(eventName, data)
	}
}

func (s *Service) sendResult(ctx context.Context, sess *secure.ManagedSession, requestID string, result any) {
	if sess == nil {
		return
	}
	b, err := json.Marshal(OutboundResponse{
		V:         ProtocolVersion,
		Type:      "response",
		RequestID: requestID,
		OK:        true,
		Result:    result,
	})
	if err != nil || len(b) > secure.MaxRelayPlaintextSize {
		s.sendError(ctx, sess, requestID, "internal", "response exceeds frame limit")
		return
	}
	_ = sess.Send(ctx, b)
}

func (s *Service) sendError(ctx context.Context, sess *secure.ManagedSession, requestID, code, message string) {
	if sess == nil {
		return
	}
	b, err := json.Marshal(OutboundResponse{
		V:         ProtocolVersion,
		Type:      "response",
		RequestID: requestID,
		OK:        false,
		Error:     &ErrorBody{Code: code, Message: message},
	})
	if err != nil {
		return
	}
	_ = sess.Send(ctx, b)
}

func decodeStrictParams(raw json.RawMessage, dst any) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		trimmed = []byte("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if dec.More() {
		return errors.New("unexpected trailing tokens in params")
	}
	return nil
}

func randomID(prefix string) (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + "_" + hex.EncodeToString(b), nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func truncateUTF8(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && (s[cut]&0xc0) == 0x80 {
		cut--
	}
	return s[:cut] + "\n[truncated]"
}
