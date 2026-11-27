import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createLiveApi } from "./api/live/liveApi";
import { FakeSocket, noiseDaemon, sessionEvent, type NoiseDaemon } from "./api/live/testing";
import { decodeBase32, encodeBase64Url } from "./encoding";
import { asJson, NOW_MS, validWire } from "./pairing/testing";
import type { TaskView } from "./protocol/messages";
import { RelayClient } from "./relay/client";
import { generateNoiseKeyPair, noiseChannelFactory } from "./secure/noise";
import type { SecureChannelFactory } from "./secure/seam";
import { storageFromPersistence, type AppServices } from "./services";
import { MemoryBackend } from "./storage/fakes";
import { PhoneIdentityStore } from "./storage/phoneIdentity";
import { PinnedDeviceStore, type PinnedDevice } from "./storage/pinnedDevices";
import { noTelegramRuntime } from "./telegram/runtime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let storageSpy: ReturnType<typeof vi.spyOn>;
const daemons: NoiseDaemon[] = [];

beforeEach(() => {
  storageSpy = vi.spyOn(Storage.prototype, "setItem");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  storageSpy.mockRestore();
  for (const d of daemons.splice(0)) d.dispose();
});

/** A relay whose socket never opens: the computer screen stays on its first step. */
function silentRelay(device: PinnedDevice): RelayClient {
  const deviceId = decodeBase32(device.deviceId);
  if (deviceId === null) throw new Error("invalid device id");
  return new RelayClient({
    relayUrl: device.relayUrl,
    deviceId,
    deviceIdText: device.deviceId,
    createSocket: () => new FakeSocket(() => undefined),
  });
}

/** The live backend wired to test doubles for the relay and the secure channel. */
function services(
  backend: MemoryBackend | null,
  wiring: {
    readonly createRelayClient: (device: PinnedDevice) => RelayClient;
    readonly secureChannel: SecureChannelFactory;
  } = { createRelayClient: silentRelay, secureChannel: noiseChannelFactory },
): AppServices {
  return {
    runtime: noTelegramRuntime,
    openStore: () => PinnedDeviceStore.open({ secure: backend, device: null }),
    now: () => NOW_MS,
    createApi: (store) =>
      createLiveApi({
        store,
        runtime: noTelegramRuntime,
        openIdentityStore: () => PhoneIdentityStore.open({ secure: backend, device: null }),
        createRelayClient: wiring.createRelayClient,
        secureChannel: wiring.secureChannel,
        describeStorage: () => Promise.resolve(storageFromPersistence(store)),
        appVersion: "0.0.0-test",
        now: () => NOW_MS,
      }),
  };
}

async function render(s: AppServices): Promise<void> {
  await act(async () => {
    root.render(<App services={s} />);
  });
}

