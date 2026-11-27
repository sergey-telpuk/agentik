/**
 * Cross-language compatibility vectors.
 *
 * The values below were produced by the Go daemon's protocol package from
 * fixed inputs. They are the contract between the two implementations: the
 * relay verifies signatures the daemon makes, so if either side changes its
 * canonical encoding, these tests fail here rather than the mismatch
 * appearing as an unexplained rejected registration in production.
 *
 * Regenerate them only together with a deliberate protocol version change.
 */

import { describe, expect, it } from "vitest";
import {
  CanonicalEncoder,
  CONTEXT_RELAY_REGISTER,
  decodeBase64,
  formatDeviceId,
  registerSigningBytes,
  sha256,
  verifyEd25519,
} from "../src/protocol";

/** Inputs the Go side used: seed bytes 0..31, challenge bytes 0xA0..0xBF. */
const VECTOR = {
  relayId: "agentik-relay-dev",
  expiresAt: 1_700_000_000n,
  deviceIdB64: "Vkdap1RjR0wChd9dvyvKtz2mUTWIOem3dIGy6rEHcIw=",
  deviceIdText: "kzdvvj2umnduyauf35o36k6kw462mujvra46tn3uqgzovmihocga",
  publicKeyB64: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
  challengeB64: "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8=",
  signatureB64:
    "ftPYGqoyEmXunSVB2dgYRm8evOIon8LVlqIQ2Fp8hRV4EDmTOeQIkVeiTyLuadAcOgyV5/TH7GRCIIWXdj/2Dg==",
  signingHex:
    "000000196167656e74696b2d72656c61792d72656769737465722d7631000100000006646576696365" +
    "000000116167656e74696b2d72656c61792d6465760000002056475aa75463474c0285df5dbf2bcab7" +
    "3da651358839e9b77481b2eab107708c0000002003a107bff3ce10be1d70dd18e74bc09967e4d6309ba" +
    "50d5f1ddc8664125531b800000020a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9ba" +
    "bbbcbdbebf000000006553f100",
} as const;

function bytes(base64: string): Uint8Array {
  const decoded = decodeBase64(base64);
  if (!decoded) throw new Error("vector is not valid base64");
  return decoded;
}

function toHex(data: Uint8Array): string {
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("compatibility with the Go daemon", () => {
  it("produces the same canonical signing bytes", () => {
    const encoded = registerSigningBytes({
      version: 1,
      role: "device",
      relayId: VECTOR.relayId,
      deviceId: bytes(VECTOR.deviceIdB64),
      registerPublicKey: bytes(VECTOR.publicKeyB64),
      challenge: bytes(VECTOR.challengeB64),
      expiresAt: VECTOR.expiresAt,
      signature: new Uint8Array(64),
    });

    expect(toHex(encoded)).toBe(VECTOR.signingHex.replace(/\s/g, ""));
  });

  it("verifies a signature the daemon produced", async () => {
    const signing = registerSigningBytes({
      version: 1,
      role: "device",
      relayId: VECTOR.relayId,
      deviceId: bytes(VECTOR.deviceIdB64),
      registerPublicKey: bytes(VECTOR.publicKeyB64),
      challenge: bytes(VECTOR.challengeB64),
      expiresAt: VECTOR.expiresAt,
      signature: new Uint8Array(64),
    });

    const valid = await verifyEd25519(
      bytes(VECTOR.publicKeyB64),
      signing,
      bytes(VECTOR.signatureB64),
    );
    expect(valid).toBe(true);
  });

  it("derives the same device id from the registration key", async () => {
    const derived = await sha256(bytes(VECTOR.publicKeyB64));
    expect(toHex(derived)).toBe(toHex(bytes(VECTOR.deviceIdB64)));
  });

  it("formats the device id the same way", () => {
    expect(formatDeviceId(bytes(VECTOR.deviceIdB64))).toBe(VECTOR.deviceIdText);
  });

  it("uses the signing context the daemon uses", () => {
    // The context is the first length-prefixed field, so a change to it
    // shows up at a known offset.
    const encoded = new CanonicalEncoder(CONTEXT_RELAY_REGISTER).bytes();
    expect(toHex(encoded)).toBe(VECTOR.signingHex.replace(/\s/g, "").slice(0, encoded.length * 2));
  });
});
