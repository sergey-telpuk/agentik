import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentikApi,
  ApiResult,
  StartTaskInput,
  TaskResult,
  TaskState,
  TaskSummary,
  TaskUpdate,
} from "../api/types";
import { SessionScreen } from "./SessionScreen";

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

const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);

function turn(id: string, prompt: string, state: TaskState, minute: number): TaskSummary {
  return {
    id,
    projectId: "proj-1",
    sessionId: "ses-1",
    agent: "codex",
    prompt,
    state,
    createdAt: T0 + minute * 60_000,
    updatedAt: T0 + minute * 60_000,
    pendingApproval: null,
    lastSeq: 0,
  };
}

function result(taskId: string, state: TaskState, output: string, diff: string | null = null): TaskResult {
  return {
    taskId,
    state,
    output,
    changes: diff === null ? [] : [{ path: "src/a.ts", additions: 1, deletions: 0 }],
    diff,
    diffTruncated: false,
    error: null,
    recovery: null,
    finishedAt: T0,
  };
}

const CODEX: Agent = {
  id: "codex",
  name: "Codex",
  status: "available",
  version: "1",
  models: [
    { id: "big", name: "Big", description: null, isDefault: true },
    { id: "small", name: "Small", description: null, isDefault: false },
  ],
};

interface Harness {
  readonly api: AgentikApi;
  readonly started: StartTaskInput[];
  /** Listener of the stream of one task, for pushing live updates. */
  readonly streams: Map<string, (update: TaskUpdate) => void>;
}

function harness(turns: TaskSummary[], results: Record<string, TaskResult>, agents: Agent[] = [{ ...CODEX, models: [] }]): Harness {
  const started: StartTaskInput[] = [];
  const streams = new Map<string, (update: TaskUpdate) => void>();
  let counter = 0;
  const ok = <T,>(value: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, value });
  const api = {
    backend: "mock",
    listAgents: () => ok(agents),
    getSession: () => ok({ sessionId: "ses-1", projectId: "proj-1", turns, truncated: false }),
    getResult: (_computer: string, taskId: string) => {
      const found = results[taskId];
      return found === undefined
        ? Promise.resolve<ApiResult<TaskResult>>({ ok: false, error: { code: "not_found", message: "no result" } })
        : ok(found);
    },
    streamEvents: (_computer: string, taskId: string, _after: number, onUpdate: (update: TaskUpdate) => void) => {
      streams.set(taskId, onUpdate);
      return () => streams.delete(taskId);
    },
    startTask: (_computer: string, input: StartTaskInput) => {
      started.push(input);
      counter += 1;
      const id = `new-${counter}`;
      results[id] = result(id, "succeeded", `reply ${counter}`);
      return ok(turn(id, input.prompt, "succeeded", 10 + counter));
    },
    cancelTask: (_computer: string, taskId: string) => ok(turn(taskId, "x", "cancel_requested", 0)),
    respondApproval: () => ok({ approvalId: "a", decision: "approve" as const }),
  } as unknown as AgentikApi;
  return { api, started, streams };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(h: Harness, newRequestId: () => string = () => "req"): Promise<void> {
  await act(async () => {
    root.render(
      <SessionScreen
        api={h.api}
        computerId="comp-1"
        projectId="proj-1"
        projectName="Project"
        sessionId="ses-1"
        initialTurn={null}
        now={() => T0}
        copyText={() => Promise.resolve(true)}
        newRequestId={newRequestId}
        onBack={() => undefined}
      />,
    );
  });
  await flush();
  await flush();
}

function composer(): HTMLTextAreaElement {
  const area = container.querySelector<HTMLTextAreaElement>("textarea.composer-input");
  if (area === null) throw new Error("no composer");
  return area;
}

async function typeMessage(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(composer(), value);
    composer().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.classList.contains("composer-send"));
  if (found === undefined) throw new Error("no send button");
  return found;
}

function chip(): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>("select.model-chip");
}

function chipLabel(): string | undefined {
  return chip()?.selectedOptions[0]?.textContent ?? undefined;
}

