/**
 * The Telegram Mini App runtime, behind a small interface.
 *
 * `@telegram-apps/sdk` (pinned in package.json) provides the bridge to the
 * Telegram client. Only this file touches it, so the rest of the app and its
 * tests depend on `TelegramRuntime` and never need a Telegram environment.
 */

import {
  isTMA,
  postEvent,
  request,
  retrieveLaunchParams,
  retrieveRawInitData,
  supports,
} from "@telegram-apps/sdk";

export interface TelegramRuntime {
  /** True when running inside a Telegram client. */
  readonly isMiniApp: boolean;
  /** Bot API version reported by the client, or null outside Telegram. */
  readonly platformVersion: string | null;
  /** The raw, unparsed `initData` string, or null. Never parsed here. */
  rawInitData(): string | null;
  /** Whether the client supports a bridge method at the reported version. */
  supportsMethod(method: "web_app_secure_storage_save_key" | "web_app_device_storage_save_key" | "web_app_open_scan_qr_popup"): boolean;
  /** Opens the native QR scanner. Resolves with the text, or null if closed. */
  scanQr(prompt: string): Promise<string | null>;
}

/** Runtime used outside Telegram: nothing is available. */
export const noTelegramRuntime: TelegramRuntime = {
  isMiniApp: false,
  platformVersion: null,
  rawInitData: () => null,
  supportsMethod: () => false,
  scanQr: () => Promise.resolve(null),
};

/** Detects the environment and returns the matching runtime. */
export function createTelegramRuntime(): TelegramRuntime {
  if (!isTMA()) return noTelegramRuntime;

  let platformVersion: string | null = null;
  try {
    platformVersion = retrieveLaunchParams().tgWebAppVersion;
  } catch {
    // Launch parameters missing or malformed: treat every versioned feature
    // as unsupported rather than guessing a version.
  }
  const version = platformVersion;

  return {
    isMiniApp: true,
    platformVersion: version,
    rawInitData: () => retrieveRawInitData() ?? null,
    supportsMethod: (method) => version !== null && supports(method, version),
    scanQr: async (prompt) => {
      const done = request("web_app_open_scan_qr_popup", ["qr_text_received", "scan_qr_popup_closed"], {
        params: { text: prompt },
      });
      try {
        const result = await done;
        return result !== undefined && "data" in result ? result.data : null;
      } finally {
        // Close the popup if the request ended another way (for example a
        // timeout), so a scanner is never left open over the app.
        postEvent("web_app_close_scan_qr_popup");
      }
    },
  };
}
