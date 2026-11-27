/**
 * A persistent key-value store that survives closing the Mini App.
 *
 * The only implementations are Telegram's SecureStorage and DeviceStorage
 * (see `telegramBackends.ts`). There is deliberately no web-storage
 * implementation: AGENTIK.md section 4 forbids silently writing a long-term
 * key to localStorage, and `src/storage/no-web-storage.test.ts` plus the
 * ESLint config enforce it.
 */
export interface KeyValueBackend {
  readonly kind: "secure" | "device";
  /** Resolves with the value, or null when the key is absent. Rejects on failure. */
  get(key: string): Promise<string | null>;
  /** Stores a value. Rejects on failure; callers must not retry elsewhere. */
  set(key: string, value: string): Promise<void>;
  /** Removes a key. Rejects on failure. */
  remove(key: string): Promise<void>;
}

/** Telegram limits values to 2048 characters and keys to [A-Za-z0-9_-]{1,128}. */
export const MAX_VALUE_LENGTH = 2048;
export const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
