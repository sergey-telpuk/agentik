/**
 * Test doubles for the live backend: a relay socket that attaches and carries
 * signaling only, a fake DataChannel link, a daemon that answers
 * inner-protocol requests, and the same daemon behind a real Noise XX
 * responder. Not part of the application bundle.
 */

import type { NoiseCipherState, NoiseHandshakeState } from "@richardhopton/noise-c.wasm";
import { decodeBase32, decodeBase64 } from "../../encoding";
import { RelayClient, type WebSocketLike } from "../../relay/client";
import { loadFreshNoiseRuntime, NOISE_PROTOCOL_NAME, type NoiseKeyPair } from "../../secure/noise";
import type { SecureChannelFactory, SecureSession } from "../../secure/seam";
import type { PinnedDevice } from "../../storage/pinnedDevices";
import { LinkError, type DataLink, type LinkErrorCode } from "../../webrtc/link";
import { webrtcPrologue } from "../../webrtc/prologue";
import type { OpenLink } from "./connection";

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

/** Fingerprints the fake link declares; the fake computer binds the same ones. */
export const TEST_PHONE_FINGERPRINT = new Uint8Array(32).fill(0xa1);
export const TEST_COMPUTER_FINGERPRINT = new Uint8Array(32).fill(0xb2);

/** What the fake `openLink` does. */
export type LinkBehavior =
  | { readonly kind: "open" }
  /** Rejects the way a failed negotiation does. */
  | { readonly kind: "fail"; readonly code: LinkErrorCode; readonly message: string }
  /** Never settles, like an ICE negotiation that is still going. */
  | { readonly kind: "hang" };

export interface SentSignal {
  readonly kind: string;
  readonly data: Uint8Array;
}

export interface FakeLink {
  /** Every opaque frame the phone sent on this link. */
  readonly frames: Uint8Array[];
  closed: boolean;
}

export interface RelayHarness {
  readonly createRelayClient: (device: PinnedDevice) => RelayClient;
  readonly openLink: OpenLink;
  /** Both of the above, for spreading into the API wiring. */
  readonly wiring: { readonly createRelayClient: (device: PinnedDevice) => RelayClient; readonly openLink: OpenLink };
  /** Sockets in creation order; the last one is current. */
  readonly sockets: FakeSocket[];
  /** Signaling payloads the phone sent through the relay, in order. */
  readonly signals: SentSignal[];
  /**
   * Anything the phone sent to the relay that is neither the attach nor a
   * signal. Application data must never show up here.
   */
  readonly strays: Record<string, unknown>[];
  /** Links opened so far, in order; the last one is current. */
  readonly links: FakeLink[];
  /** Every opaque frame the phone sent on any link. */
  readonly frames: Uint8Array[];
  /** Delivers a frame from the computer on the newest link. */
  deliver(frame: Uint8Array): void;
  /** The newest link goes away (the DataChannel closes). */
  drop(reason?: string): void;
  /** Simulates the computer leaving or (re)joining the relay. */
  peerState(present: boolean): void;
}

/**
 * A relay that attaches every socket, reporting `devicePresent`, and a link
 * opener that follows `link`. `onFrame` sees each frame the phone sends on the
 * link; `deliver` sends one back.
 */
