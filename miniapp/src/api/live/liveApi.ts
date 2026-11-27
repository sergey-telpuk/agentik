/**
 * `AgentikApi` over the real stack: Telegram-backed pins, the relay client,
 * the Noise XX session and the inner JSON protocol (AGENTIK.md sections 5-7).
 *
 * Calls that reach the computer need the synchronised session of an open
 * `connect`; without one they fail with `not_connected` instead of queueing.
 * Pairing credentials stay in memory until the computer has seen them.
 *
 * Known gaps, each surfaced to the UI rather than faked:
 * - The computer has no `task.list`, so `listTasks` returns the tasks this
 *   phone started or opened since the app was opened (refreshed live).
 * - The computer reports no display name, so computers are named from their id.
 * - Revoked/replaced/offline outcomes are remembered in memory only; pins
 *   persist just `unconfirmed`/`confirmed`.
 */

import { encodeBase64Url } from "../../encoding";
import type { UntrustedInvitation } from "../../pairing/invitation";
import { pinnedDeviceFromInvitation } from "../../pairing/pin";
import type { AgentikRpcClient } from "../../protocol/client";
import type { SessionEventView, TaskView } from "../../protocol/messages";
import type { RelayClient } from "../../relay/client";
import type { SecureChannelFactory } from "../../secure/seam";
import type { PhoneIdentityStore } from "../../storage/phoneIdentity";
import type { PinnedDevice, PinnedDeviceStore, StoreErrorCode } from "../../storage/pinnedDevices";
import type { TelegramRuntime } from "../../telegram/runtime";
import { isFinalState } from "../taskState";
import {
  MAX_PROMPT_LENGTH,
  type AgentikApi,
  type ApiErrorCode,
  type ApiResult,
  type Computer,
  type ComputerStatus,
  type Diagnostics,
  type TaskEvent,
  type TaskSummary,
  type TaskUpdate,
} from "../types";
import { ConnectAttempt, type ComputerOutcome, type PendingPairing } from "./connection";
import {
  agentsFromInfo,
  apiErrorFrom,
  changesTaskState,
  taskResultFromView,
  taskSummaryFromView,
  timelineEventFromSession,
  wireDecision,
} from "./mapping";

export interface LiveApiOptions {
  readonly store: PinnedDeviceStore;
  readonly runtime: TelegramRuntime;
  readonly openIdentityStore: () => Promise<PhoneIdentityStore>;
  readonly createRelayClient: (device: PinnedDevice) => RelayClient;
  readonly secureChannel: SecureChannelFactory;
  /** Storage facts shown in diagnostics; probing may touch Telegram storage. */
  readonly describeStorage: () => Promise<Diagnostics["storage"]>;
  readonly appVersion: string;
  readonly now?: () => number;
  readonly rpcTimeoutMs?: number;
  /** How long the computer may be absent behind an attached relay before `connect` fails. */
  readonly offlineGraceMs?: number;
  /** Failed relay attempts in a row after which `connect` fails. */
  readonly maxRelayAttempts?: number;
}

export const DEFAULT_OFFLINE_GRACE_MS = 8000;
export const DEFAULT_MAX_RELAY_ATTEMPTS = 4;
const MAX_RESUME_PAGES = 20;

interface KnownTask {
  readonly computerId: string;
  view: TaskView;
}

function ok<T>(value: T): ApiResult<T> {
  return { ok: true, value };
}

function fail<T>(code: ApiErrorCode, message: string): ApiResult<T> {
  return { ok: false, error: { code, message } };
}

function storeErrorCode(code: StoreErrorCode): ApiErrorCode {
  switch (code) {
    case "persistence_unsupported":
    case "pin_mismatch":
    case "storage_failed":
    case "not_found":
      return code;
    default:
      return "invalid";
  }
}

function nameFor(computerId: string): string {
  return `Computer ${computerId.slice(0, 4).toUpperCase()}`;
}

const OUTCOME_STATUS: Readonly<Record<ComputerOutcome, ComputerStatus>> = {
  online: "online",
  offline: "offline",
  replaced: "replaced",
  revoked: "revoked",
};

