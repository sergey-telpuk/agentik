/**
 * A demo terminal for the mock backend: it echoes typed characters, shows a
 * prompt, and answers a few commands with canned text. Nothing runs anywhere.
 */

import { MAX_TERMINAL_INPUT_BYTES, type AgentikApi, type ApiResult, type TerminalClosed, type TerminalStreamHandlers } from "../types";

type TerminalApi = Pick<AgentikApi, "openTerminal" | "sendTerminalInput" | "resizeTerminal" | "closeTerminal" | "streamTerminal">;

export interface FakeTerminalDeps {
  /** Resolves the projects of a connected computer, or why it is not connected. */
  readonly projects: (computerId: string) => Promise<ApiResult<readonly { readonly id: string; readonly name: string }[]>>;
}

const PROMPT = "\x1b[32mdemo\x1b[0m $ ";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class FakeShell {
  readonly id: string;
  readonly #projectName: string;
  #line = "";
  #pending: Uint8Array[] = [];
  #handlers: TerminalStreamHandlers | null = null;
  #closed: TerminalClosed | null = null;
  #closedDelivered = false;
  cols = 80;
  rows = 24;

  constructor(id: string, projectName: string) {
    this.id = id;
    this.#projectName = projectName;
    this.#emit(`Demo terminal in ${projectName}. Nothing runs on a real computer.\r\n${PROMPT}`);
  }

  get closed(): TerminalClosed | null {
    return this.#closed;
  }

  attach(handlers: TerminalStreamHandlers): () => void {
    this.#handlers = handlers;
    const pending = this.#pending;
    this.#pending = [];
    for (const chunk of pending) handlers.onOutput(chunk);
    this.#deliverClosed();
    return () => {
      if (this.#handlers === handlers) this.#handlers = null;
    };
  }

  type(text: string): void {
    for (let i = 0; i < text.length && this.#closed === null; i++) {
      const ch = text[i] ?? "";
      if (ch === "\x1b") {
        // Skip escape sequences such as arrow keys.
        if (text[i + 1] === "[") i += 2;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        this.#emit("\r\n");
        this.#run(this.#line.trim());
        this.#line = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.#line.length > 0) {
          this.#line = this.#line.slice(0, -1);
          this.#emit("\b \b");
        }
      } else if (ch === "\x03") {
        this.#line = "";
        this.#emit(`^C\r\n${PROMPT}`);
      } else if (ch === "\x04" && this.#line === "") {
        this.end({ reason: "exited", exitCode: 0 });
      } else if (ch >= " ") {
        this.#line += ch;
        this.#emit(ch);
      }
    }
  }

  end(closed: TerminalClosed): void {
    if (this.#closed !== null) return;
    this.#closed = closed;
    this.#deliverClosed();
  }

  #run(command: string): void {
    if (command === "exit") {
      this.#emit("logout\r\n");
      this.end({ reason: "exited", exitCode: 0 });
      return;
    }
    if (command === "pwd") this.#emit(`/Users/demo/${this.#projectName}\r\n`);
    else if (command === "clear") this.#emit("\x1b[2J\x1b[H");
    else if (command !== "") this.#emit(`demo: nothing runs here: ${command}\r\n`);
    this.#emit(PROMPT);
  }

  #emit(text: string): void {
    const bytes = encoder.encode(text);
    if (this.#handlers !== null) this.#handlers.onOutput(bytes);
    else this.#pending.push(bytes);
  }

  #deliverClosed(): void {
    if (this.#closed === null || this.#handlers === null || this.#closedDelivered) return;
    this.#closedDelivered = true;
    this.#handlers.onClosed(this.#closed);
  }
}

export function createFakeTerminals(deps: FakeTerminalDeps): TerminalApi & { readonly shells: Map<string, FakeShell> } {
  const shells = new Map<string, FakeShell>();
  let counter = 0;

  function shellOf(sessionId: string): ApiResult<FakeShell> {
    const shell = shells.get(sessionId);
    if (shell === undefined) return { ok: false, error: { code: "not_found", message: "No such terminal session." } };
    if (shell.closed !== null) return { ok: false, error: { code: "not_found", message: "The terminal session has ended." } };
    return { ok: true, value: shell };
  }

  return {
    shells,

    async openTerminal(computerId, input) {
      const projects = await deps.projects(computerId);
      if (!projects.ok) return projects;
      const project = projects.value.find((p) => p.id === input.projectId);
      if (project === undefined) return { ok: false, error: { code: "not_found", message: "project not found" } };
      counter += 1;
      const shell = new FakeShell(`term_demo_${counter}`, project.name);
      shell.cols = input.cols;
      shell.rows = input.rows;
      shells.set(shell.id, shell);
      if (input.command !== undefined && input.command !== "") shell.type(`${input.command}\r`);
      return { ok: true, value: { sessionId: shell.id, projectId: project.id } };
    },

    async sendTerminalInput(_computerId, sessionId, data) {
      if (data.length === 0 || data.length > MAX_TERMINAL_INPUT_BYTES) {
        return { ok: false, error: { code: "invalid", message: `Terminal input must be 1 to ${MAX_TERMINAL_INPUT_BYTES} bytes.` } };
      }
      const shell = shellOf(sessionId);
      if (!shell.ok) return shell;
      shell.value.type(decoder.decode(data));
      return { ok: true, value: null };
    },

    async resizeTerminal(_computerId, sessionId, cols, rows) {
      const shell = shellOf(sessionId);
      if (!shell.ok) return shell;
      shell.value.cols = cols;
      shell.value.rows = rows;
      return { ok: true, value: null };
    },

    async closeTerminal(_computerId, sessionId) {
      const shell = shells.get(sessionId);
      if (shell === undefined) return { ok: false, error: { code: "not_found", message: "No such terminal session." } };
      shell.end({ reason: "closed", exitCode: null });
      return { ok: true, value: shell.closed ?? { reason: "closed", exitCode: null } };
    },

    streamTerminal(_computerId, sessionId, handlers) {
      const shell = shells.get(sessionId);
      if (shell === undefined) {
        handlers.onClosed({ reason: "lost", exitCode: null });
        return () => undefined;
      }
      return shell.attach(handlers);
    },
  };
}
