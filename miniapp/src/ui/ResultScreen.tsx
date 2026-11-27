import { useEffect, useState } from "react";
import { TASK_STATE_DESCRIPTION } from "../api/taskState";
import type { AgentikApi, TaskResult } from "../api/types";
import { sentence, taskStatus } from "./format";
import { Empty, Notice, Page, Section, SkeletonList, StatusChip } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly taskId: string;
  readonly projectName: string;
  readonly onNewTask: (prompt: string) => void;
  readonly onBack: () => void;
  /** Copies text; resolves false when the clipboard is not available. */
  readonly copyText: (text: string) => Promise<boolean>;
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="code diff" aria-label="Diff">
      {diff.split("\n").map((line, i) => {
        const kind = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "ctx";
        return (
          <span key={i} className={`diff-line diff-${kind}`}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

export function ResultScreen({ api, computerId, taskId, projectName, onNewTask, onBack, copyText }: Props) {
  const [result, setResult] = useState<TaskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getResult(computerId, taskId), api.getTask(computerId, taskId)]).then(([r, t]) => {
      if (cancelled) return;
      if (r.ok) setResult(r.value);
      else setError(sentence(r.error.message));
      if (t.ok) setPrompt(t.value.prompt);
    });
    return () => {
      cancelled = true;
    };
  }, [api, computerId, taskId]);

  async function copy(text: string): Promise<void> {
    setCopied((await copyText(text)) ? "copied" : "failed");
  }

  const status = result !== null ? taskStatus(result.state) : null;

  return (
    <Page title="Result" subtitle={projectName} onBack={onBack}>
      {error !== null && (
        <Notice tone="bad" alert title="No result yet">
          <p>{error}</p>
        </Notice>
      )}
      {result === null && error === null && <SkeletonList rows={4} label="Loading result" />}
      {result !== null && status !== null && (
        <>
          <div className="task-status">
            <div className="task-status-row">
              <StatusChip tone={status.tone} label={status.label} />
              {result.finishedAt !== null && (
                <span className="hint">
                  {`${result.state === "recovery_required" ? "last update" : "finished"} ${new Date(result.finishedAt).toLocaleString()}`}
                </span>
              )}
            </div>
            <p className="task-status-detail">{TASK_STATE_DESCRIPTION[result.state]}</p>
          </div>

          {result.state === "recovery_required" && (
            <Notice tone="bad" title="The outcome is unknown">
              <p className="plain">{result.recovery}</p>
              <ul className="bullets">
                <li>Agentik never restarts such a task automatically, because it may already have run.</li>
                <li>Check the project on the computer before starting anything new.</li>
              </ul>
              <button type="button" className="button button-secondary" onClick={() => onNewTask(prompt)}>
                Start a new task with the same text
              </button>
            </Notice>
          )}

          {result.state === "failed" && result.error !== null && (
            <Notice tone="bad" title="Error reported by the computer">
              <p className="plain">{result.error}</p>
            </Notice>
          )}

          {result.output !== "" && (
            <Section
              title="Response"
              aside={
                <button type="button" className="button button-ghost button-small" onClick={() => void copy(result.output)}>
                  Copy
                </button>
              }
            >
              <div className="output plain">{result.output}</div>
              <p className="hint" aria-live="polite">
                {copied === "copied" && "Copied to the clipboard."}
                {copied === "failed" && "Copy is not available here. Select the text and copy it manually."}
              </p>
            </Section>
          )}

          {result.output === "" && result.state !== "recovery_required" && result.state !== "failed" && (
            <Empty title="The agent returned no text." />
          )}

          <Section title="Changed files">
            {result.changes.length === 0 ? (
              <p className="hint">No file changes were reported.</p>
            ) : (
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
            )}
            {result.diff !== null && <DiffView diff={result.diff} />}
            {result.diffTruncated && <p className="hint">The diff is truncated. The full change is on the computer.</p>}
          </Section>
        </>
      )}
    </Page>
  );
}
