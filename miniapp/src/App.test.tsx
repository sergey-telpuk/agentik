import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { asJson, NOW_MS, validWire } from "./pairing/testing";
import type { AppServices } from "./services";
import { MemoryBackend } from "./storage/fakes";
import { PinnedDeviceStore } from "./storage/pinnedDevices";
import { noTelegramRuntime } from "./telegram/runtime";

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

function services(backend: MemoryBackend | null): AppServices {
  return {
    runtime: noTelegramRuntime,
    openStore: () => PinnedDeviceStore.open({ secure: backend, device: null }),
    createRelayClient: () => {
      throw new Error("not used in this test");
    },
    now: () => NOW_MS,
  };
}

async function render(s: AppServices): Promise<void> {
  await act(async () => {
    root.render(<App services={s} />);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

/** Lets real async work (WebCrypto digests, storage) finish inside act. */
async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function type(value: string): Promise<void> {
  const area = container.querySelector("textarea");
  if (area === null) throw new Error("no textarea");
  await act(async () => {
    // React tracks the value through the native setter.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("App", () => {
  it("shows the explicit unsupported state and cannot start pairing", async () => {
    await render(services(null));
    expect(container.textContent).toContain("Persistent access is not supported on this device");
    expect(button("Connect a computer").disabled).toBe(true);
  });

  it("pairs and pins a computer, then lists it as pending confirmation", async () => {
    await render(services(new MemoryBackend()));
    expect(container.textContent).toContain("No computers paired yet");

    await click("Connect a computer");
    await type(asJson(validWire()));
    await click("Check invitation");
    await settle(() => container.textContent?.includes("not trusted yet") === true);
    expect(container.textContent).toContain("not trusted yet");

    await click("Pin this computer");
    await settle(() => container.textContent?.includes("pending confirmation") === true);
    expect(container.textContent).toContain("pending confirmation");
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
    // The summary is rendered, and it shows the public details only.
    const summary = container.querySelector("dl")?.textContent ?? "";
    expect(summary).toContain(String(wire["device_id"]));
    expect(summary).not.toContain(String(wire["invitation_secret"]));
    expect(summary).not.toContain(String(wire["invitation_id"]));
  });
});
