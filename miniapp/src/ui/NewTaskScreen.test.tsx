import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Agent, AgentikApi, TaskSummary } from "../api/types";
import { NewTaskScreen } from "./NewTaskScreen";

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

const AGENTS: Agent[] = [
  {
    id: "codex",
    name: "Codex",
    status: "available",
    version: "codex-cli 1",
    models: [
      { id: "big", name: "Big", description: "Largest model", isDefault: true },
      { id: "small", name: "Small", description: null, isDefault: false },
    ],
  },
  {
    // A second ready agent, so the model list can be seen to follow the agent.
    id: "other",
    name: "Other",
    status: "available",
    version: "2",
    models: [{ id: "o-1", name: "Other One", description: null, isDefault: false }],
  },
  {
    id: "claude",
    name: "Claude Code",
    status: "unsupported",
    version: "2.0.0",
    statusText: "Detected, not supported yet: reason",
    models: [],
  },
  { id: "cursor-agent", name: "Cursor Agent", status: "not_authorized", version: "1", models: [] },
  { id: "gemini", name: "Gemini CLI", status: "unknown", version: null, statusText: "no status command", models: [] },
];

const TASK = { id: "t1" } as unknown as TaskSummary;

async function show(agents: Agent[] = AGENTS): Promise<{ startTask: Mock<AgentikApi["startTask"]> }> {
  const startTask = vi.fn<AgentikApi["startTask"]>().mockResolvedValue({ ok: true, value: TASK });
  const api = {
    listAgents: () => Promise.resolve({ ok: true, value: agents }),
    startTask,
  } as unknown as AgentikApi;
  await act(async () => {
    root.render(
      <NewTaskScreen
        api={api}
        computerId="comp"
        computerName="Studio"
        projectId="proj"
        projectName="agentik"
        newRequestId={() => "req-1"}
        onStarted={() => undefined}
        onBack={() => undefined}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { startTask };
}

const radios = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="agent"]')];
const radio = (id: string): HTMLInputElement => {
  const found = radios().find((r) => r.value === id);
  if (found === undefined) throw new Error(`no agent radio ${id}`);
  return found;
};
const modelSelect = (): HTMLSelectElement | null => container.querySelector("select");
const optionValues = (): string[] => [...(modelSelect()?.options ?? [])].map((o) => o.value);

async function type(text: string): Promise<void> {
  const area = container.querySelector("textarea");
  if (area === null) throw new Error("no textarea");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function start(): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Start task");
  if (button === undefined) throw new Error("no start button");
  await act(async () => {
    button.click();
  });
}

describe("NewTaskScreen agent picker", () => {
  it("lists every agent but enables only the ready ones, and says why the others are disabled", async () => {
    await show();
    expect(radios().map((r) => [r.value, r.disabled])).toEqual([
      ["codex", false],
      ["other", false],
      ["claude", true],
      ["cursor-agent", true],
      ["gemini", true],
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("Detected, not supported yet: reason");
    expect(text).toContain("Not signed in on Studio");
    expect(text).toContain("Sign-in state unknown on Studio: no status command");
    // The first ready agent is preselected.
    expect(radio("codex").checked).toBe(true);
  });

  it("gives each agent radio and the model select an accessible name", async () => {
    await show();
    expect(container.querySelector("fieldset legend")?.textContent).toBe("Agent");
    for (const r of radios()) {
      // Each radio is wrapped in a label that carries the agent's name.
      expect(r.closest("label")?.textContent).toContain(AGENTS.find((a) => a.id === r.value)?.name ?? "missing");
    }
    const select = modelSelect();
    expect(select).not.toBeNull();
    const label = container.querySelector(`label[for="${select?.id ?? ""}"]`);
    expect(label?.textContent).toBe("Model");
    // Native controls: reachable and operable from the keyboard.
    expect(select?.tabIndex).toBe(0);
    expect(select?.getAttribute("aria-describedby")).not.toBeNull();
  });

  it("offers the models of the selected agent and resets the choice when the agent changes", async () => {
    await show();
    expect(optionValues()).toEqual(["", "big", "small"]);
    expect(modelSelect()?.options[0]?.textContent).toBe("Default (Big)");

    const select = modelSelect();
    if (select === null) throw new Error("no select");
    await choose(select, "small");
    expect(modelSelect()?.value).toBe("small");

    await act(async () => {
      radio("other").click();
    });
    expect(optionValues()).toEqual(["", "o-1"]);
    expect(modelSelect()?.value).toBe("");
    expect(modelSelect()?.options[0]?.textContent).toBe("Default model");
  });

  it("shows no model choice for an agent that lists none, and says so", async () => {
    await show([{ id: "codex", name: "Codex", status: "available", version: "1", models: [], modelsNote: "model list could not be read" }]);
    expect(optionValues()).toEqual([""]);
    expect(modelSelect()?.disabled).toBe(true);
    expect(container.textContent).toContain("model list could not be read");
  });

  it("sends agent and model when a model is chosen", async () => {
    const { startTask } = await show();
    await type("fix the tests");
    const select = modelSelect();
    if (select === null) throw new Error("no select");
    await choose(select, "small");
    await start();
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask.mock.calls[0]?.[1]).toEqual({
      projectId: "proj",
      agent: "codex",
      prompt: "fix the tests",
      requestId: "req-1",
      model: "small",
    });
  });

  it("sends no model when the agent default is kept", async () => {
    const { startTask } = await show();
    await type("fix the tests");
    await start();
    expect(startTask.mock.calls[0]?.[1]).toEqual({ projectId: "proj", agent: "codex", prompt: "fix the tests", requestId: "req-1" });
  });

  it("sends the second agent with its own model", async () => {
    const { startTask } = await show();
    await type("do it");
    await act(async () => {
      radio("other").click();
    });
    const select = modelSelect();
    if (select === null) throw new Error("no select");
    await choose(select, "o-1");
    await start();
    expect(startTask.mock.calls[0]?.[1]).toMatchObject({ agent: "other", model: "o-1" });
  });

  it("cannot start when no agent is ready", async () => {
    await show(AGENTS.filter((a) => a.status !== "available"));
    await type("do it");
    expect(radios().every((r) => r.disabled)).toBe(true);
    expect(modelSelect()).toBeNull();
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Start task");
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain("No agent is ready");
  });

  it("renders agent and model text from the computer as plain text", async () => {
    await show([
      {
        id: "codex",
        name: "<img src=x onerror=alert(1)>",
        status: "available",
        version: "1",
        models: [{ id: "m", name: "<script>alert(2)</script>", description: "<b>bold</b>", isDefault: false }],
      },
    ]);
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(optionValues()).toEqual(["", "m"]);
    expect(modelSelect()?.options[1]?.textContent).toBe("<script>alert(2)</script>");
  });
});