export function attachingRelay(
  options: {
    readonly devicePresent?: boolean;
    readonly link?: LinkBehavior;
    readonly onFrame?: (frame: Uint8Array, linkIndex: number) => void;
    readonly onLink?: (linkIndex: number) => void;
  } = {},
): RelayHarness {
  const sockets: FakeSocket[] = [];
  const signals: SentSignal[] = [];
  const strays: Record<string, unknown>[] = [];
  const links: FakeLink[] = [];
  const frames: Uint8Array[] = [];
  const inbound: { handlers: Set<(frame: Uint8Array) => void>; closed: Set<(reason: string) => void> }[] = [];

  const createRelayClient = (device: PinnedDevice): RelayClient => {
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
          if (outbound["type"] === "signal" && typeof outbound["kind"] === "string" && typeof outbound["data"] === "string") {
            const data = decodeBase64(outbound["data"]);
            if (data !== null) signals.push({ kind: outbound["kind"], data });
            return;
          }
          strays.push(outbound);
        });
        sockets.push(socket);
        queueMicrotask(() => socket.onopen?.({}));
        return socket;
      },
    });
  };

  const openLink: OpenLink = ({ signaling, signal }) => {
    const behavior = options.link ?? { kind: "open" };
    // The offer goes out through the relay like a real negotiation's.
    signaling.send("offer", new TextEncoder().encode(JSON.stringify({ v: 1, sdp: "fake" })));
    if (behavior.kind === "fail") return Promise.reject(new LinkError(behavior.code, behavior.message));
    if (behavior.kind === "hang") {
      return new Promise<DataLink>((_, reject) => {
        signal.addEventListener("abort", () => reject(new LinkError("closed", "aborted")), { once: true });
      });
    }
    const index = links.length;
    const link: FakeLink = { frames: [], closed: false };
    links.push(link);
    const state = { handlers: new Set<(frame: Uint8Array) => void>(), closed: new Set<(reason: string) => void>() };
    inbound.push(state);
    options.onLink?.(index);
    const dataLink: DataLink = {
      localFingerprint: TEST_PHONE_FINGERPRINT,
      remoteFingerprint: TEST_COMPUTER_FINGERPRINT,
      transport: {
        sendFrame: (frame) => {
          if (link.closed) throw new LinkError("closed", "The data channel is not open.");
          const copy = frame.slice();
          link.frames.push(copy);
          frames.push(copy);
          options.onFrame?.(copy, index);
        },
        onFrame: (handler) => {
          state.handlers.add(handler);
          return () => state.handlers.delete(handler);
        },
      },
      onClosed: (handler) => {
        state.closed.add(handler);
        return () => state.closed.delete(handler);
      },
      close: () => {
        link.closed = true;
        state.handlers.clear();
        state.closed.clear();
      },
    };
    return Promise.resolve(dataLink);
  };

  return {
    createRelayClient,
    openLink,
    wiring: { createRelayClient, openLink },
    sockets,
    signals,
    strays,
    links,
    frames,
    deliver: (frame) => {
      const state = inbound.at(-1);
      if (state === undefined) return;
      for (const h of [...state.handlers]) h(frame);
    },
    drop: (reason = "test") => {
      const state = inbound.at(-1);
      const link = links.at(-1);
      if (state === undefined || link === undefined) return;
      link.closed = true;
      for (const h of [...state.closed]) h(reason);
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

/**
 * The fake computer behind a real Noise XX responder holding `keys`. It binds
 * the fingerprints the fake link declares; `computerFingerprintView` overrides
 * what the computer believes its own fingerprint is, to model a swapped one.
 */
export async function noiseDaemon(
  deviceIdText: string,
  keys: NoiseKeyPair,
  handler: DaemonHandler,
  options: { readonly computerFingerprintView?: Uint8Array; readonly link?: LinkBehavior } = {},
): Promise<NoiseDaemon> {
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
  const peers = new Map<number, Peer>();
  let relayRef: RelayHarness | null = null;

  const encryptTo = (index: number, message: unknown): void => {
    const peer = peers.get(index);
    if (peer?.send == null) return;
    const ct = peer.send.EncryptWithAd(new Uint8Array(0), encoder.encode(JSON.stringify(message)));
    queueMicrotask(() => relayRef?.deliver(ct));
  };

  const relay = attachingRelay({
    ...(options.link === undefined ? {} : { link: options.link }),
    onLink: (index) => {
      const hs = new noise.HandshakeState(NOISE_PROTOCOL_NAME, noise.constants.NOISE_ROLE_RESPONDER);
      const prologue = webrtcPrologue(deviceId, TEST_PHONE_FINGERPRINT, options.computerFingerprintView ?? TEST_COMPUTER_FINGERPRINT);
      hs.Initialize(prologue, keys.privateKey, null, null);
      peers.set(index, { hs, step: 1, send: null, recv: null });
    },
    onFrame: (raw, index) => {
      const peer = peers.get(index);
      if (peer === undefined) return;
      if (peer.step === 1 && peer.hs !== null) {
        try {
          peer.hs.ReadMessage(raw, false, false);
        } catch {
          return;
        }
        peer.step = 3;
        const msg2 = peer.hs.WriteMessage(null);
        queueMicrotask(() => relayRef?.deliver(msg2));
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
        if (reply !== undefined) encryptTo(index, responseFor(frame, reply));
      }
    },
  });
  relayRef = relay;

  return {
    relay,
    requests,
    push: (message) => {
      const index = relay.links.length - 1;
      if (index >= 0) encryptTo(index, message);
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
