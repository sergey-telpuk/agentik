import { useEffect, useRef, useState } from "react";
import { decodeBase32, decodeBase64Url } from "../encoding";
import { AgentikRpcClient } from "../protocol/client";
import type { DeviceInfoResult } from "../protocol/messages";
import type { RelayClient, RelayStatus } from "../relay/client";
import type { NoiseKeyPair } from "../secure/noise";
import type { SecureSession } from "../secure/seam";
import type { AppServices } from "../services";
import type { PinnedDevice } from "../storage/pinnedDevices";
import { readRawInitData, sendInitDataVerification } from "../telegram/initData";

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

type HandshakeState =
  | { readonly epoch: number; readonly kind: "authenticated"; readonly info: DeviceInfoResult | null }
  | { readonly epoch: number; readonly kind: "error"; readonly message: string };

export function StatusScreen({ services, device, onBack }: Props) {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [identity, setIdentity] = useState<NoiseKeyPair | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [handshake, setHandshake] = useState<HandshakeState | null>(null);
  const [initDataSentEpoch, setInitDataSentEpoch] = useState<number | null>(null);
  const clientRef = useRef<RelayClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    void services.openIdentityStore().then(async (idStore) => {
      if (cancelled) return;
      const loaded = await idStore.getOrCreate();
      if (cancelled) return;
      if (!loaded.ok) {
        setIdentityError(loaded.message);
        return;
      }
      setIdentity(loaded.value);
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    const client = services.createRelayClient(device);
    clientRef.current = client;
    const off = client.onStatus(setStatus);
    client.start();
    return () => {
      off();
      client.stop();
      clientRef.current = null;
    };
  }, [services, device]);

  const peerEpoch = status?.peerEpoch ?? 0;
  const readyForHandshake =
    identity !== null &&
    status?.state === "connected" &&
    status.devicePresent === true &&
    peerEpoch > 0;

  useEffect(() => {
    const client = clientRef.current;
    if (!readyForHandshake || client === null || identity === null) {
      return;
    }

    const deviceId = decodeBase32(device.deviceId);
    const pinnedNoise = decodeBase64Url(device.noisePublicKey);
    if (deviceId === null || pinnedNoise === null) {
      return;
    }

    const ac = new AbortController();
    let activeSession: SecureSession | null = null;
    let activeRpc: AgentikRpcClient | null = null;
    const epoch = peerEpoch;

    void services.secureChannel
      .open({
        transport: client,
        deviceId,
        pinnedNoisePublicKey: pinnedNoise,
        clientStaticPrivateKey: identity.privateKey,
        signal: ac.signal,
      })
      .then(async (session) => {
        if (ac.signal.aborted) {
          session.close();
          return;
        }
        activeSession = session;
        activeRpc = new AgentikRpcClient(session);
        setHandshake({ epoch, kind: "authenticated", info: null });

        const rawInit = readRawInitData(services.runtime);
        if (rawInit.ok) {
          sendInitDataVerification(session, rawInit.rawInitData);
          setInitDataSentEpoch(epoch);
        }

        try {
          const info = await activeRpc.deviceInfo();
          if (!ac.signal.aborted) {
            setHandshake({ epoch, kind: "authenticated", info });
          }
        } catch {
          // Device info may fail or remain pending while pairing/info settles.
        }
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setHandshake({
          epoch,
          kind: "error",
          message: err instanceof Error ? err.message : "Noise handshake failed",
        });
      });

    return () => {
      ac.abort();
      activeRpc?.close();
      activeSession?.close();
    };
  }, [services, device, identity, readyForHandshake, peerEpoch]);

  const initData = readRawInitData(services.runtime);
  const activeHandshake =
    readyForHandshake && handshake !== null && handshake.epoch === peerEpoch ? handshake : null;
  const initDataSent = readyForHandshake && initDataSentEpoch === peerEpoch;

  function renderSecureText(): string {
    if (identityError !== null) return `unavailable (${identityError})`;
    if (identity === null) return "loading phone identity…";
    if (decodeBase32(device.deviceId) === null || decodeBase64Url(device.noisePublicKey) === null) {
      return "failed (pinned device key material is invalid)";
    }
    if (!readyForHandshake) return "waiting for relay and computer";
    if (activeHandshake === null) return "handshaking (Noise XX, verifying pinned key…)";
    if (activeHandshake.kind === "error") return `failed (${activeHandshake.message})`;
    if (activeHandshake.info !== null) {
      return `encrypted (Noise XX, key verified, ${activeHandshake.info.pairing_state})`;
    }
    return "encrypted (Noise XX, key verified)";
  }

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
        <li>Secure channel: {renderSecureText()}</li>
        <li>
          Telegram identity:{" "}
          {initData.ok
            ? initDataSent
              ? "sent over Noise session for verification"
              : "available, pending Noise session"
            : `not available (${initData.reason})`}
        </li>
      </ul>
      <button type="button" onClick={onBack}>
        Back
      </button>
    </section>
  );
}
