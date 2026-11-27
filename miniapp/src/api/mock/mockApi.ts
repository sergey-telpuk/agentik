/**
 * In-memory implementation of `AgentikApi` driven by a scenario.
 *
 * It simulates what the computer would report: connection phases, projects,
 * tasks that keep running whether or not anyone is subscribed, approvals that
 * pause a task until that exact request is decided, and stop requests that are
 * confirmed later. Timers use the global `setTimeout`, so tests can drive them
 * with fake timers. Nothing sensitive is stored: pairing goes through the real
 * `PinnedDeviceStore`, which keeps public keys only.
 */

import type { UntrustedInvitation } from "../../pairing/invitation";
import { pinnedDeviceFromInvitation } from "../../pairing/pin";
import type { PinnedDevice, PinnedDeviceStore, StoreErrorCode } from "../../storage/pinnedDevices";
import type { TelegramRuntime } from "../../telegram/runtime";
import { canRequestCancel, isFinalState, transition, type TaskState } from "../taskState";
import {
  MAX_PROMPT_LENGTH,
  type Agent,
  type AgentikApi,
  type AgentId,
  type ApiError,
  type ApiErrorCode,
  type ApiResult,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalRequest,
  type Computer,
  type ComputerStatus,
  type ConnectionState,
  type Diagnostics,
  type FileChange,
  type Project,
  type StartTaskInput,
  type TaskEvent,
  type TaskResult,
  type TaskSummary,
  type TaskUpdate,
} from "../types";
import {
  DEMO_RELAY_URL,
  PAIRED_COMPUTER_PROJECTS,
  demoDeviceId,
  scenarioData,
  type ScenarioData,
  type ScenarioName,
  type SeedProject,
  type Step,
} from "./scenarios";

export interface MockApiOptions {
  readonly scenario: ScenarioName;
  readonly store: PinnedDeviceStore;
  readonly runtime: TelegramRuntime;
  /** Storage facts shown in diagnostics; probing may touch Telegram storage. */
  readonly describeStorage: () => Promise<Diagnostics["storage"]>;
  readonly appVersion: string;
  readonly now?: () => number;
}

export const APPROVAL_TTL_MS = 10 * 60_000;
export const CANCEL_CONFIRM_MS = 1500;

type Timer = ReturnType<typeof setTimeout>;
type Draft<E> = E extends TaskEvent ? Omit<E, "seq"> : never;
type DraftEvent = Draft<TaskEvent>;

function ok<T>(value: T): ApiResult<T> {
  return { ok: true, value };
}

function fail<T>(code: ApiErrorCode, message: string): ApiResult<T> {
  const error: ApiError = { code, message };
  return { ok: false, error };
}

class IdSource {
  #n = 0;
  next(prefix: string): string {
    this.#n += 1;
    return `${prefix}_${String(this.#n).padStart(4, "0")}`;
  }
}

interface PausedApproval {
  readonly request: ApprovalRequest;
  readonly onApprove: readonly Step[];
  readonly onDeny: readonly Step[];
}

class MockTask {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agent: AgentId;
  readonly prompt: string;
  readonly createdAt: number;
  state: TaskState = "accepted";
  updatedAt: number;
  readonly events: TaskEvent[] = [];
  readonly listeners = new Set<(update: TaskUpdate) => void>();

  #queue: Step[];
  #timer: Timer | null = null;
  #paused: PausedApproval | null = null;
  readonly #decided = new Set<string>();
  readonly #changes: FileChange[] = [];
  #output = "";
  #error: string | null = null;
  #recovery: string | null = null;
  #diff: string | null = null;
  #finishedAt: number | null = null;
  #draft: TaskEvent[] = [];
  readonly #now: () => number;
  readonly #ids: IdSource;

