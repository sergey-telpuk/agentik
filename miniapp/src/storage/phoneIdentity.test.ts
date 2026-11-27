import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "./fakes";
import { PhoneIdentityStore } from "./phoneIdentity";

class RecordingStorage implements Storage {
  readonly writes: string[] = [];
  readonly #data = new Map<string, string>();
  get length(): number {
    return this.#data.size;
  }
  clear(): void {
    this.#data.clear();
  }
  getItem(key: string): string | null {
    return this.#data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    this.#data.set(key, value);
  }
  [name: string]: unknown;
}

describe("PhoneIdentityStore", () => {
  let local: RecordingStorage;
  let session: RecordingStorage;

  beforeEach(() => {
    local = new RecordingStorage();
    session = new RecordingStorage();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates once, persists in SecureStorage, and reuses across reopen", async () => {
    const backend = new MemoryBackend("secure");
    const store1 = await PhoneIdentityStore.open({ secure: backend, device: null });
    const first = await store1.getOrCreate();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.privateKey).toHaveLength(32);
    expect(first.value.publicKey).toHaveLength(32);

    const store2 = await PhoneIdentityStore.open({ secure: backend, device: null });
    const second = await store2.getOrCreate();
    expect(second).toEqual(first);
    expect(local.writes).toEqual([]);
    expect(session.writes).toEqual([]);
  });

  it("refuses when Telegram storage is unavailable and never uses localStorage", async () => {
    const store = await PhoneIdentityStore.open({ secure: null, device: null });
    expect(store.persistence.status).toBe("unsupported");
    const res = await store.getOrCreate();
    expect(res).toMatchObject({ ok: false, code: "persistence_unsupported" });
    expect(local.writes).toEqual([]);
    expect(session.writes).toEqual([]);
  });

  it("reports corrupt stored identity instead of overwriting it", async () => {
    const backend = new MemoryBackend("secure");
    backend.data.set("agentik_phone_identity_v1", "{bad");
    const store = await PhoneIdentityStore.open({ secure: backend, device: null });
    expect(await store.getOrCreate()).toMatchObject({ ok: false, code: "corrupt_record" });
  });

  it("resetIfCorrupt replaces an unreadable identity with a new keypair, in the identity backend only", async () => {
    for (const corrupt of ["{bad", "null", '{"v":2}', '{"v":1,"private_key":"AA","public_key":"AA"}']) {
      const backend = new MemoryBackend("secure");
      backend.data.set("agentik_phone_identity_v1", corrupt);
      const store = await PhoneIdentityStore.open({ secure: backend, device: null });
      expect(await store.getOrCreate()).toMatchObject({ ok: false, code: "corrupt_record" });

      expect(await store.resetIfCorrupt()).toEqual({ ok: true, value: { regenerated: true } });
      const loaded = await store.getOrCreate();
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.privateKey).toHaveLength(32);
        expect(loaded.value.publicKey).toHaveLength(32);
      }
      expect(backend.data.get("agentik_phone_identity_v1")).not.toBe(corrupt);
    }
    expect(local.writes).toEqual([]);
    expect(session.writes).toEqual([]);
  });

  it("resetIfCorrupt keeps a valid identity and does not create a missing one", async () => {
    const backend = new MemoryBackend("secure");
    const store = await PhoneIdentityStore.open({ secure: backend, device: null });
    expect(await store.resetIfCorrupt()).toEqual({ ok: true, value: { regenerated: false } });
    expect(backend.data.has("agentik_phone_identity_v1")).toBe(false);

    const created = await store.getOrCreate();
    const raw = backend.data.get("agentik_phone_identity_v1");
    expect(await store.resetIfCorrupt()).toEqual({ ok: true, value: { regenerated: false } });
    expect(backend.data.get("agentik_phone_identity_v1")).toBe(raw);
    expect(await store.getOrCreate()).toEqual(created);
  });

  it("resetIfCorrupt reports storage failures instead of treating them as corruption", async () => {
    const backend = new MemoryBackend("secure");
    backend.data.set("agentik_phone_identity_v1", "{bad");
    const store = await PhoneIdentityStore.open({ secure: backend, device: null });
    backend.failGet = true;
    expect(await store.resetIfCorrupt()).toMatchObject({ ok: false, code: "storage_failed" });
    backend.failGet = false;
    backend.failSet = true;
    expect(await store.resetIfCorrupt()).toMatchObject({ ok: false, code: "storage_failed" });
    expect(backend.data.get("agentik_phone_identity_v1")).toBe("{bad");

    const unsupported = await PhoneIdentityStore.open({ secure: null, device: null });
    expect(await unsupported.resetIfCorrupt()).toMatchObject({ ok: false, code: "persistence_unsupported" });
    expect(local.writes).toEqual([]);
    expect(session.writes).toEqual([]);
  });
});
