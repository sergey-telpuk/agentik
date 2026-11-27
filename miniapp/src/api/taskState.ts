/**
 * Task states and their allowed transitions (AGENTIK.md section 7.1).
 *
 * The computer is the source of truth; this table is what the UI accepts.
 * An update that would move a task backwards or out of a final state is
 * rejected instead of shown, so a stale or replayed event cannot make a
 * finished task look like it is running again.
 */

export const TASK_STATES = [
  "accepted",
  "starting",
  "running",
  "awaiting_approval",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "recovery_required",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

const FINAL: ReadonlySet<TaskState> = new Set(["succeeded", "failed", "cancelled", "recovery_required"]);

const NEXT: Readonly<Record<TaskState, readonly TaskState[]>> = {
  accepted: ["starting", "cancel_requested", "failed", "recovery_required"],
  starting: ["running", "cancel_requested", "failed", "recovery_required"],
  running: ["awaiting_approval", "cancel_requested", "succeeded", "failed", "recovery_required"],
  awaiting_approval: ["running", "cancel_requested", "failed", "recovery_required"],
  // A stop request races with normal completion: the agent may still finish.
  cancel_requested: ["cancelled", "succeeded", "failed", "recovery_required"],
  succeeded: [],
  failed: [],
  cancelled: [],
  recovery_required: [],
};

export function isFinalState(state: TaskState): boolean {
  return FINAL.has(state);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return NEXT[from].includes(to);
}

export type TransitionResult =
  | { readonly ok: true; readonly state: TaskState }
  | { readonly ok: false; readonly from: TaskState; readonly to: TaskState };

export function transition(from: TaskState, to: TaskState): TransitionResult {
  return canTransition(from, to) ? { ok: true, state: to } : { ok: false, from, to };
}

/** A stop can be requested while the task has not finished and no stop is pending. */
export function canRequestCancel(state: TaskState): boolean {
  return canTransition(state, "cancel_requested");
}

export const TASK_STATE_LABEL: Readonly<Record<TaskState, string>> = {
  accepted: "accepted",
  starting: "starting",
  running: "running",
  awaiting_approval: "waiting for approval",
  cancel_requested: "stop requested",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  recovery_required: "recovery required",
};

export const TASK_STATE_DESCRIPTION: Readonly<Record<TaskState, string>> = {
  accepted: "The computer validated the task and saved it.",
  starting: "The agent is being launched. Execution is not confirmed yet.",
  running: "The agent confirmed that it is working.",
  awaiting_approval: "The agent is waiting for your decision on one operation.",
  cancel_requested: "A stop was requested. The computer has not confirmed it yet.",
  succeeded: "The agent reported successful completion.",
  failed: "The computer reported a confirmed error.",
  cancelled: "The computer confirmed that the task stopped.",
  recovery_required:
    "The computer cannot tell whether the agent finished. The task is not restarted automatically.",
};
