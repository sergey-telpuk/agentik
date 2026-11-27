import type { KeyValueBackend } from "../../storage/backend";

/**
 * In-memory stand-in for Telegram storage, used only by the mock outside a
 * Telegram client so pairing can be demonstrated in a plain browser. Data is
 * lost on reload and never touches web storage.
 */
export class DemoMemoryBackend implements KeyValueBackend {
  readonly kind = "secure" as const;
  readonly #data = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#data.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.#data.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.#data.delete(key);
    return Promise.resolve();
  }
}
