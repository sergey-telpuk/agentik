/**
 * Slow receivers: the outgoing queue toward one connection is bounded, and a
 * receiver that cannot keep up is closed instead of growing memory.
 */

import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  type TestDevice,
  connectAttachedClient,
  connectRegisteredDevice,
  createDevice,
  expectMessage,
} from "./helpers";
import { type Receiver, sendWithinBudget } from "../src/backpressure";
import type { DeviceRoom } from "../src/device-room";
import { LIMITS } from "../src/limits";
import { encodeBase64 } from "../src/protocol";

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
      type: "frame",
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
    daemon.sendFrame(new Uint8Array([9]), other.connectionId);
    expect((await expectMessage(other, "frame")).data).toBe(encodeBase64(new Uint8Array([9])));

    daemon.close();
    other.close();
  });
});
