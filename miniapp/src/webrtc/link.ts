/**
 * The phone's side of the WebRTC data path: opens one reliable, ordered
 * RTCDataChannel to the computer and exposes it as a `FrameTransport` for the
 * Noise session.
 *
 * The relay only carries the SDP offer and answer, ICE candidates and the
 * computer's ICE server list (see `Signaling`). If the channel cannot open,
 * `openDataChannelLink` rejects with a `LinkError` that says why; it never
 * reaches for another transport. Application frames exist only on the
 * DataChannel.
 */

import type { FrameTransport } from "../relay/frame-transport";
import { MAX_FRAME_BYTES } from "../relay/frame-transport";
import { extractFingerprint } from "./fingerprint";
import {
  DATA_CHANNEL_LABEL,
  decodeIceCandidate,
  decodeIceServers,
  decodeSdp,
  encodeIceCandidate,
  encodeSdp,
  type IceServerConfig,
  type Signaling,
} from "./signaling";

export type LinkErrorCode =
  /** No RTCPeerConnection in this WebView. */
  | "unsupported"
  /** ICE failed: no candidate pair could be established. */
  | "ice_failed"
  /** The channel did not open in time. */
  | "timeout"
  /** The channel or connection closed (or the attempt was aborted). */
  | "closed"
  /** The relay could not carry the signaling. */
  | "signaling"
  /** The computer's answer was unusable. */
  | "protocol";

export class LinkError extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

/** An open DataChannel with the fingerprints both ends declared in the SDP. */
export interface DataLink {
  readonly transport: FrameTransport;
  /** The phone's DTLS fingerprint (from its offer). */
  readonly localFingerprint: Uint8Array;
  /** The computer's DTLS fingerprint (from its answer). */
  readonly remoteFingerprint: Uint8Array;
  /** Called once when the channel or the connection goes away. */
  onClosed(handler: (reason: string) => void): () => void;
  close(): void;
}

