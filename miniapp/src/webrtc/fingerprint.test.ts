import { describe, expect, it } from "vitest";
import { extractFingerprint, FingerprintError } from "./fingerprint";
import { fingerprintText } from "./testing";

describe("extractFingerprint", () => {
  const a = fingerprintText(0xab);
  const b = fingerprintText(0xcd);

  it("reads a session-level or media-level sha-256 fingerprint, in any case", () => {
    expect(Array.from(extractFingerprint(`v=0\r\na=fingerprint:sha-256 ${a}\r\nm=application\r\n`))).toEqual(Array(32).fill(0xab));
    expect(Array.from(extractFingerprint(`v=0\r\nm=application\r\na=fingerprint:SHA-256 ${a.toLowerCase()}\r\n`))).toEqual(Array(32).fill(0xab));
  });

  it("accepts the same value on several lines", () => {
    expect(extractFingerprint(`a=fingerprint:sha-256 ${a}\r\na=fingerprint:sha-256 ${a}\r\n`)).toHaveLength(32);
  });

  it.each([
    ["two different values", `a=fingerprint:sha-256 ${a}\r\na=fingerprint:sha-256 ${b}\r\n`],
    ["none", "v=0\r\n"],
    ["only sha-1", "a=fingerprint:sha-1 AB:CD\r\n"],
    ["too short", "a=fingerprint:sha-256 AB:CD\r\n"],
    ["not hex", `a=fingerprint:sha-256 ${a.replace("AB", "ZZ")}\r\n`],
    ["a missing value", "a=fingerprint:sha-256\r\n"],
  ])("refuses %s", (_name, sdp) => {
    expect(() => extractFingerprint(sdp)).toThrow(FingerprintError);
  });
});