export function createLiveApi(options: LiveApiOptions): AgentikApi {
  const now = options.now ?? (() => Date.now());
  const pending = new Map<string, PendingPairing>();
  const outcomes = new Map<string, { status: ComputerStatus; lastSeenAt: number | null }>();
  const attempts = new Map<string, ConnectAttempt>();
  const readyListeners = new Map<string, Set<(rpc: AgentikRpcClient) => void>>();
  const tasks = new Map<string, KnownTask>();
  const lastSeq = new Map<string, number>();
  const requests = new Map<string, string>();

  async function findPin(computerId: string): Promise<PinnedDevice | null> {
    const listed = await options.store.list();
    return listed.ok ? (listed.value.find((d) => d.deviceId === computerId) ?? null) : null;
  }

  function toComputer(device: PinnedDevice): Computer {
    const known = outcomes.get(device.deviceId);
    const status: ComputerStatus =
      known?.status ?? (device.state === "confirmed" ? "online" : "pending_confirmation");
    return {
      id: device.deviceId,
      name: nameFor(device.deviceId),
      status,
      lastSeenAt: known?.lastSeenAt ?? null,
      relayUrl: device.relayUrl,
      pairedAt: device.pinnedAt * 1000,
    };
  }

  function remember(computerId: string, view: TaskView): TaskSummary {
    const known = tasks.get(view.task_id);
    if (known === undefined) tasks.set(view.task_id, { computerId, view });
    else known.view = view;
    return taskSummaryFromView(view, lastSeq.get(view.task_id) ?? 0);
  }

  function forgetTasksOf(computerId: string): void {
    for (const [id, known] of tasks) {
      if (known.computerId !== computerId) continue;
      tasks.delete(id);
      lastSeq.delete(id);
    }
  }

  function session(computerId: string): ApiResult<AgentikRpcClient> {
    const attempt = attempts.get(computerId);
    if (attempt === undefined) return fail("not_connected", "There is no secure session with this computer.");
    if (attempt.revoked) return fail("revoked", "This computer ended access for this phone.");
    if (attempt.rpc === null) return fail("not_connected", "The secure session with this computer is not ready.");
    return ok(attempt.rpc);
  }

  async function call<T>(computerId: string, work: (rpc: AgentikRpcClient) => Promise<T>): Promise<ApiResult<T>> {
    const rpc = session(computerId);
    if (!rpc.ok) return rpc;
    try {
      return ok(await work(rpc.value));
    } catch (err) {
      const error = apiErrorFrom(err);
      return { ok: false, error };
    }
  }

  function onReady(computerId: string, rpc: AgentikRpcClient): void {
    for (const listener of readyListeners.get(computerId) ?? []) listener(rpc);
  }

  function addReadyListener(computerId: string, listener: (rpc: AgentikRpcClient) => void): () => void {
    let set = readyListeners.get(computerId);
    if (set === undefined) {
      set = new Set();
      readyListeners.set(computerId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) readyListeners.delete(computerId);
    };
  }

  return {
    backend: "live",

    async listComputers() {
      const listed = await options.store.list();
      if (!listed.ok) return fail(storeErrorCode(listed.code), listed.message);
      return ok(listed.value.map(toComputer));
    },

    async pairComputer(invitation: UntrustedInvitation) {
      const pinned = await options.store.pin(pinnedDeviceFromInvitation(invitation, Math.floor(now() / 1000)));
      if (!pinned.ok) return fail(storeErrorCode(pinned.code), pinned.message);
      pending.set(invitation.deviceIdText, {
        invitationId: encodeBase64Url(invitation.invitationId),
        invitationSecret: encodeBase64Url(invitation.invitationSecret),
        expiresAt: invitation.expiresAt,
      });
      outcomes.delete(invitation.deviceIdText);
      return ok(toComputer(pinned.value));
    },

    async forgetComputer(computerId) {
      attempts.get(computerId)?.close();
      attempts.delete(computerId);
      pending.delete(computerId);
      outcomes.delete(computerId);
      forgetTasksOf(computerId);
      const removed = await options.store.remove(computerId);
      return removed.ok || removed.code === "not_found" ? ok(null) : fail(storeErrorCode(removed.code), removed.message);
    },

    connect(computerId, onState) {
      attempts.get(computerId)?.close();
      const attempt = new ConnectAttempt(
        computerId,
        {
          runtime: options.runtime,
          secureChannel: options.secureChannel,
          createRelayClient: options.createRelayClient,
          loadIdentity: async () => {
            const store = await options.openIdentityStore();
            const loaded = await store.getOrCreate();
            return loaded.ok ? { ok: true, value: loaded.value } : { ok: false, message: loaded.message };
          },
          findPin,
          markConfirmed: async (id) => {
            const device = await findPin(id);
            if (device !== null && device.state !== "confirmed") await options.store.markConfirmed(id);
          },
          peekPendingPairing: (id) => pending.get(id) ?? null,
          dropPendingPairing: (id) => pending.delete(id),
          computerName: nameFor,
          recordOutcome: (id, outcome) => {
            const previous = outcomes.get(id)?.lastSeenAt ?? null;
            outcomes.set(id, { status: OUTCOME_STATUS[outcome], lastSeenAt: outcome === "online" ? now() : previous });
          },
          onReady,
          now,
          rpcTimeoutMs: options.rpcTimeoutMs ?? 30_000,
          offlineGraceMs: options.offlineGraceMs ?? DEFAULT_OFFLINE_GRACE_MS,
          maxRelayAttempts: options.maxRelayAttempts ?? DEFAULT_MAX_RELAY_ATTEMPTS,
        },
        onState,
      );
      attempts.set(computerId, attempt);
      attempt.start();
      return () => {
        attempt.close();
        if (attempts.get(computerId) === attempt) attempts.delete(computerId);
      };
    },

    async listProjects(computerId) {
      return call(computerId, async (rpc) => {
        const { projects } = await rpc.listProjects();
        return projects.map((p) => ({
          id: p.project_id,
          name: p.name,
          activeTasks: [...tasks.values()].filter(
            (t) => t.computerId === computerId && t.view.project_id === p.project_id && !isFinalState(taskSummaryFromView(t.view, 0).state),
          ).length,
        }));
      });
    },

    async listAgents(computerId) {
      return call(computerId, async (rpc) => agentsFromInfo((await rpc.listAgents()).agents));
    },

    async listTasks(computerId, projectId) {
      return call(computerId, async (rpc) => {
        const mine = [...tasks.values()].filter((t) => t.computerId === computerId && t.view.project_id === projectId);
        await Promise.all(
          mine
            .filter((t) => !isFinalState(taskSummaryFromView(t.view, 0).state))
            .map(async (t) => {
              try {
                remember(computerId, (await rpc.getTask(t.view.task_id)).task);
              } catch {
                // Keep the last known state; the task screen reports errors.
              }
            }),
        );
        return mine
          .map((t) => taskSummaryFromView(t.view, lastSeq.get(t.view.task_id) ?? 0))
          .sort((a, b) => b.createdAt - a.createdAt);
      });
    },

    async getTask(computerId, taskId) {
      return call(computerId, async (rpc) => remember(computerId, (await rpc.getTask(taskId)).task));
    },

    async startTask(computerId, input) {
      const prompt = input.prompt.trim();
      if (prompt === "") return fail("invalid", "Describe the task first.");
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return fail("invalid", `The task description is longer than ${MAX_PROMPT_LENGTH} characters.`);
      }
      const content = JSON.stringify([computerId, input.projectId, input.agent, prompt]);
      const previous = requests.get(input.requestId);
      if (previous !== undefined && previous !== content) {
        return fail("conflict", "This request id was already used for a different task.");
      }
      requests.set(input.requestId, content);
      // The same request id goes to the computer on every retry, so a lost
      // answer never starts a second task (AGENTIK.md section 7.2).
      return call(computerId, async (rpc) => {
        const result = await rpc.startTask(
          { project_id: input.projectId, session_id: null, agent: input.agent, prompt },
          input.requestId,
        );
        return remember(computerId, result.task);
      });
    },

    streamEvents(computerId, taskId, afterSeq, onUpdate: (update: TaskUpdate) => void) {
      let closed = false;
      let delivered = afterSeq;
      let chain: Promise<void> = Promise.resolve();
      let offEvent: (() => void) | null = null;

      // Deliveries are serialised so a later batch can never overtake an earlier one.
      const enqueue = (work: () => Promise<void>): void => {
        chain = chain.then(() => (closed ? undefined : work())).catch(() => undefined);
      };

      const emit = (view: TaskView, incoming: readonly SessionEventView[]): void => {
        const fresh = incoming.filter((e) => e.task_id === taskId && e.seq > delivered).sort((a, b) => a.seq - b.seq);
        const last = fresh.at(-1);
        if (last !== undefined) delivered = last.seq;
        lastSeq.set(taskId, Math.max(lastSeq.get(taskId) ?? 0, delivered));
        const task = remember(computerId, view);
        const events = fresh
          .map((e) => timelineEventFromSession(e, view.project_id))
          .filter((e): e is TaskEvent => e !== null);
        if (!closed) onUpdate({ task, events });
      };

      const attach = (rpc: AgentikRpcClient): void => {
        offEvent?.();
        offEvent = rpc.onEvent((ev) => {
          if (ev.event !== "session.event" || ev.data.task_id !== taskId) return;
          const data = ev.data;
          enqueue(async () => {
            if (data.seq <= delivered) return;
            const cached = tasks.get(taskId)?.view;
            const view = changesTaskState(data) || cached === undefined ? (await rpc.getTask(taskId)).task : cached;
            emit(view, [data]);
          });
        });
        enqueue(async () => {
          const sessionId = tasks.get(taskId)?.view.session_id ?? (await rpc.getTask(taskId)).task.session_id;
          const batch: SessionEventView[] = [];
          let after = delivered;
          for (let page = 0; page < MAX_RESUME_PAGES; page++) {
            const resumed = await rpc.resumeEvents(sessionId, after);
            batch.push(...resumed.events);
            const next = resumed.events.at(-1)?.seq ?? after;
            if (resumed.truncated !== true || next <= after) break;
            after = next;
          }
          emit((await rpc.getTask(taskId)).task, batch);
        });
      };

      const offReady = addReadyListener(computerId, attach);
      const current = session(computerId);
      if (current.ok) attach(current.value);
      return () => {
        closed = true;
        offEvent?.();
        offReady();
      };
    },

    async cancelTask(computerId, taskId) {
      return call(computerId, async (rpc) => remember(computerId, (await rpc.cancelTask(taskId)).task));
    },

    async respondApproval(computerId, input) {
      return call(computerId, async (rpc) => {
        const result = await rpc.resolveApproval(input.approvalId, wireDecision(input.decision));
        return {
          approvalId: result.approval_id,
          decision: result.status === "accepted" ? ("approve" as const) : ("deny" as const),
        };
      });
    },

    async getResult(computerId, taskId) {
      const rpc = session(computerId);
      if (!rpc.ok) return rpc;
      try {
        const view = (await rpc.value.getTask(taskId)).task;
        remember(computerId, view);
        if (!isFinalState(taskSummaryFromView(view, 0).state)) {
          return fail("not_finished", "The task has not finished yet.");
        }
        let changes = null;
        try {
          changes = await rpc.value.getChanges(taskId);
        } catch {
          // The result is still useful without the diff; the screen shows "no changes".
        }
        return ok(taskResultFromView(view, changes));
      } catch (err) {
        return { ok: false, error: apiErrorFrom(err) };
      }
    },

    async getDiagnostics() {
      const listed = await options.store.list();
      const relays = new Set<string>(listed.ok ? listed.value.map((d) => d.relayUrl) : []);
      const initData = options.runtime.rawInitData();
      return {
        appVersion: options.appVersion,
        backend: "live",
        scenario: null,
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
      for (const attempt of attempts.values()) attempt.close();
      attempts.clear();
      pending.clear();
      outcomes.clear();
      tasks.clear();
      lastSeq.clear();
      requests.clear();
      // resetAll does not validate the stored index, so this also recovers a corrupt one.
      const reset = await options.store.resetAll();
      if (!reset.ok) return fail(storeErrorCode(reset.code), reset.message);
      // The pins above were made for the old phone key, so regenerating it now
      // cannot leave a pin behind. A valid or absent key is kept as it is.
      const identity = await (await options.openIdentityStore()).resetIfCorrupt();
      if (!identity.ok) {
        return fail(
          storeErrorCode(identity.code),
          `Pinned computers were cleared, but the phone key could not be checked: ${identity.message}.`,
        );
      }
      return ok({ phoneKeyRegenerated: identity.value.regenerated });
    },
  };
}
