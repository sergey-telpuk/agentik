import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalRequest, TaskEvent } from "../api/types";
import { Timeline } from "./Timeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><a href="javascript:alert(1)">x</a> **bold** [link](javascript:alert(1))`;

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
  delete (window as { __pwned?: number }).__pwned;
});

const approval: ApprovalRequest = {
  id: "apr_1",
  taskId: "task_1",
  sessionId: "ses_1",
  kind: "command",
  operation: HOSTILE,
  scope: HOSTILE,
  reason: HOSTILE,
  requestedAt: 0,
  expiresAt: 60_000,
};

const events: TaskEvent[] = [
  { seq: 1, at: 0, kind: "message", role: "user", text: HOSTILE },
  { seq: 2, at: 0, kind: "message", role: "agent", text: HOSTILE },
  { seq: 3, at: 0, kind: "command", command: HOSTILE, exitCode: 1, output: HOSTILE },
  { seq: 4, at: 0, kind: "file_change", path: HOSTILE, additions: 1, deletions: 2 },
  { seq: 5, at: 0, kind: "approval_requested", approval },
  { seq: 6, at: 0, kind: "error", text: HOSTILE },
  { seq: 7, at: 0, kind: "state", state: "failed", note: HOSTILE },
];

describe("Timeline", () => {
  it("renders agent output as literal text, never as markup", () => {
    act(() => root.render(<Timeline events={events} />));
    const list = container.querySelector("ol");
    if (list === null) throw new Error("timeline not rendered");
    expect(list.querySelector("img, script, a, iframe")).toBeNull();
    expect(list.querySelectorAll("[onerror], [href]")).toHaveLength(0);
    expect(list.querySelectorAll("li")).toHaveLength(events.length);
    for (const item of list.querySelectorAll("li")) {
      expect(item.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    }
    expect(list.textContent).toContain("**bold** [link](javascript:alert(1))");
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("shows who produced each event and the state in words", () => {
    act(() => root.render(<Timeline events={events} />));
    const heads = [...container.querySelectorAll(".event-who")].map((e) => e.textContent);
    expect(heads).toEqual(["You", "Codex", "Command", "File changed", "Approval requested", "Error", "State"]);
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Exit code 1");
  });
});
