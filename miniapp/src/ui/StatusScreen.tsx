import { useEffect, useState } from "react";
import type { RelayStatus } from "../relay/client";
import type { AppServices } from "../services";
import type { PinnedDevice } from "../storage/pinnedDevices";
import { readRawInitData } from "../telegram/initData";

interface Props {
  readonly services: AppServices;
  readonly device: PinnedDevice;
  readonly onBack: () => void;
}

const STATE_TEXT: Record<RelayStatus["state"], string> = {
  stopped: "Stopped",
  connecting: "Connecting to the relay…",
  connected: "Connected to the relay",
  reconnecting: "Connection lost, retrying",
  failed: "The relay rejected this client",
};

export function StatusScreen({ services, device, onBack }: Props) {
  const [status, setStatus] = useState<RelayStatus | null>(null);

  useEffect(() => {
    const client = services.createRelayClient(device);
    const off = client.onStatus(setStatus);
    client.start();
    return () => {
      off();
      client.stop();
    };
  }, [services, device]);

  const initData = readRawInitData(services.runtime);

  return (
    <section>
      <h2>Connection status</h2>
      <p>
        Computer <code>{device.deviceId}</code>
      </p>
      <ul>
        <li>Relay: {status === null ? "Starting…" : STATE_TEXT[status.state]}</li>
        {status !== null && status.state === "connected" && (
          <li>Computer online: {status.devicePresent === null ? "unknown" : status.devicePresent ? "yes" : "no"}</li>
        )}
        {status !== null && status.state === "reconnecting" && (
          <li>
            Attempt {status.attempt}, next retry in {Math.ceil((status.nextRetryInMs ?? 0) / 1000)} s
          </li>
        )}
        {status?.lastError != null && <li>Last relay error: {status.lastError}</li>}
        <li>Secure channel: not available yet (end-to-end encryption is not implemented in this build)</li>
        <li>
          Telegram identity:{" "}
          {initData.ok
            ? "available, will be sent to your computer once the secure channel exists"
            : `not available (${initData.reason})`}
        </li>
      </ul>
      <button type="button" onClick={onBack}>
        Back
      </button>
    </section>
  );
}
