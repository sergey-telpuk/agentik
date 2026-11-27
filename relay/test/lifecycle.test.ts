/**
 * Socket lifecycle: challenge deadlines, eviction under slot pressure, and
 * registration races.
 *
 * Deadlines are tens of seconds in production, so these tests move a
 * socket's recorded deadline or activity into the past through the object's
 * own state rather than waiting.
 */

import { describe, expect, it } from "vitest";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type TestDevice,
  TestPeer,
  buildRegister,
  connectAttachedClient,
  connectRegisteredDevice,
  createDevice,
  expectMessage,
  uniqueSourceIp,
} from "./helpers";
import type { DeviceRoom } from "../src/device-room";
import { LIMITS } from "../src/limits";
import { encodeBase64 } from "../src/protocol";

type Attachment = Record<string, unknown>;

function roomFor(device: TestDevice): DurableObjectStub {
  const namespace = (env as unknown as { DEVICE: DurableObjectNamespace }).DEVICE;
  return namespace.get(namespace.idFromName(device.deviceIdText));
}

/** Rewrites the attachments `edit` returns a replacement for. */
async function editSockets(
  device: TestDevice,
  edit: (state: Attachment) => Attachment | null,
): Promise<number> {
  return runInDurableObject(roomFor(device), (_instance, state) => {
    let edited = 0;
    for (const ws of state.getWebSockets()) {
      const next = edit(ws.deserializeAttachment() as Attachment);
      if (next !== null) {
        ws.serializeAttachment(next);
        edited += 1;
      }
    }
    return edited;
  });
}

