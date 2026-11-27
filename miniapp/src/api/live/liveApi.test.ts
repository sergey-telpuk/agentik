import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "../../encoding";
import { parseInvitation, type UntrustedInvitation } from "../../pairing/invitation";
import { pinnedDeviceFromInvitation } from "../../pairing/pin";
import { asJson, NOW_MS, NOW_S, validWire } from "../../pairing/testing";
import type { TaskView } from "../../protocol/messages";
import { RelayClient } from "../../relay/client";
import { generateNoiseKeyPair, noiseChannelFactory, type NoiseKeyPair } from "../../secure/noise";
import type { SecureChannelFactory } from "../../secure/seam";
import { MemoryBackend } from "../../storage/fakes";
import { PhoneIdentityStore } from "../../storage/phoneIdentity";
import { PinnedDeviceStore, type PinnedDevice } from "../../storage/pinnedDevices";
import { noTelegramRuntime, type TelegramRuntime } from "../../telegram/runtime";
import type { AgentikApi, ConnectionState, TaskEvent, TaskUpdate } from "../types";
import { createLiveApi } from "./liveApi";
import {
  attachingRelay,
  FakeSocket,
  noiseDaemon,
  plainDaemon,
  sessionEvent,
  type DaemonHandler,
  type NoiseDaemon,
} from "./testing";

const INIT_DATA = "auth_date=1700000000&user=%7B%22id%22%3A42%7D&signature=abc";

const telegram: TelegramRuntime = {
  ...noTelegramRuntime,
  isMiniApp: true,
  platformVersion: "9.0",
  rawInitData: () => INIT_DATA,
};

interface Fixture {
  readonly keys: NoiseKeyPair;
  readonly wire: Record<string, unknown>;
  readonly invitation: UntrustedInvitation;
  readonly backend: MemoryBackend;
  readonly store: PinnedDeviceStore;
}

async function fixture(): Promise<Fixture> {
  const keys = await generateNoiseKeyPair();
  const wire = validWire({ noise_public_key: encodeBase64Url(keys.publicKey) });
  const parsed = parseInvitation(asJson(wire), NOW_MS);
  if (!parsed.ok) throw new Error("invalid test wire");
  const backend = new MemoryBackend("secure");
  const store = await PinnedDeviceStore.open({ secure: backend, device: null });
  return { keys, wire, invitation: parsed.value, backend, store };
}

async function pinConfirmed(f: Fixture): Promise<PinnedDevice> {
  const pinned = await f.store.pin(pinnedDeviceFromInvitation(f.invitation, NOW_S));
  if (!pinned.ok) throw new Error(pinned.message);
  const confirmed = await f.store.markConfirmed(pinned.value.deviceId);
  if (!confirmed.ok) throw new Error(confirmed.message);
  return confirmed.value;
}

function liveApi(
  f: Fixture,
  wiring: {
    readonly createRelayClient: (device: PinnedDevice) => RelayClient;
    readonly secureChannel: SecureChannelFactory;
    readonly runtime?: TelegramRuntime;
    readonly rpcTimeoutMs?: number;
    readonly offlineGraceMs?: number;
    readonly maxRelayAttempts?: number;
  },
): AgentikApi {
  return createLiveApi({
    store: f.store,
    runtime: wiring.runtime ?? noTelegramRuntime,
    openIdentityStore: () => PhoneIdentityStore.open({ secure: f.backend, device: null }),
    createRelayClient: wiring.createRelayClient,
    secureChannel: wiring.secureChannel,
    describeStorage: () =>
      Promise.resolve({ secureStorage: "available", deviceStorage: "unavailable", active: "secure", note: null }),
    appVersion: "1.2.3",
    now: () => NOW_MS,
    ...(wiring.rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs: wiring.rpcTimeoutMs }),
    offlineGraceMs: wiring.offlineGraceMs ?? 10_000,
    ...(wiring.maxRelayAttempts === undefined ? {} : { maxRelayAttempts: wiring.maxRelayAttempts }),
  });
}

function track(api: AgentikApi, computerId: string): { states: ConnectionState[]; stop: () => void } {
  const states: ConnectionState[] = [];
  const stop = api.connect(computerId, (s) => states.push(s));
  cleanups.push(stop);
  return { states, stop };
}

