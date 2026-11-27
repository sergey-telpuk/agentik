import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A long-term key must never be written to ordinary web storage
      // (AGENTIK.md section 4). Persistence goes through src/storage, which
      // uses Telegram DeviceStorage/SecureStorage only.
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "Use src/storage; web storage is not allowed for keys." },
        { name: "sessionStorage", message: "Use src/storage; web storage is not allowed for keys." },
        { name: "indexedDB", message: "Use src/storage; web storage is not allowed for keys." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "localStorage", message: "Use src/storage." },
        { object: "window", property: "sessionStorage", message: "Use src/storage." },
        { object: "globalThis", property: "localStorage", message: "Use src/storage." },
        { object: "globalThis", property: "sessionStorage", message: "Use src/storage." },
      ],
    },
  },
  {
    // Build-time Node scripts.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // Tests inspect web storage to prove it is never written to.
    files: ["src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" },
  },
);
