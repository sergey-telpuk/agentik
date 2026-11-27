/**
 * The pairing invitation carried by the QR code (AGENTIK.md section 5.3).
 *
 * Text form: `AGENTIK1:` followed by unpadded RFC 4648 base32 (uppercase) of a
 * binary payload, all integers big-endian:
 *
 *   1   version (1)
 *   1   relay selector: 0 default relay, 1 wss:// custom, 2 ws:// custom
 *   32  register public key (Ed25519); device_id is its SHA-256
 *   32  Noise public key (X25519)
 *   32  invitation secret; invitation_id is its SHA-256
 *   4   expiry, Unix seconds
 *   64  Ed25519 signature of the PairingDescriptor
 *   ..  custom relay only: host[:port][/path] without the scheme
 *
 * The layout mirrors `EncodeInvitation` in
 * `daemon/internal/pairing/invitation.go`; a shared vector in both test suites
 * keeps them in step.
 *
 * Trust: everything parsed here is UNTRUSTED. A QR code can come from anyone,
 * and anyone can sign one with their own key. The signature check proves the
 * keys and relay were published together by the holder of the registration
 * key and were not altered on the way; it grants nothing. Access exists only
 * after the full Noise handshake and the confirmation on the computer.
 */

import { decodeBase32, encodeBase32, sha256 } from "../encoding";

/** Protocol version this client understands. */
export const INVITATION_VERSION = 1;

/** Text prefix of every invitation. Must match `InvitationPrefix` in the daemon. */
export const INVITATION_PREFIX = "AGENTIK1:";

/** The hosted relay, carried as a one-byte selector. Must match `DefaultRelayURL`. */
export const DEFAULT_RELAY_URL = "wss://agentik-relay.agentikcl.workers.dev";

/** Signing context of the pairing descriptor (`ContextPairingDescriptor`). */
export const PAIRING_DESCRIPTOR_CONTEXT = "agentik-pairing-descriptor-v1";

export const DEVICE_ID_SIZE = 32;
export const ED25519_PUBLIC_KEY_SIZE = 32;
export const NOISE_PUBLIC_KEY_SIZE = 32;
export const INVITATION_ID_SIZE = 32;
export const INVITATION_SECRET_SIZE = 32;
export const SIGNATURE_SIZE = 64;

export const RELAY_DEFAULT = 0;
export const RELAY_WSS = 1;
export const RELAY_WS = 2;

/** Size of the binary payload for the default relay. */
export const INVITATION_FIXED_SIZE =
  1 + 1 + ED25519_PUBLIC_KEY_SIZE + NOISE_PUBLIC_KEY_SIZE + INVITATION_SECRET_SIZE + 4 + SIGNATURE_SIZE;

/**
 * Upper bound on the invitation once whitespace is removed; a real invitation
 * is about 280 characters. Must match `MaxInvitationTextLength`.
 */
export const MAX_INVITATION_TEXT_LENGTH = 1024;

/**
 * A parsed invitation whose contents have not been confirmed by the daemon.
 *
 * `trust` is a literal so code that needs a confirmed pairing cannot be handed
 * this type by accident.
 */
export interface UntrustedInvitation {
  readonly trust: "untrusted";
  readonly version: number;
  /** Base URL of the relay, normalised (no trailing slash, no query). */
  readonly relayUrl: string;
  /** SHA-256 of the registration key. */
  readonly deviceId: Uint8Array;
  /** Text form of `deviceId`, for display and the relay's `device` parameter. */
  readonly deviceIdText: string;
  /** Ed25519 key that identifies the computer to the relay. */
  readonly registerPublicKey: Uint8Array;
  /** X25519 long-term Noise key to pin. */
  readonly noisePublicKey: Uint8Array;
  /** SHA-256 of the one-time invitation secret. */
  readonly invitationId: Uint8Array;
  /**
   * The one-time secret. It must stay in memory only: never persisted,
   * logged, or placed in a URL (AGENTIK.md section 5.3).
   */
  readonly invitationSecret: Uint8Array;
  /** Expiry in Unix seconds. */
  readonly expiresAt: number;
  /** Signature by the registration key, verified by `parseInvitation`. */
  readonly signature: Uint8Array;
}

