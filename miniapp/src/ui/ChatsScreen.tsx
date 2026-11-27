/**
 * The home screen: every conversation with an agent, newest activity first.
 *
 * Agents keep working while the app is closed, so this screen is also the
 * place to see what is happening without opening anything: a conversation
 * waiting for a decision comes first, then the ones running right now.
 *
 * Everything from the computer is untrusted and shown as plain text.
 */

import { useEffect, useState } from "react";
import { isFinalState } from "../api/taskState";
import type { AgentikApi, Computer, ConversationSummary } from "../api/types";
import { relativeTime, sentence, taskStatus } from "./format";
import { Empty, Notice, Page, SkeletonList, useBusy, useNow, ConfirmDialog } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly now: () => number;
  /** Opens the paired-computers screen, where a computer is added or removed. */
  readonly onComputers: () => void;
  /** Opens an existing conversation. */
  readonly onOpen: (computerId: string, projectId: string, sessionId: string) => void;
  /** Starts a new one: an empty chat whose first message creates it. */
  readonly onNew: () => void;
  readonly onSettings: () => void;
}

/** One conversation plus the computer it lives on. */
interface Row extends ConversationSummary {
  readonly computerId: string;
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly rows: readonly Row[]; readonly warning: string | null }
  | { readonly kind: "error"; readonly message: string };

/** How often the list refreshes while an agent is working. */
const REFRESH_MS = 2000;

/**
 * Waiting for a decision first: an agent has stopped and cannot continue
 * without the user. Then the ones still running, then the rest by recency.
 */
function rank(row: Row): number {
  if (row.latestState === "awaiting_approval") return 0;
  return isFinalState(row.latestState) ? 2 : 1;
}

function byPriority(a: Row, b: Row): number {
  return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
}

