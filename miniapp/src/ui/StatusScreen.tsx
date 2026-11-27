import { useEffect, useRef, useState } from "react";
import { decodeBase32, decodeBase64Url } from "../encoding";
import { AgentikRpcClient, RpcClientClosedError } from "../protocol/client";
import type { DeviceInfoResult } from "../protocol/messages";
import type { RelayClient, RelayStatus } from "../relay/client";
import type { NoiseKeyPair } from "../secure/noise";
import type { SecureSession } from "../secure/seam";
import type { AppServices } from "../services";
import type { PinnedDevice, PinnedDeviceStore } from "../storage/pinnedDevices";
import { readRawInitData, sendInitDataVerification } from "../telegram/initData";
import type { PendingPairingCredentials } from "./PairScreen";
import { TaskWorkspace } from "./TaskWorkspace";

interface Props {
  readonly services: AppServices;
  readonly device: PinnedDevice;
  readonly store?: PinnedDeviceStore;
  readonly pendingPairing?: PendingPairingCredentials | null;
  readonly onConfirmed?: (device: PinnedDevice) => void;
  readonly onClearPendingPairing?: (deviceId: string) => void;
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

type PairingUiState =
  | { readonly kind: "awaiting_local_approval"; readonly verificationCode?: string }
  | { readonly kind: "paired" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export function StatusScreen({
  services,
  device,
  store,
  pendingPairing = null,
  onConfirmed,
  onClearPendingPairing,
  onBack,
}: Props) {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [identity, setIdentity] = useState<NoiseKeyPair | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [handshake, setHandshake] = useState<HandshakeState | null>(null);
  const [activeRpc, setActiveRpc] = useState<{ readonly epoch: number; readonly rpc: AgentikRpcClient } | null>(null);
  const [initDataSentEpoch, setInitDataSentEpoch] = useState<number | null>(null);
  const [pairingUi, setPairingUi] = useState<PairingUiState | null>(null);

  const clientRef = useRef<RelayClient | null>(null);
  const deviceRef = useRef(device);
  const storeRef = useRef(store);
  const pendingPairingRef = useRef(pendingPairing);
  const onConfirmedRef = useRef(onConfirmed);
  const onClearPendingRef = useRef(onClearPendingPairing);

  useEffect(() => {
    deviceRef.current = device;
  }, [device]);

  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  useEffect(() => {
    pendingPairingRef.current = pendingPairing;
  }, [pendingPairing]);

  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
  }, [onConfirmed]);

