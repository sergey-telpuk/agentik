/**
 * One Durable Object serves the connections of one computer.
 *
 * The object's name is derived from the device identifier, so no mapping
 * table is needed: a peer asking for a device reaches the same object every
 * time.
 *
 * What this object holds is deliberately small: the live sockets, the
 * challenge issued to each unauthenticated socket, the connection identifier
 * of each attached client, and counters for the limits. No frame contents,
 * no Noise keys, and no task history. Frames pass through as opaque bytes and
 * are never written to storage or to logs.
 *
 * The WebSocket Hibernation API is used: the handler may be evicted while
 * sockets stay open, and an inbound message revives it. Per-socket state
 * therefore lives in a serialisable attachment rather than in instance
 * fields, which do not survive eviction.
 */

import {
  CLOSE_CODES,
  KEEPALIVE_PING,
  KEEPALIVE_PONG,
  type AttachPayload,
  type ErrorCode,
  type FramePayload,
  type RegisterPayload,
  type ServerMessage,
  errorMessage,
  frameMessage,
  newConnectionId,
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
import { LIMITS, sourceKey } from "./limits";
import { QueueLedger, sendWithinBudget } from "./backpressure";

/** Bindings available to the Worker and the object. */
export interface Env {
  RELAY_ID: string;
  DEVICE: DurableObjectNamespace;
  /** Per-source-IP WebSocket upgrades; see limits.ts. */
  CONNECT_LIMITER: RateLimit;
  /** Per-source-IP registration attempts; see limits.ts. */
  REGISTER_LIMITER: RateLimit;
}


/**
 * Per-socket state, stored as a hibernation attachment.
 *
 * Roles: `pending` holds an unused challenge; `verifying` has consumed it
 * and is awaiting signature verification; `device` and `client` are
 * established; `closing` was closed by the relay and is ignored from then on.
 */
interface SocketState {
  /** What this socket is allowed to do. */
  role: "pending" | "verifying" | "device" | "client" | "closing";
  /** Base64 challenge issued to this socket, cleared once consumed. */
  challenge?: string;
  /** When the socket must have authenticated by (epoch ms). */
  challengeExpiresAt?: number;
  /**
   * Source address an unauthenticated socket connected from, kept only
   * until it registers or attaches, for the per-IP registration limit.
   */
  sourceIp?: string;
  /** Relay-assigned identifier of an attached client. */
  connectionId?: string;
  /** When a client attached or last had a frame forwarded either way (epoch ms). */
  lastActivity?: number;
  /** Start of the current rate-limit window (epoch ms). */
  windowStart: number;
  /** Frames seen in the current window. */
  windowCount: number;
}

function isUnauthenticated(state: SocketState): boolean {
  return state.role === "pending" || state.role === "verifying";
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
  /**
   * Who the bytes queued toward each device socket belong to. Kept in
   * memory only: after the object is evicted, whatever is still queued is
   * charged to no client, which only makes the shared limit stricter.
   */
  readonly #ledgers = new WeakMap<WebSocket, QueueLedger>();

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    // Keepalive is answered by the runtime, so it needs no timer here and
    // never wakes the object; see KEEPALIVE_PING.
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG),
    );
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

    const now = Date.now();
    this.#sweepExpired(now);
    this.#makeRoomForPending();

    const pair = new WebSocketPair();
    const [clientSide, serverSide] = Object.values(pair) as [WebSocket, WebSocket];

    // acceptWebSocket (rather than accept) is what allows this object to be
    // evicted while the socket stays open.
    this.#state.acceptWebSocket(serverSide);

    const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_SIZE));
    const challengeText = encodeBase64(challenge);
    const expiresAt = now + LIMITS.challengeTtlMs;

    writeState(serverSide, {
      role: "pending",
      challenge: challengeText,
      challengeExpiresAt: expiresAt,
      sourceIp: sourceKey(request),
      windowStart: now,
      windowCount: 0,
    });

    this.#send(serverSide, {
      type: "challenge",
      challenge: challengeText,
      relayId: this.#env.RELAY_ID,
      expiresAt: Math.floor(expiresAt / 1000),
    });

    // A socket that never sends anything would otherwise never be looked at
    // again. The alarm wakes the object at the deadline without a timer that
    // would keep it from hibernating.
    await this.#scheduleSweep(expiresAt);

    return new Response(null, { status: 101, webSocket: clientSide });
  }

  /** Closes unauthenticated sockets whose deadline has passed. */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.#sweepExpired(now);

    let next: number | null = null;
    for (const ws of this.#state.getWebSockets()) {
      const state = readState(ws);
      if (state === null || !isUnauthenticated(state)) continue;
      if (state.challengeExpiresAt === undefined) continue;
      if (next === null || state.challengeExpiresAt < next) next = state.challengeExpiresAt;
    }
    if (next !== null) await this.#state.storage.setAlarm(next);
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
    if (state.role === "closing") return;

    const now = Date.now();
    if (this.#isExpired(state, now)) {
      this.#closeWith(ws, "expired", "challenge expired");
      return;
    }
    this.#sweepExpired(now);

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
      if (isUnauthenticated(state)) {
        this.#closeWith(ws, parsed.code, parsed.message);
      } else {
        this.#send(ws, errorMessage(parsed.code, parsed.message));
      }
      return;
    }

    // The rate check rewrote the attachment; continue from what it stored.
    const current = readState(ws) ?? state;
    switch (parsed.value.type) {
      case "register":
        await this.#handleRegister(ws, current, parsed.value.payload);
        return;
      case "attach":
        this.#handleAttach(ws, current, parsed.value.payload);
        return;
      case "frame":
        this.#handleFrame(ws, current, parsed.value.payload);
        return;
    }
  }

  /** Notifies the peer when a socket goes away. */
  async webSocketClose(ws: WebSocket): Promise<void> {
    this.#markGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.#markGone(ws);
  }

  /** Announces a socket's departure once, however it ended. */
  #markGone(ws: WebSocket): void {
    const state = readState(ws);
    if (state === null || state.role === "closing") return;
    writeState(ws, { ...state, role: "closing" });
    this.#announceDeparture(ws, state);
  }

  #isExpired(state: SocketState, now: number): boolean {
    return (
      isUnauthenticated(state) &&
      (state.challengeExpiresAt === undefined || now >= state.challengeExpiresAt)
    );
  }

  /** Closes every unauthenticated socket past its deadline. */
  #sweepExpired(now: number): void {
    for (const ws of this.#state.getWebSockets()) {
      const state = readState(ws);
      if (state !== null && this.#isExpired(state, now)) {
        this.#closeWith(ws, "expired", "challenge expired");
      }
    }
  }

  /**
   * Evicts the oldest unauthenticated sockets so a new one fits.
   *
   * Refusing the newcomer instead would let a peer that opens sockets and
   * sends nothing hold every slot until the deadline, over and over.
   *
   * Sockets whose registration is being verified go last, and only when no
   * other socket is left to evict: otherwise a burst of new sockets could
   * evict a reconnecting daemon mid-verification. Every message from a
   * pending socket either closes it or moves it on, so the pending sockets
   * evicted first are ones that have sent nothing.
   */
  #makeRoomForPending(): void {
    const order = (state: SocketState | null): [number, number] => [
      state?.role === "verifying" ? 1 : 0,
      state?.challengeExpiresAt ?? 0,
    ];
    const pending = this.#state
      .getWebSockets()
      .map((ws) => ({ ws, state: readState(ws) }))
      .filter((entry) => entry.state !== null && isUnauthenticated(entry.state))
      .sort((a, b) => {
        const [roleA, expiryA] = order(a.state);
        const [roleB, expiryB] = order(b.state);
        return roleA - roleB || expiryA - expiryB;
      });
    while (pending.length >= LIMITS.maxPending) {
      const oldest = pending.shift();
      if (oldest === undefined) break;
      this.#sendFinal(
        oldest.ws,
        errorMessage("too_many_connections", "evicted to admit a newer connection"),
      );
      this.#drop(oldest.ws, CLOSE_CODES.evicted, "evicted");
    }
  }

  async #scheduleSweep(at: number): Promise<void> {
    const current = await this.#state.storage.getAlarm();
    if (current === null || current > at) {
      await this.#state.storage.setAlarm(at);
    }
  }

  /**
   * Reports whether a registration in progress may continue after an await.
   * The socket may have expired, been evicted, or closed in the meantime.
   */
  #stillVerifying(ws: WebSocket): boolean {
    return readState(ws)?.role === "verifying";
  }

  /**
   * Reports whether a device id names this object.
   *
   * The object's own id is compared with the id derived from the claimed
   * device, so the check does not depend on `id.name` being populated: an
   * object reached any other way fails closed.
   */
  #isThisRoute(deviceId: Uint8Array): boolean {
    const expected = this.#env.DEVICE.idFromName(formatDeviceId(deviceId));
    return expected.equals(this.#state.id);
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
    payload: RegisterPayload,
  ): Promise<void> {
    if (state.role !== "pending") {
      this.#send(ws, errorMessage("bad_request", "this connection is already registered or attached"));
      return;
    }

    // The challenge is consumed before the first await. Verification yields
    // to other events on this socket, and a second register or attach
    // arriving meanwhile must not find the challenge still unused.
    const expectedChallenge = state.challenge ? decodeBase64(state.challenge) : null;
    const challengeExpiresAt = state.challengeExpiresAt;
    const consumed: SocketState = {
      role: "verifying",
      windowStart: state.windowStart,
      windowCount: state.windowCount,
    };
    if (challengeExpiresAt !== undefined) consumed.challengeExpiresAt = challengeExpiresAt;
    writeState(ws, consumed);

    if (payload.version !== VERSION) {
      this.#closeWith(ws, "unsupported_version", "unsupported protocol version");
      return;
    }
    if (payload.relayId !== this.#env.RELAY_ID) {
      // A signature made for another relay must not be usable here.
      this.#closeWith(ws, "unauthorized", "registration is addressed to another relay");
      return;
    }

    // Every new device has to register, so limiting attempts per source
    // bounds how fast one address can create devices. It runs before the
    // signature check so a flood costs no cryptography.
    const outcome = await this.#env.REGISTER_LIMITER.limit({ key: state.sourceIp ?? "unknown" });
    if (!this.#stillVerifying(ws)) return;
    if (!outcome.success) {
      this.#closeWith(ws, "rate_limited", "too many registration attempts from this address");
      return;
    }

    if (expectedChallenge === null || challengeExpiresAt === undefined) {
      this.#closeWith(ws, "internal", "no challenge was issued for this connection");
      return;
    }
    if (Date.now() >= challengeExpiresAt) {
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
    if (!this.#stillVerifying(ws)) return;
    if (!constantTimeEqual(payload.deviceId, derivedId)) {
      this.#closeWith(ws, "unauthorized", "device id does not match the registration key");
      return;
    }

    // The object is addressed by device id, so a registration for a
    // different device reaching this object would mean the route and the
    // claim disagree.
    if (!this.#isThisRoute(derivedId)) {
      this.#closeWith(ws, "unauthorized", "registration does not match this route");
      return;
    }

    const signed = registerSigningBytes(toRegisterRequest(payload));
    const valid = await verifyEd25519(payload.registerPublicKey, signed, payload.signature);
    if (!this.#stillVerifying(ws)) return;
    if (!valid) {
      this.#closeWith(ws, "unauthorized", "signature verification failed");
      return;
    }

    const previous = this.#sockets("device").filter((other) => other !== ws);
    writeState(ws, {
      role: "device",
      windowStart: state.windowStart,
      windowCount: state.windowCount,
    });

    // Proof of the same key replaces an older device connection. An
    // unauthorized peer cannot reach this point, so it cannot evict a
    // running daemon. The route stays present throughout, so clients are
    // not told the device left; the presence update below tells them a new
    // device connection (and so a new Noise session) is in place.
    for (const other of previous) {
      this.#drop(other, CLOSE_CODES.replaced, "replaced by a newer registration", false);
    }

    // The device learns which clients are already waiting, so it can expect
    // their handshakes.
    const clients = this.#sockets("client");
    const connections = clients
      .map((client) => readState(client)?.connectionId)
      .filter((id): id is string => id !== undefined);
    this.#send(ws, { type: "registered", deviceId: formatDeviceId(derivedId), connections });

    // Clients waiting on this device learn it is reachable.
    for (const client of clients) {
      this.#send(client, { type: "peer_state", present: true });
    }
  }

  /**
   * Routes a client to this device.
   *
   * No authority is granted here. The client can exchange frames; the device
   * decides during the Noise handshake whether it is a paired peer.
   */
  #handleAttach(ws: WebSocket, state: SocketState, payload: AttachPayload): void {
    if (state.role !== "pending") {
      this.#send(ws, errorMessage("bad_request", "this connection is already registered or attached"));
      return;
    }
    if (payload.version !== VERSION) {
      this.#closeWith(ws, "unsupported_version", "unsupported protocol version");
      return;
    }

    if (!this.#isThisRoute(payload.deviceId)) {
      this.#closeWith(ws, "bad_request", "device id does not match this route");
      return;
    }

    // Arrivals are the one notice to the device a client can cause at
    // will, so they may use only half of the device's reserve. The other
    // half is left for departure notices, which cannot be refused, so a
    // stream of attaches cannot push a slow device past its limit.
    const connectionId = newConnectionId();
    const arrival = serializeServerMessage({ type: "peer_state", connectionId, present: true });
    const devices = this.#sockets("device");
    const arrivalLimit = LIMITS.maxDeviceBufferedBytes - LIMITS.deviceReserveBytes / 2;
    if (devices.some((daemon) => daemon.bufferedAmount + arrival.length > arrivalLimit)) {
      this.#closeWith(ws, "peer_unavailable", "the device is not keeping up; try again later");
      return;
    }

    // Bounding attached clients keeps one device's route from being used to
    // hold open an unbounded number of sockets. When the slots are full, an
    // idle client gives way to the newcomer, so sockets that attach and then
    // sit silent cannot lock the paired phone out. Busy clients are never
    // displaced, and the device connection is not a client slot at all.
    const now = Date.now();
    const clients = this.#sockets("client");
    if (clients.length >= LIMITS.maxClients) {
      const victim = this.#idlestClient(clients, now);
      if (victim === null) {
        this.#closeWith(ws, "too_many_connections", "too many clients attached to this device");
        return;
      }
      this.#sendFinal(
        victim,
        errorMessage("too_many_connections", "evicted while idle to admit a newer client"),
      );
      this.#drop(victim, CLOSE_CODES.evicted, "evicted while idle");
    }

    writeState(ws, {
      role: "client",
      connectionId,
      lastActivity: now,
      windowStart: state.windowStart,
      windowCount: state.windowCount,
    });

    this.#send(ws, {
      type: "attached",
      deviceId: formatDeviceId(payload.deviceId),
      connectionId,
      devicePresent: devices.length > 0,
    });

    // The device is told which client arrived, so it can expect a handshake
    // on that connection rather than discovering it only when a frame appears.
    for (const daemon of devices) {
      this.#send(daemon, { type: "peer_state", connectionId, present: true });
    }
  }

  /**
   * Forwards one opaque frame to its addressee.
   *
   * A device frame goes to exactly the client it names. A client frame goes
   * to the device, tagged with the connection id the relay assigned, so the
   * device can keep a separate Noise session per client.
   *
   * The relay is not a queue: with no peer connected, the sender is told so
   * rather than the frame being held for later delivery. A task is not
   * accepted because the cloud took the bytes.
   */
  #handleFrame(ws: WebSocket, state: SocketState, payload: FramePayload): void {
    if (state.role !== "device" && state.role !== "client") {
      this.#closeWith(ws, "not_registered", "register or attach before sending frames");
      return;
    }

    if (state.role === "device") {
      if (payload.connectionId === undefined) {
        this.#send(ws, errorMessage("bad_request", "connection_id is required on device frames"));
        return;
      }
      const target = this.#client(payload.connectionId);
      if (target === null) {
        this.#send(
          ws,
          errorMessage("peer_unavailable", "the client is not connected", payload.connectionId),
        );
        return;
      }
      if (this.#send(target, frameMessage(payload.data))) {
        this.#touch(target);
      } else {
        this.#send(
          ws,
          errorMessage(
            "peer_unavailable",
            "the client was too slow and was disconnected",
            payload.connectionId,
          ),
        );
      }
      return;
    }

    // A client's identity comes from the relay, never from the client.
    if (payload.connectionId !== undefined) {
      this.#send(ws, errorMessage("bad_request", "clients must not set connection_id"));
      return;
    }
    if (state.connectionId === undefined) {
      this.#closeWith(ws, "internal", "connection state is unavailable");
      return;
    }
    const devices = this.#sockets("device");
    if (devices.length === 0) {
      this.#send(ws, errorMessage("peer_unavailable", "the peer is not connected"));
      return;
    }
    const message = serializeServerMessage(frameMessage(payload.data, state.connectionId));
    for (const daemon of devices) {
      if (!this.#forwardToDevice(daemon, message, state.connectionId)) {
        // The sender is closed, not the device: otherwise any peer that
        // knows the device id could disconnect it by flooding frames.
        this.#closeWith(ws, "rate_limited", "frames are arriving faster than the device reads them");
        return;
      }
    }
    this.#touch(ws);
  }

  /**
   * Sends a client's frame to the device within that client's share of the
   * device's queue, and within the part of the queue clients may use at
   * all. Returns false, without sending, when the frame does not fit.
   */
  #forwardToDevice(device: WebSocket, message: string, connectionId: string): boolean {
    const charged = this.#ledger(device).inFlight(connectionId);
    if (charged + message.length > LIMITS.maxClientShareBytes) return false;
    const clientLimit = LIMITS.maxDeviceBufferedBytes - LIMITS.deviceReserveBytes;
    return this.#deliver(device, message, clientLimit, connectionId);
  }

  /** Returns a device socket's ledger, brought up to date with what has drained. */
  #ledger(device: WebSocket): QueueLedger {
    let ledger = this.#ledgers.get(device);
    if (ledger === undefined) {
      ledger = new QueueLedger(device.bufferedAmount);
      this.#ledgers.set(device, ledger);
    }
    ledger.settle(device.bufferedAmount);
    return ledger;
  }

  /**
   * Sends unless the receiver's queue would go past `limit` bytes, and
   * records a message to the device on its ledger, charged to `owner`.
   * Returns false, without sending, when it would not fit.
   */
  #deliver(target: WebSocket, message: string, limit: number, owner?: string): boolean {
    const ledger = readState(target)?.role === "device" ? this.#ledger(target) : null;
    if (!sendWithinBudget(target, message, limit)) return false;
    ledger?.record(message.length, owner);
    return true;
  }

  /**
   * Records a frame forwarded to or from a client, so it does not count as
   * idle. Nothing else counts: a malformed or refused message would
   * otherwise let a client hold a slot by sending junk.
   */
  #touch(client: WebSocket): void {
    const state = readState(client);
    if (state?.role === "client") writeState(client, { ...state, lastActivity: Date.now() });
  }

  /**
   * Picks the client that has been idle longest, if any has been idle long
   * enough to give way to a newcomer.
   */
  #idlestClient(clients: WebSocket[], now: number): WebSocket | null {
    let victim: WebSocket | null = null;
    let oldest = now - LIMITS.clientIdleMs;
    for (const client of clients) {
      const lastActivity = readState(client)?.lastActivity ?? 0;
      if (lastActivity <= oldest) {
        oldest = lastActivity;
        victim = client;
      }
    }
    return victim;
  }

  /**
   * Tells the remaining peers that one side disconnected.
   *
   * `state` is the socket's state from before it was marked closing.
   */
  #announceDeparture(closing: WebSocket, state: SocketState): void {
    if (state.role === "client") {
      if (state.connectionId === undefined) return;
      for (const daemon of this.#sockets("device")) {
        this.#send(daemon, {
          type: "peer_state",
          connectionId: state.connectionId,
          present: false,
        });
      }
      return;
    }

    if (state.role !== "device") return;
    const present = this.#sockets("device").some((s) => s !== closing);
    for (const client of this.#sockets("client")) {
      this.#send(client, { type: "peer_state", present });
    }
  }

  /** Returns the live sockets holding a given role. */
  #sockets(role: SocketState["role"]): WebSocket[] {
    return this.#state.getWebSockets().filter((ws) => readState(ws)?.role === role);
  }

  /** Returns the attached client with a given connection id. */
  #client(connectionId: string): WebSocket | null {
    for (const ws of this.#state.getWebSockets()) {
      const state = readState(ws);
      if (state?.role === "client" && state.connectionId === connectionId) return ws;
    }
    return null;
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
    const allowed =
      state.role === "device" ? LIMITS.maxDeviceFramesPerWindow : LIMITS.maxFramesPerWindow;
    return windowCount <= allowed;
  }

  /**
   * Sends a relay message within the receiver's queue budget. A receiver
   * that would exceed it is closed and its peers are told it left; the
   * message is dropped rather than queued, so a peer that never reads
   * cannot make the relay hold an unbounded backlog of replies.
   */
  #send(ws: WebSocket, message: ServerMessage): boolean {
    if (this.#deliver(ws, serializeServerMessage(message), this.#budget(ws))) return true;
    this.#drop(ws, CLOSE_CODES.slowReceiver, "receive queue limit exceeded");
    return false;
  }

  /**
   * Sends the last message before the relay closes a socket. It is dropped
   * if it does not fit: the socket is closing anyway.
   */
  #sendFinal(ws: WebSocket, message: ServerMessage): void {
    this.#deliver(ws, serializeServerMessage(message), this.#budget(ws));
  }

  /** The most a socket's queue may hold of the relay's messages. */
  #budget(ws: WebSocket): number {
    return readState(ws)?.role === "device"
      ? LIMITS.maxDeviceBufferedBytes
      : LIMITS.maxBufferedBytes;
  }

  /** Reports an error and closes the socket. */
  #closeWith(ws: WebSocket, code: ErrorCode, message: string): void {
    this.#sendFinal(ws, errorMessage(code, message));
    this.#drop(ws, CLOSE_CODES.protocolError, code);
  }

  /**
   * Closes a socket from the relay side.
   *
   * The socket is marked closing first, so it stops receiving frames and its
   * close event is not announced a second time. Its peers are told it left
   * unless `announce` is false.
   */
  #drop(ws: WebSocket, code: number, reason: string, announce = true): void {
    const state = readState(ws);
    if (state !== null && state.role !== "closing") {
      writeState(ws, { ...state, role: "closing" });
      if (announce) this.#announceDeparture(ws, state);
    }
    this.#closeSocket(ws, code, reason);
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
