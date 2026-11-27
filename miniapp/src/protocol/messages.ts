/**
 * Inner JSON protocol v1 transmitted strictly inside an authenticated
 * `SecureSession` (AGENTIK.md sections 6.2, 6.3, 7).
 */

export const PROTOCOL_VERSION = 1;

export type TaskState =
  | "accepted"
  | "starting"
  | "running"
  | "awaiting_approval"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "recovery_required";

export type ApprovalDecision = "accept" | "decline";

export interface PendingApprovalView {
  readonly approval_id: string;
  readonly kind: "command" | "file_change";
  readonly summary: string;
  readonly expires_at: number;
}

export interface TaskView {
  readonly task_id: string;
  readonly session_id: string;
  readonly project_id: string;
  readonly agent: string;
  /** The model the task was started with; empty or absent means the agent's default. */
  readonly model?: string;
  readonly prompt: string;
  readonly state: TaskState;
  readonly result_text: string;
  readonly error_message: string;
  readonly pending_approval: PendingApprovalView | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ProjectInfo {
  readonly project_id: string;
  readonly name: string;
  readonly agents: readonly string[];
}

/** One model an agent can run, as listed by the computer. */
export interface AgentModelInfo {
  readonly id: string;
  readonly display_name?: string;
  readonly description?: string;
  readonly is_default?: boolean;
}

export type AgentStatusWire = "ready" | "not_authenticated" | "unknown" | "unsupported" | "not_installed";

/**
 * One agent in `agent.list`. `name`..`detail` are the original fields; the
 * rest is sent by computers that detect every installed agent and is absent
 * from older ones, so each is optional.
 */
export interface AgentInfo {
  readonly name: string;
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly version?: string;
  readonly detail?: string;
  readonly id?: string;
  readonly display_name?: string;
  readonly status?: AgentStatusWire;
  readonly status_text?: string;
  readonly supported?: boolean;
  readonly models?: readonly AgentModelInfo[];
  readonly models_source?: "live" | "static";
  readonly models_detail?: string;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly project_id: string;
  readonly agent: string;
  readonly thread_id?: string;
  readonly created_at: number;
  readonly updated_at: number;
  /** First prompt of the session, shortened. Absent on computers that predate conversation listing. */
  readonly title?: string;
  /** State of the newest turn. */
  readonly latest_state?: TaskState;
  /** Number of turns. Absent on computers that predate conversation listing. */
  readonly turn_count?: number;
}

export type SessionEventKind =
  | "status"
  | "delta"
  | "item"
  | "diff"
  | "approval_requested"
  | "approval_resolved"
  | "completed"
  | "error";

export interface SessionEventView {
  readonly session_id: string;
  readonly task_id: string;
  readonly seq: number;
  readonly kind: SessionEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly created_at: number;
}

export interface DeviceInfoResult {
  readonly device_id: string;
  readonly paired: boolean;
  readonly pairing_state: "unpaired" | "awaiting_local_approval" | "paired" | "revoked";
  readonly capabilities: readonly string[];
}

export interface PairSubmitParams {
  readonly invitation_id: string;
  readonly invitation_secret: string;
  readonly label?: string;
  readonly init_data?: string;
}

export interface PairSubmitResult {
  readonly state: "awaiting_local_approval" | "paired";
  readonly device_id: string;
  readonly verification_code?: string;
}

export interface ProjectListResult {
  readonly projects: readonly ProjectInfo[];
}

export interface AgentListResult {
  readonly agents: readonly AgentInfo[];
}

export interface SessionListResult {
  readonly sessions: readonly SessionSummary[];
  /** True when older sessions were left out. */
  readonly sessions_truncated?: boolean;
}

export interface SessionDeleteResult {
  readonly session_id: string;
  readonly deleted: boolean;
}

export interface SessionOpenParams {
  readonly project_id: string;
  readonly session_id?: string;
  readonly agent?: string;
}

export interface SessionOpenResult {
  readonly session_id: string;
  readonly project_id: string;
  readonly agent: string;
  readonly last_seq: number;
  /**
   * Turns of the session, oldest first. Absent on computers that predate
   * conversations; prompt and result text may be shortened per entry.
   */
  readonly tasks?: readonly TaskView[];
  /** True when older turns were left out of `tasks`. */
  readonly tasks_truncated?: boolean;
}

export interface TaskStartParams {
  readonly project_id: string;
  readonly session_id: string | null;
  readonly agent: string;
  readonly prompt: string;
  /**
   * Set together with `model` when a model other than the agent's default is
   * chosen. Older computers reject unknown parameters, so a request that does
   * not choose a model keeps exactly the original shape.
   */
  readonly agent_id?: string;
  readonly model?: string;
}

export interface TaskResult {
  readonly task: TaskView;
  readonly deduplicated?: boolean;
}

export interface ApprovalResolveResult {
  readonly approval_id: string;
  readonly status: "accepted" | "declined";
}

export interface EventsResumeResult {
  readonly session_id: string;
  readonly events: readonly SessionEventView[];
  readonly next_seq: number;
  readonly truncated?: boolean;
}

export interface ChangesResult {
  readonly task_id: string;
  readonly diff: string;
  readonly truncated: boolean;
}

export interface PairUpdatedEventData {
  readonly device_id: string;
  readonly state: "paired" | "rejected" | "expired" | "revoked";
}

export type ServerEvent =
  | { readonly event: "session.event"; readonly data: SessionEventView }
  | { readonly event: "pair.updated"; readonly data: PairUpdatedEventData };
