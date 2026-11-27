/**
 * Extraction of the DTLS certificate fingerprint from an SDP. Mirrors
 * `ExtractFingerprint` in `daemon/internal/webrtc/fingerprint.go`.
 *
 * Only sha-256 is accepted: the Noise prologue binds a fixed 32-byte value,
 * so a peer offering only a weaker algorithm is refused, not downgraded.
 * Every sha-256 fingerprint line (session and media level) must agree.
 */

import { DTLS_FINGERPRINT_SIZE } from "./prologue";

export class FingerprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FingerprintError";
  }
}

const OCTET = /^[0-9a-fA-F]{2}$/;

function parseFingerprint(text: string): Uint8Array {
  const parts = text.split(":");
  if (parts.length !== DTLS_FINGERPRINT_SIZE) {
    throw new FingerprintError(`fingerprint has ${parts.length} octets, want ${DTLS_FINGERPRINT_SIZE}`);
  }
  const out = new Uint8Array(parts.length);
  parts.forEach((part, i) => {
    if (!OCTET.test(part)) throw new FingerprintError("malformed fingerprint octet");
    out[i] = Number.parseInt(part, 16);
  });
  return out;
}

export function extractFingerprint(sdp: string): Uint8Array {
  let found: Uint8Array | null = null;
  for (const raw of sdp.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("a=fingerprint:")) continue;
    const fields = line.slice("a=fingerprint:".length).split(/\s+/).filter((f) => f !== "");
    if (fields.length !== 2) throw new FingerprintError("malformed fingerprint line");
    if (fields[0]?.toLowerCase() !== "sha-256") continue;
    const fp = parseFingerprint(fields[1] ?? "");
    if (found !== null && !sameBytes(found, fp)) {
      throw new FingerprintError("SDP declares more than one distinct DTLS fingerprint");
    }
    found = fp;
  }
  if (found === null) throw new FingerprintError("SDP has no sha-256 DTLS fingerprint");
  return found;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
