import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentikRpcClient } from "../protocol/client";
import type { TaskView } from "../protocol/messages";
import type { SecureSession } from "../secure/seam";
import { TaskWorkspace } from "./TaskWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface RpcFrame {
  readonly request_id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function createFakeRpc(
  onRequest: (req: RpcFrame, rpcMock: { deliver: (msg: unknown) => void }) => void,
  options: { readonly timeoutMs?: number } = {},
): {
  rpc: AgentikRpcClient;
  requests: RpcFrame[];
  deliver: (msg: unknown) => void;
} {
  const requests: RpcFrame[] = [];
  const handlers = new Set<(pt: Uint8Array) => void>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const deliver = (msg: unknown): void => {
    const bytes = encoder.encode(JSON.stringify(msg));
    for (const h of handlers) h(bytes);
  };

  const session: SecureSession = {
    send: (pt) => {
      const req = JSON.parse(decoder.decode(pt)) as RpcFrame;
      requests.push(req);
      onRequest(req, { deliver });
    },
    onMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    close: () => undefined,
  };

  const rpc = new AgentikRpcClient(session, options);
  return { rpc, requests, deliver };
}

function replyOk(deliver: (msg: unknown) => void, requestId: string, result: unknown): void {
  queueMicrotask(() => {
    deliver({ v: 1, type: "response", request_id: requestId, ok: true, result });
  });
}

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

