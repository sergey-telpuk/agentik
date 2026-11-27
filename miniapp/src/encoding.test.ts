import { describe, expect, it } from "vitest";
import {
  bytesEqual,
  decodeBase32,
  decodeBase64,
  decodeBase64Url,
  encodeBase32,
  encodeBase64,
  encodeBase64Url,
} from "./encoding";

describe("encoding", () => {
  const sample = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);

  it("round-trips base32, base64 and base64url", () => {
    expect(decodeBase32(encodeBase32(sample))).toEqual(sample);
    expect(decodeBase64(encodeBase64(sample))).toEqual(sample);
    expect(decodeBase64Url(encodeBase64Url(sample))).toEqual(sample);
  });

  it("matches known base32 vectors (RFC 4648, lowercase, unpadded)", () => {
    // Compare as plain arrays: under jsdom, TextEncoder returns a Uint8Array
    // from another realm, which toEqual treats as a different type.
    const text = Uint8Array.from("foobar", (c) => c.charCodeAt(0));
    expect(encodeBase32(text)).toBe("mzxw6ytboi");
    expect(Array.from(decodeBase32("mzxw6ytboi") ?? [])).toEqual(Array.from(text));
  });

  it("rejects text outside the alphabet or with non-canonical bits", () => {
    expect(decodeBase32("MZXW6")).toBeNull();
    expect(decodeBase32("mzxw1")).toBeNull();
    // "mzxw7" has non-zero trailing bits.
    expect(decodeBase32("mzxw7")).toBeNull();
    expect(decodeBase64Url("ab+/")).toBeNull();
    expect(decodeBase64Url("abcde")).toBeNull();
    expect(decodeBase64Url("ab==")).toBeNull();
  });

  it("compares bytes by value and length", () => {
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
  });
});
