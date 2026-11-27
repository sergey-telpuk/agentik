import { describe, expect, it } from "vitest";
import { webrtcPrologue } from "./prologue";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
}

const seq = (from: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => from + i);

/** Asserted byte for byte by `TestNoiseWebRTCPrologueCrossLanguageVector` in daemon/internal/protocol. */
const GO_VECTOR =
  "000000206167656e74696b2d6e6f6973652d7765627274632d70726f6c6f6775652d7631000100000006636c69656e74000000066465766963650000002056475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c000000200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20000000202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";
const DEVICE_ID = fromHex("56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c");

describe("webrtcPrologue", () => {
  it("matches the Go encoding byte for byte", () => {
    expect(hex(webrtcPrologue(DEVICE_ID, seq(0x01), seq(0x21)))).toBe(GO_VECTOR);
  });

  it("is ordered: swapping the two fingerprints changes the prologue", () => {
    expect(hex(webrtcPrologue(DEVICE_ID, seq(0x21), seq(0x01)))).not.toBe(GO_VECTOR);
  });

  it("changes when any one fingerprint byte changes", () => {
    const tampered = seq(0x21);
    tampered[31] = (tampered[31] ?? 0) ^ 1;
    expect(hex(webrtcPrologue(DEVICE_ID, seq(0x01), tampered))).not.toBe(GO_VECTOR);
  });

  it("rejects malformed inputs", () => {
    expect(() => webrtcPrologue(DEVICE_ID.slice(1), seq(1), seq(2))).toThrow();
    expect(() => webrtcPrologue(DEVICE_ID, seq(1).slice(1), seq(2))).toThrow();
    expect(() => webrtcPrologue(DEVICE_ID, seq(1), new Uint8Array(33))).toThrow();
  });
});
