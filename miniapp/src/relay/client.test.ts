import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64 } from "../encoding";
import {
  computeBackoffDelay,
  DEFAULT_BACKOFF,
  DEFAULT_MAX_FRAME_BYTES,
  FrameTooLargeError,
  KEEPALIVE_PING,
  RELAY_CLOSE_CODES,
  RelayClient,
  RelayNotConnectedError,
  type BackoffOptions,
  type RelayClientOptions,
  type WebSocketLike,
} from "./client";

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }

  // -- test controls --
  open(): void {
    this.onopen?.({});
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  attach(devicePresent = true): void {
    this.receive({ type: "attached", deviceId: "ignored", connectionId: "c1", devicePresent });
  }
  drop(): void {
    this.onclose?.({ code: 1006, reason: "" });
  }
}

const DEVICE_ID = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 8000, factor: 2 };

interface Harness {
  client: RelayClient;
  sockets: FakeSocket[];
  latest(): FakeSocket;
}

function setup(overrides: Partial<RelayClientOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const client = new RelayClient({
    relayUrl: "wss://relay.example.com",
    deviceId: DEVICE_ID,
    deviceIdText: "abcdefg",
    backoff: BACKOFF,
    // Always the top of the jitter range, so delays equal the ceiling.
    random: () => 1,
    handshakeTimeoutMs: 5000,
    stableAfterMs: 10_000,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });
  return {
    client,
    sockets,
    latest: () => {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error("no socket was created");
      return socket;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computeBackoffDelay", () => {
  it("grows exponentially and stops at the cap", () => {
    const delays = [0, 1, 2, 3, 4, 5].map((n) => computeBackoffDelay(n, BACKOFF, () => 1));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("applies equal jitter: between half the ceiling and the ceiling, never zero", () => {
    expect(computeBackoffDelay(2, BACKOFF, () => 0)).toBe(2000);
    expect(computeBackoffDelay(2, BACKOFF, () => 0.5)).toBe(3000);
    expect(computeBackoffDelay(2, BACKOFF, () => 0.999999)).toBe(4000);
    for (let n = 0; n < 10; n++) {
      expect(computeBackoffDelay(n, DEFAULT_BACKOFF, () => 0)).toBeGreaterThan(0);
    }
  });
});

describe("RelayClient: connecting", () => {
  it("opens the relay URL for the device and attaches once the socket opens", () => {
    const { client, latest } = setup();
    client.start();
    expect(latest().url).toBe("wss://relay.example.com/v1/connect?device=abcdefg");
    expect(client.getStatus().state).toBe("connecting");

    latest().open();
    expect(latest().sent).toEqual([
      { type: "attach", version: 1, device_id: encodeBase64(DEVICE_ID) },
    ]);
    expect(client.getStatus().state).toBe("connecting");

    latest().attach(true);
    expect(client.getStatus()).toMatchObject({ state: "connected", devicePresent: true });
  });

  it("keeps a base path on the relay URL", () => {
    const { client, latest } = setup({ relayUrl: "wss://relay.example.com/base" });
    client.start();
    expect(latest().url).toBe("wss://relay.example.com/base/v1/connect?device=abcdefg");
  });

  it("tracks whether the computer is present behind the relay", () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().attach(false);
    expect(client.getStatus().devicePresent).toBe(false);
    latest().receive({ type: "peer_state", present: true });
    expect(client.getStatus().devicePresent).toBe(true);
  });

  it("notifies status subscribers until they unsubscribe", () => {
    const { client, latest } = setup();
    const states: string[] = [];
    const off = client.onStatus((s) => states.push(s.state));
    client.start();
    latest().open();
    latest().attach();
    off();
    latest().drop();
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("does nothing when started twice", () => {
    const { client, sockets } = setup();
    client.start();
    client.start();
    expect(sockets).toHaveLength(1);
  });
});

describe("RelayClient: reconnect with backoff", () => {
  it("reconnects after a drop with growing delays", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().open();
    latest().attach();

    latest().drop();
    expect(client.getStatus()).toMatchObject({ state: "reconnecting", attempt: 1, nextRetryInMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(client.getStatus().state).toBe("connecting");

    // The second attempt fails before the socket ever opens.
    latest().drop();
    expect(client.getStatus()).toMatchObject({ attempt: 2, nextRetryInMs: 2000 });
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(3);

    latest().drop();
    expect(client.getStatus().nextRetryInMs).toBe(4000);
    vi.advanceTimersByTime(4000);
    latest().drop();
    expect(client.getStatus().nextRetryInMs).toBe(8000);
    vi.advanceTimersByTime(8000);
    latest().drop();
    // Capped.
    expect(client.getStatus().nextRetryInMs).toBe(8000);
  });

  it("does not reset the backoff when a connection drops before it was stable", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().open();
    latest().attach();
    latest().drop();
    vi.advanceTimersByTime(1000);

    latest().open();
    latest().attach();
    vi.advanceTimersByTime(9_999); // just short of the stable threshold
    latest().drop();
    expect(client.getStatus()).toMatchObject({ attempt: 2, nextRetryInMs: 2000 });
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(3);
  });

  it("resets the backoff after a connection stays attached long enough", () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().attach();
    latest().drop();
    vi.advanceTimersByTime(1000);
    latest().drop();
    vi.advanceTimersByTime(2000);

    latest().open();
    latest().attach();
    vi.advanceTimersByTime(10_000);
    expect(client.getStatus().attempt).toBe(0);
    latest().drop();
    expect(client.getStatus()).toMatchObject({ attempt: 1, nextRetryInMs: 1000 });
  });

  it("retries when the socket never opens or attaches in time", () => {
    const { client, sockets } = setup();
    client.start();
    vi.advanceTimersByTime(5000);
    expect(sockets[0]?.closed).toBe(true);
    expect(client.getStatus()).toMatchObject({ state: "reconnecting", nextRetryInMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it("retries when the socket opens but the relay never answers the attach", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().open();
    vi.advanceTimersByTime(5000);
    expect(client.getStatus().state).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it("retries when creating the socket throws", () => {
    let calls = 0;
    const { client } = setup({
      createSocket: () => {
        calls++;
        throw new Error("blocked");
      },
    });
    client.start();
    expect(client.getStatus().state).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(2);
  });

  it("ignores late events from a socket that was already replaced", () => {
    const { client, sockets } = setup();
    client.start();
    const first = sockets[0];
    first?.open();
    first?.attach();
    first?.drop();
    vi.advanceTimersByTime(1000);
    const second = sockets[1];
    second?.open();
    second?.attach();

    first?.drop(); // a stray close from the old socket
    expect(client.getStatus().state).toBe("connected");
    expect(sockets).toHaveLength(2);
  });

  it("does not reconnect after stop, and cancels a pending retry", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().open();
    latest().attach();
    latest().drop();
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.getStatus().state).toBe("stopped");
  });

  it("closes the socket on stop and ignores its close event", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().open();
    latest().attach();
    const socket = latest();
    client.stop();
    expect(socket.closed).toBe(true);
    socket.drop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.getStatus().state).toBe("stopped");
  });

  it("can be started again after stop with a fresh backoff", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().drop();
    client.stop();
    client.start();
    expect(sockets).toHaveLength(2);
    latest().drop();
    expect(client.getStatus()).toMatchObject({ attempt: 1, nextRetryInMs: 1000 });
  });

  it("stops retrying after a fatal relay error", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().open();
    latest().receive({ type: "error", code: "unsupported_version", message: "nope" });
    expect(client.getStatus()).toMatchObject({ state: "failed", lastError: "unsupported_version" });
    latest().drop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("keeps retrying after a transient relay error and records it", () => {
    const { client, sockets, latest } = setup();
    client.start();
    latest().open();
    latest().receive({ type: "error", code: "rate_limited", message: "slow down" });
    expect(client.getStatus().lastError).toBe("rate_limited");
    latest().drop();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });
});

describe("RelayClient: frames", () => {
  function attached(): Harness {
    const h = setup();
    h.client.start();
    h.latest().open();
    h.latest().attach();
    return h;
  }

  it("encodes outgoing frames as opaque base64", () => {
    const { client, latest } = attached();
    client.sendFrame(Uint8Array.of(1, 2, 3, 250));
    expect(latest().sent.at(-1)).toEqual({ type: "frame", data: encodeBase64(Uint8Array.of(1, 2, 3, 250)) });
  });

  it("delivers incoming frames as bytes to every subscriber", () => {
    const { client, latest } = attached();
    const a: number[][] = [];
    const b: number[][] = [];
    client.onFrame((f) => a.push(Array.from(f)));
    const off = client.onFrame((f) => b.push(Array.from(f)));
    latest().receive({ type: "frame", data: encodeBase64(Uint8Array.of(9, 8, 7)) });
    off();
    latest().receive({ type: "frame", data: encodeBase64(Uint8Array.of(1)) });
    expect(a).toEqual([[9, 8, 7], [1]]);
    expect(b).toEqual([[9, 8, 7]]);
  });

  it("refuses to send, rather than queue, when not attached", () => {
    const { client, latest } = setup();
    expect(() => client.sendFrame(Uint8Array.of(1))).toThrow(RelayNotConnectedError);
    client.start();
    latest().open();
    expect(() => client.sendFrame(Uint8Array.of(1))).toThrow(RelayNotConnectedError);
    latest().attach();
    latest().drop();
    expect(() => client.sendFrame(Uint8Array.of(1))).toThrow(RelayNotConnectedError);
    // Nothing was sent beyond the attach.
    expect(latest().sent).toHaveLength(1);
  });

  it("refuses empty and oversized outgoing frames", () => {
    const { client } = attached();
    expect(() => client.sendFrame(new Uint8Array(0))).toThrow();
    expect(() => client.sendFrame(new Uint8Array(DEFAULT_MAX_FRAME_BYTES + 1))).toThrow(FrameTooLargeError);
    expect(() => client.sendFrame(new Uint8Array(DEFAULT_MAX_FRAME_BYTES))).not.toThrow();
  });

  it("ignores frames that arrive before the attach is confirmed", () => {
    const { client, latest } = setup();
    const seen: unknown[] = [];
    client.onFrame((f) => seen.push(f));
    client.start();
    latest().open();
    latest().receive({ type: "frame", data: encodeBase64(Uint8Array.of(1)) });
    expect(seen).toEqual([]);
  });

  it("ignores malformed relay messages without crashing", () => {
    const { client, latest } = attached();
    const seen: unknown[] = [];
    client.onFrame((f) => seen.push(f));
    for (const bad of [
      "not json",
      "[]",
      "null",
      { type: "frame" },
      { type: "frame", data: "***" },
      { type: "frame", data: "" },
      { type: "frame", data: 5 },
      { type: "peer_state", present: "yes" },
      { type: "attached", devicePresent: "yes" },
      { type: "unknown" },
      { type: "challenge", challenge: "x" },
    ]) {
      latest().receive(bad);
    }
    latest().onmessage?.({ data: new ArrayBuffer(4) });
    expect(seen).toEqual([]);
    expect(client.getStatus().state).toBe("connected");
  });

  it("drops incoming frames larger than the limit", () => {
    const { client, latest } = attached();
    const seen: unknown[] = [];
    client.onFrame((f) => seen.push(f));
    latest().receive({ type: "frame", data: encodeBase64(new Uint8Array(DEFAULT_MAX_FRAME_BYTES + 1)) });
    expect(seen).toEqual([]);
  });
});

describe("RelayClient: keepalive and connection epoch", () => {
  it("sends exact keepalive pings and reconnects when pong times out", () => {
    const { client, sockets, latest } = setup({
      keepaliveIntervalMs: 5_000,
      keepaliveTimeoutMs: 2_000,
    });
    client.start();
    latest().open();
    latest().attach();

    vi.advanceTimersByTime(5_000);
    expect(latest().sent.at(-1)).toEqual(JSON.parse(KEEPALIVE_PING));

    latest().receive({ type: "pong" });
    vi.advanceTimersByTime(2_000);
    expect(client.getStatus().state).toBe("connected");

    // Second ping goes unanswered past keepaliveTimeoutMs -> reconnects.
    vi.advanceTimersByTime(3_000);
    expect(latest().sent.at(-1)).toEqual(JSON.parse(KEEPALIVE_PING));
    vi.advanceTimersByTime(2_000);
    expect(sockets[0]?.closed).toBe(true);
    expect(client.getStatus().state).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it("increments peerEpoch when device attaches or re-registers and captures close codes", () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().attach(true);
    expect(client.getStatus()).toMatchObject({
      connectionId: "c1",
      peerEpoch: 1,
      devicePresent: true,
    });

    // Daemon replaces its socket on the relay -> relay pushes peer_state present: true again.
    latest().receive({ type: "peer_state", present: true });
    expect(client.getStatus().peerEpoch).toBe(2);

    latest().onclose?.({ code: RELAY_CLOSE_CODES.evicted, reason: "evicted" });
    expect(client.getStatus()).toMatchObject({
      state: "reconnecting",
      connectionId: null,
      lastCloseCode: RELAY_CLOSE_CODES.evicted,
    });
  });
});

