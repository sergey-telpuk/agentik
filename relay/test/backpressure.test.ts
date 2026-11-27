/**
 * Slow receivers: the outgoing queue toward one connection is bounded, and a
 * receiver that cannot keep up is closed instead of growing memory.
 */

import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  type TestDevice,
  TestPeer,
  connectAttachedClient,
  connectRegisteredDevice,
  createDevice,
  expectMessage,
} from "./helpers";
import { QueueLedger, type Receiver, sendWithinBudget } from "../src/backpressure";
import type { DeviceRoom } from "../src/device-room";
import { LIMITS } from "../src/limits";
import { signalMessage, serializeServerMessage } from "../src/messages";
import { encodeBase64 } from "../src/protocol";

type Attachment = Record<string, unknown>;

/** Finds the relay-side socket whose attachment matches. */
function socketWhere(state: DurableObjectState, pred: (a: Attachment) => boolean): WebSocket {
  const ws = state.getWebSockets().find((s) => pred(s.deserializeAttachment() as Attachment));
  if (ws === undefined) throw new Error("socket not found");
  return ws;
}

/**
 * Queues exactly `size` bytes toward a socket. Inside one handler run
 * nothing drains, so this stands in for a peer that stopped reading.
 */
function fill(ws: WebSocket, size: number): void {
  const empty = JSON.stringify({ type: "filler", pad: "" }).length;
  ws.send(JSON.stringify({ type: "filler", pad: "p".repeat(size - empty) }));
}

/** A client frame message carrying `size` payload bytes. */
function clientFrame(size: number): string {
  return JSON.stringify({ type: "signal", kind: "ice", data: encodeBase64(new Uint8Array(size)) });
}

/** A receiver that never drains, counting what was queued. */
class StalledReceiver implements Receiver {
  bufferedAmount = 0;
  sent = 0;

  send(message: string): void {
    this.bufferedAmount += message.length;
    this.sent += 1;
  }
}

function roomFor(device: TestDevice): DurableObjectStub {
  const namespace = (env as unknown as { DEVICE: DurableObjectNamespace }).DEVICE;
  return namespace.get(namespace.idFromName(device.deviceIdText));
}

describe("send budget", () => {
  it("never lets a stalled receiver's queue exceed the bound", () => {
    const receiver = new StalledReceiver();
    const frame = "f".repeat(40 * 1024);

    let refusedAt = -1;
    for (let i = 0; i < 20; i++) {
      if (!sendWithinBudget(receiver, frame, LIMITS.maxBufferedBytes)) {
        refusedAt = i;
        break;
      }
    }

    // 256 KiB holds six 40 KiB frames; the seventh is refused unsent.
    expect(refusedAt).toBe(6);
    expect(receiver.sent).toBe(6);
    expect(receiver.bufferedAmount).toBeLessThanOrEqual(LIMITS.maxBufferedBytes);
  });

  it("accepts a frame that fits exactly", () => {
    const receiver = new StalledReceiver();
    receiver.bufferedAmount = LIMITS.maxBufferedBytes - 10;
    expect(sendWithinBudget(receiver, "x".repeat(10), LIMITS.maxBufferedBytes)).toBe(true);
    expect(sendWithinBudget(receiver, "x", LIMITS.maxBufferedBytes)).toBe(false);
  });
});

describe("queue ledger", () => {
  it("charges queued bytes to their owner until they drain, in order", () => {
    const ledger = new QueueLedger(0);
    ledger.record(100, "a");
    ledger.record(50);
    ledger.record(30, "b");
    ledger.record(20, "a");
    expect(ledger.inFlight("a")).toBe(120);
    expect(ledger.inFlight("b")).toBe(30);

    // 120 of the 200 bytes have left: a's first message and the relay's.
    ledger.settle(80);
    expect(ledger.inFlight("a")).toBe(20);
    expect(ledger.inFlight("b")).toBe(30);

    // A partly written message is still charged in full.
    ledger.settle(40);
    expect(ledger.inFlight("b")).toBe(30);

    ledger.settle(0);
    expect(ledger.inFlight("a")).toBe(0);
    expect(ledger.inFlight("b")).toBe(0);
  });

  it("charges what was queued before tracking began to no one", () => {
    const ledger = new QueueLedger(500);
    ledger.record(100, "a");
    ledger.settle(150);
    expect(ledger.inFlight("a")).toBe(100);
    ledger.settle(100);
    expect(ledger.inFlight("a")).toBe(100);
    ledger.settle(0);
    expect(ledger.inFlight("a")).toBe(0);
  });
});

