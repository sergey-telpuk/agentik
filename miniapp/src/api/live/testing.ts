/**
 * Test doubles for the live backend: a relay socket that attaches, a daemon
 * that answers inner-protocol requests, and the same daemon behind a real
 * Noise XX responder. Not part of the application bundle.
 */

import type { NoiseCipherState, NoiseHandshakeState } from "@richardhopton/noise-c.wasm";
import { decodeBase32, decodeBase64, encodeBase64 } from "../../encoding";
import { RelayClient, type WebSocketLike } from "../../relay/client";
import { devicePrologue, loadFreshNoiseRuntime, NOISE_PROTOCOL_NAME, type NoiseKeyPair } from "../../secure/noise";
import type { SecureChannelFactory, SecureSession } from "../../secure/seam";
import type { PinnedDevice } from "../../storage/pinnedDevices";

export class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(readonly onSend: (msg: Record<string, unknown>) => void) {}

  send(data: string): void {
    this.onSend(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

export interface RpcFrame {
  readonly request_id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** What the fake computer answers; `undefined` drops the request. */
export type DaemonReply = { readonly result: unknown } | { readonly error: { code: string; message: string } } | undefined;

export type DaemonHandler = (frame: RpcFrame) => DaemonReply;

function responseFor(frame: RpcFrame, reply: Exclude<DaemonReply, undefined>): unknown {
  return "result" in reply
    ? { v: 1, type: "response", request_id: frame.request_id, ok: true, result: reply.result }
    : { v: 1, type: "response", request_id: frame.request_id, ok: false, error: reply.error };
}

export function sessionEvent(data: Record<string, unknown>): unknown {
  return { v: 1, type: "event", event: "session.event", data };
}

export interface RelayHarness {
  readonly createRelayClient: (device: PinnedDevice) => RelayClient;
  /** Sockets in creation order; the last one is current. */
  readonly sockets: FakeSocket[];
  /** Every opaque frame the phone sent, exactly as the relay saw it. */
  readonly frames: Uint8Array[];
  /** Simulates the computer leaving or (re)joining the relay. */
  peerState(present: boolean): void;
}

/**
 * A relay that attaches every socket, reporting `devicePresent`. `onFrame`
 * sees each outbound opaque frame; `socket.receive` delivers inbound ones.
 */
export function attachingRelay(
  options: {
    readonly devicePresent?: boolean;
    readonly onFrame?: (frame: Uint8Array, socket: FakeSocket) => void;
    readonly onSocket?: (socket: FakeSocket) => void;
  } = {},
): RelayHarness {
  const sockets: FakeSocket[] = [];
  const frames: Uint8Array[] = [];
  return {
    sockets,
    frames,
    createRelayClient: (device) => {
      const deviceId = decodeBase32(device.deviceId);
      if (deviceId === null) throw new Error("invalid device id");
      return new RelayClient({
        relayUrl: device.relayUrl,
        deviceId,
        deviceIdText: device.deviceId,
        keepaliveIntervalMs: 0,
        createSocket: () => {
          const socket: FakeSocket = new FakeSocket((outbound) => {
            if (outbound["type"] === "attach") {
              queueMicrotask(() =>
                socket.receive({
                  type: "attached",
                  connectionId: "0123456789abcdef0123456789abcdef",
                  devicePresent: options.devicePresent ?? true,
                }),
              );
              return;
            }
            if (outbound["type"] === "frame" && typeof outbound["data"] === "string") {
              const raw = decodeBase64(outbound["data"]);
              if (raw === null) return;
              frames.push(raw);
              options.onFrame?.(raw, socket);
            }
          });
          sockets.push(socket);
          options.onSocket?.(socket);
          queueMicrotask(() => socket.onopen?.({}));
          return socket;
        },
      });
    },
    peerState: (present) => {
      sockets.at(-1)?.receive({ type: "peer_state", present });
    },
  };
}

export interface PlainDaemon {
  /** Secure channel that skips Noise and talks to `handler` directly. */
  readonly secureChannel: SecureChannelFactory;
  /** Every request, in order, across all sessions. */
  readonly requests: RpcFrame[];
  /** Requests per opened session. */
  readonly sessions: RpcFrame[][];
  /** Delivers a server message to the newest session. */
  push(message: unknown): void;
}

/** An in-memory computer for protocol-level tests; the relay only signals presence. */
export function plainDaemon(handler: DaemonHandler): PlainDaemon {
  const requests: RpcFrame[] = [];
  const sessions: RpcFrame[][] = [];
  let deliver: ((message: unknown) => void) | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    requests,
    sessions,
    push: (message) => deliver?.(message),
    secureChannel: {
      open: () => {
        const handlers = new Set<(pt: Uint8Array) => void>();
        const mine: RpcFrame[] = [];
        sessions.push(mine);
        let closed = false;
        const send = (message: unknown): void => {
          if (closed) return;
          const bytes = encoder.encode(JSON.stringify(message));
          for (const h of handlers) h(bytes);
        };
        deliver = send;
        const session: SecureSession = {
          send: (pt) => {
            const frame = JSON.parse(decoder.decode(pt)) as RpcFrame;
            requests.push(frame);
            mine.push(frame);
            const reply = handler(frame);
            if (reply !== undefined) queueMicrotask(() => send(responseFor(frame, reply)));
          },
          onMessage: (h) => {
            handlers.add(h);
            return () => handlers.delete(h);
          },
          close: () => {
            closed = true;
            handlers.clear();
          },
        };
        return Promise.resolve(session);
      },
    },
  };
}

export interface NoiseDaemon {
  readonly relay: RelayHarness;
  /** Decrypted requests, in order. */
  readonly requests: RpcFrame[];
  /** Encrypts a server message for the current session. */
  push(message: unknown): void;
  dispose(): void;
}

/** The fake computer behind a real Noise XX responder holding `keys`. */
export async function noiseDaemon(deviceIdText: string, keys: NoiseKeyPair, handler: DaemonHandler): Promise<NoiseDaemon> {
  const deviceId = decodeBase32(deviceIdText);
  if (deviceId === null) throw new Error("invalid device id");
  const noise = await loadFreshNoiseRuntime();
  const requests: RpcFrame[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  interface Peer {
    hs: NoiseHandshakeState | null;
    step: number;
    send: NoiseCipherState | null;
    recv: NoiseCipherState | null;
  }
  const peers = new Map<FakeSocket, Peer>();
  let latest: FakeSocket | null = null;

  const encryptTo = (socket: FakeSocket, message: unknown): void => {
    const peer = peers.get(socket);
    if (peer?.send == null) return;
    const ct = peer.send.EncryptWithAd(new Uint8Array(0), encoder.encode(JSON.stringify(message)));
    queueMicrotask(() => socket.receive({ type: "frame", data: encodeBase64(ct) }));
  };

  const relay = attachingRelay({
    onSocket: (socket) => {
      const hs = new noise.HandshakeState(NOISE_PROTOCOL_NAME, noise.constants.NOISE_ROLE_RESPONDER);
      hs.Initialize(devicePrologue(deviceId), keys.privateKey, null, null);
      peers.set(socket, { hs, step: 1, send: null, recv: null });
      latest = socket;
    },
    onFrame: (raw, socket) => {
      const peer = peers.get(socket);
      if (peer === undefined) return;
      if (peer.step === 1 && peer.hs !== null) {
        peer.hs.ReadMessage(raw, false, false);
        peer.step = 3;
        const msg2 = peer.hs.WriteMessage(null);
        queueMicrotask(() => socket.receive({ type: "frame", data: encodeBase64(msg2) }));
      } else if (peer.step === 3 && peer.hs !== null) {
        try {
          peer.hs.ReadMessage(raw, false, false);
        } catch {
          return;
        }
        const [send, recv] = peer.hs.Split();
        peer.send = send;
        peer.recv = recv;
        peer.hs = null;
        peer.step = 4;
      } else if (peer.recv !== null) {
        const frame = JSON.parse(decoder.decode(peer.recv.DecryptWithAd(new Uint8Array(0), raw))) as RpcFrame;
        requests.push(frame);
        const reply = handler(frame);
        if (reply !== undefined) encryptTo(socket, responseFor(frame, reply));
      }
    },
  });

  return {
    relay,
    requests,
    push: (message) => {
      if (latest !== null) encryptTo(latest, message);
    },
    dispose: () => {
      for (const peer of peers.values()) {
        peer.send?.free();
        peer.recv?.free();
      }
      peers.clear();
    },
  };
}
