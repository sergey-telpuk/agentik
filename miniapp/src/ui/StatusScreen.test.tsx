import type { NoiseCipherState } from "@richardhopton/noise-c.wasm";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64, encodeBase64Url } from "../encoding";
import { parseInvitation } from "../pairing/invitation";
import { pinnedDeviceFromInvitation } from "../pairing/pin";
import { asJson, NOW_MS, NOW_S, validWire } from "../pairing/testing";
import { RelayClient, type WebSocketLike } from "../relay/client";
import {
  devicePrologue,
  generateNoiseKeyPair,
  loadFreshNoiseRuntime,
  NOISE_PROTOCOL_NAME,
  noiseChannelFactory,
} from "../secure/noise";
import type { AppServices } from "../services";
import { MemoryBackend } from "../storage/fakes";
import { PhoneIdentityStore } from "../storage/phoneIdentity";
import { PinnedDeviceStore } from "../storage/pinnedDevices";
import { StatusScreen } from "./StatusScreen";

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

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !until(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("StatusScreen Noise wiring", () => {
  it("completes Noise XX over RelayClient, sends initData and device.info encrypted", async () => {
    const daemonKeys = await generateNoiseKeyPair();
    const wire = validWire({ noise_public_key: encodeBase64Url(daemonKeys.publicKey) });
    const parsed = parseInvitation(asJson(wire), NOW_MS);
    if (!parsed.ok) throw new Error("invalid test wire");
    const device = pinnedDeviceFromInvitation(parsed.value, NOW_S);

    const noise = await loadFreshNoiseRuntime();
    const hs = new noise.HandshakeState(NOISE_PROTOCOL_NAME, noise.constants.NOISE_ROLE_RESPONDER);
    hs.Initialize(devicePrologue(parsed.value.deviceId), daemonKeys.privateKey, null, null);
    let step = 1;
    let sendCipher = null as NoiseCipherState | null;
    let recvCipher = null as NoiseCipherState | null;
    const decryptedPayloads: Record<string, unknown>[] = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let socket: FakeSocket | null = null;

    const backend = new MemoryBackend("secure");
    const services: AppServices = {
      runtime: {
        isMiniApp: true,
        platformVersion: "9.0",
        rawInitData: () => "auth_date=1700000000&user=%7B%22id%22%3A42%7D&signature=abc",
        supportsMethod: () => true,
        scanQr: () => Promise.resolve(null),
      },
      openStore: () => PinnedDeviceStore.open({ secure: backend, device: null }),
      openIdentityStore: () => PhoneIdentityStore.open({ secure: backend, device: null }),
      createRelayClient: (d) =>
        new RelayClient({
          relayUrl: d.relayUrl,
          deviceId: parsed.value.deviceId,
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
                  queueMicrotask(() => {
                    socket?.receive({ type: "frame", data: encodeBase64(msg2) });
                  });
                } else if (step === 3) {
                  hs.ReadMessage(raw, false, false);
                  const [s, r] = hs.Split();
                  sendCipher = s;
                  recvCipher = r;
                  step = 4;
                } else if (recvCipher !== null && sendCipher !== null) {
                  const pt = recvCipher.DecryptWithAd(new Uint8Array(0), raw);
                  const msg = JSON.parse(decoder.decode(pt)) as Record<string, unknown>;
                  decryptedPayloads.push(msg);
                  if (msg["method"] === "device.info") {
                    const reply = encoder.encode(
                      JSON.stringify({
                        v: 1,
                        type: "response",
                        request_id: msg["request_id"],
                        ok: true,
                        result: {
                          device_id: d.deviceId,
                          paired: true,
                          pairing_state: "paired",
                          capabilities: ["codex"],
                        },
                      }),
                    );
                    const ct = sendCipher.EncryptWithAd(new Uint8Array(0), reply);
                    queueMicrotask(() => {
                      socket?.receive({ type: "frame", data: encodeBase64(ct) });
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

    await act(async () => {
      root.render(<StatusScreen services={services} device={device} onBack={() => undefined} />);
    });

    await settle(() => container.textContent?.includes("key verified, paired") === true);
    expect(container.textContent).toContain("encrypted (Noise XX, key verified, paired)");
    expect(container.textContent).toContain("sent over Noise session for verification");
    expect(decryptedPayloads.map((p) => p["method"])).toContain("auth.telegram");
    expect(decryptedPayloads.map((p) => p["method"])).toContain("device.info");

    await act(async () => {
      root.unmount();
    });
    sendCipher?.free();
    recvCipher?.free();
  });

  it("clears pending credentials and blocks task UI when computer rejects pairing", async () => {
    const daemonKeys = await generateNoiseKeyPair();
    const wire = validWire({ noise_public_key: encodeBase64Url(daemonKeys.publicKey) });
    const parsed = parseInvitation(asJson(wire), NOW_MS);
    if (!parsed.ok) throw new Error("invalid test wire");
    const device = pinnedDeviceFromInvitation(parsed.value, NOW_S);

    const noise = await loadFreshNoiseRuntime();
    const hs = new noise.HandshakeState(NOISE_PROTOCOL_NAME, noise.constants.NOISE_ROLE_RESPONDER);
    hs.Initialize(devicePrologue(parsed.value.deviceId), daemonKeys.privateKey, null, null);
    let step = 1;
    let sendCipher = null as NoiseCipherState | null;
    let recvCipher = null as NoiseCipherState | null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let socket: FakeSocket | null = null;
    let clearedDeviceId: string | null = null;

    const sendEncrypted = (msg: unknown): void => {
      if (sendCipher === null) return;
      const ct = sendCipher.EncryptWithAd(new Uint8Array(0), encoder.encode(JSON.stringify(msg)));
      queueMicrotask(() => socket?.receive({ type: "frame", data: encodeBase64(ct) }));
    };

    const backend = new MemoryBackend("secure");
    const store = await PinnedDeviceStore.open({ secure: backend, device: null });
    await store.pin(device);

    const services: AppServices = {
      runtime: {
        isMiniApp: false,
        platformVersion: null,
        rawInitData: () => null,
        supportsMethod: () => false,
        scanQr: () => Promise.resolve(null),
      },
      openStore: () => Promise.resolve(store),
      openIdentityStore: () => PhoneIdentityStore.open({ secure: backend, device: null }),
      createRelayClient: (d) =>
        new RelayClient({
          relayUrl: d.relayUrl,
          deviceId: parsed.value.deviceId,
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
                  const msg = JSON.parse(decoder.decode(pt)) as Record<string, unknown>;
                  if (msg["method"] === "device.info") {
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: msg["request_id"],
                      ok: true,
                      result: {
                        device_id: d.deviceId,
                        paired: false,
                        pairing_state: "unpaired",
                        capabilities: ["codex"],
                      },
                    });
                  } else if (msg["method"] === "pair.submit") {
                    sendEncrypted({
                      v: 1,
                      type: "response",
                      request_id: msg["request_id"],
                      ok: true,
                      result: {
                        state: "awaiting_local_approval",
                        device_id: d.deviceId,
                        verification_code: "11:22:33:44",
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

    await act(async () => {
      root.render(
        <StatusScreen
          services={services}
          device={device}
          store={store}
          pendingPairing={{
            deviceId: device.deviceId,
            invitationId: String(wire["invitation_id"]),
            invitationSecret: String(wire["invitation_secret"]),
          }}
          onClearPendingPairing={(id) => {
            clearedDeviceId = id;
          }}
          onBack={() => undefined}
        />,
      );
    });

    await settle(() => container.textContent?.includes("11:22:33:44") === true);

    await act(async () => {
      sendEncrypted({
        v: 1,
        type: "event",
        event: "pair.updated",
        data: { device_id: device.deviceId, state: "rejected" },
      });
    });

    await settle(() => container.textContent?.includes("Pairing rejected by the computer") === true);
    expect(clearedDeviceId).toBe(device.deviceId);
    expect(container.textContent).not.toContain("Run task");
    const listed = await store.list();
    expect(listed.ok && listed.value[0]?.state).toBe("unconfirmed");

    await act(async () => {
      root.unmount();
    });
    sendCipher?.free();
    recvCipher?.free();
  });
});
