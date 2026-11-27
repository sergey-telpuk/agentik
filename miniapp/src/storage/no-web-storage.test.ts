import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Collects application source files, excluding tests and test helpers. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    const isSource = /\.(ts|tsx)$/.test(name);
    const isTestFile = /\.test\.(ts|tsx)$/.test(name) || name === "testing.ts" || name === "fakes.ts";
    return isSource && !isTestFile ? [path] : [];
  });
}

/** Drops comment lines, which may mention web storage to forbid it. */
function codeOnly(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

describe("application source", () => {
  it("never references web storage", () => {
    const offenders = sourceFiles(join(__dirname, ".."))
      .filter((file) => /\b(localStorage|sessionStorage|indexedDB)\b/.test(codeOnly(readFileSync(file, "utf8"))))
      .map((file) => file.replace(/^.*\/src\//, "src/"));
    expect(offenders).toEqual([]);
  });
});
