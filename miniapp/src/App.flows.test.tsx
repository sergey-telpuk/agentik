import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createMockApi } from "./api/mock/mockApi";
import type { ScenarioName } from "./api/mock/scenarios";
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

function services(scenario: ScenarioName): AppServices {
  return {
    runtime: noTelegramRuntime,
    openStore: () => PinnedDeviceStore.open({ secure: new MemoryBackend(), device: null }),
    createRelayClient: () => {
      throw new Error("not used in this test");
    },
    now: () => Date.now(),
    createApi: (store) =>
      createMockApi({
        scenario,
        store,
        runtime: noTelegramRuntime,
        appVersion: "9.9.9",
        describeStorage: () =>
          Promise.resolve({ secureStorage: "available", deviceStorage: "unavailable", active: "secure", note: null }),
      }),
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
  it("lists every computer status with text, not colour only", async () => {
    await render("happy");
    const text = container.textContent ?? "";
    for (const label of ["online", "offline", "pending confirmation", "key replaced"]) expect(text).toContain(label);
    expect(text).toContain("Demo data");
  });

  it("asks before forgetting a computer", async () => {
    await render("happy");
    await click("Forget Home Linux box");
    expect(dialog()?.textContent).toContain("Forget Home Linux box?");
    await click("Cancel");
    expect(container.textContent).toContain("Home Linux box");
    await click("Forget Home Linux box");
    await click("Forget computer", 10);
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
    expect(heading()).toBe("Task");
    expect(container.textContent).toContain("Closing the app does not cancel the task");
    await advance(3000);
    expect(container.textContent).toContain("Running");
    expect(find("Stop task").disabled).toBe(false);
    await advance(20_000);
    expect(container.querySelector(".chip-label")?.textContent).toBe("succeeded");
    await click("View result", 10);
    expect(heading()).toBe("Result");
    expect(container.textContent).toContain("Added a /healthz route");
    expect(container.textContent).toContain("relay/src/index.ts");
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
    expect(container.querySelector(".chip-label")?.textContent).toBe("stop requested");
    await advance(2000);
    expect(container.querySelector(".chip-label")?.textContent).toBe("cancelled");
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
    expect(container.querySelector(".chip-label")?.textContent).toBe("succeeded");
  });

  it("shows recovery_required with its explanation and no automatic retry", async () => {
    await openMainProject("recovery");
    await click("New task", 100);
    await typePrompt("Regenerate vectors");
    await click("Start task", 10_000);
    expect(container.querySelector(".chip-label")?.textContent).toBe("recovery required");
    await click("View result", 10);
    expect(container.textContent).toContain("The outcome is unknown");
    expect(container.textContent).toContain("never restarts such a task automatically");
    await click("Start a new task with the same text", 100);
    expect(container.querySelector("textarea")?.value).toBe("Regenerate vectors");
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
    expect(container.textContent).toContain("access ended");
  });

  it("does not allow starting a task when Codex is missing", async () => {
    await openMainProject("codex_missing");
    await click("New task", 100);
    await typePrompt("Anything");
    expect(container.textContent).toContain("Not installed on Work MacBook");
    expect(find("Start task").disabled).toBe(true);
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
    expect(container.textContent).toContain("No computers paired yet.");
  });
});
