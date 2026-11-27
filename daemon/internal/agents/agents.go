// Package agents is the registry of AI coding agents on this computer: which
// ones are installed, whether each can be used by Agentik, and which models a
// usable one offers.
//
// Detection comes from package discovery. Running a task is done by an
// adapter (package codex defines the adapter contract and the Codex App Server
// adapter). A detected agent without an adapter is listed as unsupported with
// a reason; Agentik never pretends to support an agent it cannot drive with
// its approval and recovery rules.
package agents

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/agents/codex"
	"github.com/sergey-telpuk/agentik/daemon/internal/agents/discovery"
)

// Agent is a supported agent: an adapter that can run turns and can list the
// models it is able to run.
type Agent interface {
	codex.Adapter
	// Models returns the models this agent can run. It never fails: when the
	// agent cannot be queried it returns a labelled static fallback.
	Models(ctx context.Context) codex.ModelCatalog
}

var _ Agent = (*codex.AppServerAdapter)(nil)

// ModelProvider is the optional model-listing half of Agent. Adapters that do
// not implement it simply offer no model choice (their default model only).
type ModelProvider interface {
	Models(ctx context.Context) codex.ModelCatalog
}

// Status is the readiness of one agent, as shown to the phone.
type Status string

const (
	// StatusReady means installed, supported, and signed in.
	StatusReady Status = "ready"
	// StatusNotAuthenticated means installed and supported but signed out.
	StatusNotAuthenticated Status = "not_authenticated"
	// StatusUnknown means installed but sign-in state could not be determined.
	StatusUnknown Status = "unknown"
	// StatusUnsupported means detected, but Agentik has no adapter for it yet.
	StatusUnsupported Status = "unsupported"
	// StatusNotInstalled means Agentik supports it but no binary was found.
	StatusNotInstalled Status = "not_installed"
)

// Entry is the wire view of one agent in agent.list. The embedded
// codex.AgentStatus keeps the original response fields (name, available,
// authenticated, version, detail, capabilities) working for existing clients.
// The local binary path is deliberately not part of it.
type Entry struct {
	codex.AgentStatus
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Status      Status `json:"status"`
	// StatusText is a short human-readable explanation of Status.
	StatusText string `json:"status_text"`
	// Supported is true when Agentik has an adapter for this agent.
	Supported bool `json:"supported"`
	// Models are the selectable models; empty means "the agent's default".
	Models       []codex.Model     `json:"models"`
	ModelsSource codex.ModelSource `json:"models_source,omitempty"`
	ModelsDetail string            `json:"models_detail,omitempty"`
}

// Selection is a validated agent and model choice for one task.
type Selection struct {
	AgentID string
	// Model is empty when the agent's own default model is used.
	Model string
}

// Selection error codes.
const (
	ErrCodeUnknownAgent = "unknown_agent"
	ErrCodeUnsupported  = "agent_unsupported"
	ErrCodeNotReady     = "agent_not_ready"
	ErrCodeUnknownModel = "unknown_model"
)

// SelectionError explains why an agent or model choice was rejected.
type SelectionError struct {
	Code    string
	Message string
}

func (e *SelectionError) Error() string { return e.Message }

const (
	defaultTTL = 30 * time.Second
	// minForcedRefresh stops a stream of unknown-model requests from
	// re-running discovery on every call.
	minForcedRefresh = 5 * time.Second
)

// unsupportedReasons say, per agent, why no adapter exists yet. They are based
// on the installed CLIs' own --help output.
var unsupportedReasons = map[string]string{
	"claude": "Detected, not supported yet: Agentik has not implemented Claude Code's stream-json protocol " +
		"or its host-side permission prompts, so approvals could not be routed to the phone.",
	"cursor-agent": "Detected, not supported yet: Cursor Agent's print mode has access to all tools, " +
		"including write and shell, without asking, so Agentik cannot enforce its approval rule.",
	"gemini": "Detected, not supported yet: Agentik has no adapter for Gemini CLI and its " +
		"non-interactive protocol has not been verified.",
}

const defaultUnsupportedReason = "Detected, not supported yet: Agentik has no adapter for this agent."

