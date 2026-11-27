/**
 * Frame routing, peer presence, and resource limits.
 *
 * The relay must forward opaque bytes unchanged, refuse to act as a queue
 * when the peer is absent, and hold the bounds that keep one connection from
 * consuming the object's resources.
 */

import { describe, expect, it } from "vitest";
import {
  TestPeer,
  buildRegister,
  connectAttachedClient,
  connectRegisteredDevice,
  createDevice,
  expectMessage,
} from "./helpers";
import { LIMITS } from "../src/limits";
import { maxMessageLength } from "../src/messages";
import { decodeBase64, encodeBase64 } from "../src/protocol";

describe("frame routing", () => {
  it("forwards frames between a device and a client unchanged", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);

    // The device learns which client arrived.
    const presence = await expectMessage(daemon, "peer_state");
    expect(presence.present).toBe(true);
    expect(presence.connectionId).toBe(phone.connectionId);

    // A Noise ciphertext is arbitrary bytes, including non-UTF8 sequences,
    // so the relay must not transform them in any way.
    const payload = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0xc3, 0x28, 0x01]);
    phone.sendFrame(payload);

    const received = await expectMessage(daemon, "frame");
    expect(received.connectionId).toBe(phone.connectionId);
    expect(Array.from(decodeBase64(received.data)!)).toEqual(Array.from(payload));

    // And in the other direction, addressed to that client.
    const reply = new Uint8Array([0x42, 0x00, 0xfe]);
    daemon.sendFrame(reply, phone.connectionId);
    const back = await expectMessage(phone, "frame");
    expect(back.connectionId).toBeUndefined();
    expect(Array.from(decodeBase64(back.data)!)).toEqual(Array.from(reply));

    daemon.close();
    phone.close();
  });

  it("isolates frames between two clients of one device", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phoneA = await connectAttachedClient(device.deviceIdText, device.deviceId);
    const phoneB = await connectAttachedClient(device.deviceIdText, device.deviceId);
    expect(phoneA.connectionId).toBeDefined();
    expect(phoneA.connectionId).not.toBe(phoneB.connectionId);

    const arrivals = [
      (await expectMessage(daemon, "peer_state")).connectionId,
      (await expectMessage(daemon, "peer_state")).connectionId,
    ];
    expect(arrivals).toEqual([phoneA.connectionId, phoneB.connectionId]);

    // Each client's frames reach the device tagged with that client's id,
    // and never reach the other client.
    phoneA.sendFrame(new Uint8Array([0xa1]));
    const fromA = await expectMessage(daemon, "frame");
    expect(fromA.connectionId).toBe(phoneA.connectionId);
    phoneB.sendFrame(new Uint8Array([0xb1]));
    const fromB = await expectMessage(daemon, "frame");
    expect(fromB.connectionId).toBe(phoneB.connectionId);

    // A reply to A goes to A only.
    daemon.sendFrame(new Uint8Array([0xa2]), phoneA.connectionId);
    const atA = await expectMessage(phoneA, "frame");
    expect(Array.from(decodeBase64(atA.data)!)).toEqual([0xa2]);
    await phoneB.expectSilence();

    // And a reply to B goes to B only.
    daemon.sendFrame(new Uint8Array([0xb2]), phoneB.connectionId);
    const atB = await expectMessage(phoneB, "frame");
    expect(Array.from(decodeBase64(atB.data)!)).toEqual([0xb2]);
    await phoneA.expectSilence();

    daemon.close();
    phoneA.close();
    phoneB.close();
  });

  it("requires device frames to name a connected client", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");

    // Without an addressee the relay will not guess, and certainly not
    // broadcast.
    daemon.sendFrame(new Uint8Array([1]));
    const missing = await expectMessage(daemon, "error");
    expect(missing.code).toBe("bad_request");

    const unknown = "0".repeat(32);
    daemon.sendFrame(new Uint8Array([1]), unknown);
    const absent = await expectMessage(daemon, "error");
    expect(absent.code).toBe("peer_unavailable");
    expect(absent.connectionId).toBe(unknown);

    daemon.sendJson({ type: "frame", data: "AQ==", connection_id: "not-an-id" });
    const malformed = await expectMessage(daemon, "error");
    expect(malformed.code).toBe("bad_request");

    await phone.expectSilence();
    daemon.close();
    phone.close();
  });

  it("does not let a client claim another client's connection id", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phoneA = await connectAttachedClient(device.deviceIdText, device.deviceId);
    const phoneB = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");
    await expectMessage(daemon, "peer_state");

    phoneB.sendFrame(new Uint8Array([0xee]), phoneA.connectionId);
    const reply = await expectMessage(phoneB, "error");
    expect(reply.code).toBe("bad_request");
    await daemon.expectSilence();

    daemon.close();
    phoneA.close();
    phoneB.close();
  });

  it("tells the sender when no peer is connected", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);

    // The relay is not a queue: with no client attached, the frame is
    // refused rather than stored for later delivery.
    daemon.sendFrame(new Uint8Array([1, 2, 3]), "0".repeat(32));
    const reply = await expectMessage(daemon, "error");
    expect(reply.code).toBe("peer_unavailable");

    // The same holds for a client whose device is offline.
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");
    daemon.close();
    expect((await expectMessage(phone, "peer_state")).present).toBe(false);
    phone.sendFrame(new Uint8Array([4]));
    expect((await expectMessage(phone, "error")).code).toBe("peer_unavailable");
    phone.close();
  });

  it("reports that the device is absent when a client attaches first", async () => {
    const device = await createDevice();
    const phone = await TestPeer.connect(device.deviceIdText);
    await phone.challenge();
    phone.sendJson({
      type: "attach",
      version: 1,
      device_id: encodeBase64(device.deviceId),
    });

    const attached = await expectMessage(phone, "attached");
    // An unreachable computer must not look like a working connection.
    expect(attached.devicePresent).toBe(false);

    // When the device registers, it learns the waiting client, and the
    // client is told the device arrived.
    const daemon = await TestPeer.connect(device.deviceIdText);
    const challenge = await daemon.challenge();
    daemon.send(await buildRegister(device, { challenge }));
    const registered = await expectMessage(daemon, "registered");
    expect(registered.connections).toEqual([attached.connectionId]);

    const presence = await expectMessage(phone, "peer_state");
    expect(presence.present).toBe(true);
    expect(presence.connectionId).toBeUndefined();

    daemon.close();
    phone.close();
  });

  it("notifies the client when the device disconnects", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await daemon.next(); // the client's arrival

    daemon.close();

    const presence = await expectMessage(phone, "peer_state");
    expect(presence.present).toBe(false);
    phone.close();
  });

  it("tells the device which client disconnected", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phoneA = await connectAttachedClient(device.deviceIdText, device.deviceId);
    const phoneB = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");
    await expectMessage(daemon, "peer_state");

    phoneA.close();
    const presence = await expectMessage(daemon, "peer_state");
    expect(presence).toEqual({
      type: "peer_state",
      connectionId: phoneA.connectionId,
      present: false,
    });

    // The other client is unaffected.
    phoneB.sendFrame(new Uint8Array([7]));
    expect((await expectMessage(daemon, "frame")).connectionId).toBe(phoneB.connectionId);

    daemon.close();
    phoneB.close();
  });

  it("refuses frames before registering or attaching", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    await peer.challenge();

    peer.sendFrame(new Uint8Array([1]));
    const reply = await expectMessage(peer, "error");
    expect(reply.code).toBe("not_registered");
  });

  it("rejects an attach for a different device id", async () => {
    const device = await createDevice();
    const other = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    await peer.challenge();

    peer.sendJson({
      type: "attach",
      version: 1,
      device_id: encodeBase64(other.deviceId),
    });
    const reply = await expectMessage(peer, "error");
    expect(reply.code).toBe("bad_request");
  });

  it("keeps separate devices on separate routes", async () => {
    const deviceA = await createDevice();
    const deviceB = await createDevice();
    const daemonA = await connectRegisteredDevice(deviceA);
    const daemonB = await connectRegisteredDevice(deviceB);

    const phoneA = await connectAttachedClient(deviceA.deviceIdText, deviceA.deviceId);
    await daemonA.next(); // presence

    phoneA.sendFrame(new Uint8Array([0xaa]));

    const atA = await expectMessage(daemonA, "frame");
    expect(Array.from(decodeBase64(atA.data)!)).toEqual([0xaa]);

    // Device B shares no state with A: A's client is unknown on B's route,
    // and B never sees A's frame.
    daemonB.sendFrame(new Uint8Array([0xbb]), phoneA.connectionId);
    const atB = await expectMessage(daemonB, "error");
    expect(atB.code).toBe("peer_unavailable");
    await phoneA.expectSilence();

    daemonA.close();
    daemonB.close();
    phoneA.close();
  });
});

