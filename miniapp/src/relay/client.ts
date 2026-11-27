/**
 * The relay connection: the ONLY module that knows the relay wire format
 * (`relay/src/messages.ts`, `relay/src/limits.ts`).
 *
 * It opens a WebSocket to `/v1/connect?device=<base32>`, attaches to one
 * computer, maintains keepalive pings, reconnects with exponential backoff,
 * and exposes opaque encrypted frames through `FrameTransport`. It never
 * interprets frame contents: confidentiality and authentication come from the
 * Noise session layered on top (`src/secure/noise.ts`).
 *
 * Reconnecting never resumes anything. A new socket is a new connection, so
 * whoever sits above must run a fresh handshake (AGENTIK.md section 6.1).
 * Frames are therefore never queued across a reconnect.
 */

import { decodeBase64, encodeBase64 } from "../encoding";
import type { FrameTransport } from "./frame-transport";

/** Envelope version sent in `attach`. */
export const ENVELOPE_VERSION = 1;

/** Path the relay serves WebSocket upgrades on. */
const CONNECT_PATH = "/v1/connect";

/** Exact JSON keepalive messages answered by the Cloudflare DO runtime. */
export const KEEPALIVE_PING = '{"type":"ping"}';
export const KEEPALIVE_PONG = '{"type":"pong"}';

/** WebSocket close codes assigned by `relay/src/messages.ts`. */
export const RELAY_CLOSE_CODES = {
  replaced: 4000,
  protocolError: 4001,
  slowReceiver: 4002,
  evicted: 4003,
} as const;

/** Messages this client sends. */
type OutboundMessage =
  | { type: "attach"; version: number; device_id: string }
  | { type: "frame"; data: string };

/** Known relay error codes from `relay/src/messages.ts`. */
export type RelayKnownErrorCode =
  | "bad_request"
  | "unsupported_version"
  | "unauthorized"
  | "expired"
  | "not_registered"
  | "peer_unavailable"
  | "too_many_connections"
  | "rate_limited"
  | "message_too_large"
  | "internal";

/** Error codes the relay may report. Open-ended for forward compatibility. */
export type RelayErrorCode = RelayKnownErrorCode | (string & {});

/** Error codes after which retrying cannot help, so the client stops. */
const FATAL_ERROR_CODES: ReadonlySet<string> = new Set(["bad_request", "unsupported_version"]);

/** Messages this client understands from the relay, after validation. */
type InboundMessage =
  | { type: "attached"; devicePresent: boolean; connectionId: string }
  | { type: "peer_state"; present: boolean }
  | { type: "frame"; data: Uint8Array }
  | { type: "error"; code: RelayErrorCode }
  | { type: "pong" };

/**
 * Validates one relay message. The relay is not a trusted party for message
 * shape: anything unexpected yields null and is ignored.
 */
function parseInbound(text: string): InboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const message = parsed as Record<string, unknown>;

  switch (message["type"]) {
    case "attached": {
      if (typeof message["devicePresent"] !== "boolean") return null;
      const id = message["connectionId"];
      if (typeof id !== "string" || id.length === 0) return null;
      return {
        type: "attached",
        devicePresent: message["devicePresent"],
        connectionId: id,
      };
    }
    case "peer_state":
      return typeof message["present"] === "boolean"
        ? { type: "peer_state", present: message["present"] }
        : null;
    case "frame": {
      if (typeof message["data"] !== "string") return null;
      const data = decodeBase64(message["data"]);
      return data !== null && data.length > 0 ? { type: "frame", data } : null;
    }
    case "error":
      return typeof message["code"] === "string" ? { type: "error", code: message["code"] } : null;
    case "pong":
      return { type: "pong" };
    default:
      // `challenge` and `registered` are for the computer, not for a phone.
      return null;
  }
}

function serialize(message: OutboundMessage): string {
  return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  /** Ceiling of the first retry delay. */
  readonly baseMs: number;
  /** Largest ceiling a retry delay can reach. */
  readonly maxMs: number;
  /** Growth per consecutive failure. */
  readonly factor: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 30_000, factor: 2 };

