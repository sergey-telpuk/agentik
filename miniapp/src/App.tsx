import { useCallback, useEffect, useState } from "react";
import { createDefaultServices, type AppServices } from "./services";
import type { PinnedDevice, PinnedDeviceStore } from "./storage/pinnedDevices";
import { DeviceListScreen } from "./ui/DeviceListScreen";
import { PairScreen, type PendingPairingCredentials } from "./ui/PairScreen";
import { StatusScreen } from "./ui/StatusScreen";

type Screen =
  | { readonly name: "devices" }
  | { readonly name: "pair" }
  | { readonly name: "status"; readonly device: PinnedDevice };

interface Props {
  /** Replaceable for tests; defaults to the real Telegram-backed services. */
  readonly services?: AppServices;
}

export function App({ services: provided }: Props) {
  // Created lazily and once: building the Telegram runtime touches the
  // environment, which must not happen at import time.
  const [services] = useState<AppServices>(() => provided ?? createDefaultServices());
  const [store, setStore] = useState<PinnedDeviceStore | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: "devices" });
  const [refreshKey, setRefreshKey] = useState(0);
  // Ephemeral one-time pairing credentials (id + secret) stay strictly in
  // memory until submitted/confirmed; never written to persistent storage.
  const [pendingPairingByDevice, setPendingPairingByDevice] = useState<
    Readonly<Record<string, PendingPairingCredentials>>
  >({});

  useEffect(() => {
    let cancelled = false;
    void services.openStore().then((opened) => {
      if (!cancelled) setStore(opened);
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  const handleClearPendingPairing = useCallback((deviceId: string) => {
    setPendingPairingByDevice((prev) => {
      if (!(deviceId in prev)) return prev;
      const next = { ...prev };
      delete next[deviceId];
      return next;
    });
  }, []);

  const handleConfirmed = useCallback((confirmed: PinnedDevice) => {
    setRefreshKey((n) => n + 1);
    setScreen((prev) =>
      prev.name === "status" && prev.device.deviceId === confirmed.deviceId
        ? { name: "status", device: confirmed }
        : prev,
    );
  }, []);

  return (
    <main>
      <h1>Agentik</h1>
      {store === null ? (
        <p>Starting…</p>
      ) : screen.name === "pair" ? (
        <PairScreen
          services={services}
          store={store}
          onPinned={(pinnedDevice, pending) => {
            setPendingPairingByDevice((prev) => ({ ...prev, [pinnedDevice.deviceId]: pending }));
            setRefreshKey((n) => n + 1);
            setScreen({ name: "devices" });
          }}
          onCancel={() => setScreen({ name: "devices" })}
        />
      ) : screen.name === "status" ? (
        <StatusScreen
          services={services}
          device={screen.device}
          store={store}
          pendingPairing={pendingPairingByDevice[screen.device.deviceId] ?? null}
          onConfirmed={handleConfirmed}
          onClearPendingPairing={handleClearPendingPairing}
          onBack={() => setScreen({ name: "devices" })}
        />
      ) : (
        <DeviceListScreen
          store={store}
          refreshKey={refreshKey}
          onAdd={() => setScreen({ name: "pair" })}
          onOpen={(device) => setScreen({ name: "status", device })}
        />
      )}
    </main>
  );
}
