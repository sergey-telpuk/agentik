/**
 * A conversation with the agent inside one session: the user's messages and
 * the agent's replies as bubbles, and a composer that sends the next message
 * into the same session, so the agent keeps its context.
 *
 * Everything from the computer is untrusted and shown as plain text.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { canRequestCancel, isFinalState } from "../api/taskState";
import { MAX_PROMPT_LENGTH, type AgentikApi, type TaskSummary } from "../api/types";
import { ApprovalSheet } from "./ApprovalSheet";
import { sentence } from "./format";
import { ConfirmDialog, Notice, Page, SkeletonList, useBusy } from "./kit";
import { Turn } from "./Turn";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly sessionId: string;
  /** The turn that was just started, shown immediately while the rest loads. */
  readonly initialTurn: TaskSummary | null;
  readonly now: () => number;
  readonly copyText: (text: string) => Promise<boolean>;
  /** Chosen once per message; a retry of the same message reuses it. */
  readonly newRequestId: () => string;
  readonly onBack: () => void;
}

/** Distance from the bottom, in pixels, within which new content keeps the view pinned. */
const STICK_THRESHOLD = 120;

function scroller(): Element {
  // Some WebViews (and jsdom) do not expose scrollingElement.
  return document.scrollingElement ?? document.documentElement;
}

function withTurn(turns: readonly TaskSummary[], turn: TaskSummary): TaskSummary[] {
  return turns.some((t) => t.id === turn.id) ? [...turns] : [...turns, turn];
}

/** The computer's list wins; turns it did not list yet (just sent) stay at the end. */
function mergeTurns(listed: readonly TaskSummary[], local: readonly TaskSummary[]): TaskSummary[] {
  const known = new Set(listed.map((t) => t.id));
  return [...listed, ...local.filter((t) => !known.has(t.id))];
}

function lastActive(tasks: readonly TaskSummary[]): TaskSummary | null {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i];
    if (task !== undefined && !isFinalState(task.state)) return task;
  }
  return null;
}