describe("limits", () => {
  it("rejects a frame larger than the limit", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await daemon.next(); // presence

    phone.sendFrame(new Uint8Array(LIMITS.maxFrameBytes + 1));
    const reply = await phone.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("message_too_large");

    daemon.close();
    phone.close();
  });

  it("rejects an oversized raw message before parsing it", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);

    daemon.send("x".repeat(maxMessageLength(LIMITS.maxFrameBytes) + 1));
    const reply = await expectMessage(daemon, "error");
    expect(reply.code).toBe("message_too_large");
    daemon.close();
  });

  it("accepts a frame at exactly the limit", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await daemon.next(); // presence

    const payload = new Uint8Array(LIMITS.maxFrameBytes).fill(0x5a);
    phone.sendFrame(payload);

    const received = await daemon.next();
    if (received.type !== "frame") throw new Error(`expected frame, got ${received.type}`);
    expect(decodeBase64(received.data)!.length).toBe(LIMITS.maxFrameBytes);

    daemon.close();
    phone.close();
  });

  it("rejects an empty frame", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await daemon.next();

    phone.sendJson({ type: "frame", data: "" });
    const reply = await phone.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("bad_request");

    daemon.close();
    phone.close();
  });

  it("bounds the number of clients attached to one device", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);

    const clients: TestPeer[] = [];
    for (let i = 0; i < LIMITS.maxClients; i++) {
      clients.push(await connectAttachedClient(device.deviceIdText, device.deviceId));
    }

    const extra = await TestPeer.connect(device.deviceIdText);
    await extra.challenge();
    extra.sendJson({
      type: "attach",
      version: 1,
      device_id: encodeBase64(device.deviceId),
    });
    const reply = await extra.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("too_many_connections");

    daemon.close();
    for (const c of clients) c.close();
  });

  it("rate-limits a flood of frames", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await daemon.next(); // presence

    // Past the window allowance the socket is closed rather than letting one
    // peer monopolise the object.
    for (let i = 0; i < LIMITS.maxFramesPerWindow + 10; i++) {
      phone.sendFrame(new Uint8Array([i & 0xff]));
    }

    // Drain until the relay reports the limit.
    let sawRateLimit = false;
    for (let i = 0; i < LIMITS.maxFramesPerWindow + 20 && !sawRateLimit; i++) {
      let message;
      try {
        message = await phone.next(1_000);
      } catch {
        break;
      }
      if (message.type === "error" && message.code === "rate_limited") {
        sawRateLimit = true;
      }
    }
    expect(sawRateLimit).toBe(true);

    daemon.close();
    phone.close();
  });

  it("rejects binary messages", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    await peer.challenge();

    // The protocol is JSON text; a binary message is a protocol error
    // rather than something to guess at.
    peer.sendBinary(new Uint8Array([0x00, 0x01, 0x02]));

    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("bad_request");
  });
});
