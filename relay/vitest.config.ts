import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Tests run inside workerd, so Durable Objects, the WebSocket Hibernation
// API, and WebCrypto behave as they do in production rather than being
// stubbed by a mock.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
