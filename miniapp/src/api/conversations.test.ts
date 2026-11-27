import { describe, expect, it } from "vitest";
import { conversationsFromTasks, mergeConversations } from "./conversations";
import type { ConversationSummary, TaskState, TaskSummary } from "./types";

function task(id: string, sessionId: string, prompt: string, state: TaskState, at: number): TaskSummary {
  return {
    id,
    projectId: "p",
    sessionId,
    agent: "codex",
    prompt,
    state,
    createdAt: at,
    updatedAt: at,
    pendingApproval: null,
    lastSeq: 0,
  };
}

function row(sessionId: string, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    sessionId,
    projectId: "p",
    agent: "codex",
    title: `title of ${sessionId}`,
    latestState: "succeeded",
    turns: 1,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("conversationsFromTasks", () => {
  it("titles a session by its first turn and takes the status of the newest", () => {
    const rows = conversationsFromTasks([
      task("t2", "s1", "second", "running", 20),
      task("t1", "s1", "first", "succeeded", 10),
      task("t3", "s2", "other", "failed", 5),
    ]);
    expect(rows.find((r) => r.sessionId === "s1")).toMatchObject({ title: "first", latestState: "running", turns: 2, updatedAt: 20 });
    expect(rows.find((r) => r.sessionId === "s2")).toMatchObject({ title: "other", latestState: "failed", turns: 1 });
  });
});

describe("mergeConversations", () => {
  it("returns one row per session id, newest activity first", () => {
    const merged = mergeConversations(
      [row("a", { updatedAt: 100 }), row("b", { updatedAt: 300 })],
      [row("a", { updatedAt: 100, title: "local a" }), row("c", { updatedAt: 200 })],
    );
    expect(merged.map((r) => r.sessionId)).toEqual(["b", "c", "a"]);
    expect(merged.find((r) => r.sessionId === "a")?.title).toBe("title of a");
  });

  it("keeps the computer's row when the phone knows nothing newer", () => {
    const [only] = mergeConversations([row("a", { turns: 5, latestState: "failed", updatedAt: 500 })], [row("a", { turns: 1, updatedAt: 400 })]);
    expect(only).toMatchObject({ turns: 5, latestState: "failed", updatedAt: 500 });
  });

  it("takes the newer status from the phone and never reduces the turn count", () => {
    const [only] = mergeConversations([row("a", { turns: 2, updatedAt: 500 })], [row("a", { turns: 3, latestState: "running", updatedAt: 600 })]);
    expect(only).toMatchObject({ turns: 3, latestState: "running", updatedAt: 600, title: "title of a" });
  });
});
