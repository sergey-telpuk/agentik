import { describe, expect, it } from "vitest";
import { detectWebRtc } from "./support";

describe("detectWebRtc", () => {
  it("is supported when RTCPeerConnection can create a data channel", () => {
    class Peer {
      createDataChannel(): void {}
    }
    expect(detectWebRtc({ RTCPeerConnection: Peer })).toEqual({ supported: true });
  });

  it("names the missing piece when it is not", () => {
    expect(detectWebRtc({})).toMatchObject({ supported: false, reason: expect.stringContaining("no RTCPeerConnection") });
    expect(detectWebRtc({ RTCPeerConnection: class {} })).toMatchObject({
      supported: false,
      reason: expect.stringContaining("data channel"),
    });
  });

  it("reports the jsdom test environment, which has no WebRTC, as unsupported", () => {
    expect(detectWebRtc()).toMatchObject({ supported: false });
  });
});
