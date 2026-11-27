/** Test doubles for storage. Not imported by application code. */

import type { KeyValueBackend } from "./backend";

export class MemoryBackend implements KeyValueBackend {
  readonly data = new Map<string, string>();
  failGet = false;
  failSet = false;
  readonly setCalls: string[] = [];

  constructor(readonly kind: "secure" | "device" = "secure") {}

  get(key: string): Promise<string | null> {
    if (this.failGet) return Promise.reject(new Error("get failed"));
    return Promise.resolve(this.data.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.setCalls.push(key);
    if (this.failSet) return Promise.reject(new Error("set failed"));
    this.data.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}
