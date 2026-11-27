import { useCallback, useEffect, useRef, useState } from "react";
import { AgentikRpcClient, RpcClientClosedError, RpcError, RpcTimeoutError } from "../protocol/client";
import type {
  AgentInfo,
  ApprovalDecision,
  ChangesResult,
  ProjectInfo,
  SessionEventView,
  SessionSummary,
  TaskState,
  TaskView,
} from "../protocol/messages";

interface Props {
  readonly rpc: AgentikRpcClient | null;
  readonly reconnectKey: number;
}

interface PendingSubmit {
  readonly requestId: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly agent: string;
  readonly prompt: string;
}

function isTaskActive(state: TaskState): boolean {
  return (
    state === "accepted" ||
    state === "starting" ||
    state === "running" ||
    state === "awaiting_approval" ||
    state === "cancel_requested"
  );
}

function mergeEvents(
  existing: readonly SessionEventView[],
  incoming: readonly SessionEventView[],
): SessionEventView[] {
  const bySeq = new Map<number, SessionEventView>();
  for (const ev of existing) bySeq.set(ev.seq, ev);
  for (const ev of incoming) bySeq.set(ev.seq, ev);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function summarizeEvent(ev: SessionEventView): string {
  const p = ev.payload;
  switch (ev.kind) {
    case "status": {
      const state = typeof p["state"] === "string" ? p["state"] : "";
      const note = typeof p["message"] === "string" ? p["message"] : "";
      return note !== "" ? `${state}: ${note}` : state;
    }
    case "delta":
      return typeof p["text"] === "string" ? p["text"] : "";
    case "item":
      return typeof p["text"] === "string" ? p["text"] : "agent item";
    case "diff":
      return "diff updated";
    case "approval_requested": {
      const kind = typeof p["kind"] === "string" ? p["kind"] : "approval";
      const summary = typeof p["summary"] === "string" ? p["summary"] : "";
      return `${kind}: ${summary}`;
    }
    case "approval_resolved": {
      const decision = typeof p["decision"] === "string" ? p["decision"] : "resolved";
      return `decision: ${decision}`;
    }
    case "completed": {
      const state = typeof p["state"] === "string" ? p["state"] : "done";
      return `task ${state}`;
    }
    case "error":
      return typeof p["message"] === "string" ? p["message"] : "error";
    default:
      return ev.kind;
  }
}

export function TaskWorkspace({ rpc, reconnectKey }: Props) {
  const [projects, setProjects] = useState<readonly ProjectInfo[]>([]);
  const [agents, setAgents] = useState<readonly AgentInfo[]>([]);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryIdempotentHint, setRetryIdempotentHint] = useState(false);

  const [activeTask, setActiveTask] = useState<TaskView | null>(null);
  const [events, setEvents] = useState<readonly SessionEventView[]>([]);
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);

  const pendingSubmitRef = useRef<PendingSubmit | null>(null);
  const activeTaskRef = useRef<TaskView | null>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    activeTaskRef.current = activeTask;
  }, [activeTask]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const refreshSessions = useCallback(
    async (client: AgentikRpcClient, projectId: string): Promise<void> => {
      if (projectId === "") {
        setSessions([]);
        return;
      }
      try {
        const res = await client.listSessions(projectId);
        setSessions(res.sessions);
      } catch (err) {
        if (err instanceof RpcClientClosedError) return;
      }
    },
    [],
  );

  // Initial metadata load + reconnect task/events catch-up.
  useEffect(() => {
    if (rpc === null) return;
    let cancelled = false;

    void Promise.allSettled([rpc.listProjects(), rpc.listAgents()]).then(async ([projRes, agentRes]) => {
      if (cancelled) return;
      if (projRes.status === "fulfilled") {
        setLoadError(null);
        const list = projRes.value.projects;
        setProjects(list);
        const prevSelected = selectedProjectIdRef.current;
        const firstId = list[0]?.project_id ?? "";
        const targetId =
          prevSelected !== "" && list.some((p) => p.project_id === prevSelected)
            ? prevSelected
            : firstId;
        if (targetId !== prevSelected) {
          setSelectedProjectId(targetId);
          setSelectedSessionId("");
        }
        if (targetId !== "") {
          void refreshSessions(rpc, targetId);
        }
      } else if (!(projRes.reason instanceof RpcClientClosedError)) {
        const msg = projRes.reason instanceof Error ? projRes.reason.message : "Failed to load projects";
        setLoadError(msg);
      }

      if (agentRes.status === "fulfilled") {
        setAgents(agentRes.value.agents);
      }
    });

    const currentTask = activeTaskRef.current;
    if (currentTask !== null) {
      void (async () => {
        try {
          const [taskRes, resumed] = await Promise.all([
            rpc.getTask(currentTask.task_id),
            rpc.resumeEvents(currentTask.session_id, lastSeqRef.current),
          ]);
          if (cancelled) return;
          setActiveTask(taskRes.task);
          if (resumed.events.length > 0) {
            setEvents((prev) => mergeEvents(prev, resumed.events));
            lastSeqRef.current = Math.max(lastSeqRef.current, resumed.next_seq - 1);
          }
          if (!isTaskActive(taskRes.task.state) || resumed.truncated === true) {
            const ch = await rpc.getChanges(taskRes.task.task_id);
            if (!cancelled) setChanges(ch);
          }
        } catch (err) {
          if (cancelled || err instanceof RpcClientClosedError) return;
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [rpc, reconnectKey, refreshSessions]);

  // Live session event subscription.
  useEffect(() => {
    if (rpc === null) return;
    let cancelled = false;
    const off = rpc.onEvent((ev) => {
      if (ev.event !== "session.event") return;
      const incoming = ev.data;
      const tracked = activeTaskRef.current;
      if (tracked !== null && incoming.session_id !== tracked.session_id) {
        return;
      }
      if (tracked === null) return;

      lastSeqRef.current = Math.max(lastSeqRef.current, incoming.seq);
      setEvents((prev) => mergeEvents(prev, [incoming]));

      if (
        incoming.kind === "status" ||
        incoming.kind === "approval_requested" ||
        incoming.kind === "approval_resolved" ||
        incoming.kind === "completed" ||
        incoming.kind === "error"
      ) {
        void rpc
          .getTask(tracked.task_id)
          .then(async (res) => {
            if (cancelled) return;
            setActiveTask(res.task);
            if (!isTaskActive(res.task.state)) {
              setCancelling(false);
              setResolvingApprovalId(null);
              void refreshSessions(rpc, res.task.project_id);
              try {
                const ch = await rpc.getChanges(res.task.task_id);
                if (!cancelled) setChanges(ch);
              } catch {
                // Changes are optional if none exist.
              }
            }
          })
          .catch(() => undefined);
      }
    });

    return () => {
      cancelled = true;
      off();
    };
  }, [rpc, refreshSessions]);

  async function handleStartTask(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (rpc === null || submitting) return;
    const trimmedPrompt = prompt.trim();
    if (selectedProjectId === "" || trimmedPrompt === "") return;

    const sessionId = selectedSessionId === "" ? null : selectedSessionId;
    const agent = "codex";

    let pending = pendingSubmitRef.current;
    if (
      pending === null ||
      pending.projectId !== selectedProjectId ||
      pending.sessionId !== sessionId ||
      pending.agent !== agent ||
      pending.prompt !== trimmedPrompt
    ) {
      pending = {
        requestId: crypto.randomUUID(),
        projectId: selectedProjectId,
        sessionId,
        agent,
        prompt: trimmedPrompt,
      };
      pendingSubmitRef.current = pending;
    }

    setSubmitting(true);
    setSubmitError(null);
    setActionError(null);

    try {
      const res = await rpc.startTask(
        {
          project_id: pending.projectId,
          session_id: pending.sessionId,
          agent: pending.agent,
          prompt: pending.prompt,
        },
        pending.requestId,
      );
      pendingSubmitRef.current = null;
      setRetryIdempotentHint(false);
      setPrompt("");
      setActiveTask(res.task);
      setChanges(null);
      if (sessionId === null || activeTask?.session_id !== res.task.session_id) {
        setEvents([]);
        lastSeqRef.current = 0;
      }
      setSelectedSessionId(res.task.session_id);

      // Catch up any events emitted right after task.start created the task.
      try {
        const resumed = await rpc.resumeEvents(res.task.session_id, lastSeqRef.current);
        if (resumed.events.length > 0) {
          setEvents((prev) => mergeEvents(prev, resumed.events));
          lastSeqRef.current = Math.max(lastSeqRef.current, resumed.next_seq - 1);
        }
      } catch {
        // Live events will also stream.
      }
    } catch (err) {
      if (err instanceof RpcError) {
        pendingSubmitRef.current = null;
        setRetryIdempotentHint(false);
        setSubmitError(err.message);
      } else if (err instanceof RpcTimeoutError || err instanceof RpcClientClosedError) {
        setRetryIdempotentHint(true);
        setSubmitError("Connection dropped before task confirmation. Retry safely with the same request.");
      } else {
        setRetryIdempotentHint(true);
        setSubmitError(err instanceof Error ? err.message : "Failed to start task");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (rpc === null || activeTask === null || cancelling) return;
    setCancelling(true);
    setActionError(null);
    try {
      const res = await rpc.cancelTask(activeTask.task_id);
      setActiveTask(res.task);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel task");
    } finally {
      setCancelling(false);
    }
  }

  async function handleResolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (rpc === null || activeTask === null || resolvingApprovalId !== null) return;
    setResolvingApprovalId(approvalId);
    setActionError(null);
    try {
      await rpc.resolveApproval(approvalId, decision);
      const updated = await rpc.getTask(activeTask.task_id);
      setActiveTask(updated.task);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to submit decision");
    } finally {
      setResolvingApprovalId(null);
    }
  }

  async function handleLoadChanges(): Promise<void> {
    if (rpc === null || activeTask === null) return;
    setActionError(null);
    try {
      const res = await rpc.getChanges(activeTask.task_id);
      setChanges(res);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to fetch diff");
    }
  }

  const codexAgent = agents.find((a) => a.name === "codex");
  const codexUnavailableReason =
    codexAgent === undefined
      ? null
      : !codexAgent.available
        ? `Codex CLI unavailable (${codexAgent.detail ?? "not installed"})`
        : !codexAgent.authenticated
          ? `Codex CLI not logged in (${codexAgent.detail ?? "run codex login on computer"})`
          : null;

  const projectBusy = activeTask !== null && activeTask.project_id === selectedProjectId && isTaskActive(activeTask.state);
  const canStart =
    rpc !== null &&
    !submitting &&
    selectedProjectId !== "" &&
    prompt.trim() !== "" &&
    codexUnavailableReason === null &&
    !projectBusy;

  const streamedText =
    activeTask === null
      ? ""
      : events
          .filter((ev) => ev.task_id === activeTask.task_id && ev.kind === "delta")
          .map((ev) => (typeof ev.payload["text"] === "string" ? ev.payload["text"] : ""))
          .join("");
  const displayOutput =
    activeTask !== null && activeTask.result_text !== "" ? activeTask.result_text : streamedText;

  const timelineEvents = activeTask === null ? [] : events.filter((ev) => ev.task_id === activeTask.task_id && ev.kind !== "delta");
  const pendingApproval = activeTask?.pending_approval ?? null;

  return (
    <section aria-label="Task workspace">
      <h3>Run task</h3>
      {loadError !== null && <p role="alert">{loadError}</p>}
      {codexAgent !== undefined && (
        <p>
          Agent <code>codex</code>:{" "}
          {codexUnavailableReason === null
            ? `ready${codexAgent.version ? ` (${codexAgent.version})` : ""}`
            : codexUnavailableReason}
        </p>
      )}
      {projects.length === 0 && loadError === null ? (
        <p>No permitted projects configured on this computer.</p>
      ) : (
        <form onSubmit={(event) => void handleStartTask(event)}>
          <p>
            <label>
              Project{" "}
              <select
                value={selectedProjectId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setSelectedProjectId(nextId);
                  setSelectedSessionId("");
                  if (rpc !== null) void refreshSessions(rpc, nextId);
                }}
              >
                {projects.map((project) => (
                  <option key={project.project_id} value={project.project_id}>
                    {project.name} ({project.project_id})
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Session{" "}
              <select
                value={selectedSessionId}
                onChange={(event) => setSelectedSessionId(event.target.value)}
              >
                <option value="">New session</option>
                {sessions.map((s) => (
                  <option key={s.session_id} value={s.session_id}>
                    {s.session_id.slice(0, 8)}… ({s.agent})
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Task prompt
              <br />
              <textarea
                rows={4}
                cols={40}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe what Codex should do in this project…"
              />
            </label>
          </p>
          {submitError !== null && <p role="alert">{submitError}</p>}
          {retryIdempotentHint && <p>Retry uses the original idempotent request ID.</p>}
          <button type="submit" disabled={!canStart}>
            {submitting ? "Starting…" : "Start task"}
          </button>
        </form>
      )}

      {activeTask !== null && (
        <section aria-label="Active task">
          <h4>
            Task <code>{activeTask.task_id.slice(0, 8)}…</code> — <strong>{activeTask.state}</strong>
          </h4>
          {isTaskActive(activeTask.state) && (
            <p>
              <button
                type="button"
                disabled={rpc === null || cancelling || activeTask.state === "cancel_requested"}
                onClick={() => void handleCancel()}
              >
                {activeTask.state === "cancel_requested" || cancelling ? "Cancelling…" : "Cancel task"}
              </button>
            </p>
          )}
          {actionError !== null && <p role="alert">{actionError}</p>}

          {pendingApproval !== null && (
            <div role="region" aria-label="Approval required">
              <p>
                <strong>Approval required ({pendingApproval.kind}):</strong> {pendingApproval.summary}
              </p>
              <p>
                <button
                  type="button"
                  disabled={rpc === null || resolvingApprovalId !== null}
                  onClick={() => void handleResolveApproval(pendingApproval.approval_id, "accept")}
                >
                  Approve once
                </button>{" "}
                <button
                  type="button"
                  disabled={rpc === null || resolvingApprovalId !== null}
                  onClick={() => void handleResolveApproval(pendingApproval.approval_id, "decline")}
                >
                  Decline
                </button>
              </p>
            </div>
          )}

          {activeTask.error_message !== "" && <p role="alert">{activeTask.error_message}</p>}

          {displayOutput !== "" && (
            <div>
              <h5>Output</h5>
              <pre data-testid="task-output">{displayOutput}</pre>
            </div>
          )}

          {timelineEvents.length > 0 && (
            <div>
              <h5>Events</h5>
              <ul>
                {timelineEvents.map((ev) => (
                  <li key={ev.seq}>
                    <code>#{ev.seq}</code> <strong>{ev.kind}</strong>: {summarizeEvent(ev)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!isTaskActive(activeTask.state) && changes === null && (
            <p>
              <button type="button" disabled={rpc === null} onClick={() => void handleLoadChanges()}>
                Load diff
              </button>
            </p>
          )}

          {changes !== null && changes.diff !== "" && (
            <div>
              <h5>Diff{changes.truncated ? " (truncated)" : ""}</h5>
              <pre data-testid="task-diff">{changes.diff}</pre>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
