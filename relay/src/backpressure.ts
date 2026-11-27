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

/**
 * Charges the bytes queued toward one receiver to the connections whose
 * messages they are, so each sender's share of that queue can be bounded.
 *
 * The runtime reports only the receiver's total queued bytes. The queue
 * drains in the order messages were sent, so the bytes sent so far minus
 * the bytes still queued is how far it has drained, and every message that
 * ends at or before that point has left. A message without an owner (one
 * of the relay's own) still moves that point but is charged to no one.
 *
 * Every send to the receiver must be recorded here; an unrecorded one only
 * makes owners look charged for longer than they are.
 */
export class QueueLedger {
  /** Bytes put into the queue since tracking began, including what it held then. */
  #sent: number;
  /** Owned messages that may still be queued, oldest first, starting at `#head`. */
  readonly #entries: { owner: string; size: number; end: number }[] = [];
  #head = 0;
  readonly #charged = new Map<string, number>();

  /** `queued` is what the receiver already holds; it is charged to no one. */
  constructor(queued: number) {
    this.#sent = queued;
  }

  /** Releases the messages that have left the queue, given the bytes still queued. */
  settle(queued: number): void {
    const drained = this.#sent - queued;
    while (this.#head < this.#entries.length) {
      const entry = this.#entries[this.#head]!;
      if (entry.end > drained) break;
      this.#head += 1;
      const left = this.inFlight(entry.owner) - entry.size;
      if (left > 0) this.#charged.set(entry.owner, left);
      else this.#charged.delete(entry.owner);
    }
    if (this.#head === this.#entries.length) {
      this.#entries.length = 0;
      this.#head = 0;
    } else if (this.#head >= 1024) {
      this.#entries.splice(0, this.#head);
      this.#head = 0;
    }
  }

  /** Bytes charged to `owner` that may still be queued. */
  inFlight(owner: string): number {
    return this.#charged.get(owner) ?? 0;
  }

  /** Records a message just queued, charged to `owner` when it has one. */
  record(size: number, owner?: string): void {
    this.#sent += size;
    if (owner === undefined) return;
    this.#entries.push({ owner, size, end: this.#sent });
    this.#charged.set(owner, this.inFlight(owner) + size);
  }
}