describe("device queue limits", () => {
  it("fits a full-size frame in one client's share and every share in the device queue", () => {
    const largest = serializeServerMessage(
      signalMessage("ice", new Uint8Array(LIMITS.maxSignalBytes), "0".repeat(32)),
    );
    expect(largest.length).toBeLessThanOrEqual(LIMITS.maxClientShareBytes);
    expect(LIMITS.maxDeviceBufferedBytes).toBe(
      LIMITS.maxClients * LIMITS.maxClientShareBytes + LIMITS.deviceReserveBytes,
    );
  });
});

describe("slow receiver", () => {
  it("closes a client whose queue is full and tells the device which one", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const slow = await connectAttachedClient(device.deviceIdText, device.deviceId);
    const other = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");
    await expectMessage(daemon, "peer_state");

    // Fill the slow client's real outgoing queue past the bound, then have
    // the device send it a frame before the runtime gets a chance to drain.
    const frame = JSON.stringify({
      type: "signal",
      kind: "ice",
      data: encodeBase64(new Uint8Array([1, 2, 3])),
      connection_id: slow.connectionId,
    });
    await runInDurableObject(roomFor(device), async (instance: DeviceRoom, state) => {
      const sockets = state.getWebSockets();
      const find = (pred: (a: Record<string, unknown>) => boolean) =>
        sockets.find((ws) => pred(ws.deserializeAttachment() as Record<string, unknown>));
      const target = find((a) => a["connectionId"] === slow.connectionId);
      const daemonSide = find((a) => a["role"] === "device");
      if (!target || !daemonSide) throw new Error("sockets not found");

      target.send(JSON.stringify({ type: "filler", pad: "p".repeat(LIMITS.maxBufferedBytes) }));
      expect(target.bufferedAmount).toBeGreaterThan(LIMITS.maxBufferedBytes);
      await instance.webSocketMessage(daemonSide, frame);
    });

    expect((await slow.waitClosed()).code).toBe(4002);

    // The device learns that exactly this client is gone, and that its
    // frame was not delivered.
    expect(await expectMessage(daemon, "peer_state")).toEqual({
      type: "peer_state",
      connectionId: slow.connectionId,
      present: false,
    });
    const error = await expectMessage(daemon, "error");
    expect(error).toMatchObject({ code: "peer_unavailable", connectionId: slow.connectionId });

    // Other clients keep working.
    daemon.sendSignal(new Uint8Array([9]), other.connectionId);
    expect((await expectMessage(other, "signal")).data).toBe(encodeBase64(new Uint8Array([9])));

    daemon.close();
    other.close();
  });

  it("closes a client that does not read its error replies instead of queueing them", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");

    await runInDurableObject(roomFor(device), async (instance: DeviceRoom, state) => {
      const phoneSide = socketWhere(state, (a) => a["connectionId"] === phone.connectionId);
      fill(phoneSide, LIMITS.maxBufferedBytes - 10);
      for (let i = 0; i < 5; i++) await instance.webSocketMessage(phoneSide, "{}");
      expect(phoneSide.bufferedAmount).toBeLessThanOrEqual(LIMITS.maxBufferedBytes);
    });

    expect((await phone.waitClosed()).code).toBe(4002);
    expect(await expectMessage(daemon, "peer_state")).toEqual({
      type: "peer_state",
      connectionId: phone.connectionId,
      present: false,
    });
    expect(daemon.closed).toBeNull();
    daemon.close();
  });
});

