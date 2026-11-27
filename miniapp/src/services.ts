import { RelayClient } from "./relay/client";
import type { PinnedDevice } from "./storage/pinnedDevices";
import { PinnedDeviceStore } from "./storage/pinnedDevices";
import { createTelegramBackends } from "./storage/telegramBackends";
import { createTelegramRuntime, type TelegramRuntime } from "./telegram/runtime";
import { decodeBase32 } from "./encoding";

/** Everything the UI needs from the outside world, so tests can replace it. */
export interface AppServices {
  readonly runtime: TelegramRuntime;
  /** Opens the pinned-device store. Resolves once the backend was probed. */
  openStore(): Promise<PinnedDeviceStore>;
  /** Creates a relay client for a pinned device. */
  createRelayClient(device: PinnedDevice): RelayClient;
  /** Current time in milliseconds. */
  now(): number;
}

export function createDefaultServices(): AppServices {
  const runtime = createTelegramRuntime();
  return {
    runtime,
    openStore: () => PinnedDeviceStore.open(createTelegramBackends(runtime)),
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
  };
}
