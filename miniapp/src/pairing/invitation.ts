/**
 * The pairing invitation carried by the QR code (AGENTIK.md section 5.3).
 *
 * TODO(format): the final QR/descriptor format is still an open item
 * (AGENTIK.md section 14). The wire shape below is a provisional JSON
 * projection of `PairingDescriptor` in `daemon/internal/protocol/signed.go`
 * and must be aligned with the daemon once the format is fixed.
 *
 * Trust: everything parsed here is UNTRUSTED. A QR code can come from anyone.
 * This module checks structure, key lengths, and expiry so an obviously broken
 * or stale invitation is rejected early, but it grants nothing. Access exists
 * only after the full Noise handshake and the confirmation on the computer.
 */

import {
  bytesEqual,
  decodeBase32,
  decodeBase64Url,
  encodeBase32,
  sha256,
} from "../encoding";

/** Protocol version this client understands. */
export const INVITATION_VERSION = 1;

/** Optional text prefix in front of the base64url-encoded JSON payload. */
export const INVITATION_PREFIX = "agentik-pair-v1:";

export const DEVICE_ID_SIZE = 32;
export const ED25519_PUBLIC_KEY_SIZE = 32;
export const NOISE_PUBLIC_KEY_SIZE = 32;
export const INVITATION_ID_SIZE = 32;
export const INVITATION_SECRET_SIZE = 32;
export const SIGNATURE_SIZE = 64;

/** Upper bound on the pasted text; a real invitation is well under 1 KiB. */
export const MAX_INVITATION_TEXT_LENGTH = 4096;

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
  /** Signature by the registration key. Carried, not verified here. */
  readonly signature: Uint8Array;
}

export type InvitationErrorCode =
  | "empty"
  | "too_long"
  | "malformed"
  | "unsupported_version"
  | "invalid_field"
  | "expired";

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

/** Reads a required string field. */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads a base64url field and checks its decoded length. */
function readBytes(
  source: Record<string, unknown>,
  key: string,
  expectedLength: number,
): Uint8Array | null {
  const text = readString(source, key);
  if (text === null) return null;
  const bytes = decodeBase64Url(text);
  return bytes !== null && bytes.length === expectedLength ? bytes : null;
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

/**
 * Parses a QR payload or a pasted string.
 *
 * `nowMs` is injected so expiry can be tested without a clock.
 */
export function parseInvitation(text: string, nowMs: number): InvitationResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return fail("empty", "the invitation is empty");
  if (trimmed.length > MAX_INVITATION_TEXT_LENGTH) {
    return fail("too_long", "the invitation is too long");
  }

  let json = trimmed;
  if (trimmed.startsWith(INVITATION_PREFIX)) {
    const decoded = decodeBase64Url(trimmed.slice(INVITATION_PREFIX.length));
    if (decoded === null) return fail("malformed", "the invitation is not valid base64url");
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch {
      return fail("malformed", "the invitation is not valid UTF-8");
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail("malformed", "the invitation is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("malformed", "the invitation must be a JSON object");
  }
  const source = parsed as Record<string, unknown>;

  const version = source["v"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return fail("malformed", "the invitation has no integer version");
  }
  if (version !== INVITATION_VERSION) {
    return fail("unsupported_version", `unsupported invitation version ${version}`);
  }

  const relayText = readString(source, "relay");
  if (relayText === null) return fail("invalid_field", "relay is required");
  const relayUrl = normalizeRelayUrl(relayText);
  if (relayUrl === null) {
    return fail("invalid_field", "relay must be a wss:// URL without credentials, query, or fragment");
  }

  const deviceIdText = readString(source, "device_id");
  if (deviceIdText === null) return fail("invalid_field", "device_id is required");
  const deviceId = decodeBase32(deviceIdText);
  if (deviceId === null || deviceId.length !== DEVICE_ID_SIZE) {
    return fail("invalid_field", "device_id must be 32 bytes in lowercase base32");
  }

  const registerPublicKey = readBytes(source, "register_public_key", ED25519_PUBLIC_KEY_SIZE);
  if (registerPublicKey === null) {
    return fail("invalid_field", "register_public_key must be 32 bytes in base64url");
  }

  const noisePublicKey = readBytes(source, "noise_public_key", NOISE_PUBLIC_KEY_SIZE);
  if (noisePublicKey === null) {
    return fail("invalid_field", "noise_public_key must be 32 bytes in base64url");
  }

  const invitationId = readBytes(source, "invitation_id", INVITATION_ID_SIZE);
  if (invitationId === null) {
    return fail("invalid_field", "invitation_id must be 32 bytes in base64url");
  }

  const invitationSecret = readBytes(source, "invitation_secret", INVITATION_SECRET_SIZE);
  if (invitationSecret === null) {
    return fail("invalid_field", "invitation_secret must be 32 bytes in base64url");
  }

  const signature = readBytes(source, "signature", SIGNATURE_SIZE);
  if (signature === null) {
    return fail("invalid_field", "signature must be 64 bytes in base64url");
  }

  const expiresAt = source["expires_at"];
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    return fail("invalid_field", "expires_at must be a positive integer number of seconds");
  }
  // Same rule as the daemon: usable only strictly before the expiry instant.
  if (nowMs >= expiresAt * 1000) {
    return fail("expired", "the invitation has expired");
  }

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

/**
 * Checks the cross-field bindings the daemon also enforces:
 * `device_id == SHA-256(register_public_key)` and
 * `invitation_id == SHA-256(invitation_secret)`.
 *
 * This catches an inconsistent or tampered code early. It does not make the
 * invitation trusted: whoever made the QR code can make it consistent.
 *
 * TODO(signature): the Ed25519 signature is carried but not verified here,
 * because WebCrypto Ed25519 support across Telegram WebViews is unverified
 * (AGENTIK.md section 14). The Noise pin and the daemon's confirmation are
 * what actually protect pairing.
 */
export async function checkInvitationBindings(
  invitation: UntrustedInvitation,
): Promise<InvitationError | null> {
  const expectedDeviceId = await sha256(invitation.registerPublicKey);
  if (!bytesEqual(expectedDeviceId, invitation.deviceId)) {
    return { code: "invalid_field", message: "device_id does not match the registration key" };
  }
  const expectedInvitationId = await sha256(invitation.invitationSecret);
  if (!bytesEqual(expectedInvitationId, invitation.invitationId)) {
    return { code: "invalid_field", message: "invitation_id does not match the invitation secret" };
  }
  return null;
}
