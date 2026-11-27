/**
 * Registration and route-ownership tests.
 *
 * These cover the v0.1 acceptance scenarios that belong to the relay:
 * a spoofed registration is rejected, a running daemon is not evicted by an
 * unauthorized peer, and an expired or replayed challenge grants nothing.
 */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  RELAY_ID,
  TestPeer,
  buildRegister,
  connectAttachedClient,
  connectRegisteredDevice,
  createDevice,
  expectMessage,
} from "./helpers";

describe("connection setup", () => {
  it("issues a challenge bound to the connection", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);

    const first = await peer.next();
    expect(first.type).toBe("challenge");
    if (first.type !== "challenge") throw new Error("unreachable");
    expect(first.relayId).toBe(RELAY_ID);

    // Each connection must get its own challenge, or one capture would work
    // on every future socket.
    const second = await TestPeer.connect(device.deviceIdText);
    const secondChallenge = await second.next();
    if (secondChallenge.type !== "challenge") throw new Error("unreachable");
    expect(secondChallenge.challenge).not.toBe(first.challenge);

    peer.close();
    second.close();
  });

  it("rejects a non-WebSocket request", async () => {
    const response = await SELF.fetch("https://relay.test/v1/connect?device=aaaa");
    expect(response.status).toBe(426);
  });

  it("rejects a missing or malformed device id", async () => {
    const missing = await SELF.fetch("https://relay.test/v1/connect", {
      headers: { Upgrade: "websocket" },
    });
    expect(missing.status).toBe(400);

    const malformed = await SELF.fetch("https://relay.test/v1/connect?device=not-base32!", {
      headers: { Upgrade: "websocket" },
    });
    expect(malformed.status).toBe(400);
  });

  it("answers a health probe without revealing devices", async () => {
    const response = await SELF.fetch("https://relay.test/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(Object.keys(body)).toEqual(["status", "relay"]);
  });
});