export function ChatsScreen({ api, now, onOpen, onNew, onSettings, onComputers }: Props) {
  const [computers, setComputers] = useState<readonly Computer[] | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<Row | null>(null);
  const [deleting, runDelete] = useBusy();
  const current = useNow(30_000, now);

  useEffect(() => {
    let cancelled = false;
    void api.listComputers().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setState({ kind: "error", message: sentence(result.error.message) });
        return;
      }
      setComputers(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Conversations are read over the secure session, so the list opens one to
  // every paired computer and asks again as each becomes ready. Closing the
  // screen closes them.
  const [readyIds, setReadyIds] = useState<readonly string[]>([]);
  useEffect(() => {
    if (computers === null || computers.length === 0) return;
    // A computer that has not confirmed this phone yet must not be connected
    // to from here: the pairing invitation is single-use, and spending it
    // outside the pairing screen fails the pairing. A revoked or replaced one
    // has nothing to list either.
    const connectable = computers.filter((c) => c.status !== "pending_confirmation" && c.status !== "revoked" && c.status !== "replaced");
    const stops = connectable.map((computer) =>
      api.connect(computer.id, (conn) => {
        setReadyIds((ids) => {
          const isReady = conn.phase === "ready";
          const has = ids.includes(computer.id);
          if (isReady === has) return ids;
          return isReady ? [...ids, computer.id] : ids.filter((id) => id !== computer.id);
        });
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [api, computers]);

  useEffect(() => {
    if (computers === null || computers.length === 0) return;
    let cancelled = false;
    // One request per computer; a computer that fails is reported without
    // hiding the conversations of the others.
    const live = computers.filter((c) => readyIds.includes(c.id));
    if (live.length === 0) return;
    void Promise.all(
      live.map(async (computer) => {
        const result = await api.listConversations(computer.id);
        return { computer, result };
      }),
    ).then((results) => {
      if (cancelled) return;
      const rows: Row[] = [];
      const failed: string[] = [];
      for (const { computer, result } of results) {
        if (!result.ok) {
          failed.push(computer.name);
          continue;
        }
        for (const c of result.value.conversations) rows.push({ ...c, computerId: computer.id });
      }
      if (failed.length === results.length && results.length > 0) {
        setState({ kind: "error", message: "No computer could be reached." });
        return;
      }
      rows.sort(byPriority);
      setState({
        kind: "ready",
        rows,
        warning: failed.length > 0 ? `Could not reach ${failed.join(", ")}.` : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, computers, readyIds, tick]);

  // With no computer there is nothing to ask, so the screen is ready and empty
  // without an effect having to say so.
  const noComputers = computers !== null && computers.length === 0;
  // Until a session is ready there is nothing to show yet, which is loading
  // rather than an empty list.
  // Until the paired computers are known, and until a session is ready, there
  // is nothing to show yet: that is loading rather than an empty list.
  const connecting =
    computers === null || (computers.length > 0 && readyIds.length === 0 && state.kind === "loading");
  const effective: State = noComputers ? { kind: "ready", rows: [], warning: null } : state;
  const rows = effective.kind === "ready" ? effective.rows : [];
  const hasActive = rows.some((r) => !isFinalState(r.latestState));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasActive]);

  // Only worth naming the folder when conversations are spread across several.
  const manyProjects = new Set(rows.map((r) => r.projectId)).size > 1;

  async function confirmDelete(): Promise<void> {
    const row = pendingDelete;
    if (row === null) return;
    const result = await api.deleteSession(row.computerId, row.projectId, row.sessionId);
    setPendingDelete(null);
    if (result.ok) {
      setState((s) => (s.kind === "ready" ? { ...s, rows: s.rows.filter((r) => r.sessionId !== row.sessionId) } : s));
      return;
    }
    setState((s) => (s.kind === "ready" ? { ...s, warning: sentence(result.error.message) } : s));
  }

  return (
    <Page
      title="Agentik"
      actions={
        <>
        <button type="button" className="icon-button" onClick={onComputers} aria-label="Computers">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <rect x="3" y="4.5" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M8.5 20h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="icon-button" onClick={onSettings} aria-label="Settings and diagnostics">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
        </>
      }
    >
      {(effective.kind === "loading" || connecting) && <SkeletonList rows={4} label="Loading conversations" />}

      {effective.kind === "error" && (
        <Notice tone="bad" alert title="Could not load conversations">
          <p>{effective.kind === "error" ? effective.message : ""}</p>
        </Notice>
      )}

      {effective.kind === "ready" && effective.warning !== null && (
        <Notice tone="warn" title="Some conversations are missing">
          <p>{effective.kind === "ready" ? effective.warning : ""}</p>
        </Notice>
      )}

      {effective.kind === "ready" && rows.length === 0 && computers !== null && computers.length === 0 && (
        <Empty
          title="No computer paired yet."
          action={
            <button type="button" className="button button-primary" onClick={onComputers}>
              Pair a computer
            </button>
          }
        >
          <p>Agents run on your own computer. Pair one to start.</p>
        </Empty>
      )}

      {effective.kind === "ready" && rows.length === 0 && computers !== null && computers.length > 0 && (
        <Empty title="No conversations yet.">
          <p>Tap + and tell the agent what to do. It keeps working if you close the app.</p>
        </Empty>
      )}

      {rows.length > 0 && (
        <ul className="chat-list">
          {rows.map((row) => {
            const status = taskStatus(row.latestState);
            const waiting = row.latestState === "awaiting_approval";
            const running = !isFinalState(row.latestState);
            return (
              <li key={`${row.computerId}:${row.sessionId}`} className="chat-item">
                <button
                  type="button"
                  className="chat-open"
                  onClick={() => onOpen(row.computerId, row.projectId, row.sessionId)}
                >
                  <span className="chat-title clamp-2">{row.title}</span>
                  <span className={waiting ? "chat-sub chat-sub-attention" : "chat-sub"}>
                    {running && <span className={status.pulse ? "dot dot-pulse" : "dot"} aria-hidden="true" />}
                    {/* A running agent: what it is doing now. A finished one: when it finished. */}
                    {running ? status.label : relativeTime(row.updatedAt, current)}
                    {manyProjects && <span className="chat-where"> · {row.projectId}</span>}
                  </span>
                </button>
                <button
                  type="button"
                  className="chat-delete"
                  onClick={() => setPendingDelete(row)}
                  aria-label={`Delete conversation: ${row.title}`}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      d="M5 7h14M10 7V5.5h4V7M6.5 7l.8 12h9.4l.8-12M10.5 10.5v5M13.5 10.5v5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {computers !== null && computers.length > 0 && (
      <button type="button" className="fab" onClick={onNew} aria-label="New conversation">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path d="M12 5.5v13M5.5 12h13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="Delete this conversation?"
          confirmLabel="Delete"
          destructive
          busy={deleting}
          onConfirm={() => void runDelete(confirmDelete)}
          onCancel={() => setPendingDelete(null)}
        >
          <p>
            “{pendingDelete.title}” and its messages are deleted on the computer. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </Page>
  );
}
