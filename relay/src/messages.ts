/**
 * The outer relay envelope.
 *
 * The relay sees only these fields. Local paths, project names, prompts, and
 * results travel inside the Noise ciphertext and are opaque here: the relay
 * routes frames, it does not read them.
 *
 * Every message is validated before use. A field that is absent, the wrong
 * type, or the wrong size is a protocol error, never a default.
 */

import {
  CHALLENGE_SIZE,
  DEVICE_ID_SIZE,
  ED25519_PUBLIC_KEY_SIZE,
  ED25519_SIGNATURE_SIZE,
  type RegisterRequest,
  type Role,
  decodeBase64,
  encodeBase64,
} from "./protocol";

/** Messages a peer may send to the relay. */
export type ClientMessage =
  | { type: "register"; payload: RegisterPayload }
  | { type: "attach"; payload: AttachPayload }
  | { type: "frame"; payload: FramePayload };

/**
 * Messages the relay sends to a peer.
 *
 * `connectionId` names one attached client. The relay assigns it on attach;
 * the device sees it on every frame and presence change for that client, so
 * it can run one Noise session per client and address replies to exactly
 * one of them. Clients never see another client's identifier.
 */
export type ServerMessage =
  | { type: "challenge"; challenge: string; relayId: string; expiresAt: number }
  /** To the device: registration accepted, with the clients already attached. */
  | { type: "registered"; deviceId: string; connections: string[] }
  /** To a client: attach accepted, with the identifier the relay assigned it. */
  | { type: "attached"; deviceId: string; connectionId: string; devicePresent: boolean }
  /**
   * Presence change. To the device it carries the client's `connectionId`;
   * to a client it describes the device and has no `connectionId`.
   */
  | { type: "peer_state"; present: boolean; connectionId?: string }
  /**
   * Opaque ciphertext. To the device it carries the sending client's
   * `connectionId`; to a client it has none.
   */
  | { type: "frame"; data: string; connectionId?: string }
  /** `connectionId` is set when the error concerns one client connection. */
  | { type: "error"; code: ErrorCode; message: string; connectionId?: string };

/**
 * Error codes are a closed set so a client can branch on them. The human
 * message is for diagnostics and must never carry frame contents.
 */
export type ErrorCode =
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

/** A device proving ownership of its route. */
export interface RegisterPayload {
  version: number;
  role: Role;
  relayId: string;
  deviceId: Uint8Array;
  registerPublicKey: Uint8Array;
  challenge: Uint8Array;
  expiresAt: bigint;
  signature: Uint8Array;
}

/**
 * A phone asking to be routed to a device.
 *
 * Attaching carries no proof of authority on purpose: the relay cannot
 * authenticate a phone, because it never holds Noise keys. A client that
 * attaches can exchange frames with the device, and the device rejects it
 * during the Noise handshake unless it is a paired peer. The envelope
 * determines routing, not authority.
 */
export interface AttachPayload {
  version: number;
  deviceId: Uint8Array;
}

/**
 * One opaque ciphertext frame to forward to the peer.
 *
 * A device must name the client connection the frame is for. A client must
 * not name one: the relay tags its frames with the identifier it assigned,
 * so a client cannot speak as another client.
 */
export interface FramePayload {
  data: Uint8Array;
  connectionId?: string;
}

/** Length of a connection identifier: 16 random bytes as lowercase hex. */
export const CONNECTION_ID_LENGTH = 32;

const CONNECTION_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Creates a fresh, unguessable connection identifier. */
export function newConnectionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CONNECTION_ID_LENGTH / 2));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** WebSocket close codes the relay uses, so a peer can tell why it was closed. */
export const CLOSE_CODES = {
  /** The same device key registered again on a newer connection. */
  replaced: 4000,
  /** A protocol error; the reason is the error code. */
  protocolError: 4001,
  /** An idle or unauthenticated socket was closed to make room for a new one. */
  evicted: 4003,
} as const;

/** Result of parsing: either a value or the reason it was rejected. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string };

function fail<T>(code: ErrorCode, message: string): ParseResult<T> {
  return { ok: false, code, message };
}

/** Reads a required string field. */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

/** Reads a base64 field and checks its decoded length. */
function readBytes(
  source: Record<string, unknown>,
  key: string,
  expectedLength: number,
): Uint8Array | null {
  const text = readString(source, key);
  if (text === null) return null;
  const bytes = decodeBase64(text);
  if (bytes === null || bytes.length !== expectedLength) return null;
  return bytes;
}

/** Longest relay identifier accepted in a registration. */
export const MAX_RELAY_ID_LENGTH = 128;