describe("device registration", () => {
  it("accepts a correctly signed registration", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();

    peer.send(await buildRegister(device, { challenge }));

    const reply = await peer.next();
    expect(reply.type).toBe("registered");
    if (reply.type !== "registered") throw new Error("unreachable");
    expect(reply.deviceId).toBe(device.deviceIdText);
    peer.close();
  });

  it("rejects a signature made by a different key", async () => {
    const device = await createDevice();
    const attacker = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();

    // Everything is well formed except that the attacker signed it.
    peer.send(await buildRegister(device, { challenge, signWith: attacker.privateKey }));

    const reply = await peer.next();
    expect(reply.type).toBe("error");
    if (reply.type !== "error") throw new Error("unreachable");
    expect(reply.code).toBe("unauthorized");
  });

  it("rejects a garbage signature", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();

    peer.send(
      await buildRegister(device, {
        challenge,
        forgedSignature: new Uint8Array(64).fill(7),
      }),
    );

    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("unauthorized");
  });

  it("rejects a challenge from another connection", async () => {
    const device = await createDevice();
    const first = await TestPeer.connect(device.deviceIdText);
    const firstChallenge = await first.challenge();

    // A second socket gets its own challenge; replaying the first one here
    // must not work.
    const second = await TestPeer.connect(device.deviceIdText);
    await second.challenge();
    second.send(await buildRegister(device, { challenge: firstChallenge }));

    const reply = await second.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("unauthorized");
    first.close();
  });

  it("rejects a registration addressed to another relay", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();

    peer.send(await buildRegister(device, { challenge, relayId: "someone-else" }));

    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("unauthorized");
  });

  it("rejects an expired registration", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();

    peer.send(
      await buildRegister(device, {
        challenge,
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      }),
    );

    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("expired");
  });

  it("rejects an expiry far in the future", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();

    // Otherwise one signature would stay usable indefinitely.
    peer.send(
      await buildRegister(device, {
        challenge,
        expiresAt: Math.floor(Date.now() / 1000) + 86_400,
      }),
    );

    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("unauthorized");
  });

  it("rejects a device id that does not match the key", async () => {
    const device = await createDevice();
    const other = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();

    // Claiming another device's id while signing with this key.
    peer.send(await buildRegister(device, { challenge, deviceId: other.deviceId }));

    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("unauthorized");
  });

  it("rejects an unsupported protocol version", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();

    peer.send(await buildRegister(device, { challenge, version: 99 }));

    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("unsupported_version");
  });

  it("rejects a malformed registration message", async () => {
    const device = await createDevice();

    const cases: unknown[] = [
      { type: "register" },
      { type: "register", version: 1, role: "client" },
      { type: "register", version: 1, role: "device", relay_id: RELAY_ID },
      { type: "register", version: 1, role: "device", relay_id: RELAY_ID, device_id: "short" },
    ];

    for (const body of cases) {
      const peer = await TestPeer.connect(device.deviceIdText);
      await peer.challenge();
      peer.sendJson(body);
      const reply = await peer.next();
      if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
      expect(reply.code).toBe("bad_request");
    }
  });

  it("rejects input that is not JSON", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    await peer.challenge();

    peer.send("this is not json");
    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("bad_request");
  });

  it("does not let an unauthorized peer evict a registered device", async () => {
    const device = await createDevice();
    const attacker = await createDevice();
    const incumbent = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(incumbent, "peer_state");

    // Every way a registration on this route can fail. None of them may
    // touch the registered connection.
    const elsewhere = await TestPeer.connect(device.deviceIdText);
    const foreignChallenge = await elsewhere.challenge();
    const past = Math.floor(Date.now() / 1000) - 1;
    const attempts: [string, (challenge: Uint8Array) => Promise<string>][] = [
      ["foreign signature", (c) =>
        buildRegister(device, { challenge: c, signWith: attacker.privateKey })],
      ["garbage signature", (c) =>
        buildRegister(device, { challenge: c, forgedSignature: new Uint8Array(64).fill(1) })],
      ["mismatched device id", (c) =>
        buildRegister(attacker, { challenge: c, deviceId: device.deviceId })],
      ["replayed challenge", () => buildRegister(device, { challenge: foreignChallenge })],
      ["expired", (c) => buildRegister(device, { challenge: c, expiresAt: past })],
      ["other relay", (c) => buildRegister(device, { challenge: c, relayId: "elsewhere" })],
    ];

    for (const [name, build] of attempts) {
      const intruder = await TestPeer.connect(device.deviceIdText);
      const challenge = await intruder.challenge();
      intruder.send(await build(challenge));
      const rejection = await intruder.next();
      expect(rejection.type, name).toBe("error");
      expect((await intruder.waitClosed()).code, name).toBe(4001);
    }

    // The incumbent was never closed or replaced and still carries traffic
    // both ways.
    expect(incumbent.closed).toBeNull();
    phone.sendSignal(new Uint8Array([1]));
    expect((await expectMessage(incumbent, "signal")).connectionId).toBe(phone.connectionId);
    incumbent.sendSignal(new Uint8Array([2]), phone.connectionId);
    await expectMessage(phone, "signal");

    incumbent.close();
    phone.close();
    elsewhere.close();
  });

  it("rejects a validly signed registration for another device's route", async () => {
    const device = await createDevice();
    const squatter = await createDevice();
    const incumbent = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(incumbent, "peer_state");

    // The squatter's registration is entirely valid for its own key; only
    // the address it was presented on belongs to someone else.
    const intruder = await TestPeer.connect(device.deviceIdText);
    const challenge = await intruder.challenge();
    intruder.send(await buildRegister(squatter, { challenge }));
    const rejection = await expectMessage(intruder, "error");
    expect(rejection.code).toBe("unauthorized");
    expect(rejection.message).toContain("route");
    expect((await intruder.waitClosed()).code).toBe(4001);

    // The real daemon still owns the route and still carries traffic.
    phone.sendSignal(new Uint8Array([9]));
    const frame = await expectMessage(incumbent, "signal");
    expect(frame.connectionId).toBe(phone.connectionId);
    expect(incumbent.closed).toBeNull();

    incumbent.close();
    phone.close();
  });

  it("replaces an older connection when the same key re-registers", async () => {
    const device = await createDevice();
    const first = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await expectMessage(first, "peer_state");

    // A reconnect after a network change proves the same key and takes over
    // the route. It learns about the client already attached.
    const second = await TestPeer.connect(device.deviceIdText);
    const challenge = await second.challenge();
    second.send(await buildRegister(device, { challenge }));
    const registered = await expectMessage(second, "registered");
    expect(registered.connections).toEqual([phone.connectionId]);

    expect((await first.waitClosed()).code).toBe(4000);

    // The client is told a new device connection is in place, and its
    // frames now reach only the new connection.
    expect(await expectMessage(phone, "peer_state")).toEqual({ type: "peer_state", present: true });
    phone.sendSignal(new Uint8Array([0x5a]));
    expect((await expectMessage(second, "signal")).connectionId).toBe(phone.connectionId);
    await first.expectSilence();

    second.close();
    phone.close();
  });

  it("refuses a second registration on one connection", async () => {
    const device = await createDevice();
    const peer = await TestPeer.connect(device.deviceIdText);
    const challenge = await peer.challenge();
    const register = await buildRegister(device, { challenge });
    peer.send(register);
    await expectMessage(peer, "registered");

    // A complete, validly signed registration, so the only reason left to
    // refuse it is that this connection already registered.
    peer.send(register);
    const reply = await expectMessage(peer, "error");
    expect(reply.code).toBe("bad_request");
    expect(reply.message).toContain("already registered");

    // The connection is still the registered device.
    expect(peer.closed).toBeNull();
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    expect((await expectMessage(peer, "peer_state")).connectionId).toBe(phone.connectionId);
    peer.close();
    phone.close();
  });
});
