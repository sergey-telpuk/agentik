import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentikApi, ApiResult, ConversationListing, OpenTerminalInput, TerminalStreamHandlers } from "../api/types";
import { ProjectScreen } from "./ProjectScreen";
import type { TerminalView } from "./terminal/view";
import { TerminalScreen } from "./TerminalScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const enc = new TextEncoder();
const dec = new TextDecoder();

class FakeView implements TerminalView {
  readonly writes: string[] = [];
  handler: ((data: string) => void) | null = null;
  disposed = false;
  write(data: Uint8Array): void {
    this.writes.push(dec.decode(data));
  }
  onData(handler: (data: string) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
  fit() {
    return { cols: 72, rows: 20 };
  }
  focus(): void {}
  dispose(): void {
    this.disposed = true;
  }
  type(text: string): void {
    this.handler?.(text);
  }
}

interface FakeTerminalApi {
  readonly api: AgentikApi;
  readonly opened: OpenTerminalInput[];
  readonly inputs: string[];
  readonly closed: string[];
  stream: TerminalStreamHandlers | null;
}

function fakeApi(open: ApiResult<{ sessionId: string; projectId: string }> = { ok: true, value: { sessionId: "term_1", projectId: "proj-1" } }): FakeTerminalApi {
  const state: FakeTerminalApi = {
    opened: [],
    inputs: [],
    closed: [],
    stream: null,
    api: {} as AgentikApi,
  };
  const api: Partial<AgentikApi> = {
    backend: "live",
    openTerminal: (_computerId, input) => {
      state.opened.push(input);
      return Promise.resolve(open);
    },
    sendTerminalInput: (_computerId, sessionId, data) => {
      state.inputs.push(`${sessionId}:${dec.decode(data)}`);
      return Promise.resolve({ ok: true, value: null });
    },
    resizeTerminal: () => Promise.resolve({ ok: true, value: null }),
    closeTerminal: (_computerId, sessionId) => {
      state.closed.push(sessionId);
      return Promise.resolve({ ok: true, value: { reason: "closed", exitCode: null } });
    },
    streamTerminal: (_computerId, _sessionId, handlers) => {
      state.stream = handlers;
      return () => {
        state.stream = null;
      };
    },
  };
  return Object.assign(state, { api: api as AgentikApi });
}

async function render(fake: FakeTerminalApi, view: FakeView): Promise<void> {
  await act(async () => {
    root.render(
      <TerminalScreen
        api={fake.api}
        computerId="c1"
        projectId="proj-1"
        projectName="agentik"
        createView={() => Promise.resolve(view)}
        onBack={() => undefined}
      />,
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(fake.opened.length).toBeGreaterThan(0));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
}

describe("TerminalScreen", () => {
  it("opens a terminal in the project with the fitted size", async () => {
    const fake = fakeApi();
    await render(fake, new FakeView());
    expect(fake.opened).toEqual([{ projectId: "proj-1", cols: 72, rows: 20 }]);
    expect(container.textContent).toContain("Connected");
  });

  it("sends typed keys and special keys to the session in order", async () => {
    const fake = fakeApi();
    const view = new FakeView();
    await render(fake, view);

    await act(async () => {
      view.type("ls\r");
      await vi.waitFor(() => expect(fake.inputs).toEqual(["term_1:ls\r"]));
    });
    await act(async () => {
      button("Control C")?.click();
      await vi.waitFor(() => expect(fake.inputs).toEqual(["term_1:ls\r", "term_1:\x03"]));
    });
  });

  it("writes output chunks in the order they arrive", async () => {
    const fake = fakeApi();
    const view = new FakeView();
    await render(fake, view);
    act(() => {
      for (const chunk of ["$ ", "echo hi\r\n", "hi\r\n", "$ "]) fake.stream?.onOutput(enc.encode(chunk));
    });
    expect(view.writes).toEqual(["$ ", "echo hi\r\n", "hi\r\n", "$ "]);
  });

  it("shows the Closed state when the shell ends, and can open a new terminal", async () => {
    const fake = fakeApi();
    const view = new FakeView();
    await render(fake, view);
    act(() => fake.stream?.onClosed({ reason: "exited", exitCode: 2 }));

    expect(container.textContent).toContain("Closed");
    expect(container.textContent).toContain("The shell exited with code 2.");
    expect(button("Control C")).toBeUndefined();

    await act(async () => {
      button("Open a new terminal")?.click();
      await vi.waitFor(() => expect(fake.opened).toHaveLength(2));
    });
    expect(view.disposed).toBe(true);
    // A session that ended by itself is not closed again.
    expect(fake.closed).toEqual([]);
  });

  it("closes the session from the Close button and shows Closed", async () => {
    const fake = fakeApi();
    await render(fake, new FakeView());
    await act(async () => {
      button("Close terminal")?.click();
      await vi.waitFor(() => expect(fake.closed).toEqual(["term_1"]));
    });
    expect(container.textContent).toContain("Closed");
    expect(container.textContent).toContain("This terminal was closed.");
  });

  it("closes the session when leaving the screen", async () => {
    const fake = fakeApi();
    const view = new FakeView();
    await render(fake, view);
    act(() => root.render(<p>elsewhere</p>));
    expect(fake.closed).toEqual(["term_1"]);
    expect(view.disposed).toBe(true);
    expect(fake.stream).toBeNull();
  });

  it("explains why a terminal could not be opened", async () => {
    const fake = fakeApi({ ok: false, error: { code: "not_found", message: "project not found" } });
    await render(fake, new FakeView());
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain("Could not open a terminal"));
    });
    expect(container.textContent).toContain("Project not found");
  });
});

describe("ProjectScreen terminal entry", () => {
  it("offers a Terminal button next to New task", async () => {
    const listing: ConversationListing = { conversations: [], source: "computer", truncated: false, warning: null };
    const api = {
      backend: "live",
      listConversations: () => Promise.resolve({ ok: true, value: listing }),
    } as unknown as AgentikApi;
    let opened = 0;
    await act(async () => {
      root.render(
        <ProjectScreen
          api={api}
          computerId="c1"
          projectId="proj-1"
          projectName="agentik"
          now={() => 0}
          onNewTask={() => undefined}
          onOpenSession={() => undefined}
          onOpenTerminal={() => (opened += 1)}
          onBack={() => undefined}
        />,
      );
    });
    act(() => button("Terminal")?.click());
    expect(opened).toBe(1);
  });
});
