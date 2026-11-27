/**
 * One Durable Object serves the connections of one computer.
 *
 * The object's name is derived from the device identifier, so no mapping
 * table is needed: a peer asking for a device reaches the same object every
 * time.
 *
 * What this object holds is deliberately small: the live sockets, the
 * challenge issued to each unauthenticated socket, and counters for the
 * limits. No frame contents, no Noise keys, and no task history. Frames pass
 * through as opaque bytes and are never written to storage or to logs.
 *
 * The WebSocket Hibernation API is used: the handler may be evicted while
 * sockets stay open, and an inbound message revives it. Per-socket state
 * therefore lives in a serialisable attachment rather than in instance
 * fields, which do not survive eviction.
 */

import {
  type ErrorCode,
  type ServerMessage,
  errorMessage,
  frameMessage,
  parseClientMessage,
  serializeServerMessage,
  toRegisterRequest,
} from "./messages";
import {
  CHALLENGE_SIZE,
  MAX_CLOCK_SKEW_MS,
  VERSION,
  constantTimeEqual,
  decodeBase64,
  encodeBase64,
  formatDeviceId,
  registerSigningBytes,
  sha256,
  verifyEd25519,
} from "./protocol";

/** Bindings available to the object. */
export interface Env {
  RELAY_ID: string;
  DEVICE: DurableObjectNamespace;
}

/**
 * Operational limits.
 *
 * These are the design starting points from the architecture document, not
 * measured capacity. They are collected here so that load testing can move
 * them in one place.
 */
export const LIMITS = {
  /** Largest frame payload the relay will forward, in bytes. */
  maxFrameBytes: 32 * 1024,
  /** How long an unauthenticated socket may stay open. */
  challengeTtlMs: 30_000,
  /** Clients attached to one device at once. */
  maxClients: 4,
  /** Frames per second from one socket, averaged over the window. */
  maxFramesPerWindow: 120,
  /** Length of the rate-limiting window. */
  rateWindowMs: 1_000,
} as const;

/** Per-socket state, stored as a hibernation attachment. */
interface SocketState {
  /** What this socket is allowed to do. */
  role: "pending" | "device" | "client";
  /** Base64 challenge issued to this socket, cleared once registered. */
  challenge?: string;
  /** When the challenge stops being acceptable (epoch ms). */
  challengeExpiresAt?: number;
  /** Start of the current rate-limit window (epoch ms). */
  windowStart: number;
  /** Frames seen in the current window. */
  windowCount: number;
}

/**
 * Serialisable state kept across hibernation.
 *
 * Attachments have a small size limit, so only short fields go here.
 */
function readState(ws: WebSocket): SocketState | null {
  const raw = ws.deserializeAttachment() as unknown;
  if (typeof raw !== "object" || raw === null) return null;
  return raw as SocketState;
}

function writeState(ws: WebSocket, state: SocketState): void {
  ws.serializeAttachment(state);
}

