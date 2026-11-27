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

export interface AgentInfo {
  readonly name: string;
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly version?: string;
  readonly detail?: string;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly project_id: string;
  readonly agent: string;
  readonly thread_id?: string;
  readonly created_at: number;
  readonly updated_at: number;
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
}

export interface TaskStartParams {
  readonly project_id: string;
  readonly session_id: string | null;
  readonly agent: string;
  readonly prompt: string;
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
