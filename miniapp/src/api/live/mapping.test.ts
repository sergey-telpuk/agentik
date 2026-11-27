import { describe, expect, it } from "vitest";
import { RpcClientClosedError, RpcError, RpcTimeoutError } from "../../protocol/client";
import type { SessionEventView, TaskView } from "../../protocol/messages";
import {
  agentsFromInfo,
  apiErrorFrom,
  changesFromDiff,
  taskResultFromView,
  taskSummaryFromView,
  timelineEventFromSession,
} from "./mapping";

function view(overrides: Partial<TaskView> = {}): TaskView {
  return {
    task_id: "t1",
    session_id: "s1",
    project_id: "repo",
    agent: "codex",
    prompt: "Fix it",
    state: "running",
    result_text: "",
    error_message: "",
    pending_approval: null,
    created_at: 100,
    updated_at: 160,
    ...overrides,
  };
}

function event(kind: SessionEventView["kind"], payload: Record<string, unknown>, seq = 7): SessionEventView {
  return { session_id: "s1", task_id: "t1", seq, kind, payload, created_at: 200 };
}

describe("live mapping", () => {
  it("converts task views from Unix seconds and treats unknown states as an unknown outcome", () => {
    const summary = taskSummaryFromView(
      view({
        state: "awaiting_approval",
        pending_approval: { approval_id: "a1", kind: "file_change", summary: "Write src/a.ts", expires_at: 400 },
      }),
      9,
    );
    expect(summary).toMatchObject({ id: "t1", projectId: "repo", sessionId: "s1", createdAt: 100_000, updatedAt: 160_000, lastSeq: 9 });
    expect(summary.pendingApproval).toMatchObject({ id: "a1", taskId: "t1", kind: "file_change", operation: "Write src/a.ts", expiresAt: 400_000 });
    const odd = { ...view(), state: "exploded" } as unknown as TaskView;
    expect(taskSummaryFromView(odd, 0).state).toBe("recovery_required");
  });

  it("maps session events one to one and leaves streaming fragments out of the timeline", () => {
    expect(timelineEventFromSession(event("delta", { text: "par" }), "repo")).toBeNull();
    expect(timelineEventFromSession(event("diff", { diff: "diff --git a/x b/x" }), "repo")).toBeNull();
    expect(timelineEventFromSession(event("status", { state: "running", message: "go" }), "repo")).toEqual({
      seq: 7,
      at: 200_000,
      kind: "state",
      state: "running",
      note: "go",
    });
    expect(timelineEventFromSession(event("status", { state: "bogus" }), "repo")).toBeNull();
    expect(timelineEventFromSession(event("item", { item_type: "commandExecution", command: "npm test" }), "repo")).toMatchObject({
      kind: "command",
      command: "npm test",
      exitCode: null,
    });
    expect(timelineEventFromSession(event("item", { item_type: "reasoning", text: "thinking" }), "repo")).toBeNull();
    expect(timelineEventFromSession(event("approval_resolved", { approval_id: "a1", status: "declined" }), "repo")).toMatchObject({
      kind: "approval_resolved",
      outcome: { approvalId: "a1", decision: "deny" },
    });
    expect(timelineEventFromSession(event("approval_resolved", { approval_id: "a1", status: "expired" }), "repo")).toMatchObject({
      kind: "error",
    });
    expect(timelineEventFromSession(event("error", { state: "failed", error: "boom" }), "repo")).toMatchObject({
      kind: "error",
      text: "boom",
    });
  });

  it("counts changed lines per file in a unified diff", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "+more",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -3 +3 @@",
      "-gone",
    ].join("\n");
    expect(changesFromDiff(diff)).toEqual([
      { path: "src/a.ts", additions: 2, deletions: 1 },
      { path: "README.md", additions: 0, deletions: 1 },
    ]);
    expect(changesFromDiff("")).toEqual([]);
  });

  it("builds results for failed and unknown outcomes without inventing success", () => {
    const failed = taskResultFromView(view({ state: "failed", error_message: "compile error" }), null);
    expect(failed).toMatchObject({ state: "failed", error: "compile error", recovery: null, diff: null, changes: [] });
    const unknown = taskResultFromView(view({ state: "recovery_required" }), { task_id: "t1", diff: "", truncated: false });
    expect(unknown.recovery).toContain("cannot tell");
    expect(unknown.finishedAt).toBe(160_000);
  });

  it("reports Codex as not installed or not signed in from agent.list", () => {
    expect(agentsFromInfo([])[0]?.status).toBe("not_installed");
    expect(agentsFromInfo([{ name: "codex", available: true, authenticated: false }])[0]?.status).toBe("not_authorized");
    expect(agentsFromInfo([{ name: "codex", available: true, authenticated: true, version: "1.0" }])[0]).toEqual({
      id: "codex",
      name: "Codex",
      status: "available",
      version: "1.0",
    });
  });

  it("translates daemon and transport errors into UI error codes", () => {
    expect(apiErrorFrom(new RpcError("project_busy", "x")).code).toBe("busy");
    expect(apiErrorFrom(new RpcError("request_id_conflict", "x")).code).toBe("conflict");
    expect(apiErrorFrom(new RpcError("approval_already_resolved", "x")).code).toBe("already_resolved");
    expect(apiErrorFrom(new RpcError("approval_expired", "x")).code).toBe("expired");
    expect(apiErrorFrom(new RpcError("unauthorized", "x")).code).toBe("revoked");
    expect(apiErrorFrom(new RpcError("internal", "db locked")).code).toBe("internal");
    expect(apiErrorFrom(new RpcTimeoutError("task.start")).code).toBe("not_connected");
    expect(apiErrorFrom(new RpcClientClosedError()).code).toBe("not_connected");
  });
});
