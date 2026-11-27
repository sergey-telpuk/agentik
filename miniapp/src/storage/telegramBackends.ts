/**
 * Telegram SecureStorage and DeviceStorage as `KeyValueBackend`s.
 *
 * SecureStorage is not protection against modified Mini App code: the app can
 * read a value back (AGENTIK.md section 4). It protects data at rest on the
 * device, and that is all it is used for.
 *
 * TODO(restore): SecureStorage can offer to restore a key after a device
 * change (`web_app_secure_storage_restore_key`). It is not used: a new phone
 * goes through its own pairing (AGENTIK.md section 3.1).
 */

import { createRequestId, request } from "@telegram-apps/sdk";
import { KEY_PATTERN, MAX_VALUE_LENGTH, type KeyValueBackend } from "./backend";
import type { TelegramRuntime } from "../telegram/runtime";

const REQUEST_TIMEOUT_MS = 5000;

function checkKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error("invalid storage key");
}

function failure(error: string | undefined): Error {
  return new Error(error ?? "storage request failed");
}

function createSecureBackend(): KeyValueBackend {
  return {
    kind: "secure",
    async get(key) {
      checkKey(key);
      const id = createRequestId();
      const result = await request(
        "web_app_secure_storage_get_key",
        ["secure_storage_key_received", "secure_storage_failed"],
        {
          params: { req_id: id, key },
          timeout: REQUEST_TIMEOUT_MS,
          capture: ({ payload }) => payload.req_id === id,
        },
      );
      if ("error" in result) throw failure(result.error);
      return "value" in result ? result.value : null;
    },
    async set(key, value) {
      checkKey(key);
      if (value.length > MAX_VALUE_LENGTH) throw new Error("storage value too long");
      await save("web_app_secure_storage_save_key", "secure_storage_key_saved", "secure_storage_failed", key, value);
    },
    async remove(key) {
      checkKey(key);
      await save("web_app_secure_storage_save_key", "secure_storage_key_saved", "secure_storage_failed", key, null);
    },
  };
}

function createDeviceBackend(): KeyValueBackend {
  return {
    kind: "device",
    async get(key) {
      checkKey(key);
      const id = createRequestId();
      const result = await request(
        "web_app_device_storage_get_key",
        ["device_storage_key_received", "device_storage_failed"],
        {
          params: { req_id: id, key },
          timeout: REQUEST_TIMEOUT_MS,
          capture: ({ payload }) => payload.req_id === id,
        },
      );
      if ("error" in result) throw failure(result.error);
      return "value" in result ? result.value : null;
    },
    async set(key, value) {
      checkKey(key);
      if (value.length > MAX_VALUE_LENGTH) throw new Error("storage value too long");
      await save("web_app_device_storage_save_key", "device_storage_key_saved", "device_storage_failed", key, value);
    },
    async remove(key) {
      checkKey(key);
      await save("web_app_device_storage_save_key", "device_storage_key_saved", "device_storage_failed", key, null);
    },
  };
}

type SaveMethod = "web_app_secure_storage_save_key" | "web_app_device_storage_save_key";

async function save(
  method: SaveMethod,
  okEvent: "secure_storage_key_saved" | "device_storage_key_saved",
  failEvent: "secure_storage_failed" | "device_storage_failed",
  key: string,
  value: string | null,
): Promise<void> {
  const id = createRequestId();
  const result = await request(method, [okEvent, failEvent], {
    params: { req_id: id, key, value },
    timeout: REQUEST_TIMEOUT_MS,
    capture: ({ payload }) => payload.req_id === id,
  });
  if ("error" in result) throw failure(result.error);
}

/** The backends this client may use, or null where the client lacks support. */
export interface AvailableBackends {
  readonly secure: KeyValueBackend | null;
  readonly device: KeyValueBackend | null;
}

/** Builds backends only for the features the Telegram client reports. */
export function createTelegramBackends(runtime: TelegramRuntime): AvailableBackends {
  return {
    secure: runtime.supportsMethod("web_app_secure_storage_save_key") ? createSecureBackend() : null,
    device: runtime.supportsMethod("web_app_device_storage_save_key") ? createDeviceBackend() : null,
  };
}