describe("slow device", () => {
  it("closes a client that floods the device, not the device", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const flooder = await connectAttachedClient(device.deviceIdText, device.deviceId);
    const other = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");
    await expectMessage(daemon, "peer_state");

    // Every frame arrives within one run of the object, so the device reads
    // none of them in between: it is slower than the flood.
    const frame = clientFrame(LIMITS.maxSignalBytes);
    await runInDurableObject(roomFor(device), async (instance: DeviceRoom, state) => {
      const flooderSide = socketWhere(state, (a) => a["connectionId"] === flooder.connectionId);
      const otherSide = socketWhere(state, (a) => a["connectionId"] === other.connectionId);
      for (let i = 0; i < 10; i++) await instance.webSocketMessage(flooderSide, frame);

      // The flooder's frames are still queued toward the device, yet the
      // other client's share is untouched.
      await instance.webSocketMessage(otherSide, frame);
    });

    expect((await expectMessage(flooder, "error")).code).toBe("rate_limited");
    expect((await flooder.waitClosed()).code).toBe(4001);

    // The device got the frame that fit, learned the flooder left, and got
    // the other client's frame.
    expect((await expectMessage(daemon, "signal")).connectionId).toBe(flooder.connectionId);
    expect(await expectMessage(daemon, "peer_state")).toEqual({
      type: "peer_state",
      connectionId: flooder.connectionId,
      present: false,
    });
    expect((await expectMessage(daemon, "signal")).connectionId).toBe(other.connectionId);
    expect(daemon.closed).toBeNull();

    // The device stays registered and the other client keeps working.
    other.sendSignal(new Uint8Array([1]));
    expect((await expectMessage(daemon, "signal")).connectionId).toBe(other.connectionId);
    daemon.sendSignal(new Uint8Array([2]), other.connectionId);
    expect((await expectMessage(other, "signal")).data).toBe(encodeBase64(new Uint8Array([2])));
    expect(other.closed).toBeNull();

    daemon.close();
    other.close();
  });

  it("closes the sending client when the part of the device queue clients may use is full", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");

    const clientLimit = LIMITS.maxDeviceBufferedBytes - LIMITS.deviceReserveBytes;
    await runInDurableObject(roomFor(device), async (instance: DeviceRoom, state) => {
      const daemonSide = socketWhere(state, (a) => a["role"] === "device");
      const phoneSide = socketWhere(state, (a) => a["connectionId"] === phone.connectionId);
      // Bytes no live client owns, such as frames from clients already gone.
      fill(daemonSide, clientLimit - 100);
      await instance.webSocketMessage(phoneSide, clientFrame(200));
    });

    expect((await expectMessage(phone, "error")).code).toBe("rate_limited");
    expect((await phone.waitClosed()).code).toBe(4001);

    expect((await daemon.next()).type).toBe("filler");
    expect(await expectMessage(daemon, "peer_state")).toEqual({
      type: "peer_state",
      connectionId: phone.connectionId,
      present: false,
    });
    expect(daemon.closed).toBeNull();
    daemon.close();
  });

  it("closes a device that does not read its own replies, and tells its clients", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");

    // The device addresses a client that is not there, over and over, and
    // reads none of the replies.
    const misaddressed = JSON.stringify({
      type: "signal",
      kind: "ice",
      data: encodeBase64(new Uint8Array([1])),
      connection_id: "0".repeat(32),
    });
    await runInDurableObject(roomFor(device), async (instance: DeviceRoom, state) => {
      const daemonSide = socketWhere(state, (a) => a["role"] === "device");
      fill(daemonSide, LIMITS.maxDeviceBufferedBytes - 10);
      for (let i = 0; i < 5; i++) await instance.webSocketMessage(daemonSide, misaddressed);
      expect(daemonSide.bufferedAmount).toBeLessThanOrEqual(LIMITS.maxDeviceBufferedBytes);
    });

    expect((await daemon.waitClosed()).code).toBe(4002);
    expect(await expectMessage(phone, "peer_state")).toEqual({ type: "peer_state", present: false });
    expect(phone.closed).toBeNull();
    phone.close();
  });

  it("refuses an attach while the device is far behind, without closing the device", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const newcomer = await TestPeer.connect(device.deviceIdText);
    const challenge = encodeBase64(await newcomer.challenge());
    const attach = JSON.stringify({ type: "attach", version: 1, device_id: encodeBase64(device.deviceId) });

    const arrivalLimit = LIMITS.maxDeviceBufferedBytes - LIMITS.deviceReserveBytes / 2;
    await runInDurableObject(roomFor(device), async (instance: DeviceRoom, state) => {
      const daemonSide = socketWhere(state, (a) => a["role"] === "device");
      const newcomerSide = socketWhere(state, (a) => a["challenge"] === challenge);
      fill(daemonSide, arrivalLimit - 10);
      await instance.webSocketMessage(newcomerSide, attach);
    });

    expect((await expectMessage(newcomer, "error")).code).toBe("peer_unavailable");
    expect((await newcomer.waitClosed()).code).toBe(4001);

    expect((await daemon.next()).type).toBe("filler");
    await daemon.expectSilence();
    expect(daemon.closed).toBeNull();

    // Once the device has caught up, attaching works again.
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    expect((await expectMessage(daemon, "peer_state")).connectionId).toBe(phone.connectionId);
    daemon.close();
    phone.close();
  });
});
