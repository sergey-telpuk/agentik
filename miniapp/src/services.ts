import { createLiveApi } from "./api/live/liveApi";
import { DemoMemoryBackend } from "./api/mock/memoryBackend";
import { createMockApi } from "./api/mock/mockApi";
import { readScenario, scenarioData, type ScenarioName } from "./api/mock/scenarios";
import type { AgentikApi, Diagnostics, StorageAvailability } from "./api/types";
import { decodeBase32 } from "./encoding";
import { RelayClient } from "./relay/client";
import { readWebRtcConfig } from "./webrtc/config";
import { openDataChannelLink } from "./webrtc/link";
import { noiseChannelFactory } from "./secure/noise";
import type { KeyValueBackend } from "./storage/backend";
import { PhoneIdentityStore } from "./storage/phoneIdentity";
import type { PinnedDevice } from "./storage/pinnedDevices";
import { PinnedDeviceStore } from "./storage/pinnedDevices";
import { createTelegramBackends, type AvailableBackends } from "./storage/telegramBackends";
import { createTelegramRuntime, type TelegramRuntime } from "./telegram/runtime";
import { APP_VERSION } from "./version";

/** Everything the UI needs from the outside world, so tests can replace it. */
export interface AppServices {
  readonly runtime: TelegramRuntime;
  /** Opens the pinned-device store. Resolves once the backend was probed. */
  openStore(): Promise<PinnedDeviceStore>;
  /** Current time in milliseconds. */
  now(): number;
  /** Builds the backend the screens talk to, on top of the opened store. */
  createApi(store: PinnedDeviceStore): AgentikApi;
}

/** Which backend the app runs on. */
export type BackendChoice =
  | { readonly kind: "mock"; readonly scenario: ScenarioName }
  | { readonly kind: "live" };

/**
 * A `scenario` query parameter selects the mock backend with that scenario
 * (an unknown name falls back to `happy`). Without it the app is live.
 */
export function chooseBackend(search: string): BackendChoice {
  return new URLSearchParams(search).has("scenario") ? { kind: "mock", scenario: readScenario(search) } : { kind: "live" };
}

async function probe(backend: KeyValueBackend | null): Promise<StorageAvailability> {
  if (backend === null) return "unavailable";
  const store = await PinnedDeviceStore.open({ secure: backend, device: null });
  return store.persistence.status === "available" ? "available" : "failed";
}

/** Storage facts for diagnostics, derived from the opened store only. */
export function storageFromPersistence(store: PinnedDeviceStore): Diagnostics["storage"] {
  const p = store.persistence;
  return p.status === "available"
    ? {
        secureStorage: p.backend === "secure" ? "available" : "unavailable",
        deviceStorage: p.backend === "device" ? "available" : "unavailable",
        active: p.backend,
        note: null,
      }
    : { secureStorage: "unavailable", deviceStorage: "unavailable", active: "none", note: p.reason };
}

async function describeOpenedStore(
  store: PinnedDeviceStore,
  backends: AvailableBackends,
): Promise<Diagnostics["storage"]> {
  const [secureStorage, deviceStorage] = await Promise.all([probe(backends.secure), probe(backends.device)]);
  return { ...storageFromPersistence(store), secureStorage, deviceStorage };
}

/** Creates the signaling client for a pinned device. It carries SDP and ICE only. */
export function relayClientFor(device: PinnedDevice): RelayClient {
  const deviceId = decodeBase32(device.deviceId);
  if (deviceId === null) throw new Error("pinned device id is not valid");
  return new RelayClient({
    relayUrl: device.relayUrl,
    deviceId,
    deviceIdText: device.deviceId,
  });
}

export function createDefaultServices(search: string = window.location.search): AppServices {
  const choice = chooseBackend(search);
  return choice.kind === "mock" ? createMockServices(choice.scenario) : createLiveServices();
}

/** Real Telegram storage, relay signaling, WebRTC DataChannel, Noise session and inner protocol. */
function createLiveServices(): AppServices {
  const runtime = createTelegramRuntime();
  const webrtc = readWebRtcConfig(import.meta.env as unknown as Record<string, string | undefined>);
  const backends = createTelegramBackends(runtime);
  return {
    runtime,
    openStore: () => PinnedDeviceStore.open(backends),
    now: () => Date.now(),
    createApi: (store) =>
      createLiveApi({
        store,
        runtime,
        appVersion: APP_VERSION,
        openIdentityStore: () => PhoneIdentityStore.open(backends),
        createRelayClient: relayClientFor,
        openLink: ({ signaling, signal }) =>
          openDataChannelLink({
            signaling,
            signal,
            createPeerConnection: (config) => new RTCPeerConnection(config),
            extraIceServers: webrtc.stunUrls.length > 0 ? [{ urls: webrtc.stunUrls }] : [],
            iceServersWaitMs: webrtc.iceServersWaitMs,
            connectTimeoutMs: webrtc.connectTimeoutMs,
          }),
        secureChannel: noiseChannelFactory,
        describeStorage: () => describeOpenedStore(store, backends),
      }),
  };
}

/** Demo data for design review, selected with `?scenario=`. */
function createMockServices(scenario: ScenarioName): AppServices {
  const runtime = createTelegramRuntime();
  const storageAllowed = scenarioData(scenario).storageAvailable;
  const backends = createTelegramBackends(runtime);
  // Outside Telegram there is no persistent store at all; the demo keeps pins
  // in memory so pairing can still be shown. Inside Telegram the real
  // SecureStorage/DeviceStorage store is used.
  const demoMemory = storageAllowed && !runtime.isMiniApp;

  return {
    runtime,
    openStore: () => {
      if (!storageAllowed) return PinnedDeviceStore.open({ secure: null, device: null });
      if (demoMemory) return PinnedDeviceStore.open({ secure: new DemoMemoryBackend(), device: null });
      return PinnedDeviceStore.open(backends);
    },
    now: () => Date.now(),
    createApi: (store) =>
      createMockApi({
        scenario,
        store,
        runtime,
        appVersion: APP_VERSION,
        describeStorage: async () => {
          const [secureStorage, deviceStorage] = await Promise.all([probe(backends.secure), probe(backends.device)]);
          if (!storageAllowed) {
            return {
              secureStorage,
              deviceStorage,
              active: "none",
              note: "Demo scenario no_storage treats Telegram storage as unavailable. Paired computers cannot be saved, and nothing is written to ordinary browser storage.",
            };
          }
          if (demoMemory) {
            return {
              secureStorage,
              deviceStorage,
              active: "memory",
              note: "Not running inside Telegram, so there is no persistent store. The demo keeps pins in memory only; they are lost on reload.",
            };
          }
          return describeOpenedStore(store, backends);
        },
      }),
  };
}
