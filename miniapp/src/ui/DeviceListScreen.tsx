import { useEffect, useState } from "react";
import type { PinnedDevice, PinnedDeviceStore } from "../storage/pinnedDevices";

interface Props {
  readonly store: PinnedDeviceStore;
  /** Bumped by the parent after the list may have changed. */
  readonly refreshKey: number;
  readonly onAdd: () => void;
  readonly onOpen: (device: PinnedDevice) => void;
}

type Listing =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly devices: PinnedDevice[] }
  | { readonly kind: "error"; readonly message: string };

export function DeviceListScreen({ store, refreshKey, onAdd, onOpen }: Props) {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void store.list().then((result) => {
      if (cancelled) return;
      setListing(
        result.ok ? { kind: "ready", devices: result.value } : { kind: "error", message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [store, refreshKey, reload]);

  async function forget(device: PinnedDevice): Promise<void> {
    await store.remove(device.deviceId);
    setReload((n) => n + 1);
  }

  const unsupported = store.persistence.status === "unsupported";

  return (
    <section>
      <h2>Computers</h2>
      {store.persistence.status === "unsupported" && (
        <p role="alert">
          Persistent access is not supported on this device. {store.persistence.reason}. Paired computers cannot be
          saved here, and nothing is written to ordinary browser storage.
        </p>
      )}
      {listing.kind === "loading" && <p>Loading…</p>}
      {listing.kind === "error" && <p role="alert">{listing.message}</p>}
      {listing.kind === "ready" && listing.devices.length === 0 && <p>No computers paired yet.</p>}
      {listing.kind === "ready" && (
        <ul>
          {listing.devices.map((device) => (
            <li key={device.deviceId}>
              <code>{device.deviceId.slice(0, 12)}…</code> via {device.relayUrl} (
              {device.state === "confirmed" ? "confirmed" : "pending confirmation"}){" "}
              <button type="button" onClick={() => onOpen(device)}>
                Connection status
              </button>{" "}
              <button type="button" onClick={() => void forget(device)}>
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onAdd} disabled={unsupported}>
        Connect a computer
      </button>
    </section>
  );
}
