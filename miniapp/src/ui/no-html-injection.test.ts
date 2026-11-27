import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("application source", () => {
  it("never turns strings into markup", () => {
    // Agent and computer output is untrusted (AGENTIK.md section 8); it may
    // only reach the DOM as text.
    const pattern = /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|new Function\(|\beval\(/;
    const offenders = sourceFiles(join(__dirname, ".."))
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(/^.*\/src\//, "src/"));
    expect(offenders).toEqual([]);
  });
});
