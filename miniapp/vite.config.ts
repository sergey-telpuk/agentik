import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * Public base path. `/` serves from a domain root; a GitHub Pages project
 * page needs `/<repo>/`. Set VITE_BASE at build time; a missing leading or
 * trailing slash is added so `agentik` and `/agentik` both work.
 */
export function normalizeBase(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "" || value === "/") return "/";
  return `/${value.replace(/^\/+|\/+$/g, "")}/`;
}

export default defineConfig({
  plugins: [react()],
  base: normalizeBase(process.env.VITE_BASE),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
