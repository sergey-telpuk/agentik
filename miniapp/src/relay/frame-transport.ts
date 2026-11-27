/** A channel that moves opaque ciphertext frames. It never sees plaintext. */
export interface FrameTransport {
  /** Sends one opaque frame to the paired computer. */
  sendFrame(frame: Uint8Array): void;
  /** Subscribes to opaque frames from the computer. Returns an unsubscribe function. */
  onFrame(handler: (frame: Uint8Array) => void): () => void;
}