async function until(check: () => boolean, label: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!check()) throw new Error(`still waiting for ${label}`);
    },
    { timeout: 3000, interval: 5 },
  );
}

const phases = (states: readonly ConnectionState[]): string[] => states.map((s) => s.phase);
const last = (states: readonly ConnectionState[]): ConnectionState | undefined => states.at(-1);

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    task_id: "task-1111-2222",
    session_id: "sess-1111-2222",
    project_id: "proj-1",
    agent: "codex",
    prompt: "Run tests",
    state: "running",
    result_text: "",
    error_message: "",
    pending_approval: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

/** Answers what every paired session needs before it is ready. */
function paired(extra: DaemonHandler): DaemonHandler {
  return (frame) => {
    if (frame.method === "device.info") {
      return { result: { device_id: "x", paired: true, pairing_state: "paired", capabilities: ["codex"] } };
    }
    if (frame.method === "project.list") {
      return { result: { projects: [{ project_id: "proj-1", name: "agentik", agents: ["codex"] }] } };
    }
    return extra(frame);
  };
}

const cleanups: (() => void)[] = [];
const daemons: NoiseDaemon[] = [];

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  for (const d of daemons.splice(0)) d.dispose();
});

describe("live AgentikApi: secure connection and pairing", () => {
  it("completes Noise XX over the relay, sends initData and device.info encrypted, and becomes ready", async () => {
    const f = await fixture();
    const pinned = await f.store.pin(pinnedDeviceFromInvitation(f.invitation, NOW_S));
    if (!pinned.ok) throw new Error(pinned.message);
    const daemon = await noiseDaemon(f.invitation.deviceIdText, f.keys, paired(() => undefined));
    daemons.push(daemon);
    const api = liveApi(f, { createRelayClient: daemon.relay.createRelayClient, secureChannel: noiseChannelFactory, runtime: telegram });

    const { states } = track(api, f.invitation.deviceIdText);
    await until(() => last(states)?.phase === "ready", "ready");

    expect(phases(states)).toEqual(["connecting", "handshaking", "synchronizing", "ready"]);
    const methods = daemon.requests.map((r) => r.method);
    expect(methods).toContain("auth.telegram");
    expect(methods).toContain("device.info");
    expect(daemon.requests.find((r) => r.method === "auth.telegram")?.params).toEqual({ init_data: INIT_DATA });
    // Nothing on the relay is readable: every frame is Noise ciphertext.
    const onWire = daemon.relay.frames.map((frame) => new TextDecoder().decode(frame)).join("\n");
    expect(onWire).not.toContain("auth_date");
    expect(onWire).not.toContain("device.info");

    const listed = await f.store.list();
    expect(listed.ok && listed.value[0]?.state).toBe("confirmed");
    const computers = await api.listComputers();
    expect(computers.ok && computers.value[0]?.status).toBe("online");
  });

  it("submits the in-memory invitation, shows the verification code, and fails without confirming on rejection", async () => {
    const f = await fixture();
    const daemon = await noiseDaemon(f.invitation.deviceIdText, f.keys, (frame) => {
      if (frame.method === "device.info") {
        return { result: { device_id: "x", paired: false, pairing_state: "unpaired", capabilities: [] } };
      }
      if (frame.method === "pair.submit") {
        return { result: { state: "awaiting_local_approval", device_id: "x", verification_code: "11:22:33:44" } };
      }
      return undefined;
    });
    daemons.push(daemon);
    const api = liveApi(f, { createRelayClient: daemon.relay.createRelayClient, secureChannel: noiseChannelFactory });

    const pairedComputer = await api.pairComputer(f.invitation);
    expect(pairedComputer.ok && pairedComputer.value.status).toBe("pending_confirmation");
    // The one-time secret never reaches persistent storage.
    for (const value of f.backend.data.values()) expect(value).not.toContain(String(f.wire["invitation_secret"]));

    const first = track(api, f.invitation.deviceIdText);
    await until(() => last(first.states)?.phase === "awaiting_local_approval", "awaiting approval");
    expect(last(first.states)).toEqual({ phase: "awaiting_local_approval", verificationCode: "11:22:33:44" });
    expect(daemon.requests.find((r) => r.method === "pair.submit")?.params).toEqual({
      invitation_id: String(f.wire["invitation_id"]),
      invitation_secret: String(f.wire["invitation_secret"]),
    });

    daemon.push({
      v: 1,
      type: "event",
      event: "pair.updated",
      data: { device_id: f.invitation.deviceIdText, state: "rejected" },
    });
    await until(() => last(first.states)?.phase === "failed", "failed");
    const failed = last(first.states);
    expect(failed?.phase === "failed" && failed.reason).toBe("not_paired");
    expect(failed?.phase === "failed" && failed.retryable).toBe(false);
    expect(failed?.phase === "failed" && failed.message).toContain("Pairing rejected by the computer");
    const listed = await f.store.list();
    expect(listed.ok && listed.value[0]?.state).toBe("unconfirmed");
    expect((await api.listProjects(f.invitation.deviceIdText)).ok).toBe(false);

    // The spent invitation is not submitted again on the next attempt.
    first.stop();
    const second = track(api, f.invitation.deviceIdText);
    await until(() => last(second.states)?.phase === "failed", "second failure");
    expect(daemon.requests.filter((r) => r.method === "pair.submit")).toHaveLength(1);
  });

  it("moves to ready when the computer confirms the phone while waiting", async () => {
    const f = await fixture();
    let isPaired = false;
    const daemon = await noiseDaemon(f.invitation.deviceIdText, f.keys, (frame) => {
      if (frame.method === "device.info") {
        return {
          result: {
            device_id: "x",
            paired: isPaired,
            pairing_state: isPaired ? "paired" : "unpaired",
            capabilities: [],
          },
        };
      }
      if (frame.method === "pair.submit") return { result: { state: "awaiting_local_approval", device_id: "x" } };
      if (frame.method === "project.list") return { result: { projects: [] } };
      return undefined;
    });
    daemons.push(daemon);
    const api = liveApi(f, { createRelayClient: daemon.relay.createRelayClient, secureChannel: noiseChannelFactory });
    await api.pairComputer(f.invitation);

    const { states } = track(api, f.invitation.deviceIdText);
    await until(() => last(states)?.phase === "awaiting_local_approval", "awaiting approval");
    expect(last(states)).toEqual({ phase: "awaiting_local_approval" });

    isPaired = true;
    daemon.push({ v: 1, type: "event", event: "pair.updated", data: { device_id: f.invitation.deviceIdText, state: "paired" } });
    await until(() => last(states)?.phase === "ready", "ready");
    const listed = await f.store.list();
    expect(listed.ok && listed.value[0]?.state).toBe("confirmed");
  });

  it("refuses a computer whose key differs from the pinned one", async () => {
    const f = await fixture();
    await pinConfirmed(f);
    const impostor = await noiseDaemon(f.invitation.deviceIdText, await generateNoiseKeyPair(), paired(() => undefined));
    daemons.push(impostor);
    const api = liveApi(f, { createRelayClient: impostor.relay.createRelayClient, secureChannel: noiseChannelFactory });

    const { states } = track(api, f.invitation.deviceIdText);
    await until(() => last(states)?.phase === "failed", "failed");
    const failed = last(states);
    expect(failed?.phase === "failed" && failed.reason).toBe("key_mismatch");
    expect(failed?.phase === "failed" && failed.retryable).toBe(false);
    expect(impostor.requests).toEqual([]);
    const computers = await api.listComputers();
    expect(computers.ok && computers.value[0]?.status).toBe("replaced");
  });

  it("reports a computer that is not behind the relay as offline, with retry", async () => {
    const f = await fixture();
    await pinConfirmed(f);
    const relay = attachingRelay({ devicePresent: false });
    const api = liveApi(f, {
      createRelayClient: relay.createRelayClient,
      secureChannel: plainDaemon(() => undefined).secureChannel,
      offlineGraceMs: 30,
    });

    const { states } = track(api, f.invitation.deviceIdText);
    await until(() => last(states)?.phase === "failed", "failed");
    const failed = last(states);
    expect(failed?.phase === "failed" && failed.reason).toBe("computer_offline");
    expect(failed?.phase === "failed" && failed.retryable).toBe(true);
    expect(relay.sockets.at(-1)?.closed).toBe(true);
    const computers = await api.listComputers();
    expect(computers.ok && computers.value[0]?.status).toBe("offline");
  });

  it("fails with relay_unreachable after repeated relay failures", async () => {
    const f = await fixture();
    await pinConfirmed(f);
    const api = liveApi(f, {
      createRelayClient: (device) =>
        new RelayClient({
          relayUrl: device.relayUrl,
          deviceId: f.invitation.deviceId,
          deviceIdText: device.deviceId,
          backoff: { baseMs: 1, maxMs: 1, factor: 1 },
          createSocket: () => {
            const socket = new FakeSocket(() => undefined);
            queueMicrotask(() => socket.onclose?.({ code: 1006, reason: "" }));
            return socket;
          },
        }),
      secureChannel: plainDaemon(() => undefined).secureChannel,
      maxRelayAttempts: 2,
    });

    const { states } = track(api, f.invitation.deviceIdText);
    await until(() => last(states)?.phase === "failed", "failed");
    const failed = last(states);
    expect(failed?.phase === "failed" && failed.reason).toBe("relay_unreachable");
    expect(failed?.phase === "failed" && failed.retryable).toBe(true);
  });

  it("ends access when the computer reports this phone as revoked", async () => {
    const f = await fixture();
    await pinConfirmed(f);
    const daemon = plainDaemon((frame) =>
      frame.method === "device.info"
        ? { result: { device_id: "x", paired: false, pairing_state: "revoked", capabilities: [] } }
        : undefined,
    );
    const api = liveApi(f, { createRelayClient: attachingRelay().createRelayClient, secureChannel: daemon.secureChannel });

    const { states } = track(api, f.invitation.deviceIdText);
    await until(() => last(states)?.phase === "revoked", "revoked");
    const result = await api.listProjects(f.invitation.deviceIdText);
    expect(!result.ok && result.error.code).toBe("revoked");
    const computers = await api.listComputers();
    expect(computers.ok && computers.value[0]?.status).toBe("revoked");
  });
});