export function SessionScreen({
  api,
  computerId,
  projectId,
  projectName,
  sessionId,
  initialTurn,
  now,
  copyText,
  newRequestId,
  onBack,
}: Props) {
  const [turns, setTurns] = useState<readonly TaskSummary[] | null>(initialTurn === null ? null : [initialTurn]);
  // The freshest state of every turn, from the stream or from a stop request.
  const [latest, setLatest] = useState<Readonly<Record<string, TaskSummary>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  // One id per submitted content: retrying after a lost response reuses it,
  // so the computer returns the same turn instead of starting a second one.
  const [request, setRequest] = useState<{ id: string; content: string } | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [sending, runSend] = useBusy();
  const [stopping, runStop] = useBusy();
  const autoOpened = useRef(new Set<string>());
  const stick = useRef(true);
  const composerId = useId();
  const counterId = useId();

  useEffect(() => {
    let cancelled = false;
    void api.getSession(computerId, projectId, sessionId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setTurns((previous) => mergeTurns(result.value.turns, previous ?? []));
        setTruncated(result.value.truncated);
        setLoadError(null);
      } else {
        setLoadError(sentence(result.error.message));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, computerId, projectId, sessionId]);

  const onTask = useCallback((task: TaskSummary) => {
    setLatest((previous) => (previous[task.id] === task ? previous : { ...previous, [task.id]: task }));
  }, []);

  const tasks = (turns ?? []).map((t) => latest[t.id] ?? t);
  const active = lastActive(tasks);
  const pending = active?.pendingApproval ?? null;

  useEffect(() => {
    const onScroll = (): void => {
      const el = scroller();
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const signature = tasks.map((t) => `${t.id}:${t.state}`).join("|");
  useLayoutEffect(() => {
    const el = scroller();
    if (stick.current && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight });
  }, [signature]);

  useEffect(() => {
    if (pending !== null && !autoOpened.current.has(pending.id)) {
      autoOpened.current.add(pending.id);
      setSheetFor(pending.id);
    }
  }, [pending]);

  const trimmed = draft.trim();
  const tooLong = trimmed.length > MAX_PROMPT_LENGTH;
  const loaded = turns !== null;
  const canSend = loaded && trimmed !== "" && !tooLong && active === null && !sending;

  async function send(): Promise<void> {
    const content = JSON.stringify([sessionId, trimmed]);
    const id = request !== null && request.content === content ? request.id : newRequestId();
    setRequest({ id, content });
    const result = await api.startTask(computerId, {
      projectId,
      agent: "codex",
      prompt: trimmed,
      requestId: id,
      sessionId,
    });
    if (result.ok) {
      stick.current = true;
      setTurns((previous) => withTurn(previous ?? [], result.value));
      setDraft("");
      setSendError(null);
      setRequest(null);
    } else {
      setSendError(sentence(result.error.message));
    }
  }

  async function stopTurn(): Promise<void> {
    if (active === null) return;
    const result = await api.cancelTask(computerId, active.id);
    if (result.ok) {
      onTask(result.value);
      setConfirmStop(false);
      setStopError(null);
    } else {
      setStopError(sentence(result.error.message));
    }
  }

  let stopControl = null;
  if (active !== null && active.state === "cancel_requested") {
    stopControl = (
      <button type="button" className="button button-secondary button-block" disabled aria-busy="true">
        Stopping… waiting for the computer
      </button>
    );
  } else if (active !== null) {
    stopControl = (
      <button
        type="button"
        className="button button-destructive-outline button-block"
        onClick={() => setConfirmStop(true)}
        disabled={!canRequestCancel(active.state)}
      >
        Stop task
      </button>
    );
  }

  const footer = (
    <div className="composer-area">
      {stopControl}
      {sendError !== null && (
        <Notice tone="bad" alert title="The message was not sent">
          <p>{sendError}</p>
        </Notice>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) void runSend(send);
        }}
      >
        <label htmlFor={composerId} className="visually-hidden">
          Message to the agent
        </label>
        <textarea
          id={composerId}
          className="composer-input"
          rows={2}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSendError(null);
          }}
          placeholder={active === null ? "Message the agent" : "Type your next message while the agent works"}
          aria-describedby={counterId}
          aria-invalid={tooLong}
          disabled={sending}
        />
        <button type="submit" className="button button-primary composer-send" disabled={!canSend} aria-busy={sending}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
      <p id={counterId} className={tooLong ? "hint hint-bad" : "hint"}>
        {active !== null
          ? "The agent is working. You can send the next message when it finishes."
          : `${trimmed.length} / ${MAX_PROMPT_LENGTH} characters`}
      </p>
    </div>
  );

  return (
    <Page title="Conversation" subtitle={projectName} onBack={onBack} footer={footer}>
      {loadError !== null && (
        <Notice tone="bad" alert title={turns === null ? "Could not load the conversation" : "Could not refresh the conversation"}>
          <p>{loadError}</p>
        </Notice>
      )}
      {turns === null && loadError === null && <SkeletonList rows={4} label="Loading conversation" />}
      {truncated && <p className="hint">Earlier messages are not shown. They are stored on the computer.</p>}
      {turns !== null && (
        <ol className="conversation" aria-label="Conversation">
          {tasks.map((task) => (
            <Turn
              key={task.id}
              api={api}
              computerId={computerId}
              task={task}
              copyText={copyText}
              onTask={onTask}
              onReviewApproval={() => setSheetFor(task.pendingApproval?.id ?? null)}
              onReuse={setDraft}
            />
          ))}
        </ol>
      )}
      {active !== null && (
        <p className="hint keep-running">
          Closing the app does not cancel the task. It keeps running on the computer; reopen Agentik to see its state.
        </p>
      )}

      {pending !== null && sheetFor === pending.id && (
        <ApprovalSheet
          key={pending.id}
          api={api}
          computerId={computerId}
          request={pending}
          now={now}
          onDecided={() => setSheetFor(null)}
          onClose={() => setSheetFor(null)}
        />
      )}

      {confirmStop && (
        <ConfirmDialog
          title="Stop this task?"
          confirmLabel="Stop task"
          cancelLabel="Keep running"
          destructive
          busy={stopping}
          error={stopError}
          onConfirm={() => void runStop(stopTurn)}
          onCancel={() => {
            setConfirmStop(false);
            setStopError(null);
          }}
        >
          <p>The computer asks the agent to stop. Changes already made stay in the project.</p>
          <p className="hint">The task shows “cancelled” only after the computer confirms the stop.</p>
        </ConfirmDialog>
      )}
    </Page>
  );
}
