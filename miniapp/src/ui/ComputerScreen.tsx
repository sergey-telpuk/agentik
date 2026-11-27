import { useEffect, useState } from "react";
import type { Agent, AgentikApi, Computer, ConnectionState, Project } from "../api/types";
import { CONNECTION_STEPS, connectionText, sentence, shortId } from "./format";
import { ConfirmDialog, Empty, Notice, Page, Section, SkeletonList, StatusChip } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly computer: Computer;
  readonly connection: ConnectionState | null;
  readonly onRetry: () => void;
  readonly onForget: () => void;
  readonly onOpenProject: (project: Project) => void;
  readonly onBack: () => void;
}

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly projects: Project[]; readonly agents: Agent[] }
  | { readonly kind: "error"; readonly message: string };

const STEP_ORDER = ["connecting", "handshaking", "awaiting_local_approval", "synchronizing", "ready"];

function ConnectionProgress({ connection, skipConfirm }: { connection: ConnectionState | null; skipConfirm: boolean }) {
  const phase = connection?.phase ?? "connecting";
  const reached = phase === "failed" || phase === "revoked" ? -1 : STEP_ORDER.indexOf(phase);
  const steps = CONNECTION_STEPS.filter((s) => !(skipConfirm && s.phase === "awaiting_local_approval"));
  return (
    <ol className="progress" aria-label="Connection steps">
      {steps.map((step) => {
        const index = STEP_ORDER.indexOf(step.phase);
        const state = reached > index ? "done" : reached === index ? "current" : "todo";
        return (
          <li key={step.phase} className={`progress-step progress-${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span className="progress-dot" aria-hidden="true" />
            <span className="progress-label">
              {step.label}
              <span className="visually-hidden">
                {state === "done" ? " (done)" : state === "current" ? " (in progress)" : " (not started)"}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ComputerScreen({ api, computer, connection, onRetry, onForget, onOpenProject, onBack }: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [confirmingForget, setConfirmingForget] = useState(false);
  const ready = connection?.phase === "ready";
  const name = connection?.phase === "ready" ? connection.computerName : computer.name;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void Promise.all([api.listProjects(computer.id), api.listAgents(computer.id)]).then(([projects, agents]) => {
      if (cancelled) return;
      if (!projects.ok) setLoaded({ kind: "error", message: sentence(projects.error.message) });
      else if (!agents.ok) setLoaded({ kind: "error", message: sentence(agents.error.message) });
      else setLoaded({ kind: "ready", projects: projects.value, agents: agents.value });
    });
    return () => {
      cancelled = true;
    };
  }, [api, computer.id, ready]);

  const text = connectionText(connection, name);
  const inProgress = connection === null || !["ready", "failed", "revoked"].includes(connection.phase);
  const codex = loaded.kind === "ready" ? loaded.agents.find((a) => a.id === "codex") : undefined;

  return (
    <Page title={name} subtitle={shortId(computer.id)} onBack={onBack}>
      <div className={`connection connection-${text.tone}`} aria-live="polite">
        <div className="connection-head">
          <StatusChip tone={text.tone} label={text.label} pulse={inProgress} />
        </div>
        <p className="connection-detail">{text.detail}</p>
        {connection?.phase !== "ready" && connection?.phase !== "failed" && (
          <ConnectionProgress connection={connection} skipConfirm={computer.status !== "pending_confirmation"} />
        )}
        {connection?.phase === "failed" && (
          <div className="button-row">
            {connection.retryable ? (
              <button type="button" className="button button-primary" onClick={onRetry}>
                Retry
              </button>
            ) : (
              <button type="button" className="button button-destructive" onClick={() => setConfirmingForget(true)}>
                Forget this computer
              </button>
            )}
          </div>
        )}
      </div>

      {connection?.phase === "failed" && connection.reason === "computer_offline" && (
        <p className="hint">An unreachable computer means neither success nor a stopped task. Nothing new is accepted until it is back.</p>
      )}

      {ready && (
        <Section title="Projects" aside={codex !== undefined ? <AgentBadge agent={codex} /> : undefined}>
          {loaded.kind === "loading" && <SkeletonList rows={3} label="Loading projects" />}
          {loaded.kind === "error" && (
            <Notice tone="bad" alert>
              <p>{loaded.message}</p>
            </Notice>
          )}
          {loaded.kind === "ready" && codex !== undefined && codex.status !== "available" && (
            <Notice tone="warn" title={codex.status === "not_installed" ? "Codex is not installed" : "Codex is not signed in"}>
              <p>Install Codex on the computer and sign in there. New tasks cannot start until then.</p>
            </Notice>
          )}
          {loaded.kind === "ready" && loaded.projects.length === 0 && (
            <Empty title="No projects are shared with this phone.">
              <p>Choose the permitted projects in Agentik on the computer.</p>
            </Empty>
          )}
          {loaded.kind === "ready" && loaded.projects.length > 0 && (
            <ul className="card-list">
              {loaded.projects.map((p) => (
                <li key={p.id} className="card">
                  <button type="button" className="card-main" onClick={() => onOpenProject(p)}>
                    <span className="card-title-row">
                      <span className="card-title">{p.name}</span>
                      {p.activeTasks > 0 && <StatusChip tone="info" label={`${p.activeTasks} active`} pulse />}
                    </span>
                    <span className="card-meta mono">{p.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {connection?.phase !== "failed" || connection.retryable ? (
        <button type="button" className="button button-ghost forget-button" onClick={() => setConfirmingForget(true)}>
          Forget this computer
        </button>
      ) : null}
      {confirmingForget && (
        <ConfirmDialog
          title={`Forget ${name}?`}
          confirmLabel="Forget computer"
          destructive
          onConfirm={onForget}
          onCancel={() => setConfirmingForget(false)}
        >
          <p>This removes the pinned key from this phone only.</p>
          <p className="hint">
            The computer keeps its record of this phone until you revoke it there. To use the computer again you need a
            new invitation from it.
          </p>
        </ConfirmDialog>
      )}
    </Page>
  );
}

function AgentBadge({ agent }: { agent: Agent }) {
  return agent.status === "available" ? (
    <span className="hint">
      {agent.name} {agent.version}
    </span>
  ) : (
    <StatusChip tone="warn" label={`${agent.name} unavailable`} />
  );
}
