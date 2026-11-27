/**
 * Interfaces for the authenticated, encrypted Noise session layered over
 * `FrameTransport`.
 *
 * Everything confidential (`initData`, pairing submission, agent commands,
 * task events, approvals) is expressed against `SecureSession`, never against
 * `FrameTransport` directly, so application code cannot accidentally emit
 * plaintext to the relay.
 */

import type { FrameTransport } from "../relay/frame-transport";

/** A phone's confirmed view of the computer it talks to. */
export interface SecureChannelParams {
  readonly transport: FrameTransport;
  /** The 32-byte device identifier the relay routes by. */
  readonly deviceId: Uint8Array;
  /** The pinned X25519 static public key of the daemon. A mismatch aborts. */
  readonly pinnedNoisePublicKey: Uint8Array;
  /** This phone's long-term X25519 static private key (32 bytes). */
  readonly clientStaticPrivateKey: Uint8Array;
  /** Maximum milliseconds to wait for handshake completion. */
  readonly handshakeTimeoutMs?: number;
  /** Optional abort signal to cancel an in-flight handshake. */
  readonly signal?: AbortSignal;
}

/** An authenticated, encrypted session. Created only after a full handshake. */
export interface SecureSession {
  /** Sends one inner message. The implementation encrypts it. */
  send(plaintext: Uint8Array): void;
  /** Subscribes to decrypted inner messages. Returns an unsubscribe function. */
  onMessage(handler: (plaintext: Uint8Array) => void): () => void;
  /** Subscribes to decryption or session errors after handshake completion. */
  onError?(handler: (error: Error) => void): () => void;
  close(): void;
}

export interface SecureChannelFactory {
  /** Resolves only after the handshake completed and the daemon key matched the pin. */
  open(params: SecureChannelParams): Promise<SecureSession>;
}
