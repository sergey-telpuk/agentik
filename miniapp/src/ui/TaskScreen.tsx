import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TASK_STATE_DESCRIPTION, canRequestCancel, isFinalState } from "../api/taskState";
import type { AgentikApi, TaskEvent, TaskSummary } from "../api/types";
import { ApprovalSheet } from "./ApprovalSheet";
import { relativeTime, sentence, taskStatus } from "./format";
import { ConfirmDialog, Notice, Page, SkeletonList, StatusChip, useBusy, useNow } from "./kit";
import { Timeline } from "./Timeline";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly taskId: string;
  readonly projectName: string;
  readonly now: () => number;
  readonly onOpenResult: () => void;
  readonly onBack: () => void;
}

/** Distance from the bottom, in pixels, within which new events keep the view pinned. */
const STICK_THRESHOLD = 120;

function scroller(): Element {
  // Some WebViews (and jsdom) do not expose scrollingElement.
  return document.scrollingElement ?? document.documentElement;
}

export function TaskScreen({ api, computerId, taskId, projectName, now, onOpenResult, onBack }: Props) {
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [events, setEvents] = useState<readonly TaskEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const autoOpened = useRef(new Set<string>());
  const stick = useRef(true);
  const current = useNow(15_000, now);

  useEffect(() => {
    let cancelled = false;
    void api.getTask(computerId, taskId).then((result) => {
      if (cancelled) return;
      if (result.ok) setTask(result.value);
      else setLoadError(sentence(result.error.message));
    });
    const stop = api.streamEvents(computerId, taskId, 0, (update) => {
      setTask(update.task);
      setEvents((previous) => {
        const last = previous.at(-1)?.seq ?? 0;
        const fresh = update.events.filter((e) => e.seq > last);
        return fresh.length === 0 ? previous : [...previous, ...fresh];
      });
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [api, computerId, taskId]);

  useEffect(() => {
    const onScroll = (): void => {
      const el = scroller();
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = scroller();
    if (stick.current && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight });
  }, [events.length]);

  const pending = task?.pendingApproval ?? null;
  useEffect(() => {
    if (pending !== null && !autoOpened.current.has(pending.id)) {
      autoOpened.current.add(pending.id);
      setSheetFor(pending.id);
    }
  }, [pending]);

  async function stopTask(): Promise<void> {
    const result = await api.cancelTask(computerId, taskId);
    if (result.ok) {
      setTask(result.value);
      setConfirmStop(false);
      setStopError(null);
    } else {
      setStopError(sentence(result.error.message));
    }
  }

  const status = task !== null ? taskStatus(task.state) : null;
  const final = task !== null && isFinalState(task.state);

  let footer;
  if (task !== null && final) {
    footer = (
      <button type="button" className="button button-primary button-block" onClick={onOpenResult}>
        View result
      </button>
    );
  } else if (task !== null && task.state === "cancel_requested") {
    footer = (
      <button type="button" className="button button-secondary button-block" disabled aria-busy="true">
        Stopping… waiting for the computer
      </button>
    );
  } else if (task !== null) {
    footer = (
      <button
        type="button"
        className="button button-destructive-outline button-block"
        onClick={() => setConfirmStop(true)}
        disabled={!canRequestCancel(task.state)}
      >
        Stop task
      </button>
    );
  }

  return (
    <Page title="Task" subtitle={projectName} onBack={onBack} footer={footer}>
      {loadError !== null && (
        <Notice tone="bad" alert title="Could not load the task">
          <p>{loadError}</p>
        </Notice>
      )}
      {task === null && loadError === null && <SkeletonList rows={4} label="Loading task" />}
      {task !== null && status !== null && (
        <>
          <div className="task-status" aria-live="polite">
            <div className="task-status-row">
              <StatusChip tone={status.tone} label={status.label} pulse={status.pulse} />
              <span className="hint">started {relativeTime(task.createdAt, current)}</span>
            </div>
            <p className="task-status-detail">{TASK_STATE_DESCRIPTION[task.state]}</p>
            {pending !== null && (
              <div className="attention-row">
                <span>The agent is waiting for your decision.</span>
                <button type="button" className="button button-primary button-small" onClick={() => setSheetFor(pending.id)}>
                  Review request
                </button>
              </div>
            )}
          </div>
          {!final && (
            <p className="hint keep-running">
              Closing the app does not cancel the task. It keeps running on the computer; reopen Agentik to see its
              state.
            </p>
          )}
          <Timeline events={events} />
        </>
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
          busy={busy}
          error={stopError}
          onConfirm={() => void run(stopTask)}
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
