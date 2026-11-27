import { useEffect, useState } from "react";
import { isFinalState } from "../api/taskState";
import type { AgentikApi, ConversationListing } from "../api/types";
import { relativeTime, sentence, taskStatus } from "./format";
import { Empty, Notice, Page, SkeletonList, StatusChip, useNow } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly now: () => number;
  readonly onNewTask: () => void;
  /** Opens the conversation a task belongs to. */
  readonly onOpenSession: (sessionId: string) => void;
  readonly onBack: () => void;
}

type Listing =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly listing: ConversationListing }
  | { readonly kind: "error"; readonly message: string };

const REFRESH_MS = 2000;

export function ProjectScreen({ api, computerId, projectId, projectName, now, onNewTask, onOpenSession, onBack }: Props) {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const current = useNow(30_000, now);

  useEffect(() => {
    let cancelled = false;
    void api.listConversations(computerId, projectId).then((result) => {
      if (cancelled) return;
      setListing(
        result.ok ? { kind: "ready", listing: result.value } : { kind: "error", message: sentence(result.error.message) },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, computerId, projectId, tick]);

  const ready = listing.kind === "ready" ? listing.listing : null;
  const conversations = ready?.conversations ?? [];
  const hasActive = conversations.some((c) => !isFinalState(c.latestState));
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
      {ready !== null && conversations.length === 0 && (
        <Empty title={ready.source === "local" && api.backend === "live" ? "No tasks started from this phone yet." : "No tasks in this project yet."}>
          <p>Start one with “New task”. It runs on the computer and keeps running if you close the app.</p>
        </Empty>
      )}
      {ready !== null && ready.warning !== null && (
        <Notice tone="warn" title="Earlier conversations could not be loaded">
          <p>{sentence(ready.warning)}</p>
        </Notice>
      )}
      {ready !== null && ready.source === "local" && api.backend === "live" && ready.warning === null && (
        <p className="hint">
          Only tasks started or opened on this phone since Agentik was opened are listed. This computer cannot list
          earlier conversations yet; update Agentik on the computer to see them.
        </p>
      )}
      {ready !== null && ready.truncated && (
        <p className="hint">Only the most recent conversations are shown.</p>
      )}
      {conversations.length > 0 && (
        <ul className="card-list">
          {conversations.map((c) => {
            const status = taskStatus(c.latestState);
            return (
              <li key={c.sessionId} className={c.latestState === "awaiting_approval" ? "card card-attention" : "card"}>
                <button type="button" className="card-main" onClick={() => onOpenSession(c.sessionId)}>
                  <span className="card-title clamp-2">{c.title}</span>
                  <span className="card-title-row">
                    <StatusChip tone={status.tone} label={status.label} pulse={status.pulse} />
                    <span className="card-meta">
                      {c.turns > 1 ? `${c.turns} messages · ` : ""}
                      {relativeTime(c.updatedAt, current)}
                    </span>
                  </span>
                  {c.latestState === "awaiting_approval" && <span className="card-meta attention">Needs your decision</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