export class DeviceRoom implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
  }

  /**
   * Accepts a WebSocket and issues this socket's challenge.
   *
   * The challenge is bound to this one socket, so a signature captured from
   * another connection cannot be replayed here.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [clientSide, serverSide] = Object.values(pair) as [WebSocket, WebSocket];

    // acceptWebSocket (rather than accept) is what allows this object to be
    // evicted while the socket stays open.
    this.#state.acceptWebSocket(serverSide);

    const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_SIZE));
    const challengeText = encodeBase64(challenge);
    const expiresAt = Date.now() + LIMITS.challengeTtlMs;

    writeState(serverSide, {
      role: "pending",
      challenge: challengeText,
      challengeExpiresAt: expiresAt,
      windowStart: Date.now(),
      windowCount: 0,
    });

    this.#send(serverSide, {
      type: "challenge",
      challenge: challengeText,
      relayId: this.#env.RELAY_ID,
      expiresAt: Math.floor(expiresAt / 1000),
    });

    return new Response(null, { status: 101, webSocket: clientSide });
  }

  /** Handles one inbound message. */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const state = readState(ws);
    if (state === null) {
      // An attachment this object cannot read means the socket predates a
      // format change; closing is safer than guessing its privileges.
      this.#closeWith(ws, "internal", "connection state is unavailable");
      return;
    }

    // Binary frames are not part of the protocol: every message is JSON
    // with base64 payloads, which keeps parsing uniform.
    if (typeof message !== "string") {
      this.#closeWith(ws, "bad_request", "messages must be text");
      return;
    }

    if (!this.#allowMessage(ws, state)) {
      this.#closeWith(ws, "rate_limited", "message rate exceeded");
      return;
    }

    const parsed = parseClientMessage(message, LIMITS.maxFrameBytes);
    if (!parsed.ok) {
      // A malformed message is reported but does not close an established
      // session: a single bad frame should not drop a working connection.
      if (state.role === "pending") {
        this.#closeWith(ws, parsed.code, parsed.message);
      } else {
        this.#send(ws, errorMessage(parsed.code, parsed.message));
      }
      return;
    }

    switch (parsed.value.type) {
      case "register":
        await this.#handleRegister(ws, state, parsed.value.payload);
        return;
      case "attach":
        this.#handleAttach(ws, state, parsed.value.payload);
        return;
      case "frame":
        this.#handleFrame(ws, state, parsed.value.payload.data);
        return;
    }
  }

  /** Notifies the peer when a socket goes away. */
  async webSocketClose(ws: WebSocket): Promise<void> {
    this.#announcePresence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.#announcePresence(ws);
  }

  /**
   * Verifies a device's claim to this route.
   *
   * Order matters: cheap structural checks run before the signature
   * verification, so malformed input costs less than a cryptographic
   * operation.
   */
  async #handleRegister(
    ws: WebSocket,
    state: SocketState,
    payload: import("./messages").RegisterPayload,
  ): Promise<void> {
    if (state.role !== "pending") {
      this.#send(ws, errorMessage("bad_request", "this connection is already registered"));
      return;
    }
    if (payload.version !== VERSION) {
      this.#closeWith(ws, "unsupported_version", "unsupported protocol version");
      return;
    }
    if (payload.relayId !== this.#env.RELAY_ID) {
      // A signature made for another relay must not be usable here.
      this.#closeWith(ws, "unauthorized", "registration is addressed to another relay");
      return;
    }

    const expectedChallenge = state.challenge ? decodeBase64(state.challenge) : null;
    if (expectedChallenge === null || state.challengeExpiresAt === undefined) {
      this.#closeWith(ws, "internal", "no challenge was issued for this connection");
      return;
    }
    if (Date.now() > state.challengeExpiresAt) {
      this.#closeWith(ws, "expired", "challenge expired");
      return;
    }
    if (!constantTimeEqual(payload.challenge, expectedChallenge)) {
      this.#closeWith(ws, "unauthorized", "challenge does not match this connection");
      return;
    }

    // The expiry is checked against relay time, bounded in both directions:
    // a stale request is rejected, and so is one whose clock is so far ahead
    // that the signature would stay valid indefinitely.
    const expiresAtMs = Number(payload.expiresAt) * 1000;
    const now = Date.now();
    if (now >= expiresAtMs) {
      this.#closeWith(ws, "expired", "registration expired");
      return;
    }
    if (expiresAtMs > now + MAX_CLOCK_SKEW_MS) {
      this.#closeWith(ws, "unauthorized", "registration expiry is too far ahead");
      return;
    }

    // The device identifier is recomputed from the key rather than trusted,
    // so a request cannot claim an address belonging to a different key.
    const derivedId = await sha256(payload.registerPublicKey);
    if (!constantTimeEqual(payload.deviceId, derivedId)) {
      this.#closeWith(ws, "unauthorized", "device id does not match the registration key");
      return;
    }

    // The object is addressed by device id, so a registration for a
    // different device reaching this object would mean the route and the
    // claim disagree.
    const expectedName = formatDeviceId(derivedId);
    if (this.#state.id.name !== undefined && this.#state.id.name !== expectedName) {
      this.#closeWith(ws, "unauthorized", "registration does not match this route");
      return;
    }

    const signed = registerSigningBytes(toRegisterRequest(payload));
    const valid = await verifyEd25519(payload.registerPublicKey, signed, payload.signature);
    if (!valid) {
      this.#closeWith(ws, "unauthorized", "signature verification failed");
      return;
    }

    // Proof of the same key replaces an older device connection. An
    // unauthorized peer cannot reach this point, so it cannot evict a
    // running daemon.
    for (const other of this.#sockets("device")) {
      if (other !== ws) {
        this.#closeSocket(other, 4000, "replaced by a newer registration");
      }
    }

    writeState(ws, {
      role: "device",
      windowStart: Date.now(),
      windowCount: 0,
    });
    this.#send(ws, { type: "registered", deviceId: expectedName });

    // Clients waiting on this device learn it is reachable.
    for (const client of this.#sockets("client")) {
      this.#send(client, { type: "peer_state", present: true });
    }
  }

  /**
   * Routes a client to this device.
   *
   * No authority is granted here. The client can exchange frames; the device
   * decides during the Noise handshake whether it is a paired peer.
   */
  #handleAttach(
    ws: WebSocket,
    state: SocketState,
    payload: import("./messages").AttachPayload,
  ): void {
    if (state.role !== "pending") {
      this.#send(ws, errorMessage("bad_request", "this connection is already attached"));
      return;
    }
    if (payload.version !== VERSION) {
      this.#closeWith(ws, "unsupported_version", "unsupported protocol version");
      return;
    }

    const requested = formatDeviceId(payload.deviceId);
    if (this.#state.id.name !== undefined && this.#state.id.name !== requested) {
      this.#closeWith(ws, "bad_request", "device id does not match this route");
      return;
    }

    // Bounding attached clients keeps one device's route from being used to
    // hold open an unbounded number of sockets.
    if (this.#sockets("client").length >= LIMITS.maxClients) {
      this.#closeWith(ws, "too_many_connections", "too many clients attached to this device");
      return;
    }

    writeState(ws, {
      role: "client",
      windowStart: Date.now(),
      windowCount: 0,
    });

    const devices = this.#sockets("device");
    this.#send(ws, {
      type: "attached",
      deviceId: requested,
      devicePresent: devices.length > 0,
    });

    // The device is told a client arrived, so it can expect a handshake
    // rather than discovering the peer only when a frame appears.
    for (const daemon of devices) {
      this.#send(daemon, { type: "peer_state", present: true });
    }
  }

  /**
   * Forwards one opaque frame to the peer.
   *
   * The relay is not a queue: with no peer connected, the sender is told so
   * rather than the frame being held for later delivery. A task is not
   * accepted because the cloud took the bytes.
   */
  #handleFrame(ws: WebSocket, state: SocketState, data: Uint8Array): void {
    if (state.role === "pending") {
      this.#closeWith(ws, "not_registered", "register or attach before sending frames");
      return;
    }

    const targets =
      state.role === "device" ? this.#sockets("client") : this.#sockets("device");
    if (targets.length === 0) {
      this.#send(ws, errorMessage("peer_unavailable", "the peer is not connected"));
      return;
    }

    const message = serializeServerMessage(frameMessage(data));
    for (const target of targets) {
      // A send that fails means the peer is gone; the close handler will
      // clean it up, and one dead socket must not stop the others.
      try {
        target.send(message);
      } catch {
        // Intentionally ignored: handled by webSocketClose.
      }
    }
  }

  /** Tells the remaining peers that one side disconnected. */
  #announcePresence(closing: WebSocket): void {
    const state = readState(closing);
    if (state === null || state.role === "pending") return;

    const audience = state.role === "device" ? "client" : "device";
    const present = this.#sockets(state.role).filter((s) => s !== closing).length > 0;
    for (const peer of this.#sockets(audience)) {
      this.#send(peer, { type: "peer_state", present });
    }
  }

  /** Returns the live sockets holding a given role. */
  #sockets(role: "device" | "client" | "pending"): WebSocket[] {
    return this.#state.getWebSockets().filter((ws) => readState(ws)?.role === role);
  }

  /**
   * Applies a per-socket rate limit using a fixed window.
   *
   * The counter lives in the socket attachment so it survives hibernation,
   * and needs no server-side timer that would keep the object awake.
   */
  #allowMessage(ws: WebSocket, state: SocketState): boolean {
    const now = Date.now();
    let { windowStart, windowCount } = state;
    if (now - windowStart >= LIMITS.rateWindowMs) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    writeState(ws, { ...state, windowStart, windowCount });
    return windowCount <= LIMITS.maxFramesPerWindow;
  }

  #send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(serializeServerMessage(message));
    } catch {
      // The socket is already gone; the close handler does the cleanup.
    }
  }

  /** Reports an error and closes the socket. */
  #closeWith(ws: WebSocket, code: ErrorCode, message: string): void {
    this.#send(ws, errorMessage(code, message));
    this.#closeSocket(ws, 4001, code);
  }

  #closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      // Close reasons are capped at 123 bytes by the WebSocket protocol.
      ws.close(code, reason.slice(0, 120));
    } catch {
      // Already closed.
    }
  }
}
