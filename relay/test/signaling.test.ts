/**
 * WebRTC signaling over the relay.
 *
 * The relay forwards offers, answers, ICE candidates, and the ICE server list
 * as opaque bytes, and nothing else. In particular it has no path for
 * application frames: Noise and RPC traffic travel over the DataChannel.
 */

import { describe, expect, it } from "vitest";
import {
  TestPeer,
  connectAttachedClient,
  connectRegisteredDevice,
  createDevice,
  expectMessage,
} from "./helpers";
import { LIMITS } from "../src/limits";
import { parseClientMessage } from "../src/messages";
import { decodeBase64, encodeBase64 } from "../src/protocol";

async function pair() {
  const device = await createDevice();
  const daemon = await connectRegisteredDevice(device);
  const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
  await expectMessage(daemon, "peer_state");
  return { device, daemon, phone };
}

/** Bytes that are not SDP, not JSON, and not valid UTF-8. */
const OPAQUE = new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x28]);

async function expectError(peer: TestPeer, code: string): Promise<void> {
  const reply = await peer.next();
  if (reply.type !== "error") throw new Error(`expected error, got ${JSON.stringify(reply)}`);
  expect(reply.code).toBe(code);
}

describe("signaling", () => {
  it("forwards an offer from the phone to the device, tagged with the phone's connection", async () => {
    const { daemon, phone } = await pair();

    phone.sendSignal(OPAQUE, undefined, "offer");
    const received = await expectMessage(daemon, "signal");
    expect(received.kind).toBe("offer");
    expect(received.connectionId).toBe(phone.connectionId);
    expect(Array.from(decodeBase64(received.data)!)).toEqual(Array.from(OPAQUE));

    daemon.close();
    phone.close();
  });

  it("forwards an answer, ice, and ice_servers from the device to exactly the named phone", async () => {
    const { device, daemon, phone } = await pair();
    const other = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");

    for (const kind of ["ice_servers", "answer", "ice"]) {
      daemon.sendSignal(OPAQUE, phone.connectionId, kind);
      const received = await expectMessage(phone, "signal");
      expect(received.kind).toBe(kind);
      expect(received.connectionId).toBeUndefined();
      expect(Array.from(decodeBase64(received.data)!)).toEqual(Array.from(OPAQUE));
    }
    await other.expectSilence();

    daemon.close();
    phone.close();
    other.close();
  });

  it("forwards ice from the phone to the device", async () => {
    const { daemon, phone } = await pair();
    phone.sendSignal(OPAQUE, undefined, "ice");
    expect((await expectMessage(daemon, "signal")).kind).toBe("ice");
    daemon.close();
    phone.close();
  });

  it("refuses kinds that do not belong to the sender's role, without dropping the connection", async () => {
    const { daemon, phone } = await pair();

    for (const kind of ["answer", "ice_servers"]) {
      phone.sendSignal(OPAQUE, undefined, kind);
      await expectError(phone, "bad_request");
    }
    daemon.sendSignal(OPAQUE, phone.connectionId, "offer");
    await expectError(daemon, "bad_request");

    // Nothing was forwarded, and both sides still work.
    await daemon.expectSilence();
    await phone.expectSilence();
    phone.sendSignal(OPAQUE, undefined, "offer");
    expect((await expectMessage(daemon, "signal")).kind).toBe("offer");

    daemon.close();
    phone.close();
  });

  it("rejects an unknown or missing kind", async () => {
    const { daemon, phone } = await pair();

    phone.sendJson({ type: "signal", kind: "candidate", data: "AQ==" });
    await expectError(phone, "bad_request");
    phone.sendJson({ type: "signal", data: "AQ==" });
    await expectError(phone, "bad_request");
    phone.sendJson({ type: "signal", kind: 7, data: "AQ==" });
    await expectError(phone, "bad_request");

    await daemon.expectSilence();
    daemon.close();
    phone.close();
  });

  it("rejects malformed payloads: empty, not base64, oversized", async () => {
    const { daemon, phone } = await pair();

    phone.sendJson({ type: "signal", kind: "offer", data: "" });
    await expectError(phone, "bad_request");
    phone.sendJson({ type: "signal", kind: "offer", data: "not base64!" });
    await expectError(phone, "bad_request");
    phone.sendJson({ type: "signal", kind: "offer", data: 5 });
    await expectError(phone, "bad_request");
    phone.sendSignal(new Uint8Array(LIMITS.maxSignalBytes + 1), undefined, "offer");
    await expectError(phone, "message_too_large");

    await daemon.expectSilence();
    daemon.close();
    phone.close();
  });

  it("does not parse the payload: a payload that is not SDP still passes the size and kind checks", async () => {
    const { daemon, phone } = await pair();
    const notSdp = new TextEncoder().encode("this is not SDP at all");
    phone.sendSignal(notSdp, undefined, "offer");
    const received = await expectMessage(daemon, "signal");
    expect(new TextDecoder().decode(decodeBase64(received.data)!)).toBe("this is not SDP at all");
    daemon.close();
    phone.close();
  });

  it("keeps the rule that clients cannot set connection_id on signals", async () => {
    const { daemon, phone } = await pair();
    phone.sendSignal(OPAQUE, "0".repeat(32), "offer");
    await expectError(phone, "bad_request");
    await daemon.expectSilence();
    daemon.close();
    phone.close();
  });

  it("tells the sender when the peer is absent instead of queueing the signal", async () => {
    const device = await createDevice();
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    phone.sendSignal(OPAQUE, undefined, "offer");
    await expectError(phone, "peer_unavailable");
    phone.close();
  });

  it("applies the per-connection rate limit to signals", async () => {
    const { daemon, phone } = await pair();
    for (let i = 0; i < LIMITS.maxMessagesPerWindow + 10; i++) {
      phone.sendSignal(new Uint8Array([i & 0xff]), undefined, "ice");
    }
    let sawRateLimit = false;
    for (let i = 0; i < LIMITS.maxMessagesPerWindow + 20 && !sawRateLimit; i++) {
      try {
        const message = await phone.next(1_000);
        if (message.type === "error" && message.code === "rate_limited") sawRateLimit = true;
      } catch {
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
    daemon.close();
    phone.close();
  });
});

describe("no application data path", () => {
  it("rejects the legacy frame message from a phone and from the device, and forwards nothing", async () => {
    const { daemon, phone } = await pair();
    const data = encodeBase64(new Uint8Array([1, 2, 3]));

    phone.sendJson({ type: "frame", data });
    await expectError(phone, "bad_request");
    daemon.sendJson({ type: "frame", data, connection_id: phone.connectionId });
    await expectError(daemon, "bad_request");

    await daemon.expectSilence();
    await phone.expectSilence();
    daemon.close();
    phone.close();
  });

  it("the parser has no frame message type", () => {
    const raw = JSON.stringify({ type: "frame", data: "AQ==" });
    expect(parseClientMessage(raw, LIMITS.maxSignalBytes)).toMatchObject({
      ok: false,
      code: "bad_request",
      message: "unknown message type",
    });
  });
});
