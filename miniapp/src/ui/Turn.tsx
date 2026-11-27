/**
 * One turn of a conversation: the user's message and the agent's reply.
 *
 * The prompt, the progress events, the reply, errors and diffs all come from
 * the user or from the computer and are untrusted. They are rendered only as
 * React text children, so markup in them is shown literally and never parsed
 * (AGENTIK.md section 8, "dangerous agent output").
 */

import { useEffect, useMemo, useState } from "react";
import { TASK_STATE_DESCRIPTION, isFinalState } from "../api/taskState";
import type { AgentikApi, TaskEvent, TaskResult, TaskSummary } from "../api/types";
import { DiffView } from "./DiffView";
import { clockTime, sentence, taskStatus } from "./format";
import { Notice, StatusChip } from "./kit";
import { Timeline } from "./Timeline";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  /** The turn as the conversation currently knows it. */
  readonly task: TaskSummary;
  /** Copies text; resolves false when the clipboard is not available. */
  readonly copyText: (text: string) => Promise<boolean>;
  /** Called with every state the computer reports while this turn runs. */
  readonly onTask: (task: TaskSummary) => void;
  readonly onReviewApproval: () => void;
  /** Puts the text of this turn back into the composer. Never sends it. */
  readonly onReuse: (prompt: string) => void;
}

/** Progress is everything the agent did; the user's own message has its own bubble. */
function progressOf(events: readonly TaskEvent[], reply: string): TaskEvent[] {
  return events.filter((e) => {
    if (e.kind === "message" && e.role === "user") return false;
    // The final answer is shown as the reply, not twice.
    return !(e.kind === "message" && reply !== "" && e.text === reply);
  });
}

export function Turn({ api, computerId, task, copyText, onTask, onReviewApproval, onReuse }: Props) {
  const [events, setEvents] = useState<readonly TaskEvent[]>([]);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  // Only a turn that is still running when it appears is streamed. Finished
  // turns are read once, so opening a long conversation stays cheap.
  const [streamed] = useState(() => !isFinalState(task.state));
  const final = isFinalState(task.state);
  const taskId = task.id;

  useEffect(() => {
    if (!streamed) return;
    return api.streamEvents(computerId, taskId, 0, (update) => {
      onTask(update.task);
      setEvents((previous) => {
        const last = previous.at(-1)?.seq ?? 0;
        const fresh = update.events.filter((e) => e.seq > last);
        return fresh.length === 0 ? previous : [...previous, ...fresh];
      });
    });
  }, [api, computerId, taskId, streamed, onTask]);

  useEffect(() => {
    if (!final) return;
    let cancelled = false;
    void api.getResult(computerId, taskId).then((r) => {
      if (cancelled) return;
      if (r.ok) setResult(r.value);
      else setResultError(sentence(r.error.message));
    });
    return () => {
      cancelled = true;
    };
  }, [api, computerId, taskId, final]);

  const status = taskStatus(task.state);
  const reply = result?.output ?? "";
  const progress = useMemo(() => progressOf(events, reply), [events, reply]);
  const pending = task.pendingApproval;

  async function copy(text: string): Promise<void> {
    setCopied((await copyText(text)) ? "copied" : "failed");
  }

  return (
    <li className="turn">
      <div className="bubble bubble-user">
        <p className="bubble-text plain">{task.prompt}</p>
        <time className="bubble-time" dateTime={new Date(task.createdAt).toISOString()}>
          {clockTime(task.createdAt)}
        </time>
      </div>

      <div className="bubble bubble-agent" role="group" aria-label="Agent reply">
        <div className="bubble-head">
          <span className="bubble-sender">Codex</span>
          {/* A small chip while the turn runs. A turn that succeeded needs none; the reply speaks for itself.
              Other endings keep their chip, because "cancelled" has no other sign in the bubble. */}
          {task.state !== "succeeded" && <StatusChip tone={status.tone} label={status.label} pulse={status.pulse} />}
        </div>

        {!final && <p className="hint bubble-detail">{TASK_STATE_DESCRIPTION[task.state]}</p>}

        {pending !== null && (
          <div className="attention-row">
            <span>The agent is waiting for your decision.</span>
            <button type="button" className="button button-primary button-small" onClick={onReviewApproval}>
              Review request
            </button>
          </div>
        )}

        {!final && progress.length > 0 && <Timeline events={progress} />}

        {final && progress.length > 0 && (
          <details className="bubble-steps">
            <summary>{`Show steps (${progress.length})`}</summary>
            <Timeline events={progress} />
          </details>
        )}

        {final && result === null && resultError === null && (
          <p className="hint" role="status">
            Loading the reply…
          </p>
        )}
        {resultError !== null && (
          <Notice tone="bad" alert title="Could not load the reply">
            <p>{resultError}</p>
          </Notice>
        )}

        {result?.state === "recovery_required" && (
          <Notice tone="bad" title="The outcome is unknown">
            <p className="plain">{result.recovery}</p>
            <ul className="bullets">
              <li>Agentik never restarts such a task automatically, because it may already have run.</li>
              <li>Check the project on the computer before sending anything new.</li>
            </ul>
            <button type="button" className="button button-secondary" onClick={() => onReuse(task.prompt)}>
              Put this message back in the composer
            </button>
          </Notice>
        )}

        {result?.state === "failed" && result.error !== null && (
          <Notice tone="bad" title="Error reported by the computer">
            <p className="plain">{result.error}</p>
          </Notice>
        )}

        {result !== null && reply !== "" && (
          <>
            <div className="bubble-reply plain">{reply}</div>
            <div className="bubble-actions">
              <button type="button" className="button button-ghost button-small" onClick={() => void copy(reply)}>
                Copy
              </button>
              <span className="hint" aria-live="polite">
                {copied === "copied" && "Copied to the clipboard."}
                {copied === "failed" && "Copy is not available here. Select the text and copy it manually."}
              </span>
            </div>
          </>
        )}

        {result !== null && reply === "" && result.state === "succeeded" && (
          <p className="hint">The agent returned no text.</p>
        )}

        {result?.diff !== null && result?.diff !== undefined && (
          <div className="bubble-changes">
            <h3 className="bubble-changes-title">Changed files</h3>
            <ul className="file-list">
              {result.changes.map((c) => (
                <li key={c.path}>
                  <span className="mono">{c.path}</span>
                  <span className="diffstat">
                    <span className="add">+{c.additions}</span> <span className="del">−{c.deletions}</span>
                  </span>
                </li>
              ))}
            </ul>
            <DiffView diff={result.diff} />
            {result.diffTruncated && <p className="hint">The diff is truncated. The full change is on the computer.</p>}
          </div>
        )}
      </div>
    </li>
  );
}
