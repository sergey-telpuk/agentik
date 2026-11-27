/**
 * Telegram `initData` handling (AGENTIK.md section 5.4).
 *
 * The Mini App reads the RAW `initData` string and hands it to the daemon,
 * which verifies the Ed25519 signature, `bot_id`, format, and `auth_date`
 * freshness. This client does none of that and must not treat anything in
 * `initData` as proof of identity: `initDataUnsafe` is never read, and no
 * function here extracts a Telegram user id for an authorization decision.
 *
 * The raw string is sent only as an inner message inside the Noise session.
 * It never goes in a relay envelope, a URL, or a log line.
 */

import type { SecureSession } from "../secure/seam";

/** Inner-message protocol version. */
export const INNER_VERSION = 1;

/**
 * A real `initData` is a short query string. The bound only stops absurd
 * input from being forwarded; the daemon applies the real limits.
 */
export const MAX_INIT_DATA_LENGTH = 8192;

/**
 * TODO(protocol): the method name and params are provisional. AGENTIK.md
 * section 6.3 does not list an identity method yet; align with the schema in
 * `protocol/` once the daemon defines how Telegram identity is presented.
 */
export const INIT_DATA_METHOD = "auth.telegram";

/** The inner message that asks the daemon to verify the Telegram identity. */
export interface InitDataVerificationRequest {
  readonly v: typeof INNER_VERSION;
  readonly request_id: string;
  readonly method: typeof INIT_DATA_METHOD;
  readonly params: { readonly init_data: string };
}

export type InitDataReadResult =
  | { readonly ok: true; readonly rawInitData: string }
  | { readonly ok: false; readonly reason: "not_in_telegram" | "missing" | "too_large" };

/** The part of the Telegram runtime this module needs. */
export interface InitDataSource {
  readonly isMiniApp: boolean;
  rawInitData(): string | null;
}

/** Reads the raw string from the runtime without interpreting it. */
export function readRawInitData(source: InitDataSource): InitDataReadResult {
  if (!source.isMiniApp) return { ok: false, reason: "not_in_telegram" };
  const raw = source.rawInitData();
  if (raw === null || raw.length === 0) return { ok: false, reason: "missing" };
  if (raw.length > MAX_INIT_DATA_LENGTH) return { ok: false, reason: "too_large" };
  return { ok: true, rawInitData: raw };
}

/** Builds the verification request. The string is passed through unchanged. */
export function buildInitDataVerificationRequest(
  rawInitData: string,
  requestId: string = crypto.randomUUID(),
): InitDataVerificationRequest {
  return {
    v: INNER_VERSION,
    request_id: requestId,
    method: INIT_DATA_METHOD,
    params: { init_data: rawInitData },
  };
}

/**
 * Sends the verification request through an established secure session.
 *
 * The parameter type is `SecureSession`, not the relay client, so this cannot
 * be called with a plaintext transport. Returns the request id so the caller
 * can match the daemon's answer.
 */
export function sendInitDataVerification(session: SecureSession, rawInitData: string): string {
  const request = buildInitDataVerificationRequest(rawInitData);
  session.send(new TextEncoder().encode(JSON.stringify(request)));
  return request.request_id;
}