// Config configures a Registry.
type Config struct {
	// Adapters are the supported agents by ID.
	Adapters map[string]codex.Adapter
	// Discoverer finds installed agent CLIs. When nil only Adapters are
	// listed and their own Diagnose is used for readiness.
	Discoverer *discovery.Discoverer
	// TTL is how long a discovery and model snapshot is reused. Zero means 30s.
	TTL time.Duration
	// Now overrides the clock (tests).
	Now func() time.Time
}

// Registry combines discovery results with the supported adapters.
type Registry struct {
	adapters map[string]codex.Adapter
	disc     *discovery.Discoverer
	ttl      time.Duration
	now      func() time.Time

	mu       sync.Mutex
	entries  []Entry
	loadedAt time.Time
}

// NewRegistry returns a Registry. It performs no discovery until first use.
func NewRegistry(cfg Config) *Registry {
	r := &Registry{
		adapters: make(map[string]codex.Adapter, len(cfg.Adapters)),
		disc:     cfg.Discoverer,
		ttl:      cfg.TTL,
		now:      cfg.Now,
	}
	for id, a := range cfg.Adapters {
		if a != nil {
			r.adapters[id] = a
		}
	}
	if r.ttl <= 0 {
		r.ttl = defaultTTL
	}
	if r.now == nil {
		r.now = time.Now
	}
	return r
}

// List returns every detected or supported agent. The result is cached for the
// TTL, so repeated calls do not re-run CLI subprocesses.
func (r *Registry) List(ctx context.Context) []Entry {
	return r.snapshot(ctx, false)
}

// Refresh discards the cache and re-detects.
func (r *Registry) Refresh(ctx context.Context) []Entry {
	return r.snapshot(ctx, true)
}

func (r *Registry) snapshot(ctx context.Context, force bool) []Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	age := r.now().Sub(r.loadedAt)
	fresh := r.entries != nil && age < r.ttl
	if !force && fresh {
		return cloneEntries(r.entries)
	}
	if force && r.entries != nil && age < minForcedRefresh {
		return cloneEntries(r.entries)
	}
	r.entries = r.build(ctx)
	r.loadedAt = r.now()
	return cloneEntries(r.entries)
}

func cloneEntries(in []Entry) []Entry {
	out := make([]Entry, len(in))
	copy(out, in)
	return out
}