  constructor(
    init: { projectId: string; agent: AgentId; prompt: string; createdAt: number },
    steps: readonly Step[],
    now: () => number,
    ids: IdSource,
  ) {
    this.id = ids.next("task");
    this.sessionId = ids.next("ses");
    this.projectId = init.projectId;
    this.agent = init.agent;
    this.prompt = init.prompt;
    this.createdAt = init.createdAt;
    this.updatedAt = init.createdAt;
    this.#queue = [...steps];
    this.#now = now;
    this.#ids = ids;
    this.#push({ kind: "message", at: init.createdAt, role: "user", text: init.prompt });
    this.#push({ kind: "state", at: init.createdAt, state: "accepted", note: "Saved on the computer" });
    this.#flush();
  }

  get pendingApproval(): ApprovalRequest | null {
    return this.#paused?.request ?? null;
  }

  summary(): TaskSummary {
    return {
      id: this.id,
      projectId: this.projectId,
      sessionId: this.sessionId,
      agent: this.agent,
      prompt: this.prompt,
      state: this.state,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      pendingApproval: this.pendingApproval,
      lastSeq: this.events.length,
    };
  }

  result(): TaskResult {
    return {
      taskId: this.id,
      state: this.state,
      output: this.#output,
      changes: [...this.#changes],
      diff: this.#diff,
      diffTruncated: false,
      error: this.#error,
      recovery: this.#recovery,
      finishedAt: this.#finishedAt,
    };
  }

  /** Applies steps immediately with backdated timestamps, until done or paused. */
  runInstant(): void {
    let at = this.createdAt;
    while (this.#queue.length > 0 && this.#paused === null && !isFinalState(this.state)) {
      const step = this.#queue.shift() as Step;
      at += step.after;
      this.#apply(step, at);
    }
  }

  /** Schedules the next step on a real timer. */
  runLive(): void {
    if (this.#timer !== null || this.#paused !== null || isFinalState(this.state)) return;
    const step = this.#queue[0];
    if (step === undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#queue.shift();
      this.#apply(step, this.#now());
      this.runLive();
    }, step.after);
  }

  respond(approvalId: string, decision: ApprovalDecision): ApiResult<ApprovalOutcome> {
    const paused = this.#paused;
    if (paused === null || paused.request.id !== approvalId) {
      return this.#decided.has(approvalId)
        ? fail("already_resolved", "This request was already decided. A decision cannot be changed or repeated.")
        : fail("not_found", "This decision does not match the request the task is waiting for.");
    }
    const at = this.#now();
    if (at > paused.request.expiresAt) {
      return fail("expired", "This request expired. The agent has to ask again.");
    }
    this.#decided.add(approvalId);
    this.#paused = null;
    const outcome: ApprovalOutcome = { approvalId, decision };
    this.#push({ kind: "approval_resolved", at, outcome });
    this.#setState("running", decision === "approve" ? "Approved from the phone" : "Denied from the phone", at);
    this.#flush();
    this.#queue = [...(decision === "approve" ? paused.onApprove : paused.onDeny), ...this.#queue];
    this.runLive();
    return ok(outcome);
  }

  cancel(): ApiResult<TaskSummary> {
    if (!canRequestCancel(this.state)) {
      return fail("invalid", "This task cannot be stopped in its current state.");
    }
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue = [];
    const withdrawn = this.#paused !== null;
    this.#paused = null;
    const at = this.#now();
    this.#setState(
      "cancel_requested",
      withdrawn ? "Stop requested from the phone; the pending approval was withdrawn" : "Stop requested from the phone",
      at,
    );
    this.#flush();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const done = this.#now();
      this.#output = "The task was stopped before it finished. Changes made before the stop are kept.";
      this.#finishedAt = done;
      this.#setState("cancelled", "The computer confirmed the stop", done);
      this.#flush();
    }, CANCEL_CONFIRM_MS);
    return ok(this.summary());
  }

  #apply(step: Step, at: number): void {
    switch (step.kind) {
      case "state":
        this.#setState(step.state, step.note ?? null, at);
        if (isFinalState(step.state)) this.#finishedAt = at;
        break;
      case "message":
        this.#push({ kind: "message", at, role: "agent", text: step.text });
        break;
      case "command":
        this.#push({ kind: "command", at, command: step.command, exitCode: step.exitCode, output: step.output });
        break;
      case "file_change":
        this.#changes.push({ path: step.path, additions: step.additions, deletions: step.deletions });
        this.#push({ kind: "file_change", at, path: step.path, additions: step.additions, deletions: step.deletions });
        break;
      case "error":
        this.#push({ kind: "error", at, text: step.text });
        break;
      case "approval": {
        const request: ApprovalRequest = {
          ...step.request,
          id: this.#ids.next("apr"),
          taskId: this.id,
          sessionId: this.sessionId,
          requestedAt: at,
          expiresAt: at + APPROVAL_TTL_MS,
        };
        this.#paused = { request, onApprove: step.onApprove, onDeny: step.onDeny };
        this.#push({ kind: "approval_requested", at, approval: request });
        this.#setState("awaiting_approval", null, at);
        break;
      }
      case "finish":
        this.#output = step.output;
        this.#error = step.error ?? null;
        this.#recovery = step.recovery ?? null;
        this.#diff = step.diff ?? null;
        this.#finishedAt = at;
        if (step.output !== "" && step.state === "succeeded") {
          this.#push({ kind: "message", at, role: "agent", text: step.output });
        }
        this.#setState(step.state, step.state === "recovery_required" ? "Outcome unknown, not retried" : null, at);
        break;
    }
    this.#flush();
  }

  #setState(to: TaskState, note: string | null, at: number): void {
    const result = transition(this.state, to);
    if (!result.ok) throw new Error(`mock script moves ${this.id} from ${result.from} to ${result.to}`);
    this.state = to;
    this.updatedAt = at;
    this.#push({ kind: "state", at, state: to, note });
  }

  #push(draft: DraftEvent): void {
    const event = { ...draft, seq: this.events.length + this.#draft.length + 1 } as TaskEvent;
    this.#draft.push(event);
  }

  #flush(): void {
    if (this.#draft.length === 0) return;
    const batch = this.#draft;
    this.#draft = [];
    this.events.push(...batch);
    const update: TaskUpdate = { task: this.summary(), events: batch };
    for (const listener of this.listeners) listener(update);
  }
}

