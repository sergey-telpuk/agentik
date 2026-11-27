/**
 * Wire contracts shared with the Go daemon.
 *
 * The canonical encoding here must agree byte for byte with
 * `daemon/internal/protocol`: the relay verifies signatures the daemon
 * produced, so any disagreement over field order, widths, or length prefixes
 * shows up as a rejected registration rather than a subtle mismatch.
 */

/** Protocol version carried in the envelope and in signed contexts. */
export const VERSION = 1;

/** Signing context for relay registration. Must match the Go constant. */
export const CONTEXT_RELAY_REGISTER = "agentik-relay-register-v1";

/** Length of a registration challenge, in bytes. */
export const CHALLENGE_SIZE = 32;

/** Length of a device identifier (SHA-256 of the registration key). */
export const DEVICE_ID_SIZE = 32;

/** Length of an Ed25519 public key. */
export const ED25519_PUBLIC_KEY_SIZE = 32;

/** Length of an Ed25519 signature. */
export const ED25519_SIGNATURE_SIZE = 64;

/**
 * How far ahead of relay time a signed expiry may sit.
 *
 * Mirrors MaxClockSkew in Go. Without it, a peer with a badly wrong clock
 * could present a registration that never expires.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** A peer's part in the protocol. */
export type Role = "device" | "client";

/**
 * Builds a canonical byte string: a context followed by fields in a fixed
 * order, each length-prefixed so no two distinct field sequences can produce
 * the same bytes.
 */
export class CanonicalEncoder {
  // Chunks are collected and joined once, rather than reallocating a growing
  // buffer on every field.
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  constructor(context: string) {
    this.addString(context);
  }

  /** Appends a length-prefixed byte field. */
  addBytes(value: Uint8Array): this {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, value.length, false);
    this.#push(prefix);
    this.#push(value);
    return this;
  }

  /** Appends a length-prefixed string field, encoded as UTF-8. */
  addString(value: string): this {
    return this.addBytes(new TextEncoder().encode(value));
  }

  /** Appends a fixed-width 16-bit field, with no length prefix. */
  addUint16(value: number): this {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, value, false);
    this.#push(buf);
    return this;
  }

  /**
   * Appends a fixed-width signed 64-bit field.
   *
   * Used for Unix timestamps. BigInt is required because a JS number cannot
   * represent every int64 exactly, and the signed bit pattern must match
   * what Go wrote.
   */
  addInt64(value: bigint): this {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigInt64(0, value, false);
    this.#push(buf);
    return this;
  }

  #push(chunk: Uint8Array): void {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  /** Returns the encoded bytes. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** A device's claim to its relay route, as received over the wire. */
export interface RegisterRequest {
  version: number;
  role: Role;
  relayId: string;
  deviceId: Uint8Array;
  registerPublicKey: Uint8Array;
  challenge: Uint8Array;
  /** Unix seconds. */
  expiresAt: bigint;
  signature: Uint8Array;
}

/**
 * Rebuilds the exact bytes the device signed.
 *
 * Verification re-encodes from the parsed fields rather than trusting a
 * received blob, so a signature can only validate the values the relay then
 * acts on.
 */
export function registerSigningBytes(req: RegisterRequest): Uint8Array {
  return new CanonicalEncoder(CONTEXT_RELAY_REGISTER)
    .addUint16(req.version)
    .addString(req.role)
    .addString(req.relayId)
    .addBytes(req.deviceId)
    .addBytes(req.registerPublicKey)
    .addBytes(req.challenge)
    .addInt64(req.expiresAt)
    .bytes();
}

/** Device identifier text form: lowercase unpadded base32, as in Go. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encodes a device identifier for display and for Durable Object names. */
export function formatDeviceId(id: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of id) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out.toLowerCase();
}

/** Parses a device identifier produced by {@link formatDeviceId}. */
export function parseDeviceId(text: string): Uint8Array | null {
  const normalized = text.trim().toUpperCase();
  if (normalized.length === 0) return null;

  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length !== DEVICE_ID_SIZE) return null;
  return new Uint8Array(bytes);
}

/**
 * Compares two byte strings without leaking where they first differ.
 *
 * Used for challenges and identifiers, which an attacker supplies and could
 * otherwise probe byte by byte.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/** Decodes standard base64 into bytes, or null if the input is not valid. */
export function decodeBase64(text: string): Uint8Array | null {
  // Reject anything outside the base64 alphabet up front: atob is lenient
  // about some malformed input, and a silently mangled key would surface as
  // a confusing signature failure instead of a clear parse error.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

/** Encodes bytes as standard base64. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Verifies an Ed25519 signature.
 *
 * Workers expose Ed25519 through WebCrypto. An unusable key is reported as a
 * failed verification rather than throwing, so one malformed request cannot
 * take down the connection handler.
 */
export async function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== ED25519_PUBLIC_KEY_SIZE) return false;
  if (signature.length !== ED25519_SIGNATURE_SIZE) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature as BufferSource,
      message as BufferSource,
    );
  } catch {
    return false;
  }
}

/** Computes SHA-256. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(digest);
}
