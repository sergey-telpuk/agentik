/**
 * The boundary between the UI and whatever talks to the computer.
 *
 * Screens depend only on `AgentikApi`. It has two implementations: the live
 * one in `src/api/live` (relay + Noise + inner protocol, AGENTIK.md section
 * 6.3) and the demo mock in `src/api/mock`, selected with `?scenario=`.
 *
 * Everything returned here comes from the computer or from local pins and is
 * untrusted for rendering: text is always shown as plain text, never as HTML
 * (AGENTIK.md section 8 and the "dangerous agent output" check in section 13).
 */

import type { UntrustedInvitation } from "../pairing/invitation";
import type { TaskState } from "./taskState";

export type { TaskState } from "./taskState";

/** How a computer looks from this phone, before connecting. */
export type ComputerStatus =
  /** Paired and last seen reachable through the relay. */
  | "online"
  /** Paired, but the relay reports that the computer is not connected. */
  | "offline"
  /** Pinned from an invitation; the computer has not confirmed this phone yet. */
  | "pending_confirmation"
  /** The computer presented a key different from the pinned one. Needs a new pairing. */
  | "replaced"
  /** The computer revoked this phone. No automatic restoration. */
  | "revoked";

export interface Computer {
  /** Lowercase base32 device identifier. */
  readonly id: string;
  /** Display name reported by the computer, or a name derived from the id. */
  readonly name: string;
  readonly status: ComputerStatus;
  /** Milliseconds since the epoch, or null if never seen. */
  readonly lastSeenAt: number | null;
  readonly relayUrl: string;
  /** Milliseconds since the epoch when this phone pinned the computer. */
  readonly pairedAt: number;
}

/** Secure connection phases (AGENTIK.md sections 5.3 and 7.3). */
export type ConnectionState =
  | { readonly phase: "connecting" }
  | { readonly phase: "handshaking" }
  | {
      readonly phase: "awaiting_local_approval";
      /** Code the computer shows next to its confirmation prompt, when it reported one. */
      readonly verificationCode?: string;
    }
  | { readonly phase: "synchronizing" }
  | { readonly phase: "ready"; readonly computerName: string }
  | {
      readonly phase: "failed";
      readonly reason: ConnectFailure;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly phase: "revoked"; readonly message: string };

export type ConnectFailure =
  | "computer_offline"
  /** The relay could not carry the signaling. */
  | "relay_unreachable"
  /** This WebView has no RTCPeerConnection; there is no other data path. */
  | "webrtc_unsupported"
  /** The DataChannel could not open (ICE failed, no candidate pair, timeout). */
  | "ice_failed"
  /** The open DataChannel closed. */
  | "link_lost"
  | "handshake_failed"
  | "key_mismatch"
  /** The computer does not (or no longer) recognise this phone, or refused the pairing. */
  | "not_paired"
  | "quota_exceeded";

/** A project the computer allows this phone to use. Never carries a filesystem path. */
export interface Project {
  /** Opaque id resolved on the computer against its local catalogue. */
  readonly id: string;
  readonly name: string;
  /** Number of tasks that are not finished yet. */
  readonly activeTasks: number;
}

/** The computer's identifier for an agent, for example `codex`. Opaque to the UI. */
export type AgentId = string;

/** A model an agent can run. Text comes from the computer: render as plain text only. */
export interface AgentModel {
  /** The value sent back in `StartTaskInput.model`. */
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** The model the agent uses when none is chosen. */
  readonly isDefault: boolean;
}

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  /**
   * Only `available` agents can start a task. `unsupported` is an agent that is
   * installed but that Agentik cannot drive yet; `unknown` is one whose sign-in
   * state could not be determined.
   */
  readonly status: "available" | "not_installed" | "not_authorized" | "unknown" | "unsupported";
  readonly version: string | null;
  /** Why the agent is not available (or a short "Ready"), as reported by the computer. */
  readonly statusText?: string;
  /** Models to choose from. Empty or absent means only the agent's default model. */
  readonly models?: readonly AgentModel[];
  /** Set when the model list is not a live one, for example it could not be read. */
  readonly modelsNote?: string;
}

export interface ApprovalRequest {
  /** Unique per request; a decision is bound to exactly this id. */
  readonly id: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly kind: "command" | "file_change" | "network";
  /** The exact operation, for example the full command line. Plain text. */
  readonly operation: string;
  /** Where the operation applies, for example the project and working directory. */
  readonly scope: string;
  /** Why the agent asks, as reported by the agent. Plain text. */
  readonly reason: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
}

export type ApprovalDecision = "approve" | "deny";

export interface ApprovalOutcome {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
}

export interface TaskSummary {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agent: AgentId;
  readonly prompt: string;
  /** The model this turn ran with. Empty or absent means the agent's own default. */
  readonly model?: string;
  readonly state: TaskState;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The single pending approval, if the task is waiting for one. */
  readonly pendingApproval: ApprovalRequest | null;
  /** Highest event sequence number known for the task. */
  readonly lastSeq: number;
}

