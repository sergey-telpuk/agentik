/** Test helpers for building invitations. Not imported by application code. */

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { decodeBase32, decodeBase64Url, encodeBase32, encodeBase64Url } from "../encoding";
import {
  DEFAULT_RELAY_URL,
  INVITATION_PREFIX,
  INVITATION_VERSION,
  pairingDescriptorSigningBytes,
  RELAY_DEFAULT,
  RELAY_WS,
  RELAY_WSS,
} from "./invitation";

export const NOW_MS = Date.UTC(2026, 10, 27, 12, 0, 0);
export const NOW_S = NOW_MS / 1000;

function sha(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function filled(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 13 + seed) & 0xff);
}

/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function ed25519PrivateKey(seed: Uint8Array): KeyObject {
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  der.set(PKCS8_ED25519_PREFIX);
  der.set(seed, PKCS8_ED25519_PREFIX.length);
  return createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
}

function ed25519PublicKey(seed: Uint8Array): Uint8Array {
  const spki = createPublicKey(ed25519PrivateKey(seed)).export({ format: "der", type: "spki" });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

/** Seed of the test computer's registration key; it signs every test invitation. */
export const TEST_REGISTER_SEED = filled(32, 1);

/**
 * The fields of a self-consistent test invitation, binary values as unpadded
 * base64url and `device_id` as lowercase base32. Turn it into invitation text
 * with `asText`.
 */
export function validWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const registerKey = ed25519PublicKey(TEST_REGISTER_SEED);
  const secret = filled(32, 99);
  return {
    relay: "wss://relay.example.com",
    device_id: encodeBase32(sha(registerKey)),
    register_public_key: encodeBase64Url(registerKey),
    noise_public_key: encodeBase64Url(filled(32, 50)),
    invitation_id: encodeBase64Url(sha(secret)),
    invitation_secret: encodeBase64Url(secret),
    expires_at: NOW_S + 300,
    ...overrides,
  };
}

function bytesField(wire: Record<string, unknown>, key: string): Uint8Array {
  const bytes = decodeBase64Url(String(wire[key]));
  if (bytes === null) throw new Error(`test wire field ${key} is not base64url`);
  return bytes;
}

/**
 * The binary invitation payload for `wire`, signed by `TEST_REGISTER_SEED`
 * the way the daemon's `EncodeInvitation` does it.
 */
export function invitationPayload(wire: Record<string, unknown>): Uint8Array {
  const relayUrl = String(wire["relay"]);
  const registerPublicKey = ed25519PublicKey(TEST_REGISTER_SEED);
  const noisePublicKey = bytesField(wire, "noise_public_key");
  const secret = bytesField(wire, "invitation_secret");
  const expiresAt = Number(wire["expires_at"]);
  const message = pairingDescriptorSigningBytes({
    version: INVITATION_VERSION,
    relayUrl,
    deviceId: sha(registerPublicKey),
    registerPublicKey,
    noisePublicKey,
    invitationId: sha(secret),
    expiresAt,
  });
  const signature = new Uint8Array(sign(null, message, ed25519PrivateKey(TEST_REGISTER_SEED)));

  let selector = RELAY_DEFAULT;
  let relayRest = "";
  if (relayUrl !== DEFAULT_RELAY_URL) {
    selector = relayUrl.startsWith("wss://") ? RELAY_WSS : RELAY_WS;
    relayRest = relayUrl.replace(/^wss?:\/\//, "");
  }
  const rest = new TextEncoder().encode(relayRest);
  const out = new Uint8Array(2 + 32 + 32 + 32 + 4 + 64 + rest.length);
  out[0] = INVITATION_VERSION;
  out[1] = selector;
  out.set(registerPublicKey, 2);
  out.set(noisePublicKey, 34);
  out.set(secret, 66);
  new DataView(out.buffer).setUint32(98, expiresAt);
  out.set(signature, 102);
  out.set(rest, 166);
  return out;
}

/** Invitation text for raw payload bytes, signed or not. */
export function textFromPayload(payload: Uint8Array): string {
  return INVITATION_PREFIX + encodeBase32(payload).toUpperCase();
}

/** Payload bytes of an invitation text. */
export function payloadFromText(text: string): Uint8Array {
  const bytes = decodeBase32(text.slice(INVITATION_PREFIX.length).toLowerCase());
  if (bytes === null) throw new Error("not an invitation text");
  return bytes;
}

/** The invitation text the daemon would print for `wire`. */
export function asText(wire: Record<string, unknown>): string {
  return textFromPayload(invitationPayload(wire));
}

export { filled };
