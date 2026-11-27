/**
 * Test doubles for the WebRTC link: an RTCPeerConnection and an RTCDataChannel
 * a test drives by hand, and a signaling channel it can read and feed. Not
 * part of the application bundle.
 */

import type { SignalKind } from "../relay/client";
import type { Signaling } from "./signaling";

/** `a=fingerprint` text for a 32-byte value made of one repeated byte. */
export function fingerprintText(byte: number): string {
  const hex = byte.toString(16).padStart(2, "0").toUpperCase();
  return Array.from({ length: 32 }, () => hex).join(":");
}

export function sdpWithFingerprint(byte: number): string {
  return `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${fingerprintText(byte)}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;
}

export class FakeDataChannel {
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  binaryType = "blob";
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly label: string) {}

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  // -- test controls --
  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }
  close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
}

export class FakePeerConnection {
  iceConnectionState = "new";
  connectionState = "new";
  onicecandidate: ((event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  channel: FakeDataChannel | null = null;
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  closed = false;

  constructor(
    readonly config: RTCConfiguration,
    /** Byte the phone's own (fake) DTLS fingerprint is made of. */
    readonly fingerprintByte = 0xa1,
  ) {}

  createDataChannel(label: string): FakeDataChannel {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  }
  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "offer", sdp: sdpWithFingerprint(this.fingerprintByte) });
  }
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { type: String(description.type), sdp: description.sdp ?? "" };
    return Promise.resolve();
  }
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = { type: String(description.type), sdp: description.sdp ?? "" };
    return Promise.resolve();
  }
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
    if (this.channel !== null && this.channel.readyState !== "closed") this.channel.readyState = "closed";
  }

  // -- test controls --
  gather(init: RTCIceCandidateInit): void {
    this.onicecandidate?.({ candidate: { toJSON: () => init } });
  }
  setIce(state: string): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
  setConnection(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

export interface SignalingHarness extends Signaling {
  /** What the phone sent, in order. */
  readonly sent: { kind: string; data: Uint8Array }[];
  /** Feeds a signal from the computer. */
  emit(kind: SignalKind, data: Uint8Array): void;
  /** Number of active subscribers. */
  subscribers(): number;
  /** Makes `send` throw, like a relay that is not attached. */
  failSending(error: Error): void;
}

export function signalingHarness(): SignalingHarness {
  const sent: { kind: string; data: Uint8Array }[] = [];
  const handlers = new Set<(kind: SignalKind, data: Uint8Array) => void>();
  let sendError: Error | null = null;
  return {
    sent,
    send: (kind, data) => {
      if (sendError !== null) throw sendError;
      sent.push({ kind, data });
    },
    onSignal: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit: (kind, data) => {
      for (const h of [...handlers]) h(kind, data);
    },
    subscribers: () => handlers.size,
    failSending: (error) => {
      sendError = error;
    },
  };
}