export interface OpenLinkOptions {
  readonly signaling: Signaling;
  readonly createPeerConnection: (config: RTCConfiguration) => RTCPeerConnection;
  /** Static STUN servers from the build configuration. */
  readonly extraIceServers?: readonly IceServerConfig[];
  /** How long to wait for the computer's `ice_servers` before offering anyway. */
  readonly iceServersWaitMs: number;
  /** How long the whole negotiation may take. */
  readonly connectTimeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Outbound data is refused beyond this much queued data: the peer is not draining. */
const MAX_BUFFERED_BYTES = 256 * 1024;

const ICE_FAILED_MESSAGE =
  "ICE failed: no candidate pair could be established between this phone and the computer. " +
  "If the two networks do not allow a direct path, the computer needs a reachable TURN server.";

export async function openDataChannelLink(options: OpenLinkOptions): Promise<DataLink> {
  const { signaling, signal } = options;
  if (signal?.aborted) throw new LinkError("closed", "The connection attempt was cancelled.");

  const cleanups: (() => void)[] = [];
  let pc: RTCPeerConnection | null = null;
  let settled = false;
  let linkClosedHandlers: ((reason: string) => void)[] = [];
  let closedReason: string | null = null;

  const closeAll = (): void => {
    for (const c of cleanups.splice(0)) c();
    if (pc !== null) {
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
  };

  return new Promise<DataLink>((resolve, reject) => {
    const fail = (err: LinkError): void => {
      if (settled) {
        // After the channel opened, a failure is a closure.
        notifyClosed(err.message);
        return;
      }
      settled = true;
      closeAll();
      reject(err);
    };
    const notifyClosed = (reason: string): void => {
      if (closedReason !== null) return;
      closedReason = reason;
      const handlers = linkClosedHandlers;
      linkClosedHandlers = [];
      closeAll();
      for (const h of handlers) h(reason);
    };

    const onAbort = (): void => fail(new LinkError("closed", "The connection attempt was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => signal?.removeEventListener("abort", onAbort));

    const timeout = setTimeout(() => {
      fail(
        new LinkError(
          "timeout",
          `The data channel did not open within ${Math.round(options.connectTimeoutMs / 1000)} s (no candidate pair). ` +
            "If the two networks do not allow a direct path, the computer needs a reachable TURN server.",
        ),
      );
    }, options.connectTimeoutMs);
    cleanups.push(() => clearTimeout(timeout));

    void (async () => {
      // 1. The computer's ICE servers (TURN credentials), if it sends any.
      let advertised: IceServerConfig[] = [];
      let remoteReady = false;
      let remoteFingerprint: Uint8Array | null = null;
      const pendingCandidates: RTCIceCandidateInit[] = [];
      let answerHandler: ((sdp: string) => void) | null = null;
      let iceServersArrived: (() => void) | null = null;
      let gotIceServers = false;

      const off = signaling.onSignal((kind, data) => {
        if (settled) return;
        if (kind === "ice_servers") {
          const servers = decodeIceServers(data);
          if (servers !== null) advertised = servers;
          gotIceServers = true;
          iceServersArrived?.();
        } else if (kind === "answer") {
          const sdp = decodeSdp(data);
          if (sdp === null) fail(new LinkError("protocol", "The computer sent an unreadable answer."));
          else answerHandler?.(sdp);
        } else if (kind === "ice") {
          const candidate = decodeIceCandidate(data);
          if (candidate === null) return;
          if (!remoteReady || pc === null) pendingCandidates.push(candidate);
          else void pc.addIceCandidate(candidate).catch(() => undefined);
        }
      });
      cleanups.push(off);

      if (options.iceServersWaitMs > 0 && !gotIceServers) {
        await new Promise<void>((done) => {
          const t = setTimeout(done, options.iceServersWaitMs);
          iceServersArrived = () => {
            clearTimeout(t);
            done();
          };
          cleanups.push(() => clearTimeout(t));
        });
      }
      if (settled) return;

      // 2. The connection, the channel, the offer.
      const iceServers: RTCIceServer[] = [...(options.extraIceServers ?? []), ...advertised].map((s) => {
        const server: RTCIceServer = { urls: [...s.urls] };
        if (s.username !== undefined) server.username = s.username;
        if (s.credential !== undefined) server.credential = s.credential;
        return server;
      });
      try {
        pc = options.createPeerConnection({ iceServers });
      } catch (err) {
        fail(new LinkError("unsupported", `The connection could not be created: ${messageOf(err)}`));
        return;
      }
      const peer = pc;
      const channel = peer.createDataChannel(DATA_CHANNEL_LABEL);
      channel.binaryType = "arraybuffer";

      let offerSent = false;
      const queuedOutbound: RTCIceCandidateInit[] = [];
      const sendCandidate = (c: RTCIceCandidateInit): void => {
        try {
          signaling.send("ice", encodeIceCandidate(c));
        } catch (err) {
          fail(new LinkError("signaling", `The relay could not carry the signaling: ${messageOf(err)}`));
        }
      };
      peer.onicecandidate = (event) => {
        if (event.candidate === null) return;
        const init = event.candidate.toJSON();
        if (offerSent) sendCandidate(init);
        else queuedOutbound.push(init);
      };
      peer.oniceconnectionstatechange = () => {
        if (peer.iceConnectionState === "failed") fail(new LinkError("ice_failed", ICE_FAILED_MESSAGE));
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") fail(new LinkError("ice_failed", ICE_FAILED_MESSAGE));
        else if (peer.connectionState === "closed") fail(new LinkError("closed", "The connection closed."));
      };

      const frameHandlers = new Set<(frame: Uint8Array) => void>();
      channel.onmessage = (event: MessageEvent) => {
        // The computer only ever sends binary frames; anything else is dropped.
        if (!(event.data instanceof ArrayBuffer)) return;
        if (event.data.byteLength === 0 || event.data.byteLength > MAX_FRAME_BYTES) return;
        const frame = new Uint8Array(event.data);
        for (const h of frameHandlers) h(frame);
      };
      channel.onclose = () => fail(new LinkError("closed", "The data channel closed."));
      channel.onerror = () => undefined; // followed by close

      let localFingerprint: Uint8Array;
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (settled) return;
        const sdp = peer.localDescription?.sdp ?? offer.sdp ?? "";
        localFingerprint = extractFingerprint(sdp);
        offerSent = true;
        signaling.send("offer", encodeSdp(sdp));
        for (const c of queuedOutbound.splice(0)) sendCandidate(c);
      } catch (err) {
        fail(new LinkError("signaling", `The offer could not be sent: ${messageOf(err)}`));
        return;
      }

      // 3. The answer, then the channel opening.
      answerHandler = (sdp) => {
        void (async () => {
          try {
            remoteFingerprint = extractFingerprint(sdp);
            await peer.setRemoteDescription({ type: "answer", sdp });
            remoteReady = true;
            for (const c of pendingCandidates.splice(0)) await peer.addIceCandidate(c).catch(() => undefined);
          } catch (err) {
            fail(new LinkError("protocol", `The computer's answer was refused: ${messageOf(err)}`));
          }
        })();
      };

      channel.onopen = () => {
        if (settled) return;
        if (remoteFingerprint === null) {
          fail(new LinkError("protocol", "The data channel opened without a usable answer."));
          return;
        }
        settled = true;
        clearTimeout(timeout);
        off(); // no more signaling is needed or read once the channel is open
        const link: DataLink = {
          localFingerprint,
          remoteFingerprint,
          transport: {
            sendFrame: (frame) => {
              if (closedReason !== null || channel.readyState !== "open") throw new LinkError("closed", "The data channel is not open.");
              if (frame.length === 0) throw new Error("Frame is empty");
              if (frame.length > MAX_FRAME_BYTES) throw new Error(`Frame exceeds the ${MAX_FRAME_BYTES}-byte limit`);
              if (channel.bufferedAmount > MAX_BUFFERED_BYTES) {
                throw new LinkError("closed", "The computer is not draining the data channel.");
              }
              channel.send(frame as Uint8Array<ArrayBuffer>);
            },
            onFrame: (handler) => {
              frameHandlers.add(handler);
              return () => frameHandlers.delete(handler);
            },
          },
          onClosed: (handler) => {
            if (closedReason !== null) {
              queueMicrotask(() => handler(closedReason ?? ""));
              return () => undefined;
            }
            linkClosedHandlers.push(handler);
            return () => {
              linkClosedHandlers = linkClosedHandlers.filter((h) => h !== handler);
            };
          },
          close: () => {
            if (closedReason === null) closedReason = "closed by this phone";
            linkClosedHandlers = [];
            frameHandlers.clear();
            closeAll();
          },
        };
        resolve(link);
      };
    })();
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
