import { describe, expect, it } from "vitest";
import {
  decodeIceCandidate,
  decodeIceServers,
  decodeSdp,
  encodeIceCandidate,
  encodeSdp,
  SignalInbox,
} from "./signaling";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe("signaling payloads", () => {
  it("round-trips an SDP", () => {
    expect(decodeSdp(encodeSdp("v=0"))).toBe("v=0");
    expect(JSON.parse(new TextDecoder().decode(encodeSdp("v=0")))).toEqual({ v: 1, sdp: "v=0" });
  });

  it("round-trips an ICE candidate in the daemon's field names", () => {
    const init = { candidate: "candidate:1 1 UDP 1 10.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "u" };
    expect(JSON.parse(new TextDecoder().decode(encodeIceCandidate(init)))).toEqual({ v: 1, ...init });
    expect(decodeIceCandidate(encodeIceCandidate(init))).toEqual(init);
  });

  it.each([
    ["wrong version", { v: 2, sdp: "x" }],
    ["no sdp", { v: 1 }],
    ["empty sdp", { v: 1, sdp: "" }],
  ])("refuses an SDP with %s", (_n, value) => {
    expect(decodeSdp(bytes(value))).toBeNull();
  });

  it("refuses malformed candidates and non-JSON", () => {
    expect(decodeIceCandidate(bytes({ v: 1, candidate: "" }))).toBeNull();
    expect(decodeIceCandidate(bytes({ v: 3, candidate: "x" }))).toBeNull();
    expect(decodeIceCandidate(new TextEncoder().encode("nope"))).toBeNull();
    expect(decodeSdp(new TextEncoder().encode("[]"))).toBeNull();
  });

  it("reads ice_servers with time-limited TURN credentials", () => {
    expect(
      decodeIceServers(
        bytes({
          v: 1,
          servers: [
            { urls: ["stun:s.example:3478"] },
            { urls: ["turn:t.example:3478?transport=udp"], username: "1800000300:agentik", credential: "c3VwZXI=" },
          ],
        }),
      ),
    ).toEqual([
      { urls: ["stun:s.example:3478"] },
      { urls: ["turn:t.example:3478?transport=udp"], username: "1800000300:agentik", credential: "c3VwZXI=" },
    ]);
    expect(decodeIceServers(bytes({ v: 1, servers: [] }))).toEqual([]);
  });

  it.each([
    ["a script URL", { v: 1, servers: [{ urls: ["javascript:alert(1)"] }] }],
    ["an https URL", { v: 1, servers: [{ urls: ["https://x.example"] }] }],
    ["no urls", { v: 1, servers: [{ urls: [] }] }],
    ["a bad entry", { v: 1, servers: ["x"] }],
    ["no list", { v: 1 }],
    ["a wrong version", { v: 9, servers: [] }],
  ])("refuses ice_servers with %s", (_n, value) => {
    expect(decodeIceServers(bytes(value))).toBeNull();
  });
});

describe("SignalInbox", () => {
  it("replays signals that arrived before the first subscriber, in order, once", () => {
    const inbox = new SignalInbox();
    inbox.push("ice_servers", Uint8Array.of(1));
    inbox.push("ice", Uint8Array.of(2));
    const seen: [string, number][] = [];
    inbox.subscribe((k, d) => seen.push([k, d[0] ?? 0]));
    inbox.push("answer", Uint8Array.of(3));
    expect(seen).toEqual([["ice_servers", 1], ["ice", 2], ["answer", 3]]);
    const later: string[] = [];
    inbox.subscribe((k) => later.push(k));
    expect(later).toEqual([]);
  });

  it("forgets stale signals on reset and stops delivering after unsubscribe", () => {
    const inbox = new SignalInbox();
    inbox.push("ice_servers", Uint8Array.of(1));
    inbox.reset();
    const seen: string[] = [];
    const off = inbox.subscribe((k) => seen.push(k));
    expect(seen).toEqual([]);
    off();
    inbox.push("ice", Uint8Array.of(2));
    expect(seen).toEqual([]);
  });
});