interface EventBase {
  /** Monotonic within the task. */
  readonly seq: number;
  readonly at: number;
}

export type TaskEvent =
  | (EventBase & { readonly kind: "state"; readonly state: TaskState; readonly note: string | null })
  | (EventBase & { readonly kind: "message"; readonly role: "user" | "agent"; readonly text: string })
  | (EventBase & {
      readonly kind: "command";
      readonly command: string;
      readonly exitCode: number | null;
      readonly output: string;
    })
  | (EventBase & {
      readonly kind: "file_change";
      /** Path relative to the project root. */
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
    })
  | (EventBase & { readonly kind: "approval_requested"; readonly approval: ApprovalRequest })
  | (EventBase & { readonly kind: "approval_resolved"; readonly outcome: ApprovalOutcome })
  | (EventBase & { readonly kind: "error"; readonly text: string });

/** A batch of events with the task state after applying them. */
export interface TaskUpdate {
  readonly task: TaskSummary;
  readonly events: readonly TaskEvent[];
}

export interface FileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface TaskResult {
  readonly taskId: string;
  readonly state: TaskState;
  /** Final agent response. Plain text. */
  readonly output: string;
  readonly changes: readonly FileChange[];
  /** A bounded unified diff, or null if there are no changes. */
  readonly diff: string | null;
  readonly diffTruncated: boolean;
  /** Error reported by the agent or the computer for `failed`. */
  readonly error: string | null;
  /** Why the outcome is unknown, for `recovery_required`. */
  readonly recovery: string | null;
  readonly finishedAt: number | null;
}

/** Upper bound on a task description, checked on both sides. */
export const MAX_PROMPT_LENGTH = 4000;

export interface StartTaskInput {
  readonly projectId: string;
  readonly agent: AgentId;
  readonly prompt: string;
  /** A model from the agent's list. Empty or absent means the agent's own default. */
  readonly model?: string;
  /**
   * Chosen once per submission. Repeating it with the same content returns the
   * existing task; with different content it is a conflict (AGENTIK.md 7.2).
   */
  readonly requestId: string;
  /**
   * Continues this conversation: the computer runs the next turn on the same
   * agent thread, so the agent remembers the earlier turns. Omit it to start a
   * new conversation.
   */
  readonly sessionId?: string;
}

/**
 * One conversation with an agent. Every turn is a task: the user's message is
 * its prompt, the agent's reply is its outcome.
 */
export interface SessionView {
  readonly sessionId: string;
  readonly projectId: string;
  /** Turns in the order they were sent, oldest first. */
  readonly turns: readonly TaskSummary[];
  /** True when older turns were left out because the computer bounds the reply. */
  readonly truncated: boolean;
}

/** One row of the project screen: a conversation with its first message as title. */
export interface ConversationSummary {
  readonly sessionId: string;
  readonly projectId: string;
  readonly agent: AgentId;
  /** What the conversation is about: its first message. Plain text, may be shortened. */
  readonly title: string;
  /** The state of the newest turn; it decides the status shown. */
  readonly latestState: TaskState;
  /** Number of turns (messages sent) in the conversation. */
  readonly turns: number;
  /** Milliseconds since the epoch of the newest activity. */
  readonly updatedAt: number;
}

/** The conversations of one project, newest activity first. */
export interface ConversationListing {
  readonly conversations: readonly ConversationSummary[];
  /**
   * `computer` when the computer's own list was used (it is the source of
   * truth, so conversations from earlier runs are included). `local` when the
   * computer cannot list conversations (an older version) or the request
   * failed, so only conversations this phone knows in the current run appear.
   */
  readonly source: "computer" | "local";
  /** True when the computer left older conversations out of its answer. */
  readonly truncated: boolean;
  /** Why the computer's list is missing although it should have been available, or null. */
  readonly warning: string | null;
}

export interface RespondApprovalInput {
  readonly taskId: string;
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
}

export type StorageAvailability = "available" | "unavailable" | "failed";

export interface Diagnostics {
  readonly appVersion: string;
  readonly backend: "mock" | "live";
  /** Mock scenario name, or null for the live backend. */
  readonly scenario: string | null;
  readonly telegram: {
    readonly isMiniApp: boolean;
    readonly platformVersion: string | null;
    readonly initDataAvailable: boolean;
  };
  readonly storage: {
    readonly secureStorage: StorageAvailability;
    readonly deviceStorage: StorageAvailability;
    /** Store in use for pins, or `none` when persistent access is not supported. */
    readonly active: "secure" | "device" | "memory" | "none";
    /** Explanation when `active` is `none` or `memory`. */
    readonly note: string | null;
  };
  /** Relay URLs taken from paired computers. */
  readonly relayUrls: readonly string[];
}

export type ApiErrorCode =
  | "not_connected"
  | "not_found"
  | "revoked"
  | "busy"
  | "conflict"
  | "already_resolved"
  | "expired"
  | "not_finished"
  | "invalid"
  | "agent_unavailable"
  | "persistence_unsupported"
  | "pin_mismatch"
  | "storage_failed"
  /** The computer failed while handling the request. */
  | "internal";

