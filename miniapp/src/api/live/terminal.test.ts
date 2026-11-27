import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBase64, encodeBase64, encodeBase64Url } from "../../encoding";
import { parseInvitation } from "../../pairing/invitation";
import { pinnedDeviceFromInvitation } from "../../pairing/pin";
import { asText, NOW_MS, NOW_S, validWire } from "../../pairing/testing";
import { generateNoiseKeyPair } from "../../secure/noise";
import { MemoryBackend } from "../../storage/fakes";
import { PhoneIdentityStore } from "../../storage/phoneIdentity";
import { PinnedDeviceStore } from "../../storage/pinnedDevices";
import { noTelegramRuntime } from "../../telegram/runtime";
import type { AgentikApi, ConnectionState, TerminalClosed } from "../types";
import { createLiveApi } from "./liveApi";
import { attachingRelay, plainDaemon, type DaemonHandler, type DaemonReply, type RpcFrame } from "./testing";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
});

async function until(check: () => boolean, label: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!check()) throw new Error(`still waiting for ${label}`);
    },
    { timeout: 3000, interval: 5 },
  );
}

/** A live API connected to an in-memory computer that answers with `handler`. */
async function connected(handler: DaemonHandler): Promise<{ api: AgentikApi; id: string; requests: RpcFrame[] }> {
  const keys = await generateNoiseKeyPair();
  const parsed = await parseInvitation(asText(validWire({ noise_public_key: encodeBase64Url(keys.publicKey) })), NOW_MS);
  if (!parsed.ok) throw new Error("invalid test wire");
  const backend = new MemoryBackend("secure");
  const store = await PinnedDeviceStore.open({ secure: backend, device: null });
  const pinned = await store.pin(pinnedDeviceFromInvitation(parsed.value, NOW_S));
  if (!pinned.ok) throw new Error(pinned.message);
  await store.markConfirmed(pinned.value.deviceId);

  const daemon = plainDaemon((frame) => {
    if (frame.method === "device.info") {
      return { result: { device_id: "x", paired: true, pairing_state: "paired", capabilities: ["codex"] } };
    }
    if (frame.method === "project.list") {
      return { result: { projects: [{ project_id: "proj-1", name: "agentik", agents: ["codex"] }] } };
    }
    if (frame.method === "session.list") return { result: { sessions: [] } };
    return handler(frame);
  });
  // One harness: the relay client and the DataChannel must belong to the same link.
  const relay = attachingRelay();
  const api = createLiveApi({
    store,
    runtime: noTelegramRuntime,
    openIdentityStore: () => PhoneIdentityStore.open({ secure: backend, device: null }),
    createRelayClient: relay.createRelayClient,
    openLink: relay.openLink,
    // jsdom has no RTCPeerConnection, so feature detection would report no support.
    webRtcSupport: () => ({ supported: true }),
    secureChannel: daemon.secureChannel,
    describeStorage: () =>
      Promise.resolve({ secureStorage: "available", deviceStorage: "unavailable", active: "secure", note: null }),
    appVersion: "1.2.3",
    now: () => NOW_MS,
  });
  const id = parsed.value.deviceIdText;
  const states: ConnectionState[] = [];
  cleanups.push(api.connect(id, (s) => states.push(s)));
  await until(() => states.at(-1)?.phase === "ready", "ready");
  return { api, id, requests: daemon.requests };
}

const byMethod = (requests: readonly RpcFrame[], method: string): RpcFrame[] => requests.filter((r) => r.method === method);

