/**
 * The seam where the Noise session will plug in.
 *
 * Noise is NOT implemented in the Mini App yet (AGENTIK.md section 6.1). The
 * relay client moves opaque frames; a `SecureChannelFactory` turns that frame
 * transport plus a pinned daemon key into an authenticated session that can
 * carry inner messages. Everything that must be confidential (initData, agent
 * commands) is expressed against `SecureSession`, never against the raw relay
 * client, so it cannot be sent in clear by mistake.
 *
 * TODO(noise): implement `SecureChannelFactory` with
 * `Noise_XX_25519_ChaChaPoly_SHA256`, the prologue defined by
 * `NoisePrologue` in `daemon/internal/protocol/device.go`, and a vetted
 * library whose WebView compatibility has been tested (AGENTIK.md section
 * 14). The phone must check the daemon's static key against the pinned key
 * after the second XX message and refuse the session on any mismatch.
 */

import type { FrameTransport } from "../relay/frame-transport";

/** A phone's confirmed view of the computer it talks to. */
export interface SecureChannelParams {
  readonly transport: FrameTransport;
  /** The 32-byte device identifier the relay routes by. */
  readonly deviceId: Uint8Array;
  /** The pinned X25519 key of the daemon. A different key must abort. */
  readonly pinnedNoisePublicKey: Uint8Array;
}

/** An authenticated, encrypted session. Created only after a full handshake. */
export interface SecureSession {
  /** Sends one inner message. The implementation encrypts it. */
  send(plaintext: Uint8Array): void;
  /** Subscribes to decrypted inner messages. Returns an unsubscribe function. */
  onMessage(handler: (plaintext: Uint8Array) => void): () => void;
  close(): void;
}

export interface SecureChannelFactory {
  /** Resolves only after the handshake completed and the daemon key matched the pin. */
  open(params: SecureChannelParams): Promise<SecureSession>;
}

/** Raised by the placeholder factory so a missing implementation is loud. */
export class NoiseNotImplementedError extends Error {
  constructor() {
    super("The Noise secure channel is not implemented yet");
    this.name = "NoiseNotImplementedError";
  }
}

/** Placeholder used until the Noise module exists. It always refuses. */
export const unimplementedSecureChannel: SecureChannelFactory = {
  open(): Promise<SecureSession> {
    return Promise.reject(new NoiseNotImplementedError());
  },
};