async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function setPrompt(value: string): Promise<void> {
  const area = container.querySelector("textarea");
  if (area === null) throw new Error("no textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(label: string): Promise<void> {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (btn === undefined) throw new Error(`no button "${label}"`);
  await act(async () => {
    btn.click();
  });
}

function sampleTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    task_id: "task-1111-2222",
    session_id: "sess-1111-2222",
    project_id: "proj-1",
    agent: "codex",
    prompt: "Check build",
    state: "running",
    result_text: "",
    error_message: "",
    pending_approval: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

describe("TaskWorkspace", () => {
  it("starts a task, streams ordered events, handles approval, and renders safe output and diff", async () => {
    let taskState = sampleTask({ state: "accepted" });

    const { rpc, requests, deliver } = createFakeRpc((req, mock) => {
      switch (req.method) {
        case "project.list":
          replyOk(mock.deliver, req.request_id, {
            projects: [{ project_id: "proj-1", name: "agentik", agents: ["codex"] }],
          });
          break;
        case "agent.list":
          replyOk(mock.deliver, req.request_id, {
            agents: [{ name: "codex", available: true, authenticated: true, version: "0.160.0" }],
          });
          break;
        case "session.list":
          replyOk(mock.deliver, req.request_id, { sessions: [] });
          break;
        case "task.start":
          taskState = sampleTask({ state: "starting" });
          replyOk(mock.deliver, req.request_id, { task: taskState, deduplicated: false });
          break;
        case "events.resume":
          replyOk(mock.deliver, req.request_id, {
            session_id: taskState.session_id,
            events: [],
            next_seq: 1,
          });
          break;
        case "task.get":
          replyOk(mock.deliver, req.request_id, { task: taskState });
          break;
        case "approval.resolve":
          taskState = sampleTask({ state: "running", pending_approval: null });
          replyOk(mock.deliver, req.request_id, {
            approval_id: req.params["approval_id"],
            status: "accepted",
          });
          break;
        case "changes.get":
          replyOk(mock.deliver, req.request_id, {
            task_id: taskState.task_id,
            diff: "diff --git a/a.ts b/a.ts\n+ok\n",
            truncated: false,
          });
          break;
      }
    });

    await act(async () => {
      root.render(<TaskWorkspace rpc={rpc} reconnectKey={1} />);
    });

    await settle(() => container.textContent?.includes("agentik (proj-1)") === true);
    expect(container.textContent).toContain("ready (0.160.0)");

    await setPrompt("Run tests");
    await clickButton("Start task");
    await settle(() => container.textContent?.includes("starting") === true);

    const startReq = requests.find((r) => r.method === "task.start");
    expect(startReq?.params).toEqual({
      project_id: "proj-1",
      session_id: null,
      agent: "codex",
      prompt: "Run tests",
    });

    // Push live delta + approval_requested event.
    taskState = sampleTask({
      state: "awaiting_approval",
      pending_approval: {
        approval_id: "apr-1",
        kind: "command",
        summary: "Run npm test",
        expires_at: 2000,
      },
    });
    await act(async () => {
      deliver({
        v: 1,
        type: "event",
        event: "session.event",
        data: {
          session_id: "sess-1111-2222",
          task_id: "task-1111-2222",
          seq: 2,
          kind: "delta",
          payload: { text: "<img src=x onerror=alert(1)> " },
          created_at: 1001,
        },
      });
      deliver({
        v: 1,
        type: "event",
        event: "session.event",
        data: {
          session_id: "sess-1111-2222",
          task_id: "task-1111-2222",
          seq: 3,
          kind: "approval_requested",
          payload: { approval_id: "apr-1", kind: "command", summary: "Run npm test" },
          created_at: 1002,
        },
      });
    });

    await settle(() => container.textContent?.includes("Approval required") === true);
    expect(container.querySelector('[data-testid="task-output"]')?.textContent).toBe(
      "<img src=x onerror=alert(1)> ",
    );
    // Untrusted agent output must be rendered strictly as text, never HTML nodes.
    expect(container.querySelector("img")).toBeNull();

    await clickButton("Approve once");
    await settle(() => container.textContent?.includes("Approval required") === false);

    const resolveReq = requests.find((r) => r.method === "approval.resolve");
    expect(resolveReq?.params).toEqual({ approval_id: "apr-1", decision: "accept" });

    // Complete task and verify final result + diff.
    taskState = sampleTask({
      state: "succeeded",
      result_text: "All tests passed!",
    });
    await act(async () => {
      deliver({
        v: 1,
        type: "event",
        event: "session.event",
        data: {
          session_id: "sess-1111-2222",
          task_id: "task-1111-2222",
          seq: 4,
          kind: "completed",
          payload: { state: "succeeded" },
          created_at: 1003,
        },
      });
    });

    await settle(() => container.textContent?.includes("All tests passed!") === true);
    await settle(() => container.querySelector('[data-testid="task-diff"]') !== null);
    expect(container.querySelector('[data-testid="task-diff"]')?.textContent).toContain("+ok");
  });

  it("reuses the same request_id on retry after timeout, supports cancel, and resumes events on reconnect", async () => {
    let startAttempts = 0;
    let taskState = sampleTask({ state: "running" });

    const first = createFakeRpc(
      (req, mock) => {
        if (req.method === "project.list") {
          replyOk(mock.deliver, req.request_id, {
            projects: [{ project_id: "proj-1", name: "agentik", agents: ["codex"] }],
          });
        } else if (req.method === "agent.list") {
          replyOk(mock.deliver, req.request_id, {
            agents: [{ name: "codex", available: true, authenticated: true }],
          });
        } else if (req.method === "session.list") {
          replyOk(mock.deliver, req.request_id, { sessions: [] });
        } else if (req.method === "task.start") {
          startAttempts++;
          if (startAttempts === 1) {
            // Drop first response to trigger RpcTimeoutError.
            return;
          }
          replyOk(mock.deliver, req.request_id, { task: taskState, deduplicated: true });
        } else if (req.method === "events.resume") {
          replyOk(mock.deliver, req.request_id, {
            session_id: taskState.session_id,
            events: [
              {
                session_id: taskState.session_id,
                task_id: taskState.task_id,
                seq: 1,
                kind: "status",
                payload: { state: "running" },
                created_at: 1001,
              },
            ],
            next_seq: 2,
          });
        } else if (req.method === "task.cancel") {
          taskState = sampleTask({ state: "cancel_requested" });
          replyOk(mock.deliver, req.request_id, { task: taskState });
        }
      },
      { timeoutMs: 40 },
    );

    await act(async () => {
      root.render(<TaskWorkspace rpc={first.rpc} reconnectKey={1} />);
    });
    await settle(() => container.textContent?.includes("agentik (proj-1)") === true);

    await setPrompt("Check idempotency");
    await clickButton("Start task");
    await settle(() => container.textContent?.includes("Retry uses the original idempotent request ID") === true);

    await clickButton("Start task");
    await settle(() => container.textContent?.includes("Task task-111") === true);

    const startReqs = first.requests.filter((r) => r.method === "task.start");
    expect(startReqs).toHaveLength(2);
    expect(startReqs[0]?.request_id).toBe(startReqs[1]?.request_id);

    await clickButton("Cancel task");
    await settle(() => container.textContent?.includes("cancel_requested") === true);
    expect(first.requests.some((r) => r.method === "task.cancel")).toBe(true);

    // Simulate reconnect with a new AgentikRpcClient instance and verify events.resume(after_seq=1).
    taskState = sampleTask({ state: "cancelled", error_message: "cancelled by user" });
    const second = createFakeRpc((req, mock) => {
      if (req.method === "project.list") {
        replyOk(mock.deliver, req.request_id, {
          projects: [{ project_id: "proj-1", name: "agentik", agents: ["codex"] }],
        });
      } else if (req.method === "agent.list") {
        replyOk(mock.deliver, req.request_id, {
          agents: [{ name: "codex", available: true, authenticated: true }],
        });
      } else if (req.method === "session.list") {
        replyOk(mock.deliver, req.request_id, { sessions: [] });
      } else if (req.method === "task.get") {
        replyOk(mock.deliver, req.request_id, { task: taskState });
      } else if (req.method === "events.resume") {
        replyOk(mock.deliver, req.request_id, {
          session_id: taskState.session_id,
          events: [
            {
              session_id: taskState.session_id,
              task_id: taskState.task_id,
              seq: 2,
              kind: "completed",
              payload: { state: "cancelled" },
              created_at: 1002,
            },
          ],
          next_seq: 3,
        });
      } else if (req.method === "changes.get") {
        replyOk(mock.deliver, req.request_id, {
          task_id: taskState.task_id,
          diff: "",
          truncated: false,
        });
      }
    });

    await act(async () => {
      root.render(<TaskWorkspace rpc={second.rpc} reconnectKey={2} />);
    });

    await settle(() => container.textContent?.includes("cancelled by user") === true);
    const resumeReq = second.requests.find((r) => r.method === "events.resume");
    expect(resumeReq?.params).toEqual({
      session_id: "sess-1111-2222",
      after_seq: 1,
    });
    expect(container.textContent).toContain("#2");
    expect(container.textContent).toContain("task cancelled");
  });
});
