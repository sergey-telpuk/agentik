import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createMockApi } from "./api/mock/mockApi";
import type { ScenarioName } from "./api/mock/scenarios";
import type { StartTaskInput } from "./api/types";
import { NOW_MS } from "./pairing/testing";
import type { AppServices } from "./services";
import { MemoryBackend } from "./storage/fakes";
import { PinnedDeviceStore } from "./storage/pinnedDevices";
import { noTelegramRuntime } from "./telegram/runtime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Every `startTask` input the app sent, in order. */
let startInputs: StartTaskInput[] = [];

function services(scenario: ScenarioName): AppServices {
  startInputs = [];
  return {
    runtime: noTelegramRuntime,
    openStore: () => PinnedDeviceStore.open({ secure: new MemoryBackend(), device: null }),
    now: () => Date.now(),
    createApi: (store) => {
      const api = createMockApi({
        scenario,
        store,
        runtime: noTelegramRuntime,
        appVersion: "9.9.9",
        describeStorage: () =>
          Promise.resolve({ secureStorage: "available", deviceStorage: "unavailable", active: "secure", note: null }),
      });
      return {
        ...api,
        startTask: (computerId, input) => {
          startInputs.push(input);
          return api.startTask(computerId, input);
        },
      };
    },
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function render(scenario: ScenarioName): Promise<void> {
  await act(async () => {
    root.render(<App services={services(scenario)} />);
  });
  await advance(0);
  // Home is the conversation list now; these flows start from the computers
  // screen, which it links to once the paired computers have loaded. How long
  // that takes depends on the scenario, so poll instead of guessing.
  for (let i = 0; i < 20; i++) {
    const link = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Pair a computer" || b.getAttribute("aria-label") === "New conversation",
    );
    if (link !== undefined) {
      await act(async () => {
        link.click();
      });
      await advance(10);
      return;
    }
    await advance(50);
  }
  throw new Error(`home never offered a way to the computers screen: ${container.textContent}`);
}

function find(text: string): HTMLButtonElement {
  const all = [...container.querySelectorAll("button")];
  const found =
    all.find((b) => b.textContent === text || b.getAttribute("aria-label") === text) ??
    all.find((b) => b.textContent?.includes(text) === true);
  if (found === undefined) throw new Error(`no button "${text}" in: ${container.textContent}`);
  return found;
}

async function click(text: string, after = 0): Promise<void> {
  await act(async () => {
    find(text).click();
  });
  await advance(after);
}

function heading(): string {
  return container.querySelector(".page-title h2")?.textContent ?? "";
}

function dialog(): HTMLElement | null {
  return container.querySelector('[role="dialog"]');
}

async function typePrompt(value: string): Promise<void> {
  const area = container.querySelector("textarea");
  if (area === null) throw new Error("no textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openMainProject(scenario: ScenarioName, project = "Billing service"): Promise<void> {
  await render(scenario);
  await click("Work MacBook", 3000);
  expect(container.textContent).toContain("secure session");
  await click(project, 100);
  expect(heading()).toBe(project);
}

describe("App flows on mock data", () => {
  it("lists computers as icon rows with name, id and OPEN, and no status text", async () => {
    await render("happy");
    const rows = [...container.querySelectorAll("li.computer-row")];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.querySelector("img.computer-icon")).not.toBeNull();
      expect(row.querySelector(".computer-name")?.textContent).not.toBe("");
      expect(row.querySelector(".computer-id")?.textContent).toMatch(/^\w{4} \w{4} …$/);
      expect(row.querySelector(".button-primary")?.textContent).toBe("OPEN");
      expect(row.querySelector(".chip")).toBeNull();
      expect(row.textContent).not.toMatch(/online|offline|pending|replaced|ended|seen|never connected|!/i);
    }
    expect(container.textContent).toContain("Demo data");
  });

  it("opens a computer from the row, the name area and the OPEN button", async () => {
    for (const target of ["Open Work MacBook", "Work MacBook"]) {
      await render("happy");
      await click(target, 10);
      expect(heading()).toBe("Work MacBook");
      act(() => root.unmount());
      root = createRoot(container);
    }
    await render("happy");
    await act(async () => {
      container.querySelector<HTMLElement>("li.computer-row")?.click();
    });
    await advance(10);
    expect(container.querySelector(".page-title h2")).not.toBeNull();
    expect(container.querySelector("li.computer-row")).toBeNull();
  });

  it("keeps the connection status on the computer screen, not on the list row", async () => {
    await render("happy");
    await click("Open Work MacBook");
    expect(container.textContent).toContain("connecting");
    await advance(3000);
    expect(container.textContent).toContain("secure session");
  });

  it("asks before forgetting a computer, from the computer screen", async () => {
    await render("happy");
    expect(container.textContent).not.toContain("Forget");
    await click("Open Home Linux box", 10);
    await click("Forget this computer");
    expect(dialog()?.textContent).toContain("Forget Home Linux box?");
    await click("Cancel");
    expect(dialog()).toBeNull();
    await click("Forget this computer");
    await click("Forget computer", 10);
    // Forgetting returns home (the conversation list); the remaining computer
    // is still paired, so reach its row through the new-conversation button.
    await click("New conversation", 10);
    expect(container.querySelector("li.computer-row")).not.toBeNull();
    expect(container.textContent).not.toContain("Home Linux box");
  });

  it("shows projects by name and id only after the secure session is ready", async () => {
    await render("happy");
    await click("Work MacBook");
    expect(container.textContent).toContain("connecting");
    expect(container.textContent).not.toContain("proj_agentik");
    await advance(3000);
    expect(container.textContent).toContain("proj_agentik");
    expect(container.textContent).toContain("Billing service");
  });

  it("runs a new task, streams events and shows the result", async () => {
    await openMainProject("happy");
    expect(container.textContent).toContain("No tasks in this project yet");
    await click("New task", 100);
    expect(find("Start task").disabled).toBe(true);
    await typePrompt("Make the relay tests pass");
    await click("Start task", 0);
    expect(heading()).toBe("Conversation");
    expect(container.textContent).toContain("Closing the app does not cancel the task");
    await advance(3000);
    expect(container.querySelector(".bubble-agent .chip-label")?.textContent).toBe("running");
    expect(find("Stop task").disabled).toBe(false);
    expect(find("Send").disabled).toBe(true);
    await advance(20_000);
    // The chip is only for a turn that runs or ended otherwise; a reply that succeeded has none.
    expect(container.querySelector(".bubble-agent .chip")).toBeNull();
    expect(container.textContent).toContain("Added a /healthz route");
    expect(container.textContent).toContain("relay/src/index.ts");
    expect(container.textContent).not.toContain("Closing the app does not cancel the task");
    expect(find("Copy")).toBeDefined();
  });

  it("shows a seeded conversation turn by turn and sends a follow-up into the same session", async () => {
    await openMainProject("happy", "Agentik");
    // One row per conversation, titled by its first message.
    expect(container.textContent).toContain("Add a health check endpoint to the relay");
    expect(container.textContent).toContain("3 messages");
    expect(container.textContent).not.toContain("Now add a regression test for it");

    await click("Add a health check endpoint to the relay", 100);
    expect(heading()).toBe("Conversation");
    const prompts = [...container.querySelectorAll(".bubble-user .bubble-text")].map((p) => p.textContent);
    expect(prompts).toEqual([
      "Add a health check endpoint to the relay",
      "Now add a regression test for it",
      "Did you touch anything else?",
    ]);
    expect(container.querySelectorAll(".bubble-agent")).toHaveLength(3);
    expect(container.textContent).toContain("Added a regression test for /healthz");
    expect(container.textContent).toContain("relay/src/index.test.ts");
    expect(find("Send").disabled).toBe(true);

    await typePrompt("Thanks. Anything left to do?");
    expect(find("Send").disabled).toBe(false);
    await click("Send", 0);
    expect(startInputs).toHaveLength(1);
    expect(startInputs[0]?.sessionId).toBeDefined();
    expect(startInputs[0]?.prompt).toBe("Thanks. Anything left to do?");
    // The composer is cleared, the message is in the conversation, and Send waits for the reply.
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
    expect(container.querySelectorAll(".bubble-user")).toHaveLength(4);
    expect(find("Send").disabled).toBe(true);
    await advance(10_000);
    expect(container.querySelectorAll(".bubble-agent")).toHaveLength(4);
    expect(container.textContent).toContain("I only touched relay/src/index.ts");
    await typePrompt("Great");
    expect(find("Send").disabled).toBe(false);
    await click("Send", 10_000);
    expect(startInputs).toHaveLength(2);
    expect(startInputs[1]?.sessionId).toBe(startInputs[0]?.sessionId);
    expect(startInputs[1]?.requestId).not.toBe(startInputs[0]?.requestId);
    expect(container.querySelectorAll(".bubble-user")).toHaveLength(5);
  });

  it("stops a task only after confirmation and shows cancelled when confirmed", async () => {
    await openMainProject("happy");
    await click("New task", 100);
    await typePrompt("Long job");
    await click("Start task", 2500);
    await click("Stop task");
    expect(dialog()?.textContent).toContain("Stop this task?");
    await click("Keep running");
    expect(dialog()).toBeNull();
    await click("Stop task");
    const confirm = [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Stop task");
    await act(async () => confirm?.click());
    await advance(0);
    expect(container.textContent).toContain("Stopping… waiting for the computer");
    expect(container.querySelector(".bubble-agent .chip-label")?.textContent).toBe("stop requested");
    await advance(2000);
    expect(container.querySelector(".bubble-agent .chip-label")?.textContent).toBe("cancelled");
    // A stopped turn leaves the conversation open for the next message.
    await typePrompt("Never mind");
    expect(find("Send").disabled).toBe(false);
  });

  it("opens the approval sheet with the exact operation and applies the decision to that request only", async () => {
    await openMainProject("approval", "Agentik");
    await click("Fix the failing protocol tests", 100);
    const sheet = dialog();
    expect(sheet?.textContent).toContain("npm ci --no-audit --no-fund");
    expect(sheet?.textContent).toContain("working directory: project root");
    expect(sheet?.textContent).toContain("This decision applies only to this request");
    const firstId = sheet?.querySelector("dd .mono")?.textContent;
    await click("Approve", 10);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("You approved this request.");
    await advance(5000);
    const next = dialog();
    expect(next?.textContent).toContain("protocol/vectors/noise-xx.json");
    expect(next?.querySelector("dd .mono")?.textContent).not.toBe(firstId);
    await click("Deny", 10);
    expect(container.textContent).toContain("You denied this request.");
    await advance(5000);
    expect(container.querySelector(".bubble-agent .chip")).toBeNull();
    expect(container.textContent).toContain("Show steps");
  });

  it("shows recovery_required with its explanation and no automatic retry", async () => {
    await openMainProject("recovery");
    await click("New task", 100);
    await typePrompt("Regenerate vectors");
    await click("Start task", 10_000);
    expect(container.querySelector(".bubble-agent .chip-label")?.textContent).toBe("recovery required");
    expect(container.textContent).toContain("The outcome is unknown");
    expect(container.textContent).toContain("never restarts such a task automatically");
    // Nothing was started again; the message only returns to the composer, for the user to send.
    expect(startInputs).toHaveLength(1);
    await click("Put this message back in the composer", 10);
    expect(container.querySelector("textarea")?.value).toBe("Regenerate vectors");
    expect(startInputs).toHaveLength(1);
  });

  it("shows a failed connection with Retry for an offline computer", async () => {
    await render("offline");
    await click("Work MacBook", 3000);
    expect(container.textContent).toContain("connection failed");
    expect(container.textContent).toContain("is not connected");
    await click("Retry", 10);
    expect(container.textContent).toContain("connecting");
  });

  it("moves to the access ended screen when the computer revokes the phone", async () => {
    await openMainProject("revoked");
    await advance(8000);
    expect(heading()).toBe("Access ended");
    expect(container.textContent).toContain("Work MacBook ended access for this phone");
    expect(container.textContent).toContain("not restored automatically");
    await click("Back to computers", 10);
    // That returns home (the conversation list); the computers screen is one
    // step further.
    await click("New conversation", 10);
    // The list row shows no status; opening a revoked computer leads to the access-ended screen.
    expect(container.textContent).not.toContain("access ended");
    await click("Open Work MacBook", 10);
    expect(heading()).toBe("Access ended");
  });

  it("does not allow starting a task when Codex is missing", async () => {
    await openMainProject("codex_missing");
    await click("New task", 100);
    await typePrompt("Anything");
    expect(container.textContent).toContain("Not installed on Work MacBook");
    expect(find("Start task").disabled).toBe(true);
  });

  it("opens Settings from a computer screen and returns home after clearing local data", async () => {
    await render("offline");
    await click("Work MacBook", 3000);
    expect(container.textContent).toContain("connection failed");
    await click("Settings and diagnostics", 10);
    expect(heading()).toBe("Settings");
    await click("Clear local pinned data");
    await click("Clear data", 10);
    expect(container.textContent).toContain("Local pinned data cleared.");
    await click("Back", 10);
    expect(heading()).toBe("Agentik");
    expect(container.textContent).toContain("No computer paired yet.");
  });

  it("shows diagnostics and clears local data after confirmation", async () => {
    await render("happy");
    await click("Settings and diagnostics", 10);
    expect(heading()).toBe("Settings");
    const text = container.textContent ?? "";
    expect(text).toContain("9.9.9");
    expect(text).toContain("wss://relay.agentik.example");
    expect(text).toContain("SecureStorage");
    await click("Clear local pinned data");
    await click("Clear data", 10);
    expect(container.textContent).toContain("Local pinned data cleared.");
    await click("Back", 10);
    await click("Pair a computer", 10);
    expect(container.textContent).toContain("No computers paired yet.");
  });
});
