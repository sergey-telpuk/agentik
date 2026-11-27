import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "../encoding";
import { parseInvitation } from "../pairing/invitation";
import { pinnedDeviceFromInvitation } from "../pairing/pin";
import { asJson, filled, NOW_MS, validWire } from "../pairing/testing";
import { MemoryBackend } from "./fakes";
import { MAX_PINNED_DEVICES, PinnedDeviceStore, type PinnedDevice } from "./pinnedDevices";

function device(overrides: Partial<PinnedDevice> = {}): PinnedDevice {
  const parsed = parseInvitation(asJson(validWire()), NOW_MS);
  if (!parsed.ok) throw new Error("fixture invitation is invalid");
  return { ...pinnedDeviceFromInvitation(parsed.value, NOW_MS / 1000), ...overrides };
}

describe("PinnedDeviceStore: persistence selection", () => {
  it("prefers SecureStorage over DeviceStorage", async () => {
    const store = await PinnedDeviceStore.open({
      secure: new MemoryBackend("secure"),
      device: new MemoryBackend("device"),
    });
    expect(store.persistence).toEqual({ status: "available", backend: "secure" });
  });

  it("uses DeviceStorage when SecureStorage is missing or fails its probe", async () => {
    const broken = new MemoryBackend("secure");
    broken.failGet = true;
    const a = await PinnedDeviceStore.open({ secure: null, device: new MemoryBackend("device") });
    const b = await PinnedDeviceStore.open({ secure: broken, device: new MemoryBackend("device") });
    expect(a.persistence).toEqual({ status: "available", backend: "device" });
    expect(b.persistence).toEqual({ status: "available", backend: "device" });
  });

  it("reports the explicit unsupported state when nothing works", async () => {
    const broken = new MemoryBackend("secure");
    broken.failGet = true;
    const none = await PinnedDeviceStore.open({ secure: null, device: null });
    const failing = await PinnedDeviceStore.open({ secure: broken, device: null });
    expect(none.persistence.status).toBe("unsupported");
    expect(failing.persistence.status).toBe("unsupported");
  });
});

describe("PinnedDeviceStore: pinning", () => {
  it("pins, lists, confirms, and removes a device", async () => {
    const backend = new MemoryBackend();
    const store = await PinnedDeviceStore.open({ secure: backend, device: null });

    expect(await store.list()).toEqual({ ok: true, value: [] });
    const pinned = await store.pin(device());
    expect(pinned.ok).toBe(true);
    const listed = await store.list();
    expect(listed.ok && listed.value).toEqual([device()]);

    const confirmed = await store.markConfirmed(device().deviceId);
    expect(confirmed.ok && confirmed.value.state).toBe("confirmed");

    expect((await store.remove(device().deviceId)).ok).toBe(true);
    expect(await store.list()).toEqual({ ok: true, value: [] });
  });

  it("survives a reopen with the same backend", async () => {
    const backend = new MemoryBackend();
    const first = await PinnedDeviceStore.open({ secure: backend, device: null });
    await first.pin(device());
    const second = await PinnedDeviceStore.open({ secure: backend, device: null });
    const listed = await second.list();
    expect(listed.ok && listed.value).toHaveLength(1);
  });

  it("treats pinning the same keys again as a no-op that keeps the state", async () => {
    const backend = new MemoryBackend();
    const store = await PinnedDeviceStore.open({ secure: backend, device: null });
    await store.pin(device());
    await store.markConfirmed(device().deviceId);
    const again = await store.pin(device());
    expect(again.ok && again.value.state).toBe("confirmed");
  });

  it("refuses to replace a pinned key with a different one", async () => {
    const backend = new MemoryBackend();
    const store = await PinnedDeviceStore.open({ secure: backend, device: null });
    await store.pin(device());
    const swapped = await store.pin(device({ noisePublicKey: encodeBase64Url(filled(32, 222)) }));
    expect(swapped).toMatchObject({ ok: false, code: "pin_mismatch" });
    const listed = await store.list();
    expect(listed.ok && listed.value[0]?.noisePublicKey).toBe(device().noisePublicKey);
  });

  it("rejects invalid records and enforces the device limit", async () => {
    const store = await PinnedDeviceStore.open({ secure: new MemoryBackend(), device: null });
    expect(await store.pin(device({ noisePublicKey: "short" }))).toMatchObject({
      ok: false,
      code: "invalid_device",
    });
    for (let i = 0; i < MAX_PINNED_DEVICES; i++) {
      const id = deviceIdFor(i);
      expect((await store.pin(device({ deviceId: id }))).ok).toBe(true);
    }
    expect(await store.pin(device({ deviceId: deviceIdFor(99) }))).toMatchObject({
      ok: false,
      code: "limit_reached",
    });
  });

  it("reports corrupt stored data instead of dropping it", async () => {
    const backend = new MemoryBackend();
    const store = await PinnedDeviceStore.open({ secure: backend, device: null });
    await store.pin(device());
    backend.data.set(`agentik_pin_${device().deviceId}`, "{not json");
    expect(await store.list()).toMatchObject({ ok: false, code: "corrupt_record" });
    backend.data.set("agentik_pins_index", '{"a":1}');
    expect(await store.list()).toMatchObject({ ok: false, code: "corrupt_record" });
  });

  it("reports a storage failure without throwing", async () => {
    const backend = new MemoryBackend();
    const store = await PinnedDeviceStore.open({ secure: backend, device: null });
    backend.failSet = true;
    expect(await store.pin(device())).toMatchObject({ ok: false, code: "storage_failed" });
  });
});