describe("live AgentikApi: tasks over the inner protocol", () => {
  it("starts a task, streams ordered events, decides that approval only, and returns the result with its diff", async () => {
    const f = await fixture();
    await pinConfirmed(f);
    let current = task({ state: "accepted" });
    const daemon = plainDaemon(
      paired((frame) => {
        switch (frame.method) {
          case "agent.list":
            return { result: { agents: [{ name: "codex", available: true, authenticated: true, version: "0.160.0" }] } };
          case "task.start":
            current = task({ state: "starting" });
            return { result: { task: current, deduplicated: false } };
          case "events.resume":
            return { result: { session_id: current.session_id, events: [], next_seq: 1 } };
          case "task.get":
            return { result: { task: current } };
          case "approval.resolve":
            current = task({ state: "running", pending_approval: null });
            return { result: { approval_id: frame.params["approval_id"], status: "accepted" } };
          case "changes.get":
            return { result: { task_id: current.task_id, diff: "diff --git a/a.ts b/a.ts\n+ok\n", truncated: false } };
          default:
            return undefined;
        }
      }),
    );
    const api = liveApi(f, { createRelayClient: attachingRelay().createRelayClient, secureChannel: daemon.secureChannel });
    const id = f.invitation.deviceIdText;
    const { states } = track(api, id);
    await until(() => last(states)?.phase === "ready", "ready");

    const agents = await api.listAgents(id);
    expect(agents.ok && agents.value).toEqual([{ id: "codex", name: "Codex", status: "available", version: "0.160.0" }]);
    const started = await api.startTask(id, { projectId: "proj-1", agent: "codex", prompt: "  Run tests ", requestId: "req-1" });
    expect(started.ok && started.value.state).toBe("starting");
    const startFrame = daemon.requests.find((r) => r.method === "task.start");
    expect(startFrame?.request_id).toBe("req-1");
    expect(startFrame?.params).toEqual({ project_id: "proj-1", session_id: null, agent: "codex", prompt: "Run tests" });

    const updates: TaskUpdate[] = [];
    cleanups.push(api.streamEvents(id, "task-1111-2222", 0, (u) => updates.push(u)));
    await until(() => updates.length > 0, "initial update");

    current = task({
      state: "awaiting_approval",
      pending_approval: { approval_id: "apr-1", kind: "command", summary: "Run npm test", expires_at: 2000 },
    });
    const base = { session_id: "sess-1111-2222", task_id: "task-1111-2222" };
    daemon.push(sessionEvent({ ...base, seq: 2, kind: "delta", payload: { text: "<img src=x " }, created_at: 1001 }));
    daemon.push(
      sessionEvent({
        ...base,
        seq: 3,
        kind: "item",
        payload: { item_type: "agentMessage", text: "<img src=x onerror=alert(1)> running" },
        created_at: 1001,
      }),
    );
    daemon.push(
      sessionEvent({
        ...base,
        seq: 4,
        kind: "approval_requested",
        payload: { approval_id: "apr-1", kind: "command", summary: "Run npm test", expires_at: 2000 },
        created_at: 1002,
      }),
    );
    await until(() => updates.at(-1)?.task.pendingApproval?.id === "apr-1", "approval");

    const events: TaskEvent[] = updates.flatMap((u) => u.events);
    expect(events.map((e) => [e.seq, e.kind])).toEqual([
      [3, "message"],
      [4, "approval_requested"],
    ]);
    // Agent text is passed through verbatim for plain-text rendering.
    expect(events[0]?.kind === "message" && events[0].text).toBe("<img src=x onerror=alert(1)> running");
    const approval = updates.at(-1)?.task.pendingApproval;
    expect(approval?.operation).toBe("Run npm test");
    expect(approval?.expiresAt).toBe(2_000_000);

    const decided = await api.respondApproval(id, { taskId: "task-1111-2222", approvalId: "apr-1", decision: "approve" });
    expect(decided.ok && decided.value).toEqual({ approvalId: "apr-1", decision: "approve" });
    expect(daemon.requests.find((r) => r.method === "approval.resolve")?.params).toEqual({
      approval_id: "apr-1",
      decision: "accept",
    });

    current = task({ state: "succeeded", result_text: "All tests passed!" });
    daemon.push(sessionEvent({ ...base, seq: 5, kind: "completed", payload: { state: "succeeded" }, created_at: 1003 }));
    await until(() => updates.at(-1)?.task.state === "succeeded", "succeeded");
    expect(updates.at(-1)?.task.lastSeq).toBe(5);

    const result = await api.getResult(id, "task-1111-2222");
    expect(result.ok && result.value.output).toBe("All tests passed!");
    expect(result.ok && result.value.diff).toContain("+ok");
    expect(result.ok && result.value.changes).toEqual([{ path: "a.ts", additions: 1, deletions: 0 }]);
    expect(result.ok && result.value.finishedAt).toBe(1_000_000);

    const listed = await api.listTasks(id, "proj-1");
    expect(listed.ok && listed.value.map((t) => [t.id, t.state])).toEqual([["task-1111-2222", "succeeded"]]);
  });

  it("reuses the request id after a timeout, cancels, and resumes events after a reconnect", async () => {
    const f = await fixture();
    await pinConfirmed(f);
    let startAttempts = 0;
    let current = task({ state: "running" });
    const daemon = plainDaemon(
      paired((frame) => {
        switch (frame.method) {
          case "task.start":
            startAttempts += 1;
            return startAttempts === 1 ? undefined : { result: { task: current, deduplicated: true } };
          case "task.get":
            return { result: { task: current } };
          case "task.cancel":
            current = task({ state: "cancel_requested" });
            return { result: { task: current } };
          case "events.resume":
            return frame.params["after_seq"] === 0
              ? {
                  result: {
                    session_id: current.session_id,
                    events: [
                      {
                        session_id: current.session_id,
                        task_id: current.task_id,
                        seq: 1,
                        kind: "status",
                        payload: { state: "running" },
                        created_at: 1001,
                      },
                    ],
                    next_seq: 2,
                  },
                }
              : {
                  result: {
                    session_id: current.session_id,
                    events: [
                      {
                        session_id: current.session_id,
                        task_id: current.task_id,
                        seq: 2,
                        kind: "completed",
                        payload: { state: "cancelled" },
                        created_at: 1002,
                      },
                    ],
                    next_seq: 3,
                  },
                };
          default:
            return undefined;
        }
      }),
    );
    const relay = attachingRelay();
    const api = liveApi(f, { createRelayClient: relay.createRelayClient, secureChannel: daemon.secureChannel, rpcTimeoutMs: 40 });
    const id = f.invitation.deviceIdText;
    const { states } = track(api, id);
    await until(() => last(states)?.phase === "ready", "ready");

    const input = { projectId: "proj-1", agent: "codex" as const, prompt: "Check idempotency", requestId: "req-7" };
    const lost = await api.startTask(id, input);
    expect(!lost.ok && lost.error.code).toBe("not_connected");
    const retried = await api.startTask(id, input);
    expect(retried.ok && retried.value.id).toBe("task-1111-2222");
    const starts = daemon.requests.filter((r) => r.method === "task.start");
    expect(starts.map((r) => r.request_id)).toEqual(["req-7", "req-7"]);

    const cancelled = await api.cancelTask(id, "task-1111-2222");
    expect(cancelled.ok && cancelled.value.state).toBe("cancel_requested");

    const updates: TaskUpdate[] = [];
    cleanups.push(api.streamEvents(id, "task-1111-2222", 0, (u) => updates.push(u)));
    await until(() => updates.some((u) => u.events.some((e) => e.seq === 1)), "first event");

    // The computer drops off the relay and comes back: a fresh handshake, then catch-up.
    current = task({ state: "cancelled", error_message: "cancelled by user" });
    relay.peerState(false);
    await until(() => last(states)?.phase === "connecting", "connection lost");
    relay.peerState(true);
    await until(() => updates.at(-1)?.task.state === "cancelled", "cancelled after reconnect");

    expect(daemon.sessions).toHaveLength(2);
    expect(daemon.sessions[1]?.find((r) => r.method === "events.resume")?.params).toEqual({
      session_id: "sess-1111-2222",
      after_seq: 1,
    });
    const after = updates.flatMap((u) => u.events);
    expect(after.map((e) => e.seq)).toEqual([1, 2]);
    expect(after[1]?.kind === "state" && after[1].state).toBe("cancelled");
  });

  it("validates input locally and refuses calls without a ready session instead of queueing them", async () => {
    const f = await fixture();
    await pinConfirmed(f);
    const daemon = plainDaemon(paired(() => ({ result: { task: task() } })));
    const api = liveApi(f, { createRelayClient: attachingRelay().createRelayClient, secureChannel: daemon.secureChannel });
    const id = f.invitation.deviceIdText;

    const early = await api.listProjects(id);
    expect(!early.ok && early.error.code).toBe("not_connected");
    const blank = await api.startTask(id, { projectId: "proj-1", agent: "codex", prompt: "   ", requestId: "r" });
    expect(!blank.ok && blank.error.code).toBe("invalid");

    const { states } = track(api, id);
    await until(() => last(states)?.phase === "ready", "ready");
    const first = await api.startTask(id, { projectId: "proj-1", agent: "codex", prompt: "One", requestId: "r-1" });
    expect(first.ok).toBe(true);
    const reused = await api.startTask(id, { projectId: "proj-1", agent: "codex", prompt: "Two", requestId: "r-1" });
    expect(!reused.ok && reused.error.code).toBe("conflict");
    expect(daemon.requests.filter((r) => r.method === "task.start")).toHaveLength(1);
  });

  it("reports live diagnostics and clears local pins", async () => {
    const f = await fixture();
    await pinConfirmed(f);
    const daemon = plainDaemon(paired(() => undefined));
    const api = liveApi(f, {
      createRelayClient: attachingRelay().createRelayClient,
      secureChannel: daemon.secureChannel,
      runtime: telegram,
    });
    const id = f.invitation.deviceIdText;
    const { states } = track(api, id);
    await until(() => last(states)?.phase === "ready", "ready");

    const diagnostics = await api.getDiagnostics();
    expect(diagnostics).toMatchObject({
      appVersion: "1.2.3",
      backend: "live",
      scenario: null,
      telegram: { isMiniApp: true, platformVersion: "9.0", initDataAvailable: true },
      relayUrls: [f.invitation.relayUrl],
    });
    expect(api.backend).toBe("live");

    expect((await api.clearLocalData()).ok).toBe(true);
    const computers = await api.listComputers();
    expect(computers.ok && computers.value).toEqual([]);
    const afterClear = await api.listProjects(id);
    expect(!afterClear.ok && afterClear.error.code).toBe("not_connected");
  });
});
