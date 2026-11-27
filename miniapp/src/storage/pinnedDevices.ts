/**
 * The list of paired computers and their pinned public keys.
 *
 * Persistence goes only through Telegram SecureStorage (preferred) or
 * DeviceStorage. When neither works, the store is in the explicit
 * `unsupported` state: nothing is persisted, `pin` refuses, and the UI says
 * "persistent access is not supported". It never falls back to localStorage
 * (AGENTIK.md section 4).
 *
 * Stored data is treated as untrusted on read: a record that fails
 * validation is reported as corrupt rather than dropped, because silently
 * forgetting a pin would let a later pairing replace it.
 */

import { bytesEqual, decodeBase32, decodeBase64Url } from "../encoding";
import { MAX_VALUE_LENGTH, type KeyValueBackend } from "./backend";
import type { AvailableBackends } from "./telegramBackends";

/** Pinned data for one computer. Keys are unpadded base64url text. */
export interface PinnedDevice {
  /** Lowercase base32 device identifier. */
  readonly deviceId: string;
  readonly relayUrl: string;
  /** Ed25519 registration key (base64url). */
  readonly registerPublicKey: string;
  /** X25519 Noise key to pin (base64url). */
  readonly noisePublicKey: string;
  /** Unix seconds when the pin was created. */
  readonly pinnedAt: number;
  /**
   * `unconfirmed` until the daemon has accepted the pairing. A pin from a QR
   * code alone grants nothing.
   */
  readonly state: "unconfirmed" | "confirmed";
}

export type PersistenceState =
  | { readonly status: "available"; readonly backend: "secure" | "device" }
  | { readonly status: "unsupported"; readonly reason: string };

export type StoreErrorCode =
  | "persistence_unsupported"
  | "pin_mismatch"
  | "limit_reached"
  | "invalid_device"
  | "corrupt_record"
  | "not_found"
  | "storage_failed";

export type StoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: StoreErrorCode; readonly message: string };

export const MAX_PINNED_DEVICES = 16;
const MAX_RELAY_URL_LENGTH = 512;
const INDEX_KEY = "agentik_pins_index";
const PROBE_KEY = "agentik_probe";
const RECORD_PREFIX = "agentik_pin_";
const CORRUPT_INDEX_MESSAGE =
  'the device index is corrupt; open Settings and use "Clear local pinned data" to reset it';

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function err<T>(code: StoreErrorCode, message: string): StoreResult<T> {
  return { ok: false, code, message };
}

function isKeyOfSize(text: unknown, size: number): text is string {
  if (typeof text !== "string") return false;
  const bytes = decodeBase64Url(text);
  return bytes !== null && bytes.length === size;
}

function isValidDevice(value: unknown): value is PinnedDevice {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const id = typeof v["deviceId"] === "string" ? decodeBase32(v["deviceId"]) : null;
  return (
    id !== null &&
    id.length === 32 &&
    typeof v["relayUrl"] === "string" &&
    v["relayUrl"].length > 0 &&
    v["relayUrl"].length <= MAX_RELAY_URL_LENGTH &&
    isKeyOfSize(v["registerPublicKey"], 32) &&
    isKeyOfSize(v["noisePublicKey"], 32) &&
    typeof v["pinnedAt"] === "number" &&
    Number.isSafeInteger(v["pinnedAt"]) &&
    (v["state"] === "unconfirmed" || v["state"] === "confirmed")
  );
}

function sameKeys(a: PinnedDevice, b: PinnedDevice): boolean {
  const eq = (x: string, y: string): boolean => {
    const bx = decodeBase64Url(x);
    const by = decodeBase64Url(y);
    return bx !== null && by !== null && bytesEqual(bx, by);
  };
  return eq(a.registerPublicKey, b.registerPublicKey) && eq(a.noisePublicKey, b.noisePublicKey);
}

export class PinnedDeviceStore {
  readonly #backend: KeyValueBackend | null;
  readonly persistence: PersistenceState;

  private constructor(backend: KeyValueBackend | null, persistence: PersistenceState) {
    this.#backend = backend;
    this.persistence = persistence;
  }

  /**
   * Picks a working backend: SecureStorage first, then DeviceStorage. A
   * backend counts as working only if a harmless read succeeds, because the
   * client can advertise a method that fails at runtime.
   */
  static async open(backends: AvailableBackends): Promise<PinnedDeviceStore> {
    const reasons: string[] = [];
    for (const backend of [backends.secure, backends.device]) {
      if (backend === null) continue;
      try {
        await backend.get(PROBE_KEY);
        return new PinnedDeviceStore(backend, { status: "available", backend: backend.kind });
      } catch {
        reasons.push(`${backend.kind} storage failed its probe`);
      }
    }
    const reason =
      reasons.length > 0 ? reasons.join("; ") : "Telegram secure storage is not available in this client";
    return new PinnedDeviceStore(null, { status: "unsupported", reason });
  }

  /** Lists pinned devices. With no backend the list is empty, never read from web storage. */
  async list(): Promise<StoreResult<PinnedDevice[]>> {
    const backend = this.#backend;
    if (backend === null) return ok([]);
    try {
      const ids = await this.#readIndex(backend);
      if (!ids.ok) return ids;
      const devices: PinnedDevice[] = [];
      for (const id of ids.value) {
        const record = await this.#readRecord(backend, id);
        if (!record.ok) return record;
        devices.push(record.value);
      }
      return ok(devices);
    } catch {
      return err("storage_failed", "reading the device list failed");
    }
  }

