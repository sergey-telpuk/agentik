import { describe, expect, it } from "vitest";
import type { TerminalClosed } from "../types";
import { createFakeTerminals } from "./fakeTerminal";

const enc = new TextEncoder();
const dec = new TextDecoder();
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function terminals() {
  return createFakeTerminals({
    projects: (computerId) =>
      Promise.resolve(
        computerId === "c1"
          ? { ok: true, value: [{ id: "proj-1", name: "agentik" }] }
          : { ok: false, error: { code: "not_connected", message: "There is no secure session with this computer." } },
      ),
  });
}

describe("mock terminal", () => {
  it("shows a prompt, echoes typed input, answers a command, and ends on exit", async () => {
    const api = terminals();
    const opened = await api.openTerminal("c1", { projectId: "proj-1", cols: 80, rows: 24 });
    if (!opened.ok) throw new Error(opened.error.message);

    let out = "";
    const closed: TerminalClosed[] = [];
    api.streamTerminal("c1", opened.value.sessionId, { onOutput: (d) => (out += dec.decode(d)), onClosed: (c) => closed.push(c) });
    expect(plain(out)).toContain("demo $ ");

    await api.sendTerminalInput("c1", opened.value.sessionId, enc.encode("pwdx\x7f\r"));
    expect(plain(out)).toContain("pwdx\b \b\r\n/Users/demo/agentik\r\ndemo $ ");

    await api.sendTerminalInput("c1", opened.value.sessionId, enc.encode("exit\r"));
    expect(closed).toEqual([{ reason: "exited", exitCode: 0 }]);
    const after = await api.sendTerminalInput("c1", opened.value.sessionId, enc.encode("x"));
    expect(after.ok).toBe(false);
  });

  it("refuses unknown projects and computers that are not connected", async () => {
    const api = terminals();
    expect((await api.openTerminal("c1", { projectId: "nope", cols: 80, rows: 24 })).ok).toBe(false);
    const offline = await api.openTerminal("c2", { projectId: "proj-1", cols: 80, rows: 24 });
    expect(offline.ok === false && offline.error.code).toBe("not_connected");
  });

  it("reports an explicit close to the stream", async () => {
    const api = terminals();
    const opened = await api.openTerminal("c1", { projectId: "proj-1", cols: 80, rows: 24, command: "codex" });
    if (!opened.ok) throw new Error(opened.error.message);
    const closed: TerminalClosed[] = [];
    let out = "";
    api.streamTerminal("c1", opened.value.sessionId, { onOutput: (d) => (out += dec.decode(d)), onClosed: (c) => closed.push(c) });
    expect(out).toContain("demo: nothing runs here: codex");
    expect(await api.closeTerminal("c1", opened.value.sessionId)).toEqual({ ok: true, value: { reason: "closed", exitCode: null } });
    expect(closed).toEqual([{ reason: "closed", exitCode: null }]);
  });
});
