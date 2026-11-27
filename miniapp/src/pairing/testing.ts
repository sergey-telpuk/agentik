/** Test helpers for building invitations. Not imported by application code. */

import { createHash } from "node:crypto";
import { encodeBase32, encodeBase64Url } from "../encoding";
import { INVITATION_PREFIX } from "./invitation";

export const NOW_MS = Date.UTC(2026, 10, 27, 12, 0, 0);
export const NOW_S = NOW_MS / 1000;

function sha(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function filled(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 13 + seed) & 0xff);
}

/** A structurally valid and self-consistent invitation wire object. */
export function validWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const registerKey = filled(32, 1);
  const secret = filled(32, 99);
  return {
    v: 1,
    relay: "wss://relay.example.com",
    device_id: encodeBase32(sha(registerKey)),
    register_public_key: encodeBase64Url(registerKey),
    noise_public_key: encodeBase64Url(filled(32, 50)),
    invitation_id: encodeBase64Url(sha(secret)),
    invitation_secret: encodeBase64Url(secret),
    expires_at: NOW_S + 300,
    signature: encodeBase64Url(filled(64, 7)),
    ...overrides,
  };
}

export function asJson(wire: Record<string, unknown>): string {
  return JSON.stringify(wire);
}

export function asPrefixed(wire: Record<string, unknown>): string {
  return INVITATION_PREFIX + encodeBase64Url(new TextEncoder().encode(JSON.stringify(wire)));
}

export { filled };
