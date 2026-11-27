/**
 * The Noise prologue that binds the DTLS fingerprints of the WebRTC
 * connection into the handshake. Mirrors `protocol.NoiseWebRTCPrologue` in
 * `daemon/internal/protocol/device.go` byte for byte; `prologue.test.ts` and
 * `TestNoiseWebRTCPrologueCrossLanguageVector` pin the same vector.
 *
 * Layout (canonical encoding: uint32 big-endian length prefixes):
 *   context, uint16 version, "client", "device", deviceId,
 *   initiator (phone) fingerprint, responder (computer) fingerprint.
 *
 * Both sides feed this into Noise. If anyone on the signaling path swapped a
 * fingerprint, the two sides hold different prologues and the Noise
 * handshake fails before any application byte is exchanged.
 */

export const WEBRTC_PROLOGUE_CONTEXT = "agentik-noise-webrtc-prologue-v1";
export const WEBRTC_PROLOGUE_VERSION = 1;
export const DTLS_FINGERPRINT_SIZE = 32;

export function webrtcPrologue(
  deviceId: Uint8Array,
  phoneFingerprint: Uint8Array,
  computerFingerprint: Uint8Array,
): Uint8Array {
  if (deviceId.length !== 32) throw new Error(`deviceId must be 32 bytes, got ${deviceId.length}`);
  if (phoneFingerprint.length !== DTLS_FINGERPRINT_SIZE || computerFingerprint.length !== DTLS_FINGERPRINT_SIZE) {
    throw new Error(`DTLS fingerprints must be ${DTLS_FINGERPRINT_SIZE} bytes`);
  }
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(WEBRTC_PROLOGUE_CONTEXT),
    null, // the version, written as a bare uint16 below
    encoder.encode("client"),
    encoder.encode("device"),
    deviceId,
    phoneFingerprint,
    computerFingerprint,
  ];
  let total = 2;
  for (const part of parts) if (part !== null) total += 4 + part.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    if (part === null) {
      view.setUint16(offset, WEBRTC_PROLOGUE_VERSION, false);
      offset += 2;
      continue;
    }
    view.setUint32(offset, part.length, false);
    offset += 4;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
