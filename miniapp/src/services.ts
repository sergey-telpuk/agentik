import { RelayClient } from "./relay/client";
import type { PinnedDevice } from "./storage/pinnedDevices";
import { PinnedDeviceStore } from "./storage/pinnedDevices";
import { createTelegramBackends } from "./storage/telegramBackends";
import { createTelegramRuntime, type TelegramRuntime } from "./telegram/runtime";
import { decodeBase32 } from "./encoding";
import type { KeyValueBackend } from "./storage/backend";
import type { AgentikApi, Diagnostics, StorageAvailability } from "./api/types";
import { createMockApi } from "./api/mock/mockApi";
import { DemoMemoryBackend } from "./api/mock/memoryBackend";
import { readScenario, scenarioData, type ScenarioName } from "./api/mock/scenarios";
import { APP_VERSION } from "./version";

/** Everything the UI needs from the outside world, so tests can replace it. */
export interface AppServices {
  readonly runtime: TelegramRuntime;
  /** Opens the pinned-device store. Resolves once the backend was probed. */
  openStore(): Promise<PinnedDeviceStore>;
  /** Creates a relay client for a pinned device. */
  createRelayClient(device: PinnedDevice): RelayClient;
  /** Current time in milliseconds. */
  now(): number;
  /**
   * Builds the backend the screens talk to. When absent, the app uses the mock
   * backend with no demo computers on top of the opened store.
   */
  createApi?(store: PinnedDeviceStore): AgentikApi;
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

export function createDefaultServices(search: string = window.location.search): AppServices {
  const runtime = createTelegramRuntime();
  const scenario: ScenarioName = readScenario(search);
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
    createRelayClient: (device) => {
      const deviceId = decodeBase32(device.deviceId);
      if (deviceId === null) throw new Error("pinned device id is not valid");
      return new RelayClient({
        relayUrl: device.relayUrl,
        deviceId,
        deviceIdText: device.deviceId,
      });
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
          const opened = storageFromPersistence(store);
          return { ...opened, secureStorage, deviceStorage };
        },
      }),
  };
}
