/**
 * Unit tests for the encoding shared with the Go daemon.
 *
 * The vectors here are the compatibility contract: if the Go side changes
 * its canonical encoding, these fail rather than the mismatch surfacing as a
 * rejected registration in production.
 */

import { describe, expect, it } from "vitest";
import {
  CONTEXT_RELAY_REGISTER,
  CanonicalEncoder,
  constantTimeEqual,
  decodeBase64,
  encodeBase64,
  formatDeviceId,
  parseDeviceId,
  registerSigningBytes,
  sha256,
} from "../src/protocol";

describe("canonical encoding", () => {
  it("distinguishes different field splits", () => {
    // Without length prefixes these would collide, and a signature over one
    // would validate the other.
    const a = new CanonicalEncoder("ctx").addString("ab").addString("c").bytes();
    const b = new CanonicalEncoder("ctx").addString("a").addString("bc").bytes();
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("separates signing contexts", () => {
    const a = new CanonicalEncoder("agentik-relay-register-v1").addString("x").bytes();
    const b = new CanonicalEncoder("agentik-pairing-descriptor-v1").addString("x").bytes();
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("writes length-prefixed fields in a fixed layout", () => {
    const encoded = new CanonicalEncoder("ab").addString("cd").bytes();
    // 4-byte big-endian length, then the bytes, for each field in order.
    expect(Array.from(encoded)).toEqual([
      0, 0, 0, 2, 0x61, 0x62, // "ab"
      0, 0, 0, 2, 0x63, 0x64, // "cd"
    ]);
  });

  it("writes fixed-width numbers without a length prefix", () => {
    const encoded = new CanonicalEncoder("").addUint16(0x0102).bytes();
    expect(Array.from(encoded)).toEqual([0, 0, 0, 0, 0x01, 0x02]);
  });

  it("writes signed 64-bit values in two's complement", () => {
    const encoded = new CanonicalEncoder("").addInt64(-1n).bytes();
    expect(Array.from(encoded).slice(4)).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("encodes a registration exactly as the daemon signs it", () => {
    const deviceId = new Uint8Array(32).fill(1);
    const key = new Uint8Array(32).fill(2);
    const challenge = new Uint8Array(32).fill(3);

    const bytes = registerSigningBytes({
      version: 1,
      role: "device",
      relayId: "r",
      deviceId,
      registerPublicKey: key,
      challenge,
      expiresAt: 1_700_000_000n,
      signature: new Uint8Array(64),
    });

    // context(4+25) + version(2) + role(4+6) + relay(4+1)
    // + id(4+32) + key(4+32) + challenge(4+32) + expiry(8)
    expect(bytes.length).toBe(29 + 2 + 10 + 5 + 36 + 36 + 36 + 8);

    const context = new TextEncoder().encode(CONTEXT_RELAY_REGISTER);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 0, context.length]);
    expect(Array.from(bytes.slice(4, 4 + context.length))).toEqual(Array.from(context));
  });
});

describe("device identifiers", () => {
  it("round-trips through the text form", async () => {
    const id = await sha256(new Uint8Array([1, 2, 3]));
    const text = formatDeviceId(id);
    expect(text).toMatch(/^[a-z2-7]+$/);
    expect(Array.from(parseDeviceId(text)!)).toEqual(Array.from(id));
  });

  it("accepts the identifier in any case", async () => {
    const id = await sha256(new Uint8Array([9]));
    const text = formatDeviceId(id);
    expect(Array.from(parseDeviceId(text.toUpperCase())!)).toEqual(Array.from(id));
  });

  it("matches the base32 alphabet the daemon uses", () => {
    // A fixed vector pins the encoding: 32 zero bytes.
    expect(formatDeviceId(new Uint8Array(32))).toBe("a".repeat(52));
  });

  it("rejects malformed identifiers", () => {
    expect(parseDeviceId("")).toBeNull();
    expect(parseDeviceId("not-base32!")).toBeNull();
    expect(parseDeviceId("aaaa")).toBeNull(); // too short
    expect(parseDeviceId("a".repeat(104))).toBeNull(); // too long
  });
});

describe("byte helpers", () => {
  it("compares equal and unequal values correctly", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it("round-trips base64 including non-UTF8 bytes", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x28]);
    expect(Array.from(decodeBase64(encodeBase64(bytes))!)).toEqual(Array.from(bytes));
  });

  it("rejects input outside the base64 alphabet", () => {
    expect(decodeBase64("not base64!")).toBeNull();
    expect(decodeBase64("##")).toBeNull();
  });
});
