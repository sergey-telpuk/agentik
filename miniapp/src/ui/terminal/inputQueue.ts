import { MAX_TERMINAL_INPUT_BYTES, type ApiError, type ApiResult } from "../../api/types";

const encoder = new TextEncoder();
/** Retries of one batch while the computer reports a full input queue. */
const MAX_BUSY_RETRIES = 20;
const BUSY_RETRY_MS = 100;

/**
 * Sends keyboard input strictly in order with one request in flight. Input
 * typed meanwhile is joined into the next request, split at the size limit.
 */
export class TerminalInputQueue {
  readonly #send: (data: Uint8Array) => Promise<ApiResult<null>>;
  readonly #onError: (error: ApiError) => void;
  #pending: number[] = [];
  #sending = false;
  #closed = false;

  constructor(send: (data: Uint8Array) => Promise<ApiResult<null>>, onError: (error: ApiError) => void) {
    this.#send = send;
    this.#onError = onError;
  }

  push(text: string): void {
    if (this.#closed || text === "") return;
    for (const byte of encoder.encode(text)) this.#pending.push(byte);
    void this.#drain();
  }

  close(): void {
    this.#closed = true;
    this.#pending = [];
  }

  async #drain(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (!this.#closed && this.#pending.length > 0) {
        const batch = Uint8Array.from(this.#pending.slice(0, MAX_TERMINAL_INPUT_BYTES));
        let result = await this.#send(batch);
        for (let retry = 0; !result.ok && result.error.code === "busy" && retry < MAX_BUSY_RETRIES && !this.#closed; retry++) {
          await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
          result = await this.#send(batch);
        }
        if (this.#closed) return;
        if (!result.ok) {
          this.#pending = [];
          this.#onError(result.error);
          return;
        }
        this.#pending = this.#pending.slice(batch.length);
      }
    } finally {
      this.#sending = false;
    }
  }
}
