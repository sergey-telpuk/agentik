/**
 * Small, strict encoders and decoders.
 *
 * Everything here rejects input outside the expected alphabet instead of
 * decoding leniently: a silently mangled key would otherwise surface much
 * later as a confusing handshake failure.
 */

const BASE64_STD = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_URL = /^[A-Za-z0-9_-]*$/;
const BASE32_LOWER = /^[a-z2-7]*$/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Decodes standard base64 (with padding as the relay produces). */
export function decodeBase64(text: string): Uint8Array | null {
  if (!BASE64_STD.test(text)) return null;
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Encodes standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decodes unpadded URL-safe base64. Padding and other alphabets are rejected. */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (!BASE64_URL.test(text)) return null;
  // A remainder of 1 can never come from whole bytes.
  if (text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return decodeBase64(padded);
}

/** Encodes unpadded URL-safe base64. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes unpadded lowercase base32, the text form of a device identifier
 * (mirrors `FormatDeviceID` in the daemon).
 */
export function decodeBase32(text: string): Uint8Array | null {
  if (!BASE32_LOWER.test(text)) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  // Leftover bits must be zero padding, otherwise the text is not canonical.
  if (buffer !== 0) return null;
  return Uint8Array.from(out);
}

/** Encodes unpadded lowercase base32. */
export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Compares two byte strings without an early exit. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** SHA-256 through WebCrypto. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed view: WebCrypto does not accept
  // views over a SharedArrayBuffer.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return new Uint8Array(digest);
}