  /**
   * Pins a device. Pinning the same keys again is a no-op; different keys for
   * an already pinned device are refused (AGENTIK.md section 5.5).
   */
  async pin(device: PinnedDevice): Promise<StoreResult<PinnedDevice>> {
    const backend = this.#backend;
    if (backend === null) {
      return err("persistence_unsupported", "persistent access is not supported on this device");
    }
    if (!isValidDevice(device)) return err("invalid_device", "the device record is not valid");
    try {
      const ids = await this.#readIndex(backend);
      if (!ids.ok) return ids;
      if (ids.value.includes(device.deviceId)) {
        const existing = await this.#readRecord(backend, device.deviceId);
        if (!existing.ok) return existing;
        if (!sameKeys(existing.value, device)) {
          return err("pin_mismatch", "a different key is already pinned for this device");
        }
        return existing;
      }
      if (ids.value.length >= MAX_PINNED_DEVICES) {
        return err("limit_reached", "too many paired computers");
      }
      const encoded = JSON.stringify(device);
      if (encoded.length > MAX_VALUE_LENGTH) return err("invalid_device", "the device record is too large");
      // Record first, then the index: a failure in between leaves an
      // unreferenced record, never an index entry without a record.
      await backend.set(RECORD_PREFIX + device.deviceId, encoded);
      await backend.set(INDEX_KEY, JSON.stringify([...ids.value, device.deviceId]));
      return ok(device);
    } catch {
      return err("storage_failed", "saving the pin failed");
    }
  }

  /** Marks a pin as confirmed once the daemon has accepted the pairing. */
  async markConfirmed(deviceId: string): Promise<StoreResult<PinnedDevice>> {
    const backend = this.#backend;
    if (backend === null) {
      return err("persistence_unsupported", "persistent access is not supported on this device");
    }
    try {
      const existing = await this.#readRecord(backend, deviceId);
      if (!existing.ok) return existing;
      const updated: PinnedDevice = { ...existing.value, state: "confirmed" };
      await backend.set(RECORD_PREFIX + deviceId, JSON.stringify(updated));
      return ok(updated);
    } catch {
      return err("storage_failed", "updating the pin failed");
    }
  }

  /** Forgets a device on this phone. It does not revoke anything on the computer. */
  async remove(deviceId: string): Promise<StoreResult<null>> {
    const backend = this.#backend;
    if (backend === null) {
      return err("persistence_unsupported", "persistent access is not supported on this device");
    }
    try {
      const ids = await this.#readIndex(backend);
      if (!ids.ok) return ids;
      if (!ids.value.includes(deviceId)) return err("not_found", "no such device");
      await backend.set(INDEX_KEY, JSON.stringify(ids.value.filter((id) => id !== deviceId)));
      await backend.remove(RECORD_PREFIX + deviceId);
      return ok(null);
    } catch {
      return err("storage_failed", "removing the device failed");
    }
  }

  /**
   * Recovery path: forgets every pin on this phone without trusting the
   * stored index, so it works when `list()` reports the index as corrupt.
   *
   * The index is overwritten with an empty list first, which is what makes
   * the store usable again. Records that a still-readable index names are then
   * removed on a best-effort basis; a record left behind is unreachable (it is
   * only ever read through the index) and is overwritten by a later pin of the
   * same device. Only the pin index and pin records are touched, never the
   * phone identity or any other key, and nothing secret is written.
   */
  async resetAll(): Promise<StoreResult<null>> {
    const backend = this.#backend;
    // Nothing is ever persisted without a backend, so there is nothing to reset.
    if (backend === null) return ok(null);
    const known = await this.#enumerateRecordIds(backend);
    try {
      await backend.set(INDEX_KEY, "[]");
    } catch {
      return err("storage_failed", "resetting the device index failed");
    }
    for (const id of known) {
      try {
        await backend.remove(RECORD_PREFIX + id);
      } catch {
        // Orphan records are harmless: they are only read via the index.
      }
    }
    return ok(null);
  }

  /** Device ids named by the stored index, read leniently. Never throws. */
  async #enumerateRecordIds(backend: KeyValueBackend): Promise<string[]> {
    try {
      const raw = await backend.get(INDEX_KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id): id is string => typeof id === "string" && decodeBase32(id)?.length === 32);
    } catch {
      return [];
    }
  }

  async #readIndex(backend: KeyValueBackend): Promise<StoreResult<string[]>> {
    const raw = await backend.get(INDEX_KEY);
    if (raw === null) return ok([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err("corrupt_record", CORRUPT_INDEX_MESSAGE);
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_PINNED_DEVICES ||
      !parsed.every((id) => typeof id === "string" && decodeBase32(id)?.length === 32)
    ) {
      return err("corrupt_record", CORRUPT_INDEX_MESSAGE);
    }
    return ok(parsed as string[]);
  }

  async #readRecord(backend: KeyValueBackend, deviceId: string): Promise<StoreResult<PinnedDevice>> {
    const raw = await backend.get(RECORD_PREFIX + deviceId);
    if (raw === null) return err("not_found", "no such device");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err("corrupt_record", "a stored device record is corrupt");
    }
    if (!isValidDevice(parsed) || parsed.deviceId !== deviceId) {
      return err("corrupt_record", "a stored device record is corrupt");
    }
    return ok(parsed);
  }
}
