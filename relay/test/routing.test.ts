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
  connectAttachedClient,
  connectRegisteredDevice,
  createDevice,
} from "./helpers";
import { LIMITS } from "../src/device-room";
import { decodeBase64, encodeBase64 } from "../src/protocol";

describe("frame routing", () => {
  it("forwards frames between a device and a client unchanged", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);

    // The device learns a client arrived.
    const presence = await daemon.next();
    expect(presence.type).toBe("peer_state");

    // A Noise ciphertext is arbitrary bytes, including non-UTF8 sequences,
    // so the relay must not transform them in any way.
    const payload = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0xc3, 0x28, 0x01]);
    phone.sendFrame(payload);

    const received = await daemon.next();
    if (received.type !== "frame") throw new Error(`expected frame, got ${received.type}`);
    expect(Array.from(decodeBase64(received.data)!)).toEqual(Array.from(payload));

    // And in the other direction.
    const reply = new Uint8Array([0x42, 0x00, 0xfe]);
    daemon.sendFrame(reply);
    const back = await phone.next();
    if (back.type !== "frame") throw new Error(`expected frame, got ${back.type}`);
    expect(Array.from(decodeBase64(back.data)!)).toEqual(Array.from(reply));

    daemon.close();
    phone.close();
  });

  it("tells the sender when no peer is connected", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);

    // The relay is not a queue: with no client attached, the frame is
    // refused rather than stored for later delivery.
    daemon.sendFrame(new Uint8Array([1, 2, 3]));
    const reply = await daemon.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("peer_unavailable");
    daemon.close();
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

    const attached = await phone.next();
    if (attached.type !== "attached") throw new Error("expected attached");
    // An unreachable computer must not look like a working connection.
    expect(attached.devicePresent).toBe(false);

    // When the device registers, the waiting client is told.
    const daemon = await connectRegisteredDevice(device);
    const presence = await phone.next();
    if (presence.type !== "peer_state") throw new Error("expected peer_state");
    expect(presence.present).toBe(true);

    daemon.close();
    phone.close();
  });

  it("notifies the client when the device disconnects", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await daemon.next(); // the client's arrival

    daemon.close();

    const presence = await phone.next();
    if (presence.type !== "peer_state") throw new Error(`expected peer_state, got ${presence.type}`);
    expect(presence.present).toBe(false);
    phone.close();
  });

  it("refuses frames before registering or attaching", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    await peer.challenge();

    peer.sendFrame(new Uint8Array([1]));
    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
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
    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
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

    const atA = await daemonA.next();
    if (atA.type !== "frame") throw new Error("device A should receive the frame");
    expect(Array.from(decodeBase64(atA.data)!)).toEqual([0xaa]);

    // Device B shares no state with A: its only traffic should be an error
    // about its own missing peer, never A's frame.
    daemonB.sendFrame(new Uint8Array([0xbb]));
    const atB = await daemonB.next();
    if (atB.type !== "error") throw new Error(`expected error, got ${atB.type}`);
    expect(atB.code).toBe("peer_unavailable");

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