async function pick(model: string): Promise<void> {
  await act(async () => {
    const el = chip();
    if (el === null) throw new Error("no model chip");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(el, model);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function send(): Promise<void> {
  await act(async () => {
    sendButton().click();
  });
  await flush();
  await flush();
}

describe("SessionScreen", () => {
  it("renders the turns of a session in order, as user and agent bubbles", async () => {
    const h = harness(
      [turn("t1", "first question", "succeeded", 0), turn("t2", "second question", "succeeded", 5)],
      { t1: result("t1", "succeeded", "first answer"), t2: result("t2", "succeeded", "second answer", "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n x\n+y") },
    );
    await render(h);

    const text = container.textContent ?? "";
    const at = ["first question", "first answer", "second question", "second answer"].map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    expect(container.querySelectorAll(".bubble-user")).toHaveLength(2);
    expect(container.querySelectorAll(".bubble-agent")).toHaveLength(2);
    // Each reply carries its own status chip.
    expect([...container.querySelectorAll(".bubble-agent .chip-label")].map((c) => c.textContent)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    // Only the reply with a diff lists changed files; both replies can be copied.
    expect(container.querySelectorAll(".bubble-changes")).toHaveLength(1);
    expect(container.querySelector(".bubble-changes")?.textContent).toContain("src/a.ts");
    expect([...container.querySelectorAll("button")].filter((b) => b.textContent === "Copy")).toHaveLength(2);
  });

  it("sends a follow-up into the same session with a fresh request id each time", async () => {
    const h = harness([turn("t1", "first question", "succeeded", 0)], { t1: result("t1", "succeeded", "first answer") });
    let n = 0;
    await render(h, () => `req-${++n}`);

    await typeMessage("  and then?  ");
    await send();
    await typeMessage("one more thing");
    await send();

    expect(h.started).toEqual([
      { projectId: "proj-1", agent: "codex", prompt: "and then?", requestId: "req-1", sessionId: "ses-1" },
      { projectId: "proj-1", agent: "codex", prompt: "one more thing", requestId: "req-2", sessionId: "ses-1" },
    ]);
    const prompts = [...container.querySelectorAll(".bubble-user .bubble-text")].map((p) => p.textContent);
    expect(prompts).toEqual(["first question", "and then?", "one more thing"]);
    expect(composer().value).toBe("");
  });

  it("shows prompts, replies, errors and diffs as literal text, never as markup", async () => {
    const hostile = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script><b>bold</b>';
    const h = harness([turn("t1", hostile, "succeeded", 0)], {
      t1: { ...result("t1", "succeeded", hostile, `+${hostile}`), error: hostile },
    });
    await render(h);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".bubble-text b, .bubble-reply b")).toBeNull();
    expect(container.querySelector(".bubble-user .bubble-text")?.textContent).toBe(hostile);
    expect(container.querySelector(".bubble-reply")?.textContent).toBe(hostile);
    expect(container.querySelector(".diff")?.textContent).toContain(hostile);
    expect((window as { pwned?: number }).pwned).toBeUndefined();
  });

  it("disables Send while a turn is running and enables it when the turn finishes", async () => {
    const h = harness([turn("t1", "long job", "running", 0)], {});
    await render(h);

    await typeMessage("next message");
    expect(sendButton().disabled).toBe(true);
    expect(container.textContent).toContain("The agent is working");
    expect(container.querySelector(".bubble-agent .chip-label")?.textContent).toBe("running");
    // Stopping stays available inside the conversation.
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Stop task")).toBe(true);
    expect(container.textContent?.match(/Closing the app does not cancel the task/g)).toHaveLength(1);

    // Submitting by keyboard does not bypass the disabled button.
    await act(async () => {
      container.querySelector("form.composer")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(h.started).toHaveLength(0);

    const push = h.streams.get("t1");
    expect(push).toBeDefined();
    const finished = turn("t1", "long job", "succeeded", 0);
    (h.api as unknown as { getResult: unknown }).getResult = () =>
      Promise.resolve({ ok: true, value: result("t1", "succeeded", "done") });
    await act(async () => {
      push?.({ task: finished, events: [] });
    });
    await flush();
    await flush();

    expect(sendButton().disabled).toBe(false);
    expect(container.textContent).not.toContain("Closing the app does not cancel the task");
    expect(container.querySelector(".bubble-reply")?.textContent).toBe("done");
  });

  it("keeps the approval flow inside the conversation", async () => {
    const waiting: TaskSummary = {
      ...turn("t1", "needs approval", "awaiting_approval", 0),
      pendingApproval: {
        id: "apr-1",
        taskId: "t1",
        sessionId: "ses-1",
        kind: "command",
        operation: "npm ci",
        scope: "Project",
        reason: "install",
        requestedAt: T0,
        expiresAt: T0 + 600_000,
      },
    };
    const h = harness([waiting], {});
    const spy = vi.spyOn(h.api, "respondApproval");
    await render(h);

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("npm ci");
    expect(sendButton().disabled).toBe(true);
    const approve = [...container.querySelectorAll("button")].find((b) => b.textContent === "Approve");
    await act(async () => approve?.click());
    await flush();
    expect(spy).toHaveBeenCalledWith("comp-1", { taskId: "t1", approvalId: "apr-1", decision: "approve" });
  });
  describe("model chip", () => {
    const bothModels = [CODEX];

    it("shows no chip when the agent offers no model choice, and sends no model", async () => {
      const h = harness([turn("t1", "q", "succeeded", 0)], { t1: result("t1", "succeeded", "a") });
      await render(h);
      expect(chip()).toBeNull();
      await typeMessage("next");
      await send();
      expect(h.started[0]).not.toHaveProperty("model");
    });

    it("shows the agent default when the conversation has no model yet, and sends none", async () => {
      const h = harness([turn("t1", "q", "succeeded", 0)], { t1: result("t1", "succeeded", "a") }, bothModels);
      await render(h);
      expect(chipLabel()).toBe("Big");
      await typeMessage("next");
      await send();
      expect(h.started).toHaveLength(1);
      expect(h.started[0]).not.toHaveProperty("model");
    });

    it("shows the model of the last turn and keeps using it", async () => {
      const turns = [{ ...turn("t1", "q", "succeeded", 0), model: "big" }, { ...turn("t2", "q2", "succeeded", 5), model: "small" }];
      const h = harness(turns, { t1: result("t1", "succeeded", "a"), t2: result("t2", "succeeded", "b") }, bothModels);
      await render(h);
      expect(chipLabel()).toBe("Small");
      await typeMessage("next");
      await send();
      expect(h.started[0]).toMatchObject({ sessionId: "ses-1", model: "small" });
    });

    it("sends the model picked in the chip with each follow-up, and the chip then shows it", async () => {
      const h = harness([turn("t1", "q", "succeeded", 0)], { t1: result("t1", "succeeded", "a") }, bothModels);
      await render(h);
      await pick("small");
      expect(chipLabel()).toBe("Small");
      await typeMessage("first follow-up");
      await send();
      expect(h.started[0]).toMatchObject({ prompt: "first follow-up", model: "small" });

      // The next message uses the same pick until it is changed again.
      await typeMessage("second follow-up");
      await send();
      expect(h.started[1]).toMatchObject({ prompt: "second follow-up", model: "small" });

      // Going back to the default sends it explicitly, so the thread switches back.
      await pick("big");
      await typeMessage("third follow-up");
      await send();
      expect(h.started[2]).toMatchObject({ prompt: "third follow-up", model: "big" });
    });

    it("ignores a model of the last turn that the agent no longer offers", async () => {
      const turns = [{ ...turn("t1", "q", "succeeded", 0), model: "retired" }];
      const h = harness(turns, { t1: result("t1", "succeeded", "a") }, bothModels);
      await render(h);
      expect(chipLabel()).toBe("Big");
      await typeMessage("next");
      await send();
      expect(h.started[0]).not.toHaveProperty("model");
    });

    it("is disabled together with Send while a turn is running", async () => {
      const h = harness([{ ...turn("t1", "long job", "running", 0), model: "small" }], {}, bothModels);
      await render(h);
      expect(chip()?.disabled).toBe(true);
      expect(chipLabel()).toBe("Small");
      await typeMessage("next");
      expect(sendButton().disabled).toBe(true);

      const push = h.streams.get("t1");
      (h.api as unknown as { getResult: unknown }).getResult = () =>
        Promise.resolve({ ok: true, value: result("t1", "succeeded", "done") });
      await act(async () => {
        push?.({ task: { ...turn("t1", "long job", "succeeded", 0), model: "small" }, events: [] });
      });
      await flush();
      await flush();
      expect(chip()?.disabled).toBe(false);
      expect(sendButton().disabled).toBe(false);
    });
  });
});
