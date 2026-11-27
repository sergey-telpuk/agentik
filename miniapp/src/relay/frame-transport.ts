/**
 * A channel that moves opaque ciphertext frames. It never sees plaintext.
 * The only implementation carries them over a WebRTC DataChannel
 * (`src/webrtc/link.ts`); nothing sends frames through the relay.
 */
export interface FrameTransport {
  /** Sends one opaque frame to the paired computer. */
  sendFrame(frame: Uint8Array): void;
  /** Subscribes to opaque frames from the computer. Returns an unsubscribe function. */
  onFrame(handler: (frame: Uint8Array) => void): () => void;
}

/** Largest frame on the DataChannel, matching `secure.MaxMessageSize` on the daemon. */
export const MAX_FRAME_BYTES = 32 * 1024;
