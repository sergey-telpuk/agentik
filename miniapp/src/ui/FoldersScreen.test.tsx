import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentikApi, Project } from "../api/types";
import { FoldersScreen } from "./FoldersScreen";

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

function button(label: string): HTMLButtonElement {
  const all = [...container.querySelectorAll("button")];
  const found =
    all.find((b) => b.textContent === label || b.getAttribute("aria-label") === label) ??
    all.find((b) => b.textContent?.includes(label) === true);
  if (found === undefined) throw new Error(`no button "${label}" in: ${container.textContent}`);
  return found;
}

async function show(api: Partial<AgentikApi>, projects: Project[]): Promise<void> {
  const full = {
    listProjects: () => Promise.resolve({ ok: true as const, value: projects }),
    browse: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          path: "/Users/me",
          parent: "/Users",
          directories: [{ name: "my-app", path: "/Users/me/my-app" }],
        },
      }),
    ...api,
  } as unknown as AgentikApi;
  await act(async () => {
    root.render(<FoldersScreen api={full} computerId="comp-1" computerName="Work box" onBack={vi.fn()} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("FoldersScreen", () => {
  it("adds a folder picked from the computer, without anyone typing a path", async () => {
    const added = vi.fn(() => Promise.resolve({ ok: true as const, value: { id: "p1", name: "my-app", activeTasks: 0 } }));
    let projects: Project[] = [];
    await show(
      {
        addProject: added as unknown as AgentikApi["addProject"],
        listProjects: () => Promise.resolve({ ok: true as const, value: projects }),
      },
      projects,
    );

    expect(container.textContent).toContain("No folders yet.");
    await act(async () => {
      button("Add a folder").click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The computer offers what it has; nobody has to know the path.
    expect(container.textContent).toContain("my-app");
    projects = [{ id: "p1", name: "my-app", activeTasks: 0 }];
    await act(async () => {
      button("Add").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(added).toHaveBeenCalledWith("comp-1", "/Users/me/my-app");
  });

  it("says what adding a folder grants", async () => {
    await show({}, []);
    await act(async () => {
      button("Add a folder").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The folder becomes an agent's working directory; that is worth stating.
    expect(container.textContent).toContain("runs with your permissions");
  });

  it("reports why the computer refused a folder", async () => {
    await show(
      {
        addProject: () =>
          Promise.resolve({ ok: false as const, error: { code: "invalid" as const, message: "no such directory" } }),
      },
      [],
    );
    await act(async () => {
      button("Add a folder").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      button("Add").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain("No such directory");
  });

  it("asks before removing a folder and keeps the conversations", async () => {
    const removed = vi.fn(() => Promise.resolve({ ok: true as const, value: null }));
    await show({ removeProject: removed as unknown as AgentikApi["removeProject"] }, [
      { id: "p1", name: "my-app", activeTasks: 0 },
    ]);

    await act(async () => {
      button("Remove folder: my-app").click();
    });
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("conversations that ran there are kept");
    expect(removed).not.toHaveBeenCalled();

    await act(async () => {
      button("Remove").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(removed).toHaveBeenCalledWith("comp-1", "p1");
  });

  it("shows that an agent is working in a folder", async () => {
    await show({}, [{ id: "p1", name: "busy-app", activeTasks: 2 }]);
    expect(container.textContent).toContain("2 agents working");
  });
});
