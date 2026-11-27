import { useEffect, useState } from "react";
import { createDefaultServices, type AppServices } from "./services";
import type { PinnedDevice, PinnedDeviceStore } from "./storage/pinnedDevices";
import { DeviceListScreen } from "./ui/DeviceListScreen";
import { PairScreen } from "./ui/PairScreen";
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

  useEffect(() => {
    let cancelled = false;
    void services.openStore().then((opened) => {
      if (!cancelled) setStore(opened);
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  return (
    <main>
      <h1>Agentik</h1>
      {store === null ? (
        <p>Starting…</p>
      ) : screen.name === "pair" ? (
        <PairScreen
          services={services}
          store={store}
          onPinned={() => {
            setRefreshKey((n) => n + 1);
            setScreen({ name: "devices" });
          }}
          onCancel={() => setScreen({ name: "devices" })}
        />
      ) : screen.name === "status" ? (
        <StatusScreen services={services} device={screen.device} onBack={() => setScreen({ name: "devices" })} />
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
