import type { NoiseCipherState } from "@richardhopton/noise-c.wasm";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { decodeBase32, decodeBase64, encodeBase64, encodeBase64Url } from "./encoding";
import { asJson, NOW_MS, validWire } from "./pairing/testing";
import { RelayClient, type WebSocketLike } from "./relay/client";
import {
  devicePrologue,
  generateNoiseKeyPair,
  loadFreshNoiseRuntime,
  NOISE_PROTOCOL_NAME,
  noiseChannelFactory,
} from "./secure/noise";
import type { AppServices } from "./services";
import { MemoryBackend } from "./storage/fakes";
import { PhoneIdentityStore } from "./storage/phoneIdentity";
import { PinnedDeviceStore } from "./storage/pinnedDevices";
import { noTelegramRuntime } from "./telegram/runtime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(readonly onSend: (msg: Record<string, unknown>) => void) {}

  send(data: string): void {
    this.onSend(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let container: HTMLElement;
let root: Root;
let storageSpy: ReturnType<typeof vi.spyOn>;

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
});

function services(backend: MemoryBackend | null): AppServices {
  return {
    runtime: noTelegramRuntime,
    openStore: () => PinnedDeviceStore.open({ secure: backend, device: null }),
    openIdentityStore: () => PhoneIdentityStore.open({ secure: backend, device: null }),
    createRelayClient: () => {
      throw new Error("not used in this test");
    },
    secureChannel: noiseChannelFactory,
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
  for (let i = 0; i < 100 && !until(); i++) {
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
    const summary = container.querySelector("dl")?.textContent ?? "";
    expect(summary).toContain(String(wire["device_id"]));
    expect(summary).not.toContain(String(wire["invitation_secret"]));
    expect(summary).not.toContain(String(wire["invitation_id"]));
  });

  it("submits pairing over Noise XX, waits for local approval, unlocks tasks, starts and cancels a task", async () => {
    const daemonKeys = await generateNoiseKeyPair();
    const wire = validWire({ noise_public_key: encodeBase64Url(daemonKeys.publicKey) });
    const deviceIdBytes = decodeBase32(String(wire["device_id"]));
    if (deviceIdBytes === null) throw new Error("invalid device id");

    const noise = await loadFreshNoiseRuntime();
    const hs = new noise.HandshakeState(NOISE_PROTOCOL_NAME, noise.constants.NOISE_ROLE_RESPONDER);
    hs.Initialize(devicePrologue(deviceIdBytes), daemonKeys.privateKey, null, null);
    let step = 1;
    let sendCipher = null as NoiseCipherState | null;
    let recvCipher = null as NoiseCipherState | null;
    let socket: FakeSocket | null = null;
    let paired = false;
    let taskCancelled = false;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const sendEncrypted = (msg: unknown): void => {
      if (sendCipher === null) return;
      const ct = sendCipher.EncryptWithAd(new Uint8Array(0), encoder.encode(JSON.stringify(msg)));
      queueMicrotask(() => socket?.receive({ type: "frame", data: encodeBase64(ct) }));
    };

    const backend = new MemoryBackend("secure");
    const fullServices: AppServices = {
      runtime: noTelegramRuntime,
      openStore: () => PinnedDeviceStore.open({ secure: backend, device: null }),
      openIdentityStore: () => PhoneIdentityStore.open({ secure: backend, device: null }),
      createRelayClient: (d) =>
        new RelayClient({
          relayUrl: d.relayUrl,
          deviceId: deviceIdBytes,
          deviceIdText: d.deviceId,
          createSocket: () => {
            socket = new FakeSocket((outbound) => {
              if (outbound["type"] === "attach") {
                queueMicrotask(() => {
                  socket?.receive({
                    type: "attached",
                    deviceId: d.deviceId,
                    connectionId: "0123456789abcdef0123456789abcdef",
                    devicePresent: true,
                  });
                });
                return;
              }
              if (outbound["type"] === "frame" && typeof outbound["data"] === "string") {
                const raw = decodeBase64(outbound["data"]);
                if (raw === null) return;
                if (step === 1) {
                  hs.ReadMessage(raw, false, false);
                  step = 3;
                  const msg2 = hs.WriteMessage(null);
                  queueMicrotask(() => socket?.receive({ type: "frame", data: encodeBase64(msg2) }));
                } else if (step === 3) {
                  hs.ReadMessage(raw, false, false);
                  const [s, r] = hs.Split();
                  sendCipher = s;
                  recvCipher = r;
                  step = 4;
                } else if (recvCipher !== null) {
                  const pt = recvCipher.DecryptWithAd(new Uint8Array(0), raw);
                  const req = JSON.parse(decoder.decode(pt)) as {
                    request_id: string;
                    method: string;
                    params: Record<string, unknown>;
                  };
                  if (req.method === "device.info") {
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: req.request_id,
                      ok: true,
                      result: {
                        device_id: d.deviceId,
                        paired,
                        pairing_state: paired ? "paired" : "unpaired",
                        capabilities: ["codex"],
                      },
                    });
                  } else if (req.method === "pair.submit") {
                    expect(req.params["invitation_secret"]).toBe(wire["invitation_secret"]);
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: req.request_id,
                      ok: true,
                      result: {
                        state: "awaiting_local_approval",
                        device_id: d.deviceId,
                        verification_code: "ab:cd:ef:01",
                      },
                    });
                  } else if (req.method === "project.list") {
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: req.request_id,
                      ok: true,
                      result: { projects: [{ project_id: "repo", name: "agentik", agents: ["codex"] }] },
                    });
                  } else if (req.method === "agent.list") {
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: req.request_id,
                      ok: true,
                      result: {
                        agents: [{ name: "codex", available: true, authenticated: true, version: "0.160.0" }],
                      },
                    });
                  } else if (req.method === "session.list") {
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: req.request_id,
                      ok: true,
                      result: { sessions: [] },
                    });
                  } else if (req.method === "task.start") {
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: req.request_id,
                      ok: true,
                      result: {
                        task: {
                          task_id: "t-1",
                          session_id: "s-1",
                          project_id: "repo",
                          agent: "codex",
                          prompt: req.params["prompt"],
                          state: "running",
                          result_text: "",
                          error_message: "",
                          pending_approval: null,
                          created_at: 1000,
                          updated_at: 1000,
                        },
                      },
                    });
                  } else if (req.method === "events.resume") {
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: req.request_id,
                      ok: true,
                      result: { session_id: "s-1", events: [], next_seq: 1 },
                    });
                  } else if (req.method === "task.cancel") {
                    taskCancelled = true;
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: req.request_id,
                      ok: true,
                      result: {
                        task: {
                          task_id: "t-1",
                          session_id: "s-1",
                          project_id: "repo",
                          agent: "codex",
                          prompt: "Fix bug",
                          state: "cancel_requested",
                          result_text: "",
                          error_message: "",
                          pending_approval: null,
                          created_at: 1000,
                          updated_at: 1001,
                        },
                      },
                    });
                  }
                }
              }
            });
            queueMicrotask(() => socket?.onopen?.({}));
            return socket;
          },
        }),
      secureChannel: noiseChannelFactory,
      now: () => NOW_MS,
    };

    await render(fullServices);
    await click("Connect a computer");
    await type(asJson(wire));
    await click("Check invitation");
    await settle(() => container.textContent?.includes("Pin this computer") === true);
    await click("Pin this computer");
    await settle(() => container.textContent?.includes("Connection status") === true);

    await click("Connection status");
    await settle(() => container.textContent?.includes("ab:cd:ef:01") === true);
    expect(container.textContent).toContain("Confirm this phone on your computer");

    // Simulate PC operator pressing 'y' on daemon console.
    paired = true;
    await act(async () => {
      sendEncrypted({
        v: 1,
        type: "event",
        event: "pair.updated",
        data: { device_id: String(wire["device_id"]), state: "paired" },
      });
    });

    await settle(() => container.textContent?.includes("agentik (repo)") === true);
    expect(container.textContent).toContain("encrypted (Noise XX, key verified, paired)");

    await type("Fix bug");
    await click("Start task");
    await settle(() => container.textContent?.includes("Cancel task") === true);
    await click("Cancel task");
    await settle(() => taskCancelled && container.textContent?.includes("cancel_requested") === true);

    // Ensure secret never persisted anywhere and pin is now confirmed.
    const storedPin = await backend.get("agentik_pin_" + String(wire["device_id"]));
    expect(storedPin).toContain('"state":"confirmed"');
    expect(storedPin).not.toContain(String(wire["invitation_secret"]));
    expect(storageSpy).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    sendCipher?.free();
    recvCipher?.free();
  });
});
