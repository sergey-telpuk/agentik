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
  connectRegisteredDevice,
  createDevice,
} from "./helpers";
import { encodeBase64 } from "../src/protocol";

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

    // A failed registration attempt on the same route.
    const intruder = await TestPeer.connect(device.deviceIdText);
    const challenge = await intruder.challenge();
    intruder.send(await buildRegister(device, { challenge, signWith: attacker.privateKey }));
    const rejection = await intruder.next();
    expect(rejection.type).toBe("error");

    // The incumbent must still be able to carry traffic. A client attaching
    // now should be told the device is present.
    const client = await TestPeer.connect(device.deviceIdText);
    await client.challenge();
    client.sendJson({
      type: "attach",
      version: 1,
      device_id: encodeBase64(device.deviceId),
    });
    const attached = await client.next();
    if (attached.type !== "attached") throw new Error(`expected attached, got ${attached.type}`);
    expect(attached.devicePresent).toBe(true);

    incumbent.close();
    client.close();
  });

  it("replaces an older connection when the same key re-registers", async () => {
    const device = await createDevice();
    const first = await connectRegisteredDevice(device);

    // A reconnect after a network change proves the same key and takes over
    // the route.
    const second = await connectRegisteredDevice(device);

    const client = await TestPeer.connect(device.deviceIdText);
    await client.challenge();
    client.sendJson({
      type: "attach",
      version: 1,
      device_id: encodeBase64(device.deviceId),
    });
    const attached = await client.next();
    if (attached.type !== "attached") throw new Error("expected attached");
    expect(attached.devicePresent).toBe(true);

    first.close();
    second.close();
    client.close();
  });

  it("refuses a second registration on one connection", async () => {
    const device = await createDevice();
    const peer = await connectRegisteredDevice(device);

    peer.sendJson({ type: "register", version: 1, role: "device", relay_id: RELAY_ID });
    const reply = await peer.next();
    if (reply.type !== "error") throw new Error(`expected error, got ${reply.type}`);
    expect(reply.code).toBe("bad_request");
    peer.close();
  });
});
