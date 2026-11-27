import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAME_BYTES } from "../relay/frame-transport";
import { LinkError, openDataChannelLink, type DataLink } from "./link";
import { encodeSdp, SIGNAL_VERSION } from "./signaling";
import { FakePeerConnection, sdpWithFingerprint, signalingHarness, type SignalingHarness } from "./testing";

const enc = new TextEncoder();
const json = (value: unknown): Uint8Array => enc.encode(JSON.stringify(value));

interface Rig {
  readonly signaling: SignalingHarness;
  readonly pcs: FakePeerConnection[];
  readonly result: Promise<DataLink>;
  pc(): FakePeerConnection;
}

function start(options: { iceServersWaitMs?: number; connectTimeoutMs?: number; signal?: AbortSignal; extra?: boolean } = {}): Rig {
  const signaling = signalingHarness();
  const pcs: FakePeerConnection[] = [];
  const result = openDataChannelLink({
    signaling,
    createPeerConnection: (config) => {
      const pc = new FakePeerConnection(config);
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    ...(options.extra === true ? { extraIceServers: [{ urls: ["stun:static.example:3478"] }] } : {}),
    iceServersWaitMs: options.iceServersWaitMs ?? 0,
    connectTimeoutMs: options.connectTimeoutMs ?? 5000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // A rejection nobody awaits yet must not fail the run.
  result.catch(() => undefined);
  return { signaling, pcs, result, pc: () => pcs[0] as FakePeerConnection };
}

async function offered(rig: Rig): Promise<void> {
  await vi.waitFor(() => expect(rig.signaling.sent.some((s) => s.kind === "offer")).toBe(true));
}

function answer(rig: Rig, byte = 0xb2): void {
  rig.signaling.emit("answer", encodeSdp(sdpWithFingerprint(byte)));
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("openDataChannelLink", () => {
  it("offers over the relay, applies the answer, and resolves with both fingerprints once the channel opens", async () => {
    const rig = start({ extra: true });
    await offered(rig);

    const offer = rig.signaling.sent.find((s) => s.kind === "offer");
    expect(JSON.parse(new TextDecoder().decode(offer?.data))).toEqual({ v: SIGNAL_VERSION, sdp: sdpWithFingerprint(0xa1) });
    expect(rig.pc().channel?.label).toBe("agentik");
    expect(rig.pc().channel?.binaryType).toBe("arraybuffer");
    expect(rig.pc().config.iceServers).toEqual([{ urls: ["stun:static.example:3478"] }]);

    answer(rig);
    await vi.waitFor(() => expect(rig.pc().remoteDescription?.type).toBe("answer"));
    rig.pc().channel?.open();
    const link = await rig.result;

    expect(Array.from(link.localFingerprint)).toEqual(Array(32).fill(0xa1));
    expect(Array.from(link.remoteFingerprint)).toEqual(Array(32).fill(0xb2));
    // Signaling is released once the channel is open.
    expect(rig.signaling.subscribers()).toBe(0);
    // Only an offer left the phone through the relay.
    expect(new Set(rig.signaling.sent.map((s) => s.kind))).toEqual(new Set(["offer"]));
  });

  it("uses the computer's ice_servers, including TURN credentials, for the connection", async () => {
    const rig = start({ iceServersWaitMs: 1000 });
    // Sent right after attach, before the phone has an offer.
    rig.signaling.emit(
      "ice_servers",
      json({
        v: 1,
        servers: [
          { urls: ["stun:s.example:3478"] },
          { urls: ["turn:t.example:3478"], username: "1800000300:agentik", credential: "c2VjcmV0" },
        ],
      }),
    );
    await offered(rig);
    expect(rig.pc().config.iceServers).toEqual([
      { urls: ["stun:s.example:3478"] },
      { urls: ["turn:t.example:3478"], username: "1800000300:agentik", credential: "c2VjcmV0" },
    ]);
  });

  it("offers without servers when none arrive in time, and ignores a malformed list", async () => {
    vi.useFakeTimers();
    const rig = start({ iceServersWaitMs: 300 });
    rig.signaling.emit("ice_servers", json({ v: 1, servers: [{ urls: ["javascript:alert(1)"] }] }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.pcs).toHaveLength(1);
    expect(rig.pc().config.iceServers).toEqual([]);
    rig.pc().channel?.onclose?.();
    await expect(rig.result).rejects.toBeInstanceOf(LinkError);
  });

  it("sends gathered candidates as ice signals, after the offer", async () => {
    const rig = start();
    await vi.waitFor(() => expect(rig.pcs).toHaveLength(1));
    // Gathered before the offer finished going out.
    rig.pc().gather({ candidate: "candidate:1 1 UDP 1 10.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 });
    await offered(rig);
    rig.pc().gather({ candidate: "candidate:2 1 UDP 1 10.0.0.2 9 typ host", sdpMid: "0", sdpMLineIndex: 0 });
    await vi.waitFor(() => expect(rig.signaling.sent.filter((s) => s.kind === "ice")).toHaveLength(2));
    expect(rig.signaling.sent[0]?.kind).toBe("offer");
  });

  it("holds remote candidates until the answer is applied", async () => {
    const rig = start();
    await offered(rig);
    rig.signaling.emit("ice", json({ v: 1, candidate: "candidate:9 1 UDP 1 10.9.9.9 9 typ host", sdpMid: "0", sdpMLineIndex: 0 }));
    expect(rig.pc().addedCandidates).toEqual([]);
    answer(rig);
    await vi.waitFor(() => expect(rig.pc().addedCandidates).toHaveLength(1));
    rig.signaling.emit("ice", json({ v: 1, candidate: "candidate:10 1 UDP 1 10.9.9.8 9 typ host", sdpMid: "0", sdpMLineIndex: 0 }));
    await vi.waitFor(() => expect(rig.pc().addedCandidates).toHaveLength(2));
  });

  it("rejects with ice_failed, naming the reason and TURN, when ICE fails", async () => {
    const rig = start();
    await offered(rig);
    answer(rig);
    rig.pc().setIce("failed");
    const err = await rig.result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).code).toBe("ice_failed");
    expect((err as LinkError).message).toContain("no candidate pair");
    expect((err as LinkError).message).toContain("TURN");
    expect(rig.pc().closed).toBe(true);
    expect(rig.signaling.subscribers()).toBe(0);
  });

  it("rejects with timeout when the channel does not open in time", async () => {
    vi.useFakeTimers();
    const rig = start({ connectTimeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(10);
    answer(rig);
    await vi.advanceTimersByTimeAsync(2100);
    const err = await rig.result.catch((e: unknown) => e);
    expect((err as LinkError).code).toBe("timeout");
    expect((err as LinkError).message).toContain("no candidate pair");
    expect(rig.pc().closed).toBe(true);
  });

  it("rejects with closed when aborted, and never opens a connection if aborted up front", async () => {
    const controller = new AbortController();
    const rig = start({ signal: controller.signal });
    await offered(rig);
    controller.abort();
    expect(((await rig.result.catch((e: unknown) => e)) as LinkError).code).toBe("closed");
    expect(rig.pc().closed).toBe(true);

    const pre = new AbortController();
    pre.abort();
    const early = start({ signal: pre.signal });
    expect(((await early.result.catch((e: unknown) => e)) as LinkError).code).toBe("closed");
    expect(early.pcs).toHaveLength(0);
  });

  it("rejects with protocol when the answer has no usable fingerprint or cannot be read", async () => {
    const noFp = start();
    await offered(noFp);
    noFp.signaling.emit("answer", encodeSdp("v=0\r\ns=-\r\n"));
    expect(((await noFp.result.catch((e: unknown) => e)) as LinkError).code).toBe("protocol");

    const garbage = start();
    await offered(garbage);
    garbage.signaling.emit("answer", enc.encode("not json"));
    expect(((await garbage.result.catch((e: unknown) => e)) as LinkError).code).toBe("protocol");
  });

  it("rejects with protocol when the channel opens without any answer", async () => {
    const rig = start();
    await offered(rig);
    rig.pc().channel?.open();
    expect(((await rig.result.catch((e: unknown) => e)) as LinkError).code).toBe("protocol");
  });

  it("rejects with signaling when the relay cannot carry the offer", async () => {
    const signaling = signalingHarness();
    signaling.failSending(new Error("not attached"));
    const pcs: FakePeerConnection[] = [];
    const result = openDataChannelLink({
      signaling,
      createPeerConnection: (config) => {
        const pc = new FakePeerConnection(config);
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      iceServersWaitMs: 0,
      connectTimeoutMs: 5000,
    });
    const err = await result.catch((e: unknown) => e);
    expect((err as LinkError).code).toBe("signaling");
    expect((err as LinkError).message).toContain("not attached");
    expect(pcs[0]?.closed).toBe(true);
  });

  it("rejects with unsupported when the connection cannot be created", async () => {
    const result = openDataChannelLink({
      signaling: signalingHarness(),
      createPeerConnection: () => {
        throw new Error("no RTCPeerConnection");
      },
      iceServersWaitMs: 0,
      connectTimeoutMs: 5000,
    });
    expect(((await result.catch((e: unknown) => e)) as LinkError).code).toBe("unsupported");
  });
});

describe("DataLink transport", () => {
  async function open(): Promise<{ rig: Rig; link: DataLink }> {
    const rig = start();
    await offered(rig);
    answer(rig);
    await vi.waitFor(() => expect(rig.pc().remoteDescription).not.toBeNull());
    rig.pc().channel?.open();
    return { rig, link: await rig.result };
  }

  it("sends binary frames and delivers binary frames only", async () => {
    const { rig, link } = await open();
    link.transport.sendFrame(Uint8Array.of(1, 2, 3));
    expect(rig.pc().channel?.sent.map((f) => Array.from(f))).toEqual([[1, 2, 3]]);

    const seen: number[][] = [];
    const off = link.transport.onFrame((f) => seen.push(Array.from(f)));
    rig.pc().channel?.receive(Uint8Array.of(9, 8).buffer);
    rig.pc().channel?.receive("text is not a frame");
    rig.pc().channel?.receive(new ArrayBuffer(0));
    rig.pc().channel?.receive(new ArrayBuffer(MAX_FRAME_BYTES + 1));
    off();
    rig.pc().channel?.receive(Uint8Array.of(7).buffer);
    expect(seen).toEqual([[9, 8]]);
  });

  it("refuses empty and oversized frames, and a peer that is not draining", async () => {
    const { rig, link } = await open();
    expect(() => link.transport.sendFrame(new Uint8Array(0))).toThrow();
    expect(() => link.transport.sendFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(/limit/);
    expect(() => link.transport.sendFrame(new Uint8Array(MAX_FRAME_BYTES))).not.toThrow();
    const channel = rig.pc().channel;
    if (channel === null) throw new Error("no channel");
    channel.bufferedAmount = 1024 * 1024;
    expect(() => link.transport.sendFrame(Uint8Array.of(1))).toThrow(LinkError);
  });

  it("reports the channel closing once, then refuses to send", async () => {
    const { rig, link } = await open();
    const reasons: string[] = [];
    link.onClosed((r) => reasons.push(r));
    rig.pc().channel?.close();
    rig.pc().channel?.close();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("closed");
    expect(rig.pc().closed).toBe(true);
    expect(() => link.transport.sendFrame(Uint8Array.of(1))).toThrow(LinkError);
    // A handler added afterwards still learns about it.
    const late: string[] = [];
    link.onClosed((r) => late.push(r));
    await Promise.resolve();
    expect(late).toHaveLength(1);
  });

  it("reports a failed connection after open as a closure, and close() ends it quietly", async () => {
    const { rig, link } = await open();
    const reasons: string[] = [];
    link.onClosed((r) => reasons.push(r));
    rig.pc().setConnection("failed");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("ICE failed");

    const second = await open();
    const quiet: string[] = [];
    second.link.onClosed((r) => quiet.push(r));
    second.link.close();
    expect(quiet).toEqual([]);
    expect(second.rig.pc().closed).toBe(true);
  });
});
