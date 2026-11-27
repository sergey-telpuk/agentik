import type { ComputerStatus, ConnectionState } from "../api/types";
import { TASK_STATE_LABEL, type TaskState } from "../api/taskState";
import type { Tone } from "./kit";

export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function clockTime(at: number): string {
  return CLOCK.format(at);
}

export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** First characters of a device id, grouped for reading aloud. */
export function shortId(id: string): string {
  return `${id.slice(0, 4)} ${id.slice(4, 8)} …`;
}

export function sentence(text: string): string {
  return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1);
}

export const COMPUTER_STATUS: Readonly<Record<ComputerStatus, { tone: Tone; label: string }>> = {
  online: { tone: "ok", label: "online" },
  offline: { tone: "neutral", label: "offline" },
  pending_confirmation: { tone: "warn", label: "pending confirmation" },
  replaced: { tone: "bad", label: "key replaced" },
  revoked: { tone: "bad", label: "access ended" },
};

const TASK_TONE: Readonly<Record<TaskState, Tone>> = {
  accepted: "info",
  starting: "info",
  running: "info",
  awaiting_approval: "warn",
  cancel_requested: "warn",
  succeeded: "ok",
  failed: "bad",
  cancelled: "neutral",
  recovery_required: "bad",
};

export function taskStatus(state: TaskState): { tone: Tone; label: string; pulse: boolean } {
  return {
    tone: TASK_TONE[state],
    label: TASK_STATE_LABEL[state],
    pulse: state === "starting" || state === "running" || state === "cancel_requested",
  };
}

export const CONNECTION_STEPS = [
  { phase: "connecting", label: "Relay" },
  { phase: "handshaking", label: "Verify key" },
  { phase: "awaiting_local_approval", label: "Confirm on computer" },
  { phase: "synchronizing", label: "Sync" },
] as const;

export function connectionText(state: ConnectionState | null, computerName: string): { tone: Tone; label: string; detail: string } {
  if (state === null) return { tone: "neutral", label: "not connected", detail: "No secure session yet." };
  switch (state.phase) {
    case "connecting":
      return { tone: "info", label: "connecting", detail: "Reaching the relay…" };
    case "handshaking":
      return { tone: "info", label: "verifying", detail: "Checking the computer's key against the pinned one…" };
    case "awaiting_local_approval":
      return {
        tone: "warn",
        label: "waiting for confirmation",
        detail: `Open Agentik on ${computerName} and confirm this phone. Nothing is shared until you do.`,
      };
    case "synchronizing":
      return { tone: "info", label: "synchronizing", detail: "Loading projects and task state from the computer…" };
    case "ready":
      return { tone: "ok", label: "secure session", detail: "End-to-end encrypted session with the pinned key." };
    case "failed":
      return { tone: "bad", label: "connection failed", detail: state.message };
    case "revoked":
      return { tone: "bad", label: "access ended", detail: state.message };
  }
}
