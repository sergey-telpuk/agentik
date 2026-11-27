/**
 * Long-term Noise X25519 static keypair for this phone.
 *
 * Stored ONLY in Telegram SecureStorage (preferred) or DeviceStorage. When
 * neither backend works, persistence is explicitly `unsupported` and no key is
 * ever written to `localStorage`, `sessionStorage`, or `indexedDB`.
 */

import { decodeBase64Url, encodeBase64Url } from "../encoding";
import { generateNoiseKeyPair, NOISE_KEY_SIZE, type NoiseKeyPair } from "../secure/noise";
import { MAX_VALUE_LENGTH, type KeyValueBackend } from "./backend";
import type { PersistenceState, StoreResult } from "./pinnedDevices";
import type { AvailableBackends } from "./telegramBackends";

const IDENTITY_KEY = "agentik_phone_identity_v1";
const PROBE_KEY = "agentik_probe";
const CORRUPT_IDENTITY_MESSAGE =
  'the stored phone identity is corrupt; open Settings and use "Clear local pinned data" to reset it';

interface StoredPhoneIdentity {
  readonly v: 1;
  readonly private_key: string;
  readonly public_key: string;
}

function parseIdentityRecord(raw: string): NoiseKeyPair | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["v"] !== 1) return null;
  if (typeof obj["private_key"] !== "string" || typeof obj["public_key"] !== "string") return null;
  const privateKey = decodeBase64Url(obj["private_key"]);
  const publicKey = decodeBase64Url(obj["public_key"]);
  if (
    privateKey === null ||
    publicKey === null ||
    privateKey.length !== NOISE_KEY_SIZE ||
    publicKey.length !== NOISE_KEY_SIZE
  ) {
    return null;
  }
  return { privateKey, publicKey };
}

export class PhoneIdentityStore {
  readonly #backend: KeyValueBackend | null;
  readonly persistence: PersistenceState;

  private constructor(backend: KeyValueBackend | null, persistence: PersistenceState) {
    this.#backend = backend;
    this.persistence = persistence;
  }

  static async open(backends: AvailableBackends): Promise<PhoneIdentityStore> {
    const reasons: string[] = [];
    for (const backend of [backends.secure, backends.device]) {
      if (backend === null) continue;
      try {
        await backend.get(PROBE_KEY);
        return new PhoneIdentityStore(backend, { status: "available", backend: backend.kind });
      } catch {
        reasons.push(`${backend.kind} storage failed its probe`);
      }
    }
    const reason =
      reasons.length > 0 ? reasons.join("; ") : "Telegram secure storage is not available in this client";
    return new PhoneIdentityStore(null, { status: "unsupported", reason });
  }

  /**
   * Loads the persisted phone X25519 static keypair, or generates and saves
   * one if absent. Returns `persistence_unsupported` if no secure backend works.
   */
  async getOrCreate(
    keygen: () => Promise<NoiseKeyPair> = () => generateNoiseKeyPair(),
  ): Promise<StoreResult<NoiseKeyPair>> {
    const backend = this.#backend;
    if (backend === null) {
      return {
        ok: false,
        code: "persistence_unsupported",
        message: "persistent access is not supported on this device",
      };
    }

    try {
      const existing = await backend.get(IDENTITY_KEY);
      if (existing !== null) {
        const parsed = parseIdentityRecord(existing);
        if (parsed === null) {
          return {
            ok: false,
            code: "corrupt_record",
            message: CORRUPT_IDENTITY_MESSAGE,
          };
        }
        return { ok: true, value: parsed };
      }

      return await this.#generateAndSave(backend, keygen);
    } catch {
      return { ok: false, code: "storage_failed", message: "saving the phone identity failed" };
    }
  }

  /**
   * Recovery for an unreadable phone identity. Only an explicit user action may
   * call this: it replaces the stored identity with a NEW keypair, so every
   * computer that knew the old public key must pair this phone again.
   *
   * A valid or absent identity is left untouched (`regenerated: false`); a
   * backend failure while reading is reported, never treated as corruption.
   */
  async resetIfCorrupt(
    keygen: () => Promise<NoiseKeyPair> = () => generateNoiseKeyPair(),
  ): Promise<StoreResult<{ readonly regenerated: boolean }>> {
    const backend = this.#backend;
    if (backend === null) {
      return {
        ok: false,
        code: "persistence_unsupported",
        message: "persistent access is not supported on this device",
      };
    }
    try {
      const existing = await backend.get(IDENTITY_KEY);
      if (existing === null || parseIdentityRecord(existing) !== null) {
        return { ok: true, value: { regenerated: false } };
      }
      const saved = await this.#generateAndSave(backend, keygen);
      return saved.ok ? { ok: true, value: { regenerated: true } } : saved;
    } catch {
      return { ok: false, code: "storage_failed", message: "resetting the phone identity failed" };
    }
  }

  /** Generates a keypair and writes it through the identity backend only. Throws on backend errors. */
  async #generateAndSave(
    backend: KeyValueBackend,
    keygen: () => Promise<NoiseKeyPair>,
  ): Promise<StoreResult<NoiseKeyPair>> {
    const generated = await keygen();
    if (generated.privateKey.length !== NOISE_KEY_SIZE || generated.publicKey.length !== NOISE_KEY_SIZE) {
      return { ok: false, code: "storage_failed", message: "generated identity has an invalid key length" };
    }
    const record: StoredPhoneIdentity = {
      v: 1,
      private_key: encodeBase64Url(generated.privateKey),
      public_key: encodeBase64Url(generated.publicKey),
    };
    const encoded = JSON.stringify(record);
    if (encoded.length > MAX_VALUE_LENGTH) {
      return { ok: false, code: "storage_failed", message: "identity record is too large" };
    }
    await backend.set(IDENTITY_KEY, encoded);
    return { ok: true, value: generated };
  }
}