export interface ApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
}

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

export type Unsubscribe = () => void;

/**
 * Operations the Mini App needs. Every call that reaches the computer goes
 * through the secure session opened by `connect`; calls made without a ready
 * session fail with `not_connected` instead of being queued.
 */
export interface ClearLocalDataResult {
  /**
   * True when the stored phone key was unreadable and a new one was generated.
   * Every computer must then pair this phone again, because the key changed.
   */
  readonly phoneKeyRegenerated: boolean;
}

export interface AgentikApi {
  /** `mock` while the UI runs on demo data; the UI labels it as such. */
  readonly backend: "mock" | "live";
  /** Paired computers on this phone, with their last known status. */
  listComputers(): Promise<ApiResult<Computer[]>>;
  /** Pins an untrusted invitation. Access exists only after the computer confirms. */
  pairComputer(invitation: UntrustedInvitation): Promise<ApiResult<Computer>>;
  /** Forgets a computer on this phone. Does not revoke anything on the computer. */
  forgetComputer(computerId: string): Promise<ApiResult<null>>;
  /**
   * Opens a secure session and reports its phases. A failed or revoked phase is
   * final for this attempt; retrying means calling `connect` again.
   */
  connect(computerId: string, onState: (state: ConnectionState) => void): Unsubscribe;
  listProjects(computerId: string): Promise<ApiResult<Project[]>>;
  listAgents(computerId: string): Promise<ApiResult<Agent[]>>;
  listTasks(computerId: string, projectId: string): Promise<ApiResult<TaskSummary[]>>;
  /**
   * The conversations of a project. The computer's list is merged with what
   * this phone knows from the current run, keyed by session id; nothing is
   * stored on the phone.
   */
  listConversations(computerId: string, projectId: string): Promise<ApiResult<ConversationListing>>;
  getTask(computerId: string, taskId: string): Promise<ApiResult<TaskSummary>>;
  /** The turns of one conversation, oldest first. */
  getSession(computerId: string, projectId: string, sessionId: string): Promise<ApiResult<SessionView>>;
  startTask(computerId: string, input: StartTaskInput): Promise<ApiResult<TaskSummary>>;
  /**
   * Replays events after `afterSeq`, then delivers live ones. Unsubscribing
   * stops delivery only; the task keeps running on the computer.
   */
  streamEvents(
    computerId: string,
    taskId: string,
    afterSeq: number,
    onUpdate: (update: TaskUpdate) => void,
  ): Unsubscribe;
  /** Requests a stop. The task moves to `cancel_requested`; `cancelled` comes later. */
  cancelTask(computerId: string, taskId: string): Promise<ApiResult<TaskSummary>>;
  /** Decides one specific pending approval. Never applies to another request. */
  respondApproval(computerId: string, input: RespondApprovalInput): Promise<ApiResult<ApprovalOutcome>>;
  getResult(computerId: string, taskId: string): Promise<ApiResult<TaskResult>>;
  getDiagnostics(): Promise<Diagnostics>;
  /**
   * Removes every pin stored on this phone. A phone key that cannot be read is
   * replaced with a new one; a valid key is kept.
   */
  clearLocalData(): Promise<ApiResult<ClearLocalDataResult>>;

  /**
   * Opens a login shell in a project folder on the computer (AGENTIK.md
   * section 8.1). The session ends when the secure session closes.
   */
  openTerminal(computerId: string, input: OpenTerminalInput): Promise<ApiResult<TerminalSession>>;
  /** Sends typed bytes, at most `MAX_TERMINAL_INPUT_BYTES` per call. */
  sendTerminalInput(computerId: string, sessionId: string, data: Uint8Array): Promise<ApiResult<null>>;
  resizeTerminal(computerId: string, sessionId: string, cols: number, rows: number): Promise<ApiResult<null>>;
  /** Ends the session; its processes are gone when this resolves. */
  closeTerminal(computerId: string, sessionId: string): Promise<ApiResult<TerminalClosed>>;
  /**
   * Delivers the session's output in order, then `onClosed` once. Output is
   * untrusted terminal data: it goes to the terminal emulator, never to HTML.
   */
  streamTerminal(computerId: string, sessionId: string, handlers: TerminalStreamHandlers): Unsubscribe;
}

/** Upper bound on one `sendTerminalInput` call, checked on both sides. */
export const MAX_TERMINAL_INPUT_BYTES = 4096;

export interface OpenTerminalInput {
  readonly projectId: string;
  /** One line typed into the shell after it starts, for example `codex`. */
  readonly command?: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalSession {
  readonly sessionId: string;
  readonly projectId: string;
}

export interface TerminalClosed {
  /** `exited`, `closed`, `idle`, `disconnected`, `revoked`, `shutdown`, or `lost` when the phone lost track of it. */
  readonly reason: string;
  readonly exitCode: number | null;
}

export interface TerminalStreamHandlers {
  readonly onOutput: (data: Uint8Array) => void;
  readonly onClosed: (closed: TerminalClosed) => void;
}