interface ComputerRecord {
  readonly id: string;
  name: string;
  status: ComputerStatus;
  lastSeenAt: number | null;
  readonly relayUrl: string;
  readonly pairedAt: number;
  readonly projects: readonly SeedProject[];
  readonly tasks: Map<string, MockTask>;
  readonly source: "demo" | "pinned";
  connectAttempts: number;
}

interface Session {
  revoked: boolean;
}

function storeErrorCode(code: StoreErrorCode): ApiErrorCode {
  switch (code) {
    case "persistence_unsupported":
    case "pin_mismatch":
    case "storage_failed":
      return code;
    case "not_found":
      return "not_found";
    default:
      return "invalid";
  }
}

export function createMockApi(options: MockApiOptions): AgentikApi {
  const now = options.now ?? (() => Date.now());
  const data: ScenarioData = scenarioData(options.scenario);
  const ids = new IdSource();
  const demo = new Map<string, ComputerRecord>();
  const pinned = new Map<string, ComputerRecord>();
  const sessions = new Map<string, Session>();
  const requests = new Map<string, { key: string; task: MockTask }>();

  const start = now();
  for (const seed of data.computers) {
    const record: ComputerRecord = {
      id: demoDeviceId(seed.seed),
      name: seed.name,
      status: seed.status,
      lastSeenAt: seed.lastSeenAgoMs === null ? null : start - seed.lastSeenAgoMs,
      relayUrl: DEMO_RELAY_URL,
      pairedAt: start - seed.pairedAgoMs,
      projects: seed.projects,
      tasks: new Map(),
      source: "demo",
      connectAttempts: 0,
    };
    for (const seedTask of [...seed.tasks].sort((a, b) => b.ageMs - a.ageMs)) {
      const task = new MockTask(
        { projectId: seedTask.projectId, agent: "codex", prompt: seedTask.prompt, createdAt: start - seedTask.ageMs },
        seedTask.steps,
        now,
        ids,
      );
      task.runInstant();
      record.tasks.set(task.id, task);
    }
    demo.set(record.id, record);
  }

  function fromPin(device: PinnedDevice): ComputerRecord {
    let record = pinned.get(device.deviceId);
    if (record === undefined) {
      record = {
        id: device.deviceId,
        name: `Computer ${device.deviceId.slice(0, 4).toUpperCase()}`,
        status: "pending_confirmation",
        lastSeenAt: null,
        relayUrl: device.relayUrl,
        pairedAt: device.pinnedAt * 1000,
        projects: PAIRED_COMPUTER_PROJECTS,
        tasks: new Map(),
        source: "pinned",
        connectAttempts: 0,
      };
      pinned.set(device.deviceId, record);
    }
    if (record.status === "pending_confirmation" || record.status === "online") {
      record.status = device.state === "confirmed" ? "online" : "pending_confirmation";
    }
    return record;
  }

  async function pinnedRecords(): Promise<ApiResult<ComputerRecord[]>> {
    const listed = await options.store.list();
    if (!listed.ok) return fail(storeErrorCode(listed.code), listed.message);
    return ok(listed.value.map(fromPin));
  }

  async function findComputer(id: string): Promise<ComputerRecord | null> {
    const found = demo.get(id);
    if (found !== undefined) return found;
    const listed = await pinnedRecords();
    return listed.ok ? (listed.value.find((r) => r.id === id) ?? null) : null;
  }

  function toComputer(r: ComputerRecord): Computer {
    return { id: r.id, name: r.name, status: r.status, lastSeenAt: r.lastSeenAt, relayUrl: r.relayUrl, pairedAt: r.pairedAt };
  }

  async function session(computerId: string): Promise<ApiResult<ComputerRecord>> {
    const s = sessions.get(computerId);
    if (s === undefined) return fail("not_connected", "There is no secure session with this computer.");
    if (s.revoked) return fail("revoked", "This computer ended access for this phone.");
    const record = await findComputer(computerId);
    return record === null ? fail("not_found", "This computer is no longer paired.") : ok(record);
  }

  async function taskOf(computerId: string, taskId: string): Promise<ApiResult<MockTask>> {
    const record = await session(computerId);
    if (!record.ok) return record;
    const task = record.value.tasks.get(taskId);
    return task === undefined ? fail("not_found", "No such task on this computer.") : ok(task);
  }

  function agents(): Agent[] {
    return [
      {
        id: "codex",
        name: "Codex",
        status: data.agentStatus,
        version: data.agentStatus === "available" ? "0.98.0" : null,
      },
    ];
  }

  return {
    backend: "mock",

    async listComputers() {
      const fromStore = await pinnedRecords();
      if (!fromStore.ok) return fromStore;
      return ok([...demo.values(), ...fromStore.value].map(toComputer));
    },

    async pairComputer(invitation: UntrustedInvitation) {
      const pinnedResult = await options.store.pin(pinnedDeviceFromInvitation(invitation, Math.floor(now() / 1000)));
      if (!pinnedResult.ok) return fail(storeErrorCode(pinnedResult.code), pinnedResult.message);
      return ok(toComputer(fromPin(pinnedResult.value)));
    },

    async forgetComputer(computerId) {
      sessions.delete(computerId);
      if (demo.delete(computerId)) return ok(null);
      pinned.delete(computerId);
      const removed = await options.store.remove(computerId);
      return removed.ok ? ok(null) : fail(storeErrorCode(removed.code), removed.message);
    },

    connect(computerId, onState) {
      let closed = false;
      const timers: Timer[] = [];
      const emit = (state: ConnectionState): void => {
        if (!closed) onState(state);
      };
      const at = (ms: number, action: () => void): void => {
        timers.push(
          setTimeout(() => {
            if (!closed) action();
          }, ms),
        );
      };
      sessions.delete(computerId);
      emit({ phase: "connecting" });

      void findComputer(computerId).then((record) => {
        if (closed) return;
        if (record === null) {
          emit({
            phase: "failed",
            reason: "handshake_failed",
            message: "This computer is not paired on this phone.",
            retryable: false,
          });
          return;
        }
        const ready = (): void => {
          const s: Session = { revoked: false };
          sessions.set(computerId, s);
          record.lastSeenAt = now();
          emit({ phase: "ready", computerName: record.name });
          const revokeAfter = data.connect.revokeAfterReadyMs;
          if (revokeAfter !== null && record.source === "demo") {
            at(revokeAfter, () => {
              s.revoked = true;
              record.status = "revoked";
              emit({
                phase: "revoked",
                message: "The secure session was closed and new requests are rejected.",
              });
            });
          }
        };

        switch (record.status) {
          case "revoked":
            at(600, () => emit({ phase: "handshaking" }));
            at(1400, () =>
              emit({
                phase: "revoked",
                message: "The computer rejected this phone when it tried to connect.",
              }),
            );
            return;
          case "replaced":
            at(600, () => emit({ phase: "handshaking" }));
            at(1400, () =>
              emit({
                phase: "failed",
                reason: "key_mismatch",
                message:
                  "The computer presented a different key from the one pinned on this phone. It may have been reinstalled, or something is impersonating it. Pair it again on the computer to continue.",
                retryable: false,
              }),
            );
            return;
          case "offline":
            at(1200, () =>
              emit({
                phase: "failed",
                reason: "computer_offline",
                message: `The relay is reachable, but ${record.name} is not connected. It may be asleep or offline. Tasks already running there keep running.`,
                retryable: true,
              }),
            );
            return;
          case "pending_confirmation":
            at(600, () => emit({ phase: "handshaking" }));
            at(1300, () => emit({ phase: "awaiting_local_approval" }));
            at(4300, () => {
              record.status = "online";
              if (record.source === "pinned") void options.store.markConfirmed(record.id);
              emit({ phase: "synchronizing" });
            });
            at(4900, ready);
            return;
          case "online":
            at(600, () => {
              // Counted only once an attempt reaches the handshake, so an
              // attempt abandoned right away does not use up a failure.
              record.connectAttempts += 1;
              emit({ phase: "handshaking" });
              if (record.connectAttempts <= data.connect.failFirstAttempts) {
                at(1000, () =>
                  emit({
                    phase: "failed",
                    reason: "handshake_failed",
                    message: "The secure handshake did not complete in time. Nothing was sent to the computer.",
                    retryable: true,
                  }),
                );
                return;
              }
              at(700, () => emit({ phase: "synchronizing" }));
              at(1300, ready);
            });
            return;
        }
      });

      return () => {
        closed = true;
        for (const timer of timers) clearTimeout(timer);
      };
    },

    async listProjects(computerId) {
      const record = await session(computerId);
      if (!record.ok) return record;
      const projects: Project[] = record.value.projects.map((p) => ({
        id: p.id,
        name: p.name,
        activeTasks: [...record.value.tasks.values()].filter((t) => t.projectId === p.id && !isFinalState(t.state))
          .length,
      }));
      return ok(projects);
    },

    async listAgents(computerId) {
      const record = await session(computerId);
      return record.ok ? ok(agents()) : record;
    },

    async listTasks(computerId, projectId) {
      const record = await session(computerId);
      if (!record.ok) return record;
      const tasks = [...record.value.tasks.values()]
        .filter((t) => t.projectId === projectId)
        .map((t) => t.summary())
        .sort((a, b) => b.createdAt - a.createdAt);
      return ok(tasks);
    },

    async getTask(computerId, taskId) {
      const task = await taskOf(computerId, taskId);
      return task.ok ? ok(task.value.summary()) : task;
    },

    async startTask(computerId, input: StartTaskInput) {
      const record = await session(computerId);
      if (!record.ok) return record;
      const project = record.value.projects.find((p) => p.id === input.projectId);
      if (project === undefined) return fail("not_found", "This project is not available to this phone.");
      const prompt = input.prompt.trim();
      if (prompt === "") return fail("invalid", "Describe the task first.");
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return fail("invalid", `The task description is longer than ${MAX_PROMPT_LENGTH} characters.`);
      }
      const key = JSON.stringify([computerId, input.projectId, input.agent, prompt]);
      const previous = requests.get(input.requestId);
      if (previous !== undefined) {
        return previous.key === key
          ? ok(previous.task.summary())
          : fail("conflict", "This request id was already used for a different task.");
      }
      if (agents().find((a) => a.id === input.agent)?.status !== "available") {
        return fail(
          "agent_unavailable",
          "Codex is not installed on this computer. Install it and sign in on the computer, then try again.",
        );
      }
      const active = [...record.value.tasks.values()].some(
        (t) => t.projectId === input.projectId && !isFinalState(t.state),
      );
      if (active) {
        return fail("busy", "Another task is still active in this project. Only one active task per project is allowed.");
      }
      const task = new MockTask(
        { projectId: input.projectId, agent: input.agent, prompt, createdAt: now() },
        data.newTaskSteps(project.name, input.agent),
        now,
        ids,
      );
      record.value.tasks.set(task.id, task);
      requests.set(input.requestId, { key, task });
      task.runLive();
      return ok(task.summary());
    },

    streamEvents(computerId, taskId, afterSeq, onUpdate) {
      let closed = false;
      let target: MockTask | null = null;
      const listener = (update: TaskUpdate): void => {
        if (!closed) onUpdate(update);
      };
      void taskOf(computerId, taskId).then((found) => {
        if (closed || !found.ok) return;
        target = found.value;
        target.listeners.add(listener);
        onUpdate({ task: target.summary(), events: target.events.filter((e) => e.seq > afterSeq) });
      });
      return () => {
        closed = true;
        target?.listeners.delete(listener);
      };
    },

    async cancelTask(computerId, taskId) {
      const task = await taskOf(computerId, taskId);
      return task.ok ? task.value.cancel() : task;
    },

    async respondApproval(computerId, input) {
      const task = await taskOf(computerId, input.taskId);
      return task.ok ? task.value.respond(input.approvalId, input.decision) : task;
    },

    async getResult(computerId, taskId) {
      const task = await taskOf(computerId, taskId);
      if (!task.ok) return task;
      if (!isFinalState(task.value.state)) return fail("not_finished", "The task has not finished yet.");
      return ok(task.value.result());
    },

    async getDiagnostics() {
      const fromStore = await pinnedRecords();
      const relays = new Set<string>([...demo.values()].map((r) => r.relayUrl));
      if (fromStore.ok) for (const r of fromStore.value) relays.add(r.relayUrl);
      const initData = options.runtime.rawInitData();
      return {
        appVersion: options.appVersion,
        backend: "mock",
        scenario: options.scenario,
        telegram: {
          isMiniApp: options.runtime.isMiniApp,
          platformVersion: options.runtime.platformVersion,
          initDataAvailable: initData !== null && initData !== "",
        },
        storage: await options.describeStorage(),
        relayUrls: [...relays],
      };
    },

    async clearLocalData() {
      sessions.clear();
      demo.clear();
      pinned.clear();
      const listed = await options.store.list();
      if (!listed.ok) return fail(storeErrorCode(listed.code), listed.message);
      for (const device of listed.value) {
        const removed = await options.store.remove(device.deviceId);
        if (!removed.ok) return fail(storeErrorCode(removed.code), removed.message);
      }
      return ok({ phoneKeyRegenerated: false });
    },
  };
}