export type InvitationErrorCode =
  | "empty"
  | "too_long"
  | "malformed"
  | "unsupported_version"
  | "invalid_field"
  | "expired"
  | "bad_signature"
  | "signature_unsupported";

export interface InvitationError {
  readonly code: InvitationErrorCode;
  /** Human-readable reason. It never contains key or secret material. */
  readonly message: string;
}

export type InvitationResult =
  | { readonly ok: true; readonly value: UntrustedInvitation }
  | { readonly ok: false; readonly error: InvitationError };

function fail(code: InvitationErrorCode, message: string): InvitationResult {
  return { ok: false, error: { code, message } };
}

/**
 * Accepts only `wss:` (and `ws:` for a loopback development relay) with no
 * credentials, query, or fragment, and returns it normalised.
 */
export function normalizeRelayUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.hostname === "") return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Decodes the base32 part, accepting only the canonical encoding. */
function decodePayload(encoded: string): Uint8Array | null {
  const lower = encoded.toLowerCase();
  const bytes = decodeBase32(lower);
  return bytes !== null && encodeBase32(bytes) === lower ? bytes : null;
}

/** The relay a selector and trailing bytes stand for, or null. */
function relayFromPayload(selector: number, rest: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rest);
  } catch {
    return null;
  }
  let relay: string;
  switch (selector) {
    case RELAY_DEFAULT:
      return text === "" ? DEFAULT_RELAY_URL : null;
    case RELAY_WSS:
      relay = `wss://${text}`;
      break;
    case RELAY_WS:
      relay = `ws://${text}`;
      break;
    default:
      return null;
  }
  // One encoding per relay: the signed URL must already be normalised, and
  // the default relay always uses its selector.
  return normalizeRelayUrl(relay) === relay && relay !== DEFAULT_RELAY_URL ? relay : null;
}

/**
 * The bytes the daemon signs: `PairingDescriptor.signingBytes` in
 * `daemon/internal/protocol/signed.go`. Byte fields carry a 32-bit length
 * prefix; the version is 16 bits and the expiry 64 bits, both without one.
 */
export function pairingDescriptorSigningBytes(fields: {
  readonly version: number;
  readonly relayUrl: string;
  readonly deviceId: Uint8Array;
  readonly registerPublicKey: Uint8Array;
  readonly noisePublicKey: Uint8Array;
  readonly invitationId: Uint8Array;
  readonly expiresAt: number;
}): Uint8Array {
  const text = new TextEncoder();
  const parts: Uint8Array[] = [];
  const field = (bytes: Uint8Array) => {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length);
    parts.push(len, bytes);
  };
  field(text.encode(PAIRING_DESCRIPTOR_CONTEXT));
  const version = new Uint8Array(2);
  new DataView(version.buffer).setUint16(0, fields.version);
  parts.push(version);
  field(text.encode(fields.relayUrl));
  field(fields.deviceId);
  field(fields.registerPublicKey);
  field(fields.noisePublicKey);
  field(fields.invitationId);
  const expiry = new Uint8Array(8);
  const view = new DataView(expiry.buffer);
  view.setUint32(0, Math.floor(fields.expiresAt / 2 ** 32));
  view.setUint32(4, fields.expiresAt >>> 0);
  parts.push(expiry);

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** RFC 8032 test 1 public key, a known-good point to probe Ed25519 support. */
const ED25519_PROBE_KEY = Uint8Array.from(
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a".match(/../g) ?? [],
  (h) => parseInt(h, 16),
);

let ed25519Support: Promise<boolean> | null = null;

/** Whether this WebView's WebCrypto implements Ed25519. */
function supportsEd25519(): Promise<boolean> {
  ed25519Support ??= crypto.subtle
    .importKey("raw", ED25519_PROBE_KEY, { name: "Ed25519" }, false, ["verify"])
    .then(
      () => true,
      () => false,
    );
  return ed25519Support;
}

