/**
 * Test helpers: a signing device and a WebSocket client that speak the real
 * protocol.
 *
 * These deliberately build registrations the same way the Go daemon does, so
 * a disagreement over the canonical encoding shows up as a failing test
 * rather than at integration time.
 */

import { env } from "cloudflare:test";
import {
  CanonicalEncoder,
  CONTEXT_RELAY_REGISTER,
  encodeBase64,
  formatDeviceId,
  sha256,
} from "../src/protocol";
import type { ServerMessage } from "../src/messages";

/** A device identity with an Ed25519 registration key. */
export interface TestDevice {
  publicKey: Uint8Array;
  privateKey: CryptoKey;
  deviceId: Uint8Array;
  deviceIdText: string;
}

/** Creates a device identity backed by WebCrypto Ed25519. */
export async function createDevice(): Promise<TestDevice> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  // exportKey is typed as returning either a buffer or a JWK; "raw" always
  // yields the buffer, so the result is narrowed explicitly.
  const exported = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const raw = new Uint8Array(exported);
  const deviceId = await sha256(raw);
  return {
    publicKey: raw,
    privateKey: pair.privateKey,
    deviceId,
    deviceIdText: formatDeviceId(deviceId),
  };
}

/** Options for building a registration, so tests can bend one field at a time. */
export interface RegisterOptions {
  version?: number;
  role?: string;
  relayId?: string;
  deviceId?: Uint8Array;
  challenge: Uint8Array;
  expiresAt?: number;
  /** Signs with this key instead of the device's own. */
  signWith?: CryptoKey;
  /** Replaces the signature with arbitrary bytes. */
  forgedSignature?: Uint8Array;
}

/** The relay id configured for the test environment. */
export const RELAY_ID = (env as unknown as { RELAY_ID: string }).RELAY_ID;

/**
 * Builds a registration message, signing exactly the bytes the relay will
 * re-encode.
 */
export async function buildRegister(
  device: TestDevice,
  options: RegisterOptions,
): Promise<string> {
  const version = options.version ?? 1;
  const role = options.role ?? "device";
  const relayId = options.relayId ?? RELAY_ID;
  const deviceId = options.deviceId ?? device.deviceId;
  const expiresAt = options.expiresAt ?? Math.floor(Date.now() / 1000) + 30;

  const signed = new CanonicalEncoder(CONTEXT_RELAY_REGISTER)
    .addUint16(version)
    .addString(role)
    .addString(relayId)
    .addBytes(deviceId)
    .addBytes(device.publicKey)
    .addBytes(options.challenge)
    .addInt64(BigInt(expiresAt))
    .bytes();

  let signature: Uint8Array;
  if (options.forgedSignature) {
    signature = options.forgedSignature;
  } else {
    const key = options.signWith ?? device.privateKey;
    signature = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, key, signed as BufferSource),
    );
  }

  return JSON.stringify({
    type: "register",
    version,
    role,
    relay_id: relayId,
    device_id: encodeBase64(deviceId),
    register_public_key: encodeBase64(device.publicKey),
    challenge: encodeBase64(options.challenge),
    expires_at: expiresAt,
    signature: encodeBase64(signature),
  });
}

const sourcePrefix = Array.from(crypto.getRandomValues(new Uint16Array(2)), (n) =>
  n.toString(16),
).join(":");
let sourceCounter = 0;

/** Returns a documentation-range IPv6 address no other connection uses. */
export function uniqueSourceIp(): string {
  sourceCounter += 1;
  return `2001:db8:${sourcePrefix}::${sourceCounter.toString(16)}`;
}

/**
 * A connected peer that collects server messages.
 *
 * Messages are queued as they arrive so a test can await the next one
 * without racing the socket.
 */
export class TestPeer {
  readonly #socket: WebSocket;
  readonly #queue: ServerMessage[] = [];
  #waiters: ((message: ServerMessage) => void)[] = [];
  #closed: { code: number; reason: string } | null = null;
  #closeWaiters: ((closed: { code: number; reason: string }) => void)[] = [];

