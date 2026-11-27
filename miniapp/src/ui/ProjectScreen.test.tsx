import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentikApi, ApiResult, ConversationListing, ConversationSummary } from "../api/types";
import { ProjectScreen } from "./ProjectScreen";

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

function conversation(overrides: Partial<ConversationSummary>): ConversationSummary {
  return {
    sessionId: "sess-1",
    projectId: "proj-1",
    agent: "codex",
    title: "Refactor the parser",
    latestState: "succeeded",
    turns: 1,
    updatedAt: T0,
    ...overrides,
  };
}

async function render(listing: ConversationListing, backend: "live" | "mock" = "live", opened: string[] = []): Promise<void> {
  const api = {
    backend,
    listConversations: (): Promise<ApiResult<ConversationListing>> => Promise.resolve({ ok: true, value: listing }),
  } as unknown as AgentikApi;
  await act(async () => {
    root.render(
      <ProjectScreen
        api={api}
        computerId="c1"
        projectId="proj-1"
        projectName="agentik"
        now={() => T0}
        onNewTask={() => undefined}
        onOpenSession={(id) => opened.push(id)}
        onBack={() => undefined}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ProjectScreen", () => {
  it("lists conversations restored from the computer, one row per session", async () => {
    const opened: string[] = [];
    await render(
      {
        conversations: [
          conversation({ sessionId: "sess-1", title: "Refactor the parser", turns: 3 }),
          conversation({ sessionId: "sess-2", title: "Fix the build", latestState: "failed", updatedAt: T0 - 60_000 }),
        ],
        source: "computer",
        truncated: false,
        warning: null,
      },
      "live",
      opened,
    );
    const rows = [...container.querySelectorAll("li.row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Refactor the parser");
    expect(rows[0]?.textContent).toContain("3 messages");
    expect(rows[1]?.textContent).toContain("Fix the build");
    // Every row shows its message count, also for a single message.
    expect(rows[1]?.textContent).toContain("1 message ·");
    expect(container.textContent).not.toContain("cannot list earlier conversations");
    act(() => rows[0]?.querySelector("button")?.click());
    expect(opened).toEqual(["sess-1"]);
  });

  it("explains the local-only list when the computer cannot list conversations", async () => {
    await render({ conversations: [conversation({})], source: "local", truncated: false, warning: null });
    expect(container.textContent).toContain("Refactor the parser");
    expect(container.textContent).toContain("cannot list earlier conversations yet");
  });

  it("shows a warning next to local rows when the computer's list failed", async () => {
    await render({ conversations: [conversation({})], source: "local", truncated: false, warning: "The computer did not answer in time" });
    expect(container.textContent).toContain("Earlier conversations could not be loaded");
    expect(container.textContent).toContain("did not answer in time");
    expect(container.querySelectorAll("li.row")).toHaveLength(1);
  });

  it("says when older conversations were left out", async () => {
    await render({ conversations: [conversation({})], source: "computer", truncated: true, warning: null });
    expect(container.textContent).toContain("Only the most recent conversations are shown");
  });

  it("shows the empty state for a project without conversations", async () => {
    await render({ conversations: [], source: "computer", truncated: false, warning: null });
    expect(container.textContent).toContain("No tasks in this project yet");
  });
});