/** Length of the base64 text that encodes `byteLength` bytes. */
function base64Length(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

/**
 * Longest raw message accepted, in UTF-16 code units.
 *
 * The largest legitimate message is a frame at the payload limit: its base64
 * data plus a connection id and the JSON keys. 512 units of headroom covers
 * that envelope and is far below what would make parsing expensive. Every
 * valid message is ASCII, so this also bounds its UTF-8 byte length.
 */
export function maxMessageLength(maxFrameBytes: number): number {
  return base64Length(maxFrameBytes) + 512;
}

/**
 * Parses a message from a peer.
 *
 * `raw` is untrusted input from the network, so this function assumes
 * nothing about its shape. Its length is bounded before JSON.parse, so an
 * oversized message is rejected without building an object tree for it.
 */
export function parseClientMessage(
  raw: string,
  maxFrameBytes: number,
): ParseResult<ClientMessage> {
  if (raw.length > maxMessageLength(maxFrameBytes)) {
    return fail("message_too_large", "message exceeds the size limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("bad_request", "message is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("bad_request", "message must be a JSON object");
  }
  const message = parsed as Record<string, unknown>;

  switch (message["type"]) {
    case "register":
      return parseRegister(message);
    case "attach":
      return parseAttach(message);
    case "frame":
      return parseFrame(message, maxFrameBytes);
    default:
      return fail("bad_request", "unknown message type");
  }
}

function parseRegister(message: Record<string, unknown>): ParseResult<ClientMessage> {
  const version = message["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return fail("bad_request", "version must be an integer");
  }

  const role = readString(message, "role");
  if (role !== "device") {
    // Only a device registers a route; a client attaches to one.
    return fail("bad_request", "role must be \"device\"");
  }

  const relayId = readString(message, "relay_id");
  if (relayId === null || relayId.length === 0) {
    return fail("bad_request", "relay_id is required");
  }
  if (relayId.length > MAX_RELAY_ID_LENGTH) {
    return fail("bad_request", "relay_id is too long");
  }

  const deviceId = readBytes(message, "device_id", DEVICE_ID_SIZE);
  if (deviceId === null) {
    return fail("bad_request", "device_id must be 32 base64-encoded bytes");
  }

  const registerPublicKey = readBytes(message, "register_public_key", ED25519_PUBLIC_KEY_SIZE);
  if (registerPublicKey === null) {
    return fail("bad_request", "register_public_key must be 32 base64-encoded bytes");
  }

  const challenge = readBytes(message, "challenge", CHALLENGE_SIZE);
  if (challenge === null) {
    return fail("bad_request", "challenge must be 32 base64-encoded bytes");
  }

  const signature = readBytes(message, "signature", ED25519_SIGNATURE_SIZE);
  if (signature === null) {
    return fail("bad_request", "signature must be 64 base64-encoded bytes");
  }

  const expiresAtRaw = message["expires_at"];
  if (typeof expiresAtRaw !== "number" || !Number.isSafeInteger(expiresAtRaw)) {
    return fail("bad_request", "expires_at must be an integer number of seconds");
  }

  return {
    ok: true,
    value: {
      type: "register",
      payload: {
        version,
        role,
        relayId,
        deviceId,
        registerPublicKey,
        challenge,
        expiresAt: BigInt(expiresAtRaw),
        signature,
      },
    },
  };
}

function parseAttach(message: Record<string, unknown>): ParseResult<ClientMessage> {
  const version = message["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return fail("bad_request", "version must be an integer");
  }
  const deviceIdText = readString(message, "device_id");
  if (deviceIdText === null) {
    return fail("bad_request", "device_id is required");
  }
  const deviceId = decodeBase64(deviceIdText);
  if (deviceId === null || deviceId.length !== DEVICE_ID_SIZE) {
    return fail("bad_request", "device_id must be 32 base64-encoded bytes");
  }
  return { ok: true, value: { type: "attach", payload: { version, deviceId } } };
}

function parseFrame(
  message: Record<string, unknown>,
  maxFrameBytes: number,
): ParseResult<ClientMessage> {
  const dataText = readString(message, "data");
  if (dataText === null) {
    return fail("bad_request", "data is required");
  }
  // The raw message was already bounded before parsing. This tighter check
  // on the encoded field rejects an oversized frame without decoding it:
  // base64 text longer than the encoding of maxFrameBytes cannot decode to
  // a payload within the limit.
  if (dataText.length > base64Length(maxFrameBytes)) {
    return fail("message_too_large", "frame exceeds the size limit");
  }
  const data = decodeBase64(dataText);
  if (data === null) {
    return fail("bad_request", "data must be base64");
  }
  if (data.length > maxFrameBytes) {
    return fail("message_too_large", "frame exceeds the size limit");
  }
  if (data.length === 0) {
    return fail("bad_request", "frame is empty");
  }

  const connectionIdRaw = message["connection_id"];
  if (connectionIdRaw === undefined) {
    return { ok: true, value: { type: "frame", payload: { data } } };
  }
  if (typeof connectionIdRaw !== "string" || !CONNECTION_ID_PATTERN.test(connectionIdRaw)) {
    return fail("bad_request", "connection_id must be 32 lowercase hex characters");
  }
  return { ok: true, value: { type: "frame", payload: { data, connectionId: connectionIdRaw } } };
}

/** Converts a parsed registration into the structure the verifier re-encodes. */
export function toRegisterRequest(payload: RegisterPayload): RegisterRequest {
  return {
    version: payload.version,
    role: payload.role,
    relayId: payload.relayId,
    deviceId: payload.deviceId,
    registerPublicKey: payload.registerPublicKey,
    challenge: payload.challenge,
    expiresAt: payload.expiresAt,
    signature: payload.signature,
  };
}

/** Serialises a message to send to a peer. */
export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Builds a frame message carrying opaque ciphertext, tagged with the sending
 * client's connection when it is addressed to the device.
 */
export function frameMessage(data: Uint8Array, connectionId?: string): ServerMessage {
  const message: ServerMessage = { type: "frame", data: encodeBase64(data) };
  if (connectionId !== undefined) message.connectionId = connectionId;
  return message;
}

/** Builds an error message, optionally naming the client connection it concerns. */
export function errorMessage(
  code: ErrorCode,
  message: string,
  connectionId?: string,
): ServerMessage {
  const out: ServerMessage = { type: "error", code, message };
  if (connectionId !== undefined) out.connectionId = connectionId;
  return out;
}
