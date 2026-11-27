import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_ICE_SERVERS_WAIT_MS, readWebRtcConfig } from "./config";

describe("readWebRtcConfig", () => {
  it("defaults to no static servers and sane timeouts", () => {
    expect(readWebRtcConfig({})).toEqual({
      stunUrls: [],
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      iceServersWaitMs: DEFAULT_ICE_SERVERS_WAIT_MS,
    });
  });

  it("reads STUN URLs and timeouts, dropping anything that is not a stun: URL", () => {
    expect(
      readWebRtcConfig({
        VITE_AGENTIK_STUN_URLS: " stun:a.example:3478, turn:b.example , https://c.example,stuns:d.example:5349 ,",
        VITE_AGENTIK_CONNECT_TIMEOUT_MS: "5000",
        VITE_AGENTIK_ICE_SERVERS_WAIT_MS: "250",
      }),
    ).toEqual({ stunUrls: ["stun:a.example:3478", "stuns:d.example:5349"], connectTimeoutMs: 5000, iceServersWaitMs: 250 });
  });

  it("ignores invalid numbers", () => {
    const c = readWebRtcConfig({ VITE_AGENTIK_CONNECT_TIMEOUT_MS: "-1", VITE_AGENTIK_ICE_SERVERS_WAIT_MS: "soon" });
    expect(c.connectTimeoutMs).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    expect(c.iceServersWaitMs).toBe(DEFAULT_ICE_SERVERS_WAIT_MS);
  });
});