/**
 * Delay before retry number `attempt` (0 for the first retry).
 *
 * "Equal jitter": half the ceiling is fixed and half is random, so many
 * phones that lost the relay together do not reconnect in lockstep, while a
 * delay of zero (a tight reconnect loop) is impossible. `random` returns a
 * value in [0, 1).
 */
export function computeBackoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number,
): number {
  const ceiling = Math.min(options.maxMs, options.baseMs * options.factor ** attempt);
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** The subset of `WebSocket` the client uses, so tests can substitute a fake. */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RelayState =
  /** Not started, or stopped by the caller. */
  | "stopped"
  /** Opening the socket or waiting for the relay to accept the attach. */
  | "connecting"
  /** Attached: frames can flow. Says nothing about the computer being online. */
  | "connected"
  /** The connection dropped; a retry is scheduled. */
  | "reconnecting"
  /** The relay rejected the client permanently; retrying would not help. */
  | "failed";

export interface RelayStatus {
  readonly state: RelayState;
  /** Consecutive failed attempts since the last stable connection. */
  readonly attempt: number;
  /** Whether the computer is online behind the relay. Null until known. */
  readonly devicePresent: boolean | null;
  /** Relay-assigned connection ID for this WebSocket, or null when unattached. */
  readonly connectionId: string | null;
  /**
   * Incremented each time the device becomes available on the current socket
   * (either at `attached` with `devicePresent: true` or upon `peer_state`
   * with `present: true`, including when a daemon re-registers). Consumers use
   * this to start a fresh Noise handshake.
   */
  readonly peerEpoch: number;
  /** Milliseconds until the next retry while `reconnecting`. */
  readonly nextRetryInMs: number | null;
  /** The last relay error code, if any. Never contains frame contents. */
  readonly lastError: string | null;
  /** The WebSocket close code of the most recent close, if any. */
  readonly lastCloseCode: number | null;
}

export interface RelayClientOptions {
  /** `wss://` relay base URL, as validated by the invitation parser. */
  readonly relayUrl: string;
  /** 32-byte device identifier. */
  readonly deviceId: Uint8Array;
  /** Text form of `deviceId` for the relay's `device` query parameter. */
  readonly deviceIdText: string;
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly backoff?: BackoffOptions;
  /** Returns a value in [0, 1). Injectable for deterministic tests. */
  readonly random?: () => number;
  /** How long the socket may take to open and be attached. */
  readonly handshakeTimeoutMs?: number;
  /** A connection must stay attached this long before the backoff resets. */
  readonly stableAfterMs?: number;
  /** How often to send `KEEPALIVE_PING` while attached (`0` disables keepalive). */
  readonly keepaliveIntervalMs?: number;
  /** How long to wait for `KEEPALIVE_PONG` after sending a ping. */
  readonly keepaliveTimeoutMs?: number;
  /** Largest frame this client will send. */
  readonly maxFrameBytes?: number;
}

/** Matches `LIMITS.maxFrameBytes` in `relay/src/limits.ts`. */
export const DEFAULT_MAX_FRAME_BYTES = 32 * 1024;

export const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 10_000;

export class RelayNotConnectedError extends Error {
  constructor() {
    super("The relay connection is not attached");
    this.name = "RelayNotConnectedError";
  }
}

export class FrameTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Frame exceeds the ${limit}-byte limit`);
    this.name = "FrameTooLargeError";
  }
}

const INITIAL_STATUS: RelayStatus = {
  state: "stopped",
  attempt: 0,
  devicePresent: null,
  connectionId: null,
  peerEpoch: 0,
  nextRetryInMs: null,
  lastError: null,
  lastCloseCode: null,
};

export class RelayClient implements FrameTransport {
  readonly #options: Required<Omit<RelayClientOptions, "createSocket">> & {
    createSocket: (url: string) => WebSocketLike;
  };
  readonly #frameHandlers = new Set<(frame: Uint8Array) => void>();
  readonly #statusHandlers = new Set<(status: RelayStatus) => void>();

  #status: RelayStatus = INITIAL_STATUS;
  #socket: WebSocketLike | null = null;
  #attached = false;
  /** Bumped for every socket so events from an old one are ignored. */
  #generation = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #stableTimer: ReturnType<typeof setTimeout> | null = null;
  #keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  #keepaliveTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(options: RelayClientOptions) {
    this.#options = {
      relayUrl: options.relayUrl,
      deviceId: options.deviceId,
      deviceIdText: options.deviceIdText,
      createSocket: options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike),
      backoff: options.backoff ?? DEFAULT_BACKOFF,
      random: options.random ?? Math.random,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      stableAfterMs: options.stableAfterMs ?? 10_000,
      keepaliveIntervalMs: options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
      keepaliveTimeoutMs: options.keepaliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS,
      maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    };
  }

  getStatus(): RelayStatus {
    return this.#status;
  }

  /** Subscribes to status changes. Returns an unsubscribe function. */
  onStatus(handler: (status: RelayStatus) => void): () => void {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }

  onFrame(handler: (frame: Uint8Array) => void): () => void {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }

  /** Starts connecting. Calling it while already running does nothing. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#setStatus({ ...INITIAL_STATUS, state: "connecting" });
    this.#open();
  }

  /** Stops for good: closes the socket and cancels any scheduled retry. */
  stop(): void {
    this.#running = false;
    this.#clearTimers();
    this.#discardSocket();
    this.#attached = false;
    this.#setStatus({
      ...this.#status,
      state: "stopped",
      connectionId: null,
      devicePresent: null,
      nextRetryInMs: null,
    });
  }

  /**
   * Sends one opaque frame. Throws rather than queueing when not attached:
   * a frame held across a reconnect would belong to a dead Noise session.
   */
  sendFrame(frame: Uint8Array): void {
    if (!this.#attached || this.#socket === null) throw new RelayNotConnectedError();
    if (frame.length === 0) throw new Error("Frame is empty");
    if (frame.length > this.#options.maxFrameBytes) {
      throw new FrameTooLargeError(this.#options.maxFrameBytes);
    }
    this.#socket.send(serialize({ type: "frame", data: encodeBase64(frame) }));
  }

  // -- internals ------------------------------------------------------------

  #url(): string {
    const url = new URL(this.#options.relayUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${CONNECT_PATH}`;
    url.searchParams.set("device", this.#options.deviceIdText);
    return url.toString();
  }

  #open(): void {
    const generation = ++this.#generation;
    let socket: WebSocketLike;
    try {
      socket = this.#options.createSocket(this.#url());
    } catch {
      this.#scheduleReconnect(null);
      return;
    }
    this.#socket = socket;
    this.#attached = false;

    this.#handshakeTimer = setTimeout(() => {
      // Opened or not, the relay did not accept the attach in time.
      if (generation !== this.#generation) return;
      this.#discardSocket();
      this.#scheduleReconnect(null);
    }, this.#options.handshakeTimeoutMs);

    socket.onopen = () => {
      if (generation !== this.#generation) return;
      socket.send(
        serialize({
          type: "attach",
          version: ENVELOPE_VERSION,
          device_id: encodeBase64(this.#options.deviceId),
        }),
      );
    };
    socket.onmessage = (event) => {
      if (generation !== this.#generation) return;
      this.#handleMessage(event.data);
    };
    socket.onclose = (event) => {
      if (generation !== this.#generation) return;
      this.#scheduleReconnect(typeof event?.code === "number" ? event.code : null);
    };
    // An error is always followed by a close event, which does the work.
    socket.onerror = () => undefined;
  }

  #handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    const message = parseInbound(data);
    if (message === null) return;

    switch (message.type) {
      case "attached": {
        this.#attached = true;
        this.#clearTimer("handshake");
        this.#clearTimer("stable");
        this.#stableTimer = setTimeout(() => {
          // Held long enough to count as a healthy connection.
          this.#setStatus({ ...this.#status, attempt: 0 });
        }, this.#options.stableAfterMs);
        this.#scheduleKeepalive();
        const nextEpoch = message.devicePresent ? this.#status.peerEpoch + 1 : this.#status.peerEpoch;
        this.#setStatus({
          ...this.#status,
          state: "connected",
          devicePresent: message.devicePresent,
          connectionId: message.connectionId,
          peerEpoch: nextEpoch,
          nextRetryInMs: null,
        });
        return;
      }
      case "peer_state":
        if (this.#attached) {
          const nextEpoch = message.present ? this.#status.peerEpoch + 1 : this.#status.peerEpoch;
          this.#setStatus({
            ...this.#status,
            devicePresent: message.present,
            peerEpoch: nextEpoch,
          });
        }
        return;
      case "frame":
        // Frames are only meaningful from an attached connection.
        if (!this.#attached || message.data.length > this.#options.maxFrameBytes) return;
        for (const handler of this.#frameHandlers) handler(message.data);
        return;
      case "pong":
        this.#clearTimer("keepaliveTimeout");
        this.#scheduleKeepalive();
        return;
      case "error":
        if (FATAL_ERROR_CODES.has(message.code)) {
          this.#running = false;
          this.#clearTimers();
          this.#discardSocket();
          this.#attached = false;
          this.#setStatus({
            ...this.#status,
            state: "failed",
            connectionId: null,
            devicePresent: null,
            lastError: message.code,
            nextRetryInMs: null,
          });
        } else {
          this.#setStatus({ ...this.#status, lastError: message.code });
        }
        return;
    }
  }

  #scheduleKeepalive(): void {
    this.#clearTimer("keepalive");
    const interval = this.#options.keepaliveIntervalMs;
    if (!this.#running || !this.#attached || interval <= 0) return;
    const generation = this.#generation;
    this.#keepaliveTimer = setTimeout(() => {
      this.#keepaliveTimer = null;
      if (generation !== this.#generation || !this.#attached || this.#socket === null) return;
      try {
        this.#socket.send(KEEPALIVE_PING);
      } catch {
        this.#discardSocket();
        this.#scheduleReconnect(null);
        return;
      }
      this.#clearTimer("keepaliveTimeout");
      this.#keepaliveTimeoutTimer = setTimeout(() => {
        this.#keepaliveTimeoutTimer = null;
        if (generation !== this.#generation) return;
        this.#discardSocket();
        this.#scheduleReconnect(null);
      }, this.#options.keepaliveTimeoutMs);
    }, interval);
  }

  /** Called when the connection ended without the caller asking for it. */
  #scheduleReconnect(closeCode: number | null): void {
    this.#clearTimers();
    this.#socket = null;
    this.#attached = false;
    if (!this.#running) return;

    const attempt = this.#status.attempt;
    const delay = computeBackoffDelay(attempt, this.#options.backoff, this.#options.random);
    this.#setStatus({
      ...this.#status,
      state: "reconnecting",
      attempt: attempt + 1,
      devicePresent: null,
      connectionId: null,
      nextRetryInMs: delay,
      lastCloseCode: closeCode ?? this.#status.lastCloseCode,
    });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (!this.#running) return;
      this.#setStatus({ ...this.#status, state: "connecting", nextRetryInMs: null });
      this.#open();
    }, delay);
  }

  /** Detaches handlers and closes the socket without triggering a retry. */
  #discardSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    // A new generation turns every late event from this socket into a no-op.
    this.#generation++;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000, "client closing");
    } catch {
      // Already closed.
    }
  }

  #clearTimer(which: "retry" | "handshake" | "stable" | "keepalive" | "keepaliveTimeout"): void {
    if (which === "retry" && this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (which === "handshake" && this.#handshakeTimer !== null) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
    if (which === "stable" && this.#stableTimer !== null) {
      clearTimeout(this.#stableTimer);
      this.#stableTimer = null;
    }
    if (which === "keepalive" && this.#keepaliveTimer !== null) {
      clearTimeout(this.#keepaliveTimer);
      this.#keepaliveTimer = null;
    }
    if (which === "keepaliveTimeout" && this.#keepaliveTimeoutTimer !== null) {
      clearTimeout(this.#keepaliveTimeoutTimer);
      this.#keepaliveTimeoutTimer = null;
    }
  }

  #clearTimers(): void {
    this.#clearTimer("retry");
    this.#clearTimer("handshake");
    this.#clearTimer("stable");
    this.#clearTimer("keepalive");
    this.#clearTimer("keepaliveTimeout");
  }

  #setStatus(status: RelayStatus): void {
    this.#status = status;
    for (const handler of this.#statusHandlers) handler(status);
  }
}