/** A distinct, valid 32-byte device id in lowercase base32. */
function deviceIdFor(n: number): string {
  const bytes = filled(32, n);
  let out = "";
  let buffer = 0;
  let bits = 0;
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * A recording Storage. The test environment's own localStorage is not
 * guaranteed to exist, and a missing one would make "nothing was written"
 * vacuously true; this fake makes every write observable.
 */
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

describe("long-term keys never reach web storage", () => {
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

  function expectNoWebStorageWrites(): void {
    expect(local.writes).toEqual([]);
    expect(session.writes).toEqual([]);
    expect(local.length).toBe(0);
    expect(session.length).toBe(0);
  }

  it("refuses to pin, and writes nothing, when Telegram storage is unavailable", async () => {
    const store = await PinnedDeviceStore.open({ secure: null, device: null });
    expect(store.persistence.status).toBe("unsupported");
    expect(await store.pin(device())).toMatchObject({ ok: false, code: "persistence_unsupported" });
    expect(await store.markConfirmed(device().deviceId)).toMatchObject({ ok: false });
    expect(await store.remove(device().deviceId)).toMatchObject({ ok: false });
    expect(await store.list()).toEqual({ ok: true, value: [] });
    expectNoWebStorageWrites();
  });

  it("does not fall back to web storage when the probe fails", async () => {
    const broken = new MemoryBackend("secure");
    broken.failGet = true;
    const store = await PinnedDeviceStore.open({ secure: broken, device: null });
    expect(await store.pin(device())).toMatchObject({ ok: false, code: "persistence_unsupported" });
    expectNoWebStorageWrites();
  });

  it("does not fall back to web storage when a write fails", async () => {
    const backend = new MemoryBackend("secure");
    const store = await PinnedDeviceStore.open({ secure: backend, device: null });
    backend.failSet = true;
    expect(await store.pin(device())).toMatchObject({ ok: false, code: "storage_failed" });
    expectNoWebStorageWrites();
  });

  it("writes only to the Telegram backend when it works", async () => {
    const backend = new MemoryBackend("secure");
    const store = await PinnedDeviceStore.open({ secure: backend, device: null });
    expect((await store.pin(device())).ok).toBe(true);
    expect(backend.setCalls.length).toBeGreaterThan(0);
    expectNoWebStorageWrites();
  });
});
