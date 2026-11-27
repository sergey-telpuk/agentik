import { decodeBase32 } from "./encoding";
import { RelayClient } from "./relay/client";
import { noiseChannelFactory } from "./secure/noise";
import type { SecureChannelFactory } from "./secure/seam";
import { PhoneIdentityStore } from "./storage/phoneIdentity";
import type { PinnedDevice } from "./storage/pinnedDevices";
import { PinnedDeviceStore } from "./storage/pinnedDevices";
import { createTelegramBackends } from "./storage/telegramBackends";
import { createTelegramRuntime, type TelegramRuntime } from "./telegram/runtime";

/** Everything the UI needs from the outside world, so tests can replace it. */
export interface AppServices {
  readonly runtime: TelegramRuntime;
  /** Opens the pinned-device store. Resolves once the backend was probed. */
  openStore(): Promise<PinnedDeviceStore>;
  /** Opens the phone's own Noise static key store. */
  openIdentityStore(): Promise<PhoneIdentityStore>;
  /** Creates a relay client for a pinned device. */
  createRelayClient(device: PinnedDevice): RelayClient;
  /** Establishes authenticated Noise sessions over a FrameTransport. */
  readonly secureChannel: SecureChannelFactory;
  /** Current time in milliseconds. */
  now(): number;
}

export function createDefaultServices(): AppServices {
  const runtime = createTelegramRuntime();
  return {
    runtime,
    openStore: () => PinnedDeviceStore.open(createTelegramBackends(runtime)),
    openIdentityStore: () => PhoneIdentityStore.open(createTelegramBackends(runtime)),
    createRelayClient: (device) => {
      const deviceId = decodeBase32(device.deviceId);
      if (deviceId === null) throw new Error("pinned device id is not valid");
      return new RelayClient({
        relayUrl: device.relayUrl,
        deviceId,
        deviceIdText: device.deviceId,
      });
    },
    secureChannel: noiseChannelFactory,
    now: () => Date.now(),
  };
}