func (r *Registry) build(ctx context.Context) []Entry {
	var detected []discovery.Agent
	if r.disc != nil {
		detected = r.disc.Discover(ctx)
	}
	found := make(map[string]discovery.Agent, len(detected))
	for _, d := range detected {
		found[d.ID] = d
	}

	ids := make([]string, 0, len(r.adapters))
	for id := range r.adapters {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	entries := make([]Entry, 0, len(ids)+len(detected))
	for _, id := range ids {
		adapter := r.adapters[id]
		var e Entry
		if r.disc == nil {
			e = fromDiagnose(id, adapter.Diagnose(ctx))
		} else if d, ok := found[id]; ok {
			e = fromDetected(d, adapter.Capabilities())
		} else {
			e = Entry{
				AgentStatus: codex.AgentStatus{
					Name:         id,
					Detail:       "binary not found",
					Capabilities: adapter.Capabilities(),
				},
				ID:          id,
				DisplayName: displayNameFor(id),
				Status:      StatusNotInstalled,
				StatusText:  "Not installed",
			}
		}
		e.Supported = true
		if e.Status == StatusReady {
			if mp, ok := adapter.(ModelProvider); ok {
				cat := mp.Models(ctx)
				e.Models = append([]codex.Model(nil), cat.Models...)
				e.ModelsSource = cat.Source
				e.ModelsDetail = cat.Detail
			}
		}
		if e.Models == nil {
			e.Models = []codex.Model{}
		}
		entries = append(entries, e)
	}

	for _, d := range detected {
		if _, supported := r.adapters[d.ID]; supported {
			continue
		}
		reason, ok := unsupportedReasons[d.ID]
		if !ok {
			reason = defaultUnsupportedReason
		}
		entries = append(entries, Entry{
			AgentStatus: codex.AgentStatus{
				Name:          d.ID,
				Available:     true,
				Authenticated: d.Auth == discovery.AuthReady,
				Version:       d.Version,
				Detail:        reason,
			},
			ID:          d.ID,
			DisplayName: d.DisplayName,
			Status:      StatusUnsupported,
			StatusText:  reason,
			Models:      []codex.Model{},
		})
	}
	return entries
}

func fromDetected(d discovery.Agent, caps codex.Capabilities) Entry {
	e := Entry{
		AgentStatus: codex.AgentStatus{
			Name:          d.ID,
			Available:     true,
			Authenticated: d.Auth == discovery.AuthReady,
			Version:       d.Version,
			Detail:        d.AuthDetail,
			Capabilities:  caps,
		},
		ID:          d.ID,
		DisplayName: d.DisplayName,
	}
	switch d.Auth {
	case discovery.AuthReady:
		e.Status, e.StatusText = StatusReady, "Ready"
	case discovery.AuthNotAuthenticated:
		e.Status, e.StatusText = StatusNotAuthenticated, "Not signed in"
	default:
		e.Status, e.StatusText = StatusUnknown, "Sign-in state unknown"
	}
	return e
}

func fromDiagnose(id string, st codex.AgentStatus) Entry {
	st.Name = id
	e := Entry{AgentStatus: st, ID: id, DisplayName: displayNameFor(id)}
	switch {
	case !st.Available:
		e.Status, e.StatusText = StatusNotInstalled, "Not installed"
	case st.Authenticated:
		e.Status, e.StatusText = StatusReady, "Ready"
	case strings.Contains(strings.ToLower(st.Detail), "not logged in"),
		strings.Contains(strings.ToLower(st.Detail), "logged out"):
		e.Status, e.StatusText = StatusNotAuthenticated, "Not signed in"
	default:
		e.Status, e.StatusText = StatusUnknown, "Sign-in state unknown"
	}
	return e
}

func displayNameFor(id string) string {
	for _, c := range discovery.DefaultCandidates() {
		if c.ID == id {
			return c.DisplayName
		}
	}
	return id
}

// Resolve validates a task's agent and model choice. An empty model selects
// the agent's own default and needs no model list. A non-empty model must
// appear in the agent's current model list.
func (r *Registry) Resolve(ctx context.Context, agentID, model string) (Selection, error) {
	agentID = strings.TrimSpace(agentID)
	model = strings.TrimSpace(model)

	if _, ok := r.adapters[agentID]; !ok {
		for _, e := range r.List(ctx) {
			if e.ID == agentID && e.Status == StatusUnsupported {
				return Selection{}, &SelectionError{Code: ErrCodeUnsupported,
					Message: fmt.Sprintf("agent %q is %s", agentID, e.StatusText)}
			}
		}
		return Selection{}, &SelectionError{Code: ErrCodeUnknownAgent,
			Message: fmt.Sprintf("agent %q is not registered", agentID)}
	}
	if model == "" {
		return Selection{AgentID: agentID}, nil
	}

	check := func(entries []Entry) (found bool, err error) {
		for _, e := range entries {
			if e.ID != agentID {
				continue
			}
			if e.Status != StatusReady {
				return false, &SelectionError{Code: ErrCodeNotReady,
					Message: fmt.Sprintf("agent %q is not ready (%s), so a model cannot be selected", agentID, e.StatusText)}
			}
			for _, m := range e.Models {
				if m.ID == model {
					return true, nil
				}
			}
			if e.ModelsSource == codex.ModelSourceStatic {
				return false, &SelectionError{Code: ErrCodeUnknownModel,
					Message: fmt.Sprintf("model %q cannot be checked: the model list of agent %q could not be read, "+
						"so only its default model can be used", model, agentID)}
			}
		}
		return false, nil
	}

	ok, _ := check(r.List(ctx))
	if !ok {
		// The cached snapshot may predate a sign-in or a new model, so the
		// decision is made on a fresh one (rate-limited by minForcedRefresh).
		var err error
		ok, err = check(r.Refresh(ctx))
		if err != nil {
			return Selection{}, err
		}
	}
	if !ok {
		return Selection{}, &SelectionError{Code: ErrCodeUnknownModel,
			Message: fmt.Sprintf("model %q is not available for agent %q", model, agentID)}
	}
	return Selection{AgentID: agentID, Model: model}, nil
}