/** Ed25519 verification through WebCrypto; null when Ed25519 is unavailable. */
async function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean | null> {
  if (!(await supportsEd25519())) return null;
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signature), new Uint8Array(message));
  } catch {
    // Support was confirmed above, so a rejected key is an invalid key.
    return false;
  }
}

/**
 * Parses a scanned or pasted invitation and verifies its signature.
 *
 * Whitespace anywhere (line wraps from a terminal) and letter case are
 * ignored. `nowMs` is injected so expiry can be tested without a clock.
 *
 * TODO(signature): the Ed25519 signature is verified with WebCrypto, and
 * parsing fails closed with `signature_unsupported` where WebCrypto has no
 * Ed25519. Which Telegram clients that rejects (older Android System WebView,
 * Telegram Desktop builds) has not been checked on real devices
 * (AGENTIK.md section 14).
 */
export async function parseInvitation(text: string, nowMs: number): Promise<InvitationResult> {
  if (text.length > MAX_INVITATION_TEXT_LENGTH * 4) {
    return fail("too_long", "the invitation is too long");
  }
  const compact = text.replace(/\s+/g, "").toUpperCase();
  if (compact.length === 0) return fail("empty", "the invitation is empty");
  if (compact.length > MAX_INVITATION_TEXT_LENGTH) {
    return fail("too_long", "the invitation is too long");
  }
  if (!compact.startsWith(INVITATION_PREFIX)) {
    return fail("malformed", "this is not an Agentik pairing invitation");
  }
  const raw = decodePayload(compact.slice(INVITATION_PREFIX.length));
  if (raw === null) return fail("malformed", "the invitation is not valid base32");
  if (raw.length < INVITATION_FIXED_SIZE) return fail("malformed", "the invitation is truncated");

  const version = raw[0] ?? 0;
  if (version !== INVITATION_VERSION) {
    return fail("unsupported_version", `unsupported invitation version ${version}`);
  }
  let offset = 2;
  const next = (n: number): Uint8Array => {
    const field = raw.slice(offset, offset + n);
    offset += n;
    return field;
  };
  const registerPublicKey = next(ED25519_PUBLIC_KEY_SIZE);
  const noisePublicKey = next(NOISE_PUBLIC_KEY_SIZE);
  const invitationSecret = next(INVITATION_SECRET_SIZE);
  const expiresAt = new DataView(next(4).buffer).getUint32(0);
  const signature = next(SIGNATURE_SIZE);

  const relayUrl = relayFromPayload(raw[1] ?? -1, raw.slice(offset));
  if (relayUrl === null) {
    return fail("invalid_field", "the relay must be a wss:// URL without credentials, query, or fragment");
  }
  if (expiresAt <= 0) return fail("invalid_field", "the expiry must be a positive number of seconds");
  // Same rule as the daemon: usable only strictly before the expiry instant.
  if (nowMs >= expiresAt * 1000) return fail("expired", "the invitation has expired");

  const deviceId = await sha256(registerPublicKey);
  const invitationId = await sha256(invitationSecret);
  const message = pairingDescriptorSigningBytes({
    version,
    relayUrl,
    deviceId,
    registerPublicKey,
    noisePublicKey,
    invitationId,
    expiresAt,
  });
  const verified = await verifyEd25519(registerPublicKey, message, signature);
  if (verified === null) {
    return fail(
      "signature_unsupported",
      "this version of Telegram cannot check the invitation signature; update Telegram and try again",
    );
  }
  if (!verified) return fail("bad_signature", "the invitation signature is not valid");

  return {
    ok: true,
    value: {
      trust: "untrusted",
      version,
      relayUrl,
      deviceId,
      deviceIdText: encodeBase32(deviceId),
      registerPublicKey,
      noisePublicKey,
      invitationId,
      invitationSecret,
      expiresAt,
      signature,
    },
  };
}