describe("live AgentikApi: terminal", () => {
  it("opens a terminal with terminal.open in the chosen project and size", async () => {
    const { api, id, requests } = await connected((frame) =>
      frame.method === "terminal.open"
        ? { result: { session_id: "term_1", project_id: frame.params["project_id"], cols: 90, rows: 30 } }
        : undefined,
    );

    const opened = await api.openTerminal(id, { projectId: "proj-1", cols: 90, rows: 30 });
    expect(opened).toEqual({ ok: true, value: { sessionId: "term_1", projectId: "proj-1" } });
    expect(byMethod(requests, "terminal.open").map((r) => r.params)).toEqual([{ project_id: "proj-1", cols: 90, rows: 30 }]);

    await api.openTerminal(id, { projectId: "proj-1", cols: 80, rows: 24, command: "codex" });
    expect(byMethod(requests, "terminal.open")[1]?.params).toEqual({ project_id: "proj-1", cols: 80, rows: 24, command: "codex" });
  });

  it("sends typed input as standard base64 and checks the size limit locally", async () => {
    const { api, id, requests } = await connected((frame) =>
      frame.method === "terminal.input" ? { result: { session_id: "term_1", bytes: 1 } } : undefined,
    );

    const typed = new TextEncoder().encode("ls -la ~/é\r");
    expect(await api.sendTerminalInput(id, "term_1", typed)).toEqual({ ok: true, value: null });
    const sent = byMethod(requests, "terminal.input");
    expect(sent.map((r) => r.params)).toEqual([{ session_id: "term_1", data: encodeBase64(typed) }]);
    expect(Array.from(decodeBase64(sent[0]?.params["data"] as string) ?? [])).toEqual(Array.from(typed));

    const tooBig = await api.sendTerminalInput(id, "term_1", new Uint8Array(4097));
    expect(tooBig.ok).toBe(false);
    expect(byMethod(requests, "terminal.input")).toHaveLength(1);
  });

  it("streams output chunks in order, acknowledging each read, then reports the end once", async () => {
    const enc = (s: string): string => encodeBase64(new TextEncoder().encode(s));
    const replies: DaemonReply[] = [
      { result: { session_id: "term_1", chunks: [{ seq: 1, data: enc("$ ") }, { seq: 2, data: enc("echo hi\r\n") }], next_seq: 2, closed: false } },
      { result: { session_id: "term_1", chunks: [], next_seq: 2, closed: false } },
      // A repeated chunk is not written twice.
      { result: { session_id: "term_1", chunks: [{ seq: 2, data: enc("echo hi\r\n") }, { seq: 3, data: enc("hi\r\n") }], next_seq: 3, closed: false } },
      { result: { session_id: "term_1", chunks: [{ seq: 4, data: enc("logout\r\n") }], next_seq: 4, closed: true, reason: "exited", exit_code: 0 } },
    ];
    const { api, id, requests } = await connected((frame) => (frame.method === "terminal.read" ? replies.shift() : undefined));

    const written: string[] = [];
    const closed: TerminalClosed[] = [];
    cleanups.push(
      api.streamTerminal(id, "term_1", {
        onOutput: (data) => written.push(new TextDecoder().decode(data)),
        onClosed: (c) => closed.push(c),
      }),
    );
    await until(() => closed.length === 1, "closed");

    expect(written).toEqual(["$ ", "echo hi\r\n", "hi\r\n", "logout\r\n"]);
    expect(closed).toEqual([{ reason: "exited", exitCode: 0 }]);
    expect(byMethod(requests, "terminal.read").map((r) => r.params["after_seq"])).toEqual([0, 2, 2, 3]);
    expect(byMethod(requests, "terminal.read").every((r) => r.params["session_id"] === "term_1" && r.params["wait_ms"] === 20_000)).toBe(true);
  });

  it("ends the stream when the computer no longer knows the session", async () => {
    const { api, id } = await connected((frame) =>
      frame.method === "terminal.read" ? { error: { code: "not_found", message: "terminal: no such session" } } : undefined,
    );
    const closed: TerminalClosed[] = [];
    cleanups.push(api.streamTerminal(id, "term_gone", { onOutput: () => undefined, onClosed: (c) => closed.push(c) }));
    await until(() => closed.length === 1, "closed");
    expect(closed).toEqual([{ reason: "lost", exitCode: null }]);
  });

  it("closes with terminal.close and explains a computer without a terminal", async () => {
    const { api, id, requests } = await connected((frame) => {
      if (frame.method === "terminal.close") return { result: { session_id: "term_1", closed: true, reason: "closed", exit_code: 1 } };
      if (frame.method === "terminal.open") return { error: { code: "bad_request", message: 'unknown method "terminal.open"' } };
      return undefined;
    });

    expect(await api.closeTerminal(id, "term_1")).toEqual({ ok: true, value: { reason: "closed", exitCode: 1 } });
    expect(byMethod(requests, "terminal.close").map((r) => r.params)).toEqual([{ session_id: "term_1" }]);

    const opened = await api.openTerminal(id, { projectId: "proj-1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.message).toMatch(/Update Agentik on the computer/);
  });

  it("refuses terminal calls without a ready session instead of queueing them", async () => {
    const { api } = await connected(() => undefined);
    const result = await api.openTerminal("not-connected", { projectId: "proj-1", cols: 80, rows: 24 });
    expect(result.ok === false && result.error.code).toBe("not_connected");
  });
});
