/**
 * Pure translation between the inner protocol (`src/protocol/messages.ts`,
 * Unix seconds, daemon vocabulary) and the UI boundary (`../types.ts`,
 * milliseconds, UI vocabulary).
 *
 * Everything coming from the computer is untrusted: unknown values fall back
 * to the most conservative reading instead of being passed through, and text
 * is copied verbatim for plain-text rendering.
 */

import { RpcClientClosedError, RpcError, RpcTimeoutError } from "../../protocol/client";
import type {
  AgentInfo,
  ApprovalDecision as WireDecision,
  ChangesResult,
  PendingApprovalView,
  SessionEventView,
  SessionSummary,
  TaskView,
} from "../../protocol/messages";
import { TASK_STATES, isFinalState, type TaskState } from "../taskState";
import type {
  Agent,
  AgentModel,
  ApiError,
  ApprovalDecision,
  ApprovalRequest,
  ConversationSummary,
  FileChange,
  TaskEvent,
  TaskResult,
  TaskSummary,
} from "../types";

export function secondsToMs(seconds: number): number {
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

/** A state the UI does not know means the outcome is unknown, never success. */
export function taskStateOf(value: unknown): TaskState {
  return isTaskState(value) ? value : "recovery_required";
}

function approvalKind(value: unknown): ApprovalRequest["kind"] {
  return value === "file_change" || value === "network" ? value : "command";
}

function scopeOf(projectId: string): string {
  return projectId === "" ? "This task's project on the computer" : `Project ${projectId} on the computer`;
}

export function approvalFromView(view: PendingApprovalView, task: TaskView): ApprovalRequest {
  return {
    id: view.approval_id,
    taskId: task.task_id,
    sessionId: task.session_id,
    kind: approvalKind(view.kind),
    operation: view.summary,
    scope: scopeOf(task.project_id),
    reason: "The computer does not report the agent's reason yet.",
    requestedAt: secondsToMs(task.updated_at),
    expiresAt: secondsToMs(view.expires_at),
  };
}

export function taskSummaryFromView(view: TaskView, lastSeq: number): TaskSummary {
  return {
    id: view.task_id,
    projectId: view.project_id,
    sessionId: view.session_id,
    agent: "codex",
    prompt: view.prompt,
    state: taskStateOf(view.state),
    createdAt: secondsToMs(view.created_at),
    updatedAt: secondsToMs(view.updated_at),
    pendingApproval: view.pending_approval === null ? null : approvalFromView(view.pending_approval, view),
    lastSeq,
  };
}

const WIRE_AGENT_STATUS: Readonly<Record<string, Agent["status"]>> = {
  ready: "available",
  not_authenticated: "not_authorized",
  not_installed: "not_installed",
  unsupported: "unsupported",
  unknown: "unknown",
};

const MAX_AGENTS = 20;
const MAX_MODELS = 50;
const MAX_NAME_CHARS = 128;
const MAX_NOTE_CHARS = 300;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function modelsFromInfo(info: AgentInfo): AgentModel[] {
  const seen = new Set<string>();
  const out: AgentModel[] = [];
  for (const m of info.models ?? []) {
    if (typeof m.id !== "string" || m.id === "" || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      name: clip(text(m.display_name) ?? m.id, MAX_NAME_CHARS),
      description: text(m.description) === null ? null : clip(m.description ?? "", MAX_NOTE_CHARS),
      isDefault: m.is_default === true,
    });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/**
 * Agents from `agent.list`.
 *
 * A computer that detects every installed agent sends `status` on each entry;
 * all of them are listed, and only `ready` ones can run a task. An older
 * computer sends only the original fields and only Codex is known to exist:
 * a computer that does not list it reports it as not installed.
 */
export function agentsFromInfo(list: readonly AgentInfo[]): Agent[] {
  if (list.some((a) => a.status !== undefined)) {
    return list.slice(0, MAX_AGENTS).map((a): Agent => {
      const id = a.id ?? a.name;
      const status = WIRE_AGENT_STATUS[a.status ?? ""] ?? "unknown";
      const note = status === "available" && a.models_source === "static" ? (text(a.models_detail) ?? undefined) : undefined;
      return {
        id,
        name: clip(text(a.display_name) ?? id, MAX_NAME_CHARS),
        status,
        version: a.version ?? null,
        ...(text(a.status_text) !== null ? { statusText: clip(a.status_text ?? "", MAX_NOTE_CHARS) } : {}),
        models: status === "available" ? modelsFromInfo(a) : [],
        ...(note !== undefined ? { modelsNote: clip(note, MAX_NOTE_CHARS) } : {}),
      };
    });
  }
  const codex = list.find((a) => a.name === "codex");
  const status: Agent["status"] =
    codex === undefined || !codex.available ? "not_installed" : !codex.authenticated ? "not_authorized" : "available";
  return [{ id: "codex", name: "Codex", status, version: codex?.version ?? null }];
}

export function wireDecision(decision: ApprovalDecision): WireDecision {
  return decision === "approve" ? "accept" : "decline";
}

/**
 * Maps one session event to at most one timeline event, keeping its `seq`.
 *
 * Streaming `delta` fragments and cumulative `diff` snapshots are not shown
 * as timeline entries: the complete agent message arrives as an `item`, and
 * the final changes are part of the result.
 */
export function timelineEventFromSession(ev: SessionEventView, projectId: string): TaskEvent | null {
  const p = ev.payload;
  const base = { seq: ev.seq, at: secondsToMs(ev.created_at) };
  switch (ev.kind) {
    case "status":
      return isTaskState(p["state"]) ? { ...base, kind: "state", state: p["state"], note: text(p["message"]) } : null;
    case "item": {
      const itemType = p["item_type"];
      const body = text(p["text"]);
      if (itemType === "commandExecution") {
        const command = text(p["command"]);
        if (command === null) return null;
        const exitCode = typeof p["exit_code"] === "number" ? p["exit_code"] : null;
        return { ...base, kind: "command", command, exitCode, output: body ?? "" };
      }
      if (body === null) return null;
      if (itemType === "agentMessage") return { ...base, kind: "message", role: "agent", text: body };
      if (itemType === "userMessage") return { ...base, kind: "message", role: "user", text: body };
      return null;
    }
    case "approval_requested": {
      const id = text(p["approval_id"]);
      if (id === null) return null;
      const expiresAt = typeof p["expires_at"] === "number" ? secondsToMs(p["expires_at"]) : base.at;
      return {
        ...base,
        kind: "approval_requested",
        approval: {
          id,
          taskId: ev.task_id,
          sessionId: ev.session_id,
          kind: approvalKind(p["kind"]),
          operation: text(p["summary"]) ?? "",
          scope: scopeOf(projectId),
          reason: "The computer does not report the agent's reason yet.",
          requestedAt: base.at,
          expiresAt,
        },
      };
    }
    case "approval_resolved": {
      const id = text(p["approval_id"]) ?? "";
      const status = p["status"];
      if (status === "accepted" || status === "declined") {
        return {
          ...base,
          kind: "approval_resolved",
          outcome: { approvalId: id, decision: status === "accepted" ? "approve" : "deny" },
        };
      }
      return status === "expired"
        ? { ...base, kind: "error", text: "The approval request expired without a decision. The agent has to ask again." }
        : null;
    }
    case "completed":
      return isTaskState(p["state"]) ? { ...base, kind: "state", state: p["state"], note: text(p["error"]) } : null;
    case "error":
      return { ...base, kind: "error", text: text(p["error"]) ?? text(p["message"]) ?? "The task failed." };
    case "delta":
    case "diff":
      return null;
    default:
      return null;
  }
}

/** Kinds after which the task summary (state, pending approval) may have changed. */
export function changesTaskState(ev: SessionEventView): boolean {
  return (
    ev.kind === "status" ||
    ev.kind === "approval_requested" ||
    ev.kind === "approval_resolved" ||
    ev.kind === "completed" ||
    ev.kind === "error"
  );
}

/** Per-file line counts from a unified diff. */
export function changesFromDiff(diff: string): FileChange[] {
  const files: { path: string; additions: number; deletions: number }[] = [];
  let current: { path: string; additions: number; deletions: number } | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = { path: match?.[1] ?? line.slice("diff --git ".length), additions: 0, deletions: 0 };
      files.push(current);
    } else if (line.startsWith("+++ ")) {
      if (current === null) {
        current = { path: line.slice(4).replace(/^b\//, ""), additions: 0, deletions: 0 };
        files.push(current);
      }
    } else if (current === null || line.startsWith("--- ")) {
      continue;
    } else if (line.startsWith("+")) {
      current.additions += 1;
    } else if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }
  return files;
}

export function taskResultFromView(view: TaskView, changes: ChangesResult | null): TaskResult {
  const state = taskStateOf(view.state);
  const diff = changes !== null && changes.diff !== "" ? changes.diff : null;
  const error = text(view.error_message);
  return {
    taskId: view.task_id,
    state,
    output: view.result_text,
    changes: diff === null ? [] : changesFromDiff(diff),
    diff,
    diffTruncated: changes?.truncated ?? false,
    error: state === "failed" ? (error ?? "The computer reported a failure without details.") : null,
    recovery:
      state === "recovery_required"
        ? (error ?? "The computer cannot tell whether the agent finished. The task was not restarted.")
        : null,
    finishedAt: isFinalState(state) ? secondsToMs(view.updated_at) : null,
  };
}

/** Translates a failed inner-protocol call into a UI error. */
export function apiErrorFrom(err: unknown): ApiError {
  if (err instanceof RpcTimeoutError) {
    return {
      code: "not_connected",
      message:
        "The computer did not answer in time. Nothing is assumed: retrying sends the same request, so a task is never started twice.",
    };
  }
  if (err instanceof RpcClientClosedError) {
    return {
      code: "not_connected",
      message: "The secure session closed before the computer answered. Reconnect and try again.",
    };
  }
  if (err instanceof RpcError) {
    switch (err.code) {
      case "not_found":
        return { code: "not_found", message: err.message };
      case "project_busy":
        return { code: "busy", message: "Another task is still active in this project. Only one active task per project is allowed." };
      case "duplicate_in_flight":
        return { code: "busy", message: "This request is still waiting for the computer's answer." };
      case "request_id_conflict":
        return { code: "conflict", message: "This request id was already used for a different task." };
      case "approval_already_resolved":
        return { code: "already_resolved", message: "This request was already decided. A decision cannot be changed or repeated." };
      case "approval_expired":
        return { code: "expired", message: "This request expired. The agent has to ask again." };
      case "agent_unavailable":
      case "agent_unsupported":
      case "agent_not_ready":
        return { code: "agent_unavailable", message: err.message };
      case "unknown_model":
        return { code: "invalid", message: err.message };
      case "unauthorized":
        return { code: "revoked", message: `The computer refused this phone: ${err.message}` };
      case "bad_request":
        return { code: "invalid", message: err.message };
      default:
        return { code: "internal", message: `The computer could not complete the request (${err.code}): ${err.message}` };
    }
  }
  return { code: "not_connected", message: err instanceof Error ? err.message : "The request failed." };
}

const UNSUPPORTED_CODES: readonly string[] = ["unknown_method", "method_not_found", "unsupported", "not_implemented"];

/**
 * True when the computer answered that it does not know a method. A daemon
 * without the method reports `bad_request` with an "unknown method" message
 * (AGENTIK.md section 6.3: an unknown method produces an explicit error).
 */
export function isUnsupportedMethod(err: unknown): boolean {
  if (!(err instanceof RpcError)) return false;
  if (UNSUPPORTED_CODES.includes(err.code)) return true;
  return err.code === "bad_request" && /unknown method|unsupported method|not implemented/i.test(err.message);
}

/**
 * One session of the computer's list as a conversation row, or null when it
 * cannot be shown: no turns yet, or a computer that lists sessions without the
 * title and turn count (an older version), so there is nothing to display.
 */
export function conversationFromSession(item: SessionSummary): ConversationSummary | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const turns = item.turn_count;
  if (title === "" || typeof turns !== "number" || !Number.isInteger(turns) || turns < 1) return null;
  if (typeof item.session_id !== "string" || item.session_id === "") return null;
  return {
    sessionId: item.session_id,
    projectId: item.project_id,
    agent: "codex",
    title,
    latestState: taskStateOf(item.latest_state),
    turns,
    updatedAt: secondsToMs(item.updated_at),
  };
}

/** True when the list came from a computer that predates the conversation fields. */
export function isLegacySessionList(list: readonly SessionSummary[]): boolean {
  return list.length > 0 && list.every((item) => item.turn_count === undefined && item.title === undefined);
}
