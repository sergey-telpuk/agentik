import { useEffect, useState } from "react";
import { isFinalState } from "../api/taskState";
import type { AgentikApi, TaskSummary } from "../api/types";
import { relativeTime, sentence, taskStatus } from "./format";
import { Empty, Notice, Page, SkeletonList, StatusChip, useNow } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly now: () => number;
  readonly onNewTask: () => void;
  readonly onOpenTask: (task: TaskSummary) => void;
  readonly onBack: () => void;
}

type Listing =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly tasks: TaskSummary[] }
  | { readonly kind: "error"; readonly message: string };

const REFRESH_MS = 2000;

export function ProjectScreen({ api, computerId, projectId, projectName, now, onNewTask, onOpenTask, onBack }: Props) {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const current = useNow(30_000, now);

  useEffect(() => {
    let cancelled = false;
    void api.listTasks(computerId, projectId).then((result) => {
      if (cancelled) return;
      setListing(result.ok ? { kind: "ready", tasks: result.value } : { kind: "error", message: sentence(result.error.message) });
    });
    return () => {
      cancelled = true;
    };
  }, [api, computerId, projectId, tick]);

  const hasActive = listing.kind === "ready" && listing.tasks.some((t) => !isFinalState(t.state));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasActive]);

  return (
    <Page
      title={projectName}
      subtitle={projectId}
      onBack={onBack}
      footer={
        <button type="button" className="button button-primary button-block" onClick={onNewTask}>
          New task
        </button>
      }
    >
      {listing.kind === "loading" && <SkeletonList rows={4} label="Loading tasks" />}
      {listing.kind === "error" && (
        <Notice tone="bad" alert title="Could not load tasks">
          <p>{listing.message}</p>
        </Notice>
      )}
      {listing.kind === "ready" && listing.tasks.length === 0 && (
        <Empty title={api.backend === "live" ? "No tasks started from this phone yet." : "No tasks in this project yet."}>
          <p>Start one with “New task”. It runs on the computer and keeps running if you close the app.</p>
        </Empty>
      )}
      {listing.kind === "ready" && api.backend === "live" && (
        <p className="hint">
          Only tasks started or opened on this phone since Agentik was opened are listed. The computer cannot list
          earlier tasks yet.
        </p>
      )}
      {listing.kind === "ready" && listing.tasks.length > 0 && (
        <ul className="card-list">
          {listing.tasks.map((t) => {
            const status = taskStatus(t.state);
            return (
              <li key={t.id} className={t.state === "awaiting_approval" ? "card card-attention" : "card"}>
                <button type="button" className="card-main" onClick={() => onOpenTask(t)}>
                  <span className="card-title clamp-2">{t.prompt}</span>
                  <span className="card-title-row">
                    <StatusChip tone={status.tone} label={status.label} pulse={status.pulse} />
                    <span className="card-meta">{relativeTime(t.createdAt, current)}</span>
                  </span>
                  {t.state === "awaiting_approval" && <span className="card-meta attention">Needs your decision</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
