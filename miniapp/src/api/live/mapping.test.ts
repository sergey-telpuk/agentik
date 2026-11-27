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

  it("lists every detected agent and only ready ones are available", () => {
    const list = agentsFromInfo([
      {
        name: "codex",
        id: "codex",
        display_name: "Codex",
        available: true,
        authenticated: true,
        version: "codex-cli 1",
        status: "ready",
        status_text: "Ready",
        supported: true,
        models: [
          { id: "big", display_name: "Big", description: "Largest", is_default: true },
          { id: "small", display_name: "Small" },
        ],
        models_source: "live",
      },
      {
        name: "claude",
        id: "claude",
        display_name: "Claude Code",
        available: true,
        authenticated: true,
        status: "unsupported",
        status_text: "Detected, not supported yet: reason",
        supported: false,
        // Models of an agent that cannot run tasks are never offered.
        models: [{ id: "x" }],
      },
      { name: "cursor-agent", available: true, authenticated: false, status: "not_authenticated", status_text: "Not signed in" },
      { name: "gemini", available: true, authenticated: false, status: "unknown" },
      { name: "weird", available: true, authenticated: true, status: "something-new" as never },
    ]);
    expect(list.map((a) => [a.id, a.status])).toEqual([
      ["codex", "available"],
      ["claude", "unsupported"],
      ["cursor-agent", "not_authorized"],
      ["gemini", "unknown"],
      // An unrecognised status is never read as ready.
      ["weird", "unknown"],
    ]);
    expect(list[0]).toMatchObject({
      name: "Codex",
      version: "codex-cli 1",
      models: [
        { id: "big", name: "Big", description: "Largest", isDefault: true },
        { id: "small", name: "Small", description: null, isDefault: false },
      ],
    });
    expect(list[1]?.models).toEqual([]);
    expect(list[1]?.statusText).toBe("Detected, not supported yet: reason");
  });

  it("keeps computer-supplied agent and model text as plain text, bounded and de-duplicated", () => {
    const [agent] = agentsFromInfo([
      {
        name: "codex",
        available: true,
        authenticated: true,
        status: "ready",
        display_name: "<b>Codex</b>".padEnd(500, "x"),
        models: [
          { id: "m1", display_name: "<img src=x onerror=alert(1)>" },
          { id: "m1", display_name: "duplicate id" },
          { id: "", display_name: "no id" },
        ],
        models_source: "static",
        models_detail: "could not list models",
      },
    ]);
    expect(agent?.name.startsWith("<b>Codex</b>")).toBe(true);
    expect(agent?.name.length).toBeLessThanOrEqual(128);
    expect(agent?.models).toHaveLength(1);
    expect(agent?.models?.[0]?.name).toBe("<img src=x onerror=alert(1)>");
    expect(agent?.modelsNote).toBe("could not list models");
  });

  it("translates daemon and transport errors into UI error codes", () => {
    expect(apiErrorFrom(new RpcError("project_busy", "x")).code).toBe("busy");
    expect(apiErrorFrom(new RpcError("unknown_model", "model nope")).code).toBe("invalid");
    expect(apiErrorFrom(new RpcError("agent_unsupported", "x")).code).toBe("agent_unavailable");
    expect(apiErrorFrom(new RpcError("agent_not_ready", "x")).code).toBe("agent_unavailable");
    expect(apiErrorFrom(new RpcError("request_id_conflict", "x")).code).toBe("conflict");
    expect(apiErrorFrom(new RpcError("approval_already_resolved", "x")).code).toBe("already_resolved");
    expect(apiErrorFrom(new RpcError("approval_expired", "x")).code).toBe("expired");
    expect(apiErrorFrom(new RpcError("unauthorized", "x")).code).toBe("revoked");
    expect(apiErrorFrom(new RpcError("internal", "db locked")).code).toBe("internal");
    expect(apiErrorFrom(new RpcTimeoutError("task.start")).code).toBe("not_connected");
    expect(apiErrorFrom(new RpcClientClosedError()).code).toBe("not_connected");
  });
});
