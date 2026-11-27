/**
 * Typed JSON command/event RPC client bound strictly to a `SecureSession`.
 */

import type { SecureSession } from "../secure/seam";
import {
  PROTOCOL_VERSION,
  type AgentListResult,
  type ApprovalDecision,
  type ApprovalResolveResult,
  type ChangesResult,
  type DeviceInfoResult,
  type EventsResumeResult,
  type PairSubmitParams,
  type PairSubmitResult,
  type ProjectListResult,
  type ServerEvent,
  type SessionListResult,
  type SessionOpenParams,
  type SessionDeleteResult,
  type SessionOpenResult,
  type TaskResult,
  type TaskStartParams,
} from "./messages";

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`Request "${method}" timed out`);
    this.name = "RpcTimeoutError";
  }
}

export class RpcClientClosedError extends Error {
  constructor() {
    super("The RPC client is closed");
    this.name = "RpcClientClosedError";
  }
}

interface PendingCall {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export class AgentikRpcClient {
  readonly #session: SecureSession;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingCall>();
  readonly #eventHandlers = new Set<(event: ServerEvent) => void>();
  readonly #offMessage: () => void;
  #closed = false;

  constructor(session: SecureSession, options: { readonly timeoutMs?: number } = {}) {
    this.#session = session;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.#offMessage = this.#session.onMessage((plaintext) => {
      this.#handleInbound(plaintext);
    });
  }

  onEvent(handler: (event: ServerEvent) => void): () => void {
    this.#eventHandlers.add(handler);
    return () => this.#eventHandlers.delete(handler);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#offMessage();
    for (const call of this.#pending.values()) {
      clearTimeout(call.timer);
      call.reject(new RpcClientClosedError());
    }
    this.#pending.clear();
    this.#eventHandlers.clear();
  }

  request<T>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: { readonly requestId?: string; readonly timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new RpcClientClosedError());
    const requestId = options.requestId ?? crypto.randomUUID();
    if (this.#pending.has(requestId)) {
      return Promise.reject(new RpcError("duplicate_in_flight", "request_id already in flight"));
    }

    const payload = JSON.stringify({
      v: PROTOCOL_VERSION,
      request_id: requestId,
      method,
      params,
    });

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
      const timer = setTimeout(() => {
        if (!this.#pending.delete(requestId)) return;
        reject(new RpcTimeoutError(method));
      }, timeoutMs);

      this.#pending.set(requestId, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.#session.send(textEncoder.encode(payload));
      } catch (err) {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  submitPairing(params: PairSubmitParams): Promise<PairSubmitResult> {
    const cleanParams: Record<string, unknown> = {
      invitation_id: params.invitation_id,
      invitation_secret: params.invitation_secret,
    };
    if (params.label !== undefined) cleanParams["label"] = params.label;
    if (params.init_data !== undefined) cleanParams["init_data"] = params.init_data;
    return this.request("pair.submit", cleanParams);
  }

  deviceInfo(): Promise<DeviceInfoResult> {
    return this.request("device.info", {});
  }

  listProjects(): Promise<ProjectListResult> {
    return this.request("project.list", {});
  }

  listAgents(): Promise<AgentListResult> {
    return this.request("agent.list", {});
  }

  listSessions(projectId?: string, options: { readonly timeoutMs?: number } = {}): Promise<SessionListResult> {
    return this.request("session.list", projectId === undefined ? {} : { project_id: projectId }, options);
  }

  /** Deletes one conversation on the computer. The removal is permanent. */
  deleteSession(projectId: string, sessionId: string): Promise<SessionDeleteResult> {
    return this.request("session.delete", { project_id: projectId, session_id: sessionId });
  }

  openSession(params: SessionOpenParams): Promise<SessionOpenResult> {
    const clean: Record<string, unknown> = { project_id: params.project_id };
    if (params.session_id !== undefined) clean["session_id"] = params.session_id;
    if (params.agent !== undefined) clean["agent"] = params.agent;
    return this.request("session.open", clean);
  }

  startTask(params: TaskStartParams, requestId?: string): Promise<TaskResult> {
    const body: Record<string, unknown> = {
      project_id: params.project_id,
      session_id: params.session_id,
      agent: params.agent,
      prompt: params.prompt,
    };
    if (params.model !== undefined && params.model !== "") {
      body["agent_id"] = params.agent_id ?? params.agent;
      body["model"] = params.model;
    }
    return this.request("task.start", body, requestId === undefined ? {} : { requestId });
  }

  getTask(taskId: string): Promise<TaskResult> {
    return this.request("task.get", { task_id: taskId });
  }

  cancelTask(taskId: string): Promise<TaskResult> {
    return this.request("task.cancel", { task_id: taskId });
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<ApprovalResolveResult> {
    return this.request("approval.resolve", { approval_id: approvalId, decision });
  }

  resumeEvents(sessionId: string, afterSeq: number): Promise<EventsResumeResult> {
    return this.request("events.resume", { session_id: sessionId, after_seq: afterSeq });
  }

  getChanges(taskId: string): Promise<ChangesResult> {
    return this.request("changes.get", { task_id: taskId });
  }

  #handleInbound(plaintext: Uint8Array): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(textDecoder.decode(plaintext));
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>;
    if (msg["v"] !== PROTOCOL_VERSION) return;

    if (msg["type"] === "event") {
      const eventName = msg["event"];
      const data = msg["data"];
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      if (eventName === "session.event" || eventName === "pair.updated") {
        const event = { event: eventName, data } as unknown as ServerEvent;
        for (const handler of this.#eventHandlers) handler(event);
      }
      return;
    }

    const requestId = msg["request_id"];
    if (typeof requestId !== "string" || requestId.length === 0) return;
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);

    if (msg["ok"] === true) {
      pending.resolve(msg["result"]);
      return;
    }

    const errObj = msg["error"];
    if (typeof errObj === "object" && errObj !== null && !Array.isArray(errObj)) {
      const rec = errObj as Record<string, unknown>;
      const code = typeof rec["code"] === "string" ? rec["code"] : "unknown_error";
      const message = typeof rec["message"] === "string" ? rec["message"] : "request failed";
      pending.reject(new RpcError(code, message));
      return;
    }
    pending.reject(new RpcError("invalid_response", "malformed error response"));
  }
}