  /** The connection id the relay assigned on attach, for client peers. */
  connectionId: string | undefined;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        this.#queue.push(message);
      }
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      this.#closed = { code: event.code, reason: event.reason };
      for (const waiter of this.#closeWaiters.splice(0)) waiter(this.#closed);
    });
  }

  /**
   * Opens a connection to the relay for a device id.
   *
   * Each connection comes from its own source address unless one is given,
   * so the per-IP limits only bite in the tests that aim at them.
   */
  static async connect(deviceIdText: string, sourceIp = uniqueSourceIp()): Promise<TestPeer> {
    const response = await (
      await import("cloudflare:test")
    ).SELF.fetch(`https://relay.test/v1/connect?device=${deviceIdText}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": sourceIp },
    });
    const socket = response.webSocket;
    if (!socket) {
      throw new Error(`no websocket in response (status ${response.status})`);
    }
    socket.accept();
    return new TestPeer(socket);
  }

  /** Waits for the next message from the relay. */
  next(timeoutMs = 2_000): Promise<ServerMessage> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== wrapped);
        reject(new Error("timed out waiting for a relay message"));
      }, timeoutMs);
      const wrapped = (message: ServerMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.#waiters.push(wrapped);
    });
  }

  /** Reads the challenge the relay issues on connect. */
  async challenge(): Promise<Uint8Array> {
    const message = await this.next();
    if (message.type !== "challenge") {
      throw new Error(`expected a challenge, got ${message.type}`);
    }
    const { decodeBase64 } = await import("../src/protocol");
    const bytes = decodeBase64(message.challenge);
    if (!bytes) throw new Error("challenge was not valid base64");
    return bytes;
  }

  send(raw: string): void {
    this.#socket.send(raw);
  }

  sendJson(value: unknown): void {
    this.#socket.send(JSON.stringify(value));
  }

  /** Sends a binary message, which the protocol does not accept. */
  sendBinary(data: Uint8Array): void {
    this.#socket.send(data as unknown as ArrayBufferView);
  }

  /** Sends an opaque frame, addressed to a client connection when given. */
  sendFrame(data: Uint8Array, connectionId?: string): void {
    const message: Record<string, unknown> = { type: "frame", data: encodeBase64(data) };
    if (connectionId !== undefined) message["connection_id"] = connectionId;
    this.sendJson(message);
  }

  get closed(): { code: number; reason: string } | null {
    return this.#closed;
  }

  /** Waits until the relay closes this connection. */
  waitClosed(timeoutMs = 2_000): Promise<{ code: number; reason: string }> {
    if (this.#closed) return Promise.resolve(this.#closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
      this.#closeWaiters.push((closed) => {
        clearTimeout(timer);
        resolve(closed);
      });
    });
  }

  /**
   * Asserts that nothing arrives within a short window. Used to prove a
   * frame was not delivered to the wrong peer.
   */
  async expectSilence(windowMs = 150): Promise<void> {
    try {
      const message = await this.next(windowMs);
      throw new Error(`expected no message, got ${JSON.stringify(message)}`);
    } catch (error) {
      if (error instanceof Error && error.message === "timed out waiting for a relay message") {
        return;
      }
      throw error;
    }
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      // Already closed.
    }
  }
}

/** Connects a device and completes a valid registration. */
export async function connectRegisteredDevice(
  device: TestDevice,
): Promise<TestPeer> {
  const peer = await TestPeer.connect(device.deviceIdText);
  const challenge = await peer.challenge();
  peer.send(await buildRegister(device, { challenge }));
  const reply = await peer.next();
  if (reply.type !== "registered") {
    throw new Error(`registration failed: ${JSON.stringify(reply)}`);
  }
  return peer;
}

/** Connects a client and attaches it to a device route. */
export async function connectAttachedClient(
  deviceIdText: string,
  deviceId: Uint8Array,
): Promise<TestPeer> {
  const peer = await TestPeer.connect(deviceIdText);
  await peer.challenge();
  peer.sendJson({ type: "attach", version: 1, device_id: encodeBase64(deviceId) });
  const reply = await peer.next();
  if (reply.type !== "attached") {
    throw new Error(`attach failed: ${JSON.stringify(reply)}`);
  }
  peer.connectionId = reply.connectionId;
  return peer;
}

/** Reads the next message and requires it to be a given type. */
export async function expectMessage<T extends ServerMessage["type"]>(
  peer: TestPeer,
  type: T,
): Promise<Extract<ServerMessage, { type: T }>> {
  const message = await peer.next();
  if (message.type !== type) {
    throw new Error(`expected ${type}, got ${JSON.stringify(message)}`);
  }
  return message as Extract<ServerMessage, { type: T }>;
}