/** Moves one pending socket's deadline into the past. */
async function expireChallenge(device: TestDevice, challenge: Uint8Array): Promise<void> {
  const text = encodeBase64(challenge);
  const edited = await editSockets(device, (s) =>
    s["challenge"] === text ? { ...s, challengeExpiresAt: Date.now() - 1 } : null,
  );
  expect(edited).toBe(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("challenge deadline", () => {
  it("closes a socket that never sends anything once its challenge expires", async () => {
    const device = await createDevice();
    const silent = await TestPeer.connect(device.deviceIdText);
    const challenge = await silent.challenge();
    const fresh = await TestPeer.connect(device.deviceIdText);
    await fresh.challenge();

    await expireChallenge(device, challenge);
    expect(await runDurableObjectAlarm(roomFor(device))).toBe(true);

    expect((await expectMessage(silent, "error")).code).toBe("expired");
    expect((await silent.waitClosed()).code).toBe(4001);

    // The socket still inside its deadline is untouched, and the alarm is
    // rearmed for it.
    await fresh.expectSilence();
    expect(fresh.closed).toBeNull();
    const alarm = await runInDurableObject(roomFor(device), (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    fresh.close();
  });

  it("rejects any message on an expired socket", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();

    await expireChallenge(device, challenge);
    peer.sendJson({ type: "attach", version: 1, device_id: encodeBase64(device.deviceId) });

    expect((await expectMessage(peer, "error")).code).toBe("expired");
    expect((await peer.waitClosed()).code).toBe(4001);
  });

  it("sweeps expired sockets when another connection arrives", async () => {
    const device = await createDevice();
    const stale = await TestPeer.connect(device.deviceIdText);
    const challenge = await stale.challenge();

    await expireChallenge(device, challenge);
    const newcomer = await TestPeer.connect(device.deviceIdText);
    await newcomer.challenge();

    expect((await expectMessage(stale, "error")).code).toBe("expired");
    expect((await stale.waitClosed()).code).toBe(4001);
    newcomer.close();
  });

  it("does not expire an established connection", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(daemon, "peer_state");

    await editSockets(device, (s) => ({ ...s, challengeExpiresAt: Date.now() - 1 }));
    await runDurableObjectAlarm(roomFor(device));

    phone.sendFrame(new Uint8Array([1]));
    expect((await expectMessage(daemon, "frame")).connectionId).toBe(phone.connectionId);
    daemon.close();
    phone.close();
  });
});

describe("eviction under slot pressure", () => {
  it("evicts the oldest unauthenticated socket to admit a new one", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);

    const pending: TestPeer[] = [];
    for (let i = 0; i < LIMITS.maxPending; i++) {
      const peer = await TestPeer.connect(device.deviceIdText);
      await peer.challenge();
      pending.push(peer);
      await sleep(2);
    }

    const newcomer = await TestPeer.connect(device.deviceIdText);
    await newcomer.challenge();

    const oldest = pending[0]!;
    expect((await expectMessage(oldest, "error")).code).toBe("too_many_connections");
    expect((await oldest.waitClosed()).code).toBe(4003);
    for (const peer of pending.slice(1)) expect(peer.closed).toBeNull();

    // The newcomer is admitted, and the registered device was never a
    // candidate for eviction.
    newcomer.sendJson({ type: "attach", version: 1, device_id: encodeBase64(device.deviceId) });
    const attached = await expectMessage(newcomer, "attached");
    expect((await expectMessage(daemon, "peer_state")).connectionId).toBe(attached.connectionId);
    expect(daemon.closed).toBeNull();

    daemon.close();
    newcomer.close();
    for (const peer of pending) peer.close();
  });

  it("never evicts a registration in progress to admit new sockets", async () => {
    const device = await createDevice();
    const daemon = await TestPeer.connect(device.deviceIdText);
    const challenge = await daemon.challenge();
    const register = await buildRegister(device, { challenge });
    const text = encodeBase64(challenge);
    // The daemon's socket is the oldest, the first to go under the old rule.
    await sleep(2);

    const upgrade = () =>
      new Request(`https://relay.test/v1/connect?device=${device.deviceIdText}`, {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": uniqueSourceIp() },
      });
    const arrivals = await runInDurableObject(roomFor(device), async (instance: DeviceRoom, state) => {
      const ws = state
        .getWebSockets()
        .find((s) => (s.deserializeAttachment() as Attachment)["challenge"] === text);
      if (ws === undefined) throw new Error("pending socket not found");
      // Verification yields at its first await, so every socket below
      // arrives while the daemon's registration is still being verified.
      const verifying = instance.webSocketMessage(ws, register);
      const responses = Array.from({ length: LIMITS.maxPending }, () => instance.fetch(upgrade()));
      await verifying;
      return (await Promise.all(responses)).map((r) => r.status);
    });
    expect(arrivals).toEqual(Array.from({ length: LIMITS.maxPending }, () => 101));

    // The daemon completed its registration; one of the newcomers gave way.
    expect((await expectMessage(daemon, "registered")).deviceId).toBe(device.deviceIdText);
    expect(daemon.closed).toBeNull();
    const stillPending = await runInDurableObject(roomFor(device), (_i, state) =>
      state.getWebSockets().filter((s) => (s.deserializeAttachment() as Attachment)["role"] === "pending")
        .length,
    );
    expect(stillPending).toBe(LIMITS.maxPending - 1);

    daemon.close();
  });

  it("evicts an idle client when every client slot is taken", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const clients: TestPeer[] = [];
    for (let i = 0; i < LIMITS.maxClients; i++) {
      clients.push(await connectAttachedClient(device.deviceIdText, device.deviceId));
      await expectMessage(daemon, "peer_state");
    }

    // One client has been silent past the idle threshold.
    const idle = clients[1]!;
    await editSockets(device, (s) =>
      s["connectionId"] === idle.connectionId
        ? { ...s, lastActivity: Date.now() - LIMITS.clientIdleMs - 1 }
        : null,
    );

    const newcomer = await connectAttachedClient(device.deviceIdText, device.deviceId);

    expect((await expectMessage(idle, "error")).code).toBe("too_many_connections");
    expect((await idle.waitClosed()).code).toBe(4003);

    // The device learns exactly which client left and which arrived.
    expect(await expectMessage(daemon, "peer_state")).toEqual({
      type: "peer_state",
      connectionId: idle.connectionId,
      present: false,
    });
    expect(await expectMessage(daemon, "peer_state")).toEqual({
      type: "peer_state",
      connectionId: newcomer.connectionId,
      present: true,
    });
    for (const client of clients) if (client !== idle) expect(client.closed).toBeNull();

    daemon.close();
    newcomer.close();
    for (const client of clients) client.close();
  });

  it("evicts a client whose only traffic is junk when the slots are needed", async () => {
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const clients: TestPeer[] = [];
    for (let i = 0; i < LIMITS.maxClients; i++) {
      clients.push(await connectAttachedClient(device.deviceIdText, device.deviceId));
      await expectMessage(daemon, "peer_state");
    }
    const [junk, sender, receiver, other] = clients as [TestPeer, TestPeer, TestPeer, TestPeer];

    // Every client was last active one idle period ago, as if this were
    // the next 25-second tick of a client that keeps sending junk.
    await editSockets(device, (s) =>
      s["role"] === "client" ? { ...s, lastActivity: Date.now() - LIMITS.clientIdleMs - 1 } : null,
    );

    // Malformed and refused messages do not count as activity...
    junk.send("{}");
    expect((await expectMessage(junk, "error")).code).toBe("bad_request");
    junk.sendFrame(new Uint8Array([1]), "0".repeat(32));
    expect((await expectMessage(junk, "error")).code).toBe("bad_request");

    // ...while forwarded frames do, in either direction.
    sender.sendFrame(new Uint8Array([2]));
    expect((await expectMessage(daemon, "frame")).connectionId).toBe(sender.connectionId);
    daemon.sendFrame(new Uint8Array([3]), receiver.connectionId);
    await expectMessage(receiver, "frame");
    other.sendFrame(new Uint8Array([4]));
    expect((await expectMessage(daemon, "frame")).connectionId).toBe(other.connectionId);

    const newcomer = await connectAttachedClient(device.deviceIdText, device.deviceId);

    expect((await expectMessage(junk, "error")).code).toBe("too_many_connections");
    expect((await junk.waitClosed()).code).toBe(4003);
    expect(await expectMessage(daemon, "peer_state")).toEqual({
      type: "peer_state",
      connectionId: junk.connectionId,
      present: false,
    });
    for (const client of [sender, receiver, other]) expect(client.closed).toBeNull();

    daemon.close();
    newcomer.close();
    for (const client of clients) client.close();
  });
});