function button(label: string): HTMLButtonElement {
  const all = [...container.querySelectorAll("button")];
  const found = all.find((b) => b.textContent === label) ?? all.find((b) => b.textContent?.includes(label) === true);
  if (found === undefined) throw new Error(`no button "${label}" in: ${container.textContent}`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

/** Lets real async work (WebCrypto digests, storage, Noise) finish inside act. */
async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !until(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function type(value: string): Promise<void> {
  const area = container.querySelector("textarea");
  if (area === null) throw new Error("no textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const has = (text: string): boolean => container.textContent?.includes(text) === true;

describe("App", () => {
  it("shows the explicit unsupported state and cannot start pairing", async () => {
    await render(services(null));
    expect(container.textContent).toContain("Persistent access is not supported on this device");
    expect(button("Connect a computer").disabled).toBe(true);
  });

  it("pairs and pins a computer, then lists it without status text", async () => {
    await render(services(new MemoryBackend()));
    expect(container.textContent).toContain("No computers paired yet");
    // The live backend is not labelled as demo data.
    expect(container.textContent).not.toContain("Demo data");

    await click("Connect a computer");
    await type(asJson(validWire()));
    await click("Check invitation");
    await settle(() => has("not trusted yet"));
    expect(container.textContent).toContain("not trusted yet");

    await click("Pin this computer");
    await settle(() => container.querySelector("li.computer-row") !== null);
    // The list row shows the computer, but no status text.
    expect(container.querySelector("li.computer-row .button-primary")?.textContent).toBe("OPEN");
    expect(container.textContent).not.toContain("pending confirmation");

    await click("OPEN");
    // The computer's own screen carries the confirmation step.
    await settle(() => has("Confirm on computer"));
    expect(container.textContent).toContain("Confirm on computer");
  });

  it("rejects an expired invitation with a readable message", async () => {
    await render(services(new MemoryBackend()));
    await click("Connect a computer");
    await type(asJson(validWire({ expires_at: NOW_MS / 1000 - 10 })));
    await click("Check invitation");
    await settle(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("expired");
    expect(container.textContent).not.toContain("Pin this computer");
  });

  it("does not render the invitation secret", async () => {
    await render(services(new MemoryBackend()));
    await click("Connect a computer");
    const wire = validWire();
    await type(asJson(wire));
    await click("Check invitation");
    await settle(() => container.querySelector("dl") !== null);
    const summary = container.querySelector("dl")?.textContent ?? "";
    expect(summary).toContain(String(wire["device_id"]));
    expect(summary).not.toContain(String(wire["invitation_secret"]));
    expect(summary).not.toContain(String(wire["invitation_id"]));
  });

  it("submits pairing over Noise XX, waits for local approval, unlocks projects, starts and stops a task", async () => {
    const daemonKeys = await generateNoiseKeyPair();
    const wire = validWire({ noise_public_key: encodeBase64Url(daemonKeys.publicKey) });
    const deviceId = String(wire["device_id"]);
    let paired = false;
    let current: TaskView | null = null;
    const taskView = (state: TaskView["state"], prompt: string): TaskView => ({
      task_id: "t-1",
      session_id: "s-1",
      project_id: "repo",
      agent: "codex",
      prompt,
      state,
      result_text: "",
      error_message: "",
      pending_approval: null,
      created_at: NOW_MS / 1000,
      updated_at: NOW_MS / 1000,
    });

    const daemon = await noiseDaemon(deviceId, daemonKeys, (frame) => {
      switch (frame.method) {
        case "device.info":
          return {
            result: { device_id: deviceId, paired, pairing_state: paired ? "paired" : "unpaired", capabilities: ["codex"] },
          };
        case "pair.submit":
          expect(frame.params["invitation_secret"]).toBe(wire["invitation_secret"]);
          return { result: { state: "awaiting_local_approval", device_id: deviceId, verification_code: "ab:cd:ef:01" } };
        case "project.list":
          return { result: { projects: [{ project_id: "repo", name: "agentik", agents: ["codex"] }] } };
        case "agent.list":
          return { result: { agents: [{ name: "codex", available: true, authenticated: true, version: "0.160.0" }] } };
        case "task.start":
          current = taskView("running", String(frame.params["prompt"]));
          return { result: { task: current } };
        case "session.open":
          return {
            result: {
              session_id: "s-1",
              project_id: "repo",
              agent: "codex",
              last_seq: 1,
              tasks: current === null ? [] : [current],
            },
          };
        case "task.get":
          return current === null ? { error: { code: "not_found", message: "task not found" } } : { result: { task: current } };
        case "events.resume":
          return { result: { session_id: "s-1", events: [], next_seq: 1 } };
        case "task.cancel":
          current = taskView("cancel_requested", current?.prompt ?? "");
          return { result: { task: current } };
        default:
          return undefined;
      }
    });
    daemons.push(daemon);

    const backend = new MemoryBackend("secure");
    await render(services(backend, { createRelayClient: daemon.relay.createRelayClient, secureChannel: noiseChannelFactory }));
    await click("Connect a computer");
    await type(asJson(wire));
    await click("Check invitation");
    await settle(() => has("Pin this computer"));
    await click("Pin this computer");
    await settle(() => container.querySelector("li.computer-row") !== null);

    await click("OPEN");
    await settle(() => has("ab:cd:ef:01"));
    expect(container.textContent).toContain("waiting for confirmation");

    // The operator confirms the phone on the computer.
    paired = true;
    daemon.push({ v: 1, type: "event", event: "pair.updated", data: { device_id: deviceId, state: "paired" } });
    await settle(() => has("agentik"));
    expect(container.textContent).toContain("secure session");
    expect(container.textContent).toContain("Codex 0.160.0");

    await click("agentik");
    await settle(() => has("No tasks started from this phone yet"));
    expect(container.textContent).toContain("The computer cannot list earlier tasks yet");
    await click("New task");
    await settle(() => has("Version 0.160.0"));
    await type("Fix bug");
    await click("Start task");
    await settle(() => has("Closing the app does not cancel the task"));
    await settle(() => container.querySelector(".chip-label")?.textContent === "running");
    expect(container.querySelector(".chip-label")?.textContent).toBe("running");

    daemon.push(
      sessionEvent({
        session_id: "s-1",
        task_id: "t-1",
        seq: 2,
        kind: "item",
        payload: { item_type: "agentMessage", text: "Looking at the failing test" },
        created_at: NOW_MS / 1000,
      }),
    );
    await settle(() => has("Looking at the failing test"));
    expect(container.textContent).toContain("Looking at the failing test");

    await click("Stop task");
    const confirm = [...(container.querySelector('[role="dialog"]')?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Stop task",
    );
    await act(async () => confirm?.click());
    await settle(() => container.querySelector(".chip-label")?.textContent === "stop requested");
    expect(container.querySelector(".chip-label")?.textContent).toBe("stop requested");
    expect(daemon.requests.some((r) => r.method === "task.cancel")).toBe(true);

    // The pin is confirmed, and the one-time secret was never persisted anywhere.
    const storedPin = await backend.get("agentik_pin_" + deviceId);
    expect(storedPin).toContain('"state":"confirmed"');
    expect(storedPin).not.toContain(String(wire["invitation_secret"]));
    for (const value of backend.data.values()) expect(value).not.toContain(String(wire["invitation_secret"]));
    expect(storageSpy).not.toHaveBeenCalled();
  });
});
