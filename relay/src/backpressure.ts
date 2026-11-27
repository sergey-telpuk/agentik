/**
 * Bounded sending toward one receiver.
 *
 * The relay is not a queue. When a receiver reads slower than its peer
 * writes, the runtime buffers outgoing data in memory; left alone that
 * buffer grows without limit. Each send is checked against the receiver's
 * queued bytes instead, and a receiver that would go over budget is closed.
 */

/** The parts of a WebSocket the budget needs, so a test can supply a fake. */
export interface Receiver {
  /** Bytes queued by send() and not yet written to the network. */
  readonly bufferedAmount: number;
  send(message: string): void;
}

/**
 * Sends `message` unless it would take the receiver's queue past `limit`
 * bytes. Returns false, without sending, when it would; the caller then
 * closes the receiver.
 *
 * `message.length` is used as its size: every relay message is ASCII JSON,
 * so its UTF-16 length equals its UTF-8 byte length.
 */
export function sendWithinBudget(receiver: Receiver, message: string, limit: number): boolean {
  if (receiver.bufferedAmount + message.length > limit) return false;
  try {
    receiver.send(message);
  } catch {
    // The receiver is already gone; its close handler does the cleanup.
  }
  return true;
}