describe("registration races", () => {
  /**
   * Delivers two messages to one socket's handler concurrently.
   *
   * The runtime hands a socket's messages to the object one at a time, so
   * the handler is called directly to make two messages overlap at their
   * awaits, which is the interleaving the synchronous challenge consumption
   * guards against.
   */
  async function deliverConcurrently(
    device: TestDevice,
    challenge: Uint8Array,
    messages: [string, string],
  ): Promise<void> {
    const text = encodeBase64(challenge);
    await runInDurableObject(roomFor(device), async (instance: DeviceRoom, state) => {
      const ws = state
        .getWebSockets()
        .find((s) => (s.deserializeAttachment() as Attachment)["challenge"] === text);
      if (ws === undefined) throw new Error("pending socket not found");
      await Promise.all(messages.map((m) => instance.webSocketMessage(ws, m)));
    });
  }

  it("refuses a second register that overlaps the first on one socket", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();
    const register = await buildRegister(device, { challenge });

    await deliverConcurrently(device, challenge, [register, register]);

    const replies = [await peer.next(), await peer.next()];
    expect(replies.map((r) => r.type).sort()).toEqual(["error", "registered"]);
    expect(replies.find((r) => r.type === "error")).toMatchObject({ code: "bad_request" });
    await peer.expectSilence();
    expect(peer.closed).toBeNull();
    peer.close();
  });

  it("keeps the rate-limit count of messages that arrive during verification", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();
    const register = await buildRegister(device, { challenge });

    await deliverConcurrently(device, challenge, [register, register]);
    await peer.next();
    await peer.next();

    const counts = await runInDurableObject(roomFor(device), (_i, state) =>
      state
        .getWebSockets()
        .map((s) => s.deserializeAttachment() as Attachment)
        .filter((a) => a["role"] === "device")
        .map((a) => a["windowCount"]),
    );
    expect(counts).toEqual([2]);
    peer.close();
  });

  it("refuses an attach that overlaps a registration on one socket", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();
    const attach = JSON.stringify({
      type: "attach",
      version: 1,
      device_id: encodeBase64(device.deviceId),
    });

    await deliverConcurrently(device, challenge, [
      await buildRegister(device, { challenge }),
      attach,
    ]);

    const replies = [await peer.next(), await peer.next()];
    expect(replies.map((r) => r.type).sort()).toEqual(["error", "registered"]);

    // The socket ended up as the device, not as a client.
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    expect((await expectMessage(peer, "peer_state")).connectionId).toBe(phone.connectionId);
    peer.close();
    phone.close();
  });
});
