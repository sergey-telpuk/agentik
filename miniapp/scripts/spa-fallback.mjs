// Copies dist/index.html to dist/404.html so GitHub Pages serves the app for
// unknown paths (deep links). Node standard library only.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const index = join(dist, "index.html");

if (!existsSync(index)) {
  console.error(`spa-fallback: ${index} not found; run vite build first`);
  process.exit(1);
}
copyFileSync(index, join(dist, "404.html"));
console.log("spa-fallback: wrote dist/404.html");
