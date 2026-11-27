/**
 * Signaling plumbing between the relay client and the link opener, and the
 * wire format of the payloads the relay carries as opaque bytes. Mirrors
 * `daemon/internal/webrtc/signaling.go`.
 */

import type { SignalKind } from "../relay/client";

export const SIGNAL_VERSION = 1;
export const DATA_CHANNEL_LABEL = "agentik";

/** What the link opener needs from the relay: send offer/ICE, receive the rest. */
export interface Signaling {
  send(kind: "offer" | "ice", data: Uint8Array): void;
  onSignal(handler: (kind: SignalKind, data: Uint8Array) => void): () => void;
}

/**
 * Holds signals that arrive before the link opener subscribes (the computer
 * sends `ice_servers` right after the relay attaches) and replays them to the
 * first subscriber. `reset` forgets them when a new negotiation starts.
 */
export class SignalInbox {
  #buffer: { kind: SignalKind; data: Uint8Array }[] = [];
  #handler: ((kind: SignalKind, data: Uint8Array) => void) | null = null;

  push(kind: SignalKind, data: Uint8Array): void {
    if (this.#handler !== null) this.#handler(kind, data);
    else if (this.#buffer.length < 64) this.#buffer.push({ kind, data });
  }

  reset(): void {
    this.#buffer = [];
    this.#handler = null;
  }

  subscribe(handler: (kind: SignalKind, data: Uint8Array) => void): () => void {
    this.#handler = handler;
    const replay = this.#buffer;
    this.#buffer = [];
    for (const item of replay) handler(item.kind, item.data);
    return () => {
      if (this.#handler === handler) this.#handler = null;
    };
  }
}

export interface IceServerConfig {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeSdp(sdp: string): Uint8Array {
  return encoder.encode(JSON.stringify({ v: SIGNAL_VERSION, sdp }));
}

export function decodeSdp(data: Uint8Array): string | null {
  const parsed = parseJson(data);
  if (parsed === null || parsed["v"] !== SIGNAL_VERSION) return null;
  const sdp = parsed["sdp"];
  return typeof sdp === "string" && sdp !== "" ? sdp : null;
}

export function encodeIceCandidate(c: RTCIceCandidateInit): Uint8Array {
  const body: Record<string, unknown> = { v: SIGNAL_VERSION, candidate: c.candidate ?? "" };
  if (c.sdpMid !== undefined && c.sdpMid !== null) body["sdpMid"] = c.sdpMid;
  if (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null) body["sdpMLineIndex"] = c.sdpMLineIndex;
  if (c.usernameFragment !== undefined && c.usernameFragment !== null) body["usernameFragment"] = c.usernameFragment;
  return encoder.encode(JSON.stringify(body));
}

export function decodeIceCandidate(data: Uint8Array): RTCIceCandidateInit | null {
  const parsed = parseJson(data);
  if (parsed === null || parsed["v"] !== SIGNAL_VERSION) return null;
  const candidate = parsed["candidate"];
  if (typeof candidate !== "string" || candidate === "") return null;
  const init: RTCIceCandidateInit = { candidate };
  if (typeof parsed["sdpMid"] === "string") init.sdpMid = parsed["sdpMid"];
  if (typeof parsed["sdpMLineIndex"] === "number") init.sdpMLineIndex = parsed["sdpMLineIndex"];
  if (typeof parsed["usernameFragment"] === "string") init.usernameFragment = parsed["usernameFragment"];
  return init;
}

/** Validates an `ice_servers` payload; anything malformed yields null. */
export function decodeIceServers(data: Uint8Array): IceServerConfig[] | null {
  const parsed = parseJson(data);
  if (parsed === null || parsed["v"] !== SIGNAL_VERSION || !Array.isArray(parsed["servers"])) return null;
  const out: IceServerConfig[] = [];
  for (const entry of parsed["servers"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    const urls = e["urls"];
    if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === "string" && /^(stuns?|turns?):/.test(u))) {
      return null;
    }
    const server: { urls: string[]; username?: string; credential?: string } = { urls: urls as string[] };
    if (typeof e["username"] === "string") server.username = e["username"];
    if (typeof e["credential"] === "string") server.credential = e["credential"];
    out.push(server);
  }
  return out;
}

function parseJson(data: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(decoder.decode(data));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