  useEffect(() => {
    onClearPendingRef.current = onClearPendingPairing;
  }, [onClearPendingPairing]);

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
    const client = services.createRelayClient(deviceRef.current);
    clientRef.current = client;
    const off = client.onStatus(setStatus);
    client.start();
    return () => {
      off();
      client.stop();
      clientRef.current = null;
    };
  }, [services, device.deviceId, device.relayUrl, device.noisePublicKey]);

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

    const deviceIdText = device.deviceId;
    const deviceId = decodeBase32(deviceIdText);
    const pinnedNoise = decodeBase64Url(device.noisePublicKey);
    if (deviceId === null || pinnedNoise === null) {
      return;
    }

    const ac = new AbortController();
    let activeSession: SecureSession | null = null;
    let rpcClient: AgentikRpcClient | null = null;
    let offEvent: (() => void) | null = null;
    const epoch = peerEpoch;

    async function confirmLocalStore(): Promise<void> {
      const s = storeRef.current;
      if (s === undefined) return;
      const res = await s.markConfirmed(deviceIdText);
      if (!ac.signal.aborted && res.ok) {
        onConfirmedRef.current?.(res.value);
      }
    }

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
        rpcClient = new AgentikRpcClient(session);
        setActiveRpc({ epoch, rpc: rpcClient });
        setHandshake({ epoch, kind: "authenticated", info: null });

        offEvent = rpcClient.onEvent((ev) => {
          if (ev.event !== "pair.updated" || ac.signal.aborted) return;
          onClearPendingRef.current?.(deviceIdText);
          if (ev.data.state === "paired") {
            setPairingUi({ kind: "paired" });
            void confirmLocalStore();
            void rpcClient
              ?.deviceInfo()
              .then((updatedInfo) => {
                if (!ac.signal.aborted) {
                  setHandshake({ epoch, kind: "authenticated", info: updatedInfo });
                }
              })
              .catch(() => undefined);
          } else {
            setPairingUi({
              kind: "rejected",
              message: `Pairing ${ev.data.state} by the computer.`,
            });
          }
        });

        const rawInit = readRawInitData(services.runtime);
        if (rawInit.ok) {
          sendInitDataVerification(session, rawInit.rawInitData);
          setInitDataSentEpoch(epoch);
        }

        try {
          const info = await rpcClient.deviceInfo();
          if (ac.signal.aborted) return;
          setHandshake({ epoch, kind: "authenticated", info });

          if (info.paired) {
            onClearPendingRef.current?.(deviceIdText);
            setPairingUi({ kind: "paired" });
            if (deviceRef.current.state !== "confirmed") {
              await confirmLocalStore();
            }
            return;
          }

          if (info.pairing_state === "awaiting_local_approval") {
            setPairingUi({ kind: "awaiting_local_approval" });
            return;
          }

          const creds = pendingPairingRef.current;
          if (info.pairing_state === "unpaired" && creds !== null && creds.deviceId === deviceIdText) {
            try {
              const pairRes = await rpcClient.submitPairing(
                rawInit.ok
                  ? {
                      invitation_id: creds.invitationId,
                      invitation_secret: creds.invitationSecret,
                      init_data: rawInit.rawInitData,
                    }
                  : {
                      invitation_id: creds.invitationId,
                      invitation_secret: creds.invitationSecret,
                    },
              );
              if (ac.signal.aborted) return;
              if (pairRes.state === "paired") {
                onClearPendingRef.current?.(deviceIdText);
                setPairingUi({ kind: "paired" });
                await confirmLocalStore();
                const updatedInfo = await rpcClient.deviceInfo();
                if (!ac.signal.aborted) {
                  setHandshake({ epoch, kind: "authenticated", info: updatedInfo });
                }
              } else {
                setPairingUi(
                  pairRes.verification_code !== undefined
                    ? { kind: "awaiting_local_approval", verificationCode: pairRes.verification_code }
                    : { kind: "awaiting_local_approval" },
                );
              }
            } catch (pairErr) {
              if (ac.signal.aborted || pairErr instanceof RpcClientClosedError) return;
              onClearPendingRef.current?.(deviceIdText);
              setPairingUi({
                kind: "error",
                message: pairErr instanceof Error ? pairErr.message : "Pairing submission failed",
              });
            }
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
      offEvent?.();
      rpcClient?.close();
      activeSession?.close();
    };
  }, [services, device.deviceId, device.noisePublicKey, identity, readyForHandshake, peerEpoch]);

  const initData = readRawInitData(services.runtime);
  const activeHandshake =
    readyForHandshake && handshake !== null && handshake.epoch === peerEpoch ? handshake : null;
  const currentRpc =
    readyForHandshake && activeRpc !== null && activeRpc.epoch === peerEpoch ? activeRpc.rpc : null;
  const initDataSent = readyForHandshake && initDataSentEpoch === peerEpoch;

  const isPaired =
    activeHandshake?.kind === "authenticated" &&
    (activeHandshake.info?.paired === true || pairingUi?.kind === "paired");

  const pairingStateText =
    activeHandshake?.kind === "authenticated" ? activeHandshake.info?.pairing_state : undefined;

  function renderSecureText(): string {
    if (identityError !== null) return `unavailable (${identityError})`;
    if (identity === null) return "loading phone identity…";
    if (decodeBase32(device.deviceId) === null || decodeBase64Url(device.noisePublicKey) === null) {
      return "failed (pinned device key material is invalid)";
    }
    if (!readyForHandshake) return "waiting for relay and computer";
    if (activeHandshake === null) return "handshaking (Noise XX, verifying pinned key…)";
    if (activeHandshake.kind === "error") return `failed (${activeHandshake.message})`;
    if (pairingUi?.kind === "paired") {
      return "encrypted (Noise XX, key verified, paired)";
    }
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

      {pairingUi?.kind === "awaiting_local_approval" && (
        <div role="status">
          <p>
            <strong>Confirm this phone on your computer.</strong>
          </p>
          {pairingUi.verificationCode !== undefined && (
            <p>
              Verification fingerprint: <code>{pairingUi.verificationCode}</code>
            </p>
          )}
        </div>
      )}

      {pairingUi?.kind === "rejected" && <p role="alert">{pairingUi.message}</p>}
      {pairingUi?.kind === "error" && <p role="alert">{pairingUi.message}</p>}

      {!isPaired &&
        activeHandshake?.kind === "authenticated" &&
        pairingStateText === "unpaired" &&
        pairingUi === null &&
        pendingPairing?.deviceId !== device.deviceId && (
          <p role="alert">
            This phone is not paired with the computer yet. Create a fresh invitation on the computer and pair
            again.
          </p>
        )}

      {isPaired && <TaskWorkspace rpc={currentRpc} reconnectKey={peerEpoch} />}

      <p>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </p>
    </section>
  );
}
