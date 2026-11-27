/**
 * The Telegram Mini App runtime, behind a small interface.
 *
 * `@telegram-apps/sdk` (pinned in package.json) provides the bridge to the
 * Telegram client. Only this file touches it, so the rest of the app and its
 * tests depend on `TelegramRuntime` and never need a Telegram environment.
 */

import {
  isTMA,
  on,
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
  /**
   * Theme colours as CSS custom properties (`--tg-theme-bg-color` and so on).
   * Calls `apply` now and whenever the client changes theme. Returns a disposer.
   */
  watchTheme(apply: (vars: Readonly<Record<string, string>>) => void): () => void;
  /** Tells the client the UI is ready and asks for the full height. */
  ready(): void;
  /** Shows the native Back button while subscribed. Returns a disposer that hides it. */
  showBackButton(onBack: () => void): () => void;
}

/** Runtime used outside Telegram: nothing is available. */
export const noTelegramRuntime: TelegramRuntime = {
  isMiniApp: false,
  platformVersion: null,
  rawInitData: () => null,
  supportsMethod: () => false,
  scanQr: () => Promise.resolve(null),
  watchTheme: () => () => {},
  ready: () => {},
  showBackButton: () => () => {},
};

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Maps `bg_color` (or `bgColor`) to `--tg-theme-bg-color`, keeping only `#RRGGBB` values. */
export function themeToCssVars(params: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  if (params === undefined) return vars;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string" || !COLOR.test(value)) continue;
    const name = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/_/g, "-");
    if (/^[a-z-]+$/.test(name)) vars[`--tg-theme-${name}`] = value;
  }
  return vars;
}

/** Detects the environment and returns the matching runtime. */
export function createTelegramRuntime(): TelegramRuntime {
  if (!isTMA()) return noTelegramRuntime;

  let platformVersion: string | null = null;
  let theme: Record<string, string> = {};
  try {
    const params = retrieveLaunchParams();
    platformVersion = params.tgWebAppVersion;
    theme = themeToCssVars(params.tgWebAppThemeParams);
  } catch {
    // Launch parameters missing or malformed: treat every versioned feature
    // as unsupported rather than guessing a version.
  }
  const version = platformVersion;
  const canBack = version !== null && supports("web_app_setup_back_button", version);

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
    watchTheme: (apply) => {
      apply(theme);
      return on("theme_changed", (payload) => {
        theme = themeToCssVars(payload.theme_params);
        apply(theme);
      });
    },
    ready: () => {
      postEvent("web_app_ready");
      postEvent("web_app_expand");
    },
    showBackButton: (onBack) => {
      if (!canBack) return () => {};
      const off = on("back_button_pressed", onBack);
      postEvent("web_app_setup_back_button", { is_visible: true });
      return () => {
        off();
        postEvent("web_app_setup_back_button", { is_visible: false });
      };
    },
  };
}
