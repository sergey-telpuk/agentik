/**
 * Conversation rows for the project screen, built from turns this phone knows
 * and from the computer's own session list (AGENTIK.md section 6.3).
 *
 * Pure functions only. Nothing here is persisted: conversation text lives in
 * memory for the current run and the computer stays the source of truth.
 */

import type { ConversationSummary, TaskSummary } from "./types";

/** One row per session: the first turn's prompt as title, the newest turn as status. */
export function conversationsFromTasks(tasks: readonly TaskSummary[]): ConversationSummary[] {
  const bySession = new Map<string, TaskSummary[]>();
  for (const task of tasks) bySession.set(task.sessionId, [...(bySession.get(task.sessionId) ?? []), task]);
  const rows: ConversationSummary[] = [];
  for (const [sessionId, group] of bySession) {
    const ordered = [...group].sort((a, b) => a.createdAt - b.createdAt);
    const first = ordered[0];
    const latest = ordered.at(-1);
    if (first === undefined || latest === undefined) continue;
    rows.push({
      sessionId,
      projectId: first.projectId,
      agent: first.agent,
      title: first.prompt,
      latestState: latest.state,
      turns: ordered.length,
      updatedAt: latest.updatedAt,
    });
  }
  return rows;
}

/**
 * Merges the computer's rows with the locally known ones, keyed by session id,
 * newest activity first. The computer wins on the title and on everything else
 * unless this phone saw newer activity than the computer's answer (a turn that
 * started while the list was in flight), in which case the status and time of
 * the newer turn are kept.
 */
export function mergeConversations(
  fromComputer: readonly ConversationSummary[],
  local: readonly ConversationSummary[],
): ConversationSummary[] {
  const merged = new Map<string, ConversationSummary>();
  for (const row of fromComputer) merged.set(row.sessionId, row);
  for (const row of local) {
    const remote = merged.get(row.sessionId);
    if (remote === undefined) {
      merged.set(row.sessionId, row);
      continue;
    }
    const newer = row.updatedAt > remote.updatedAt;
    merged.set(row.sessionId, {
      ...remote,
      latestState: newer ? row.latestState : remote.latestState,
      updatedAt: newer ? row.updatedAt : remote.updatedAt,
      turns: Math.max(remote.turns, row.turns),
    });
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
}
