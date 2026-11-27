/**
 * TURN credentials minted by the relay.
 *
 * TURN has no anonymous mode, so somebody's key has to sign for the traffic.
 * The relay holds that key and hands out short-lived credentials, which is
 * why no user ever configures one. Only a registered device may ask.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { connectAttachedClient, connectRegisteredDevice, createDevice } from "./helpers";
import { mintIceServers, TurnUnavailable, TURN_TTL_SECONDS } from "../src/turn";

const CLOUDFLARE_REPLY = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"],
      username: "minted-user",
      credential: "minted-credential",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubProvider(reply: unknown, status = 201): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("minting TURN credentials", () => {
  it("asks the provider and drops the port browsers block", async () => {
    const fetchMock = stubProvider(CLOUDFLARE_REPLY);
    const minted = await mintIceServers({ keyId: "key-1", token: "secret-token" });

    expect(minted.expiresIn).toBe(TURN_TTL_SECONDS);
    expect(minted.iceServers).toHaveLength(2);
    expect(minted.iceServers[1]?.username).toBe("minted-user");
    for (const server of minted.iceServers) {
      for (const url of server.urls) expect(url).not.toContain(":53");
    }

    // The relay's key authenticates it to the provider and must not travel
    // any further than that request.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-token");
    expect(JSON.stringify(minted)).not.toContain("secret-token");
  });

  it("says plainly when no key is configured", async () => {
    await expect(mintIceServers({ keyId: undefined, token: undefined })).rejects.toBeInstanceOf(TurnUnavailable);
    await expect(mintIceServers({ keyId: "key-1", token: "" })).rejects.toBeInstanceOf(TurnUnavailable);
  });

  it("never repeats the provider's answer, which can echo the token", async () => {
    stubProvider({ error: "bad token secret-token" }, 401);
    await expect(mintIceServers({ keyId: "key-1", token: "secret-token" })).rejects.toThrow(/status 401/);
    try {
      await mintIceServers({ keyId: "key-1", token: "secret-token" });
    } catch (err) {
      expect(String(err)).not.toContain("secret-token");
    }
  });

  it("refuses an answer with nothing usable in it", async () => {
    stubProvider({ iceServers: [] });
    await expect(mintIceServers({ keyId: "key-1", token: "t" })).rejects.toThrow(/no usable servers/);
  });
});

describe("who may ask the relay for credentials", () => {
  it("answers a registered device", async () => {
    stubProvider(CLOUDFLARE_REPLY);
    (env as Record<string, unknown>)["TURN_KEY_ID"] = "key-1";
    (env as Record<string, unknown>)["TURN_TOKEN"] = "secret-token";

    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    daemon.sendJson({ type: "turn" });
    const reply = await daemon.next();

    expect(reply.type).toBe("turn");
    if (reply.type === "turn") {
      expect(reply.iceServers.length).toBeGreaterThan(0);
      expect(reply.expiresIn).toBe(TURN_TTL_SECONDS);
    }
  });

  it("refuses a phone: credentials follow the device key, not a device id", async () => {
    stubProvider(CLOUDFLARE_REPLY);
    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    const phone = await connectAttachedClient(device.deviceIdText, device.deviceId);
    await daemon.next(); // peer_state

    phone.sendJson({ type: "turn" });
    const reply = await phone.next();
    expect(reply.type).toBe("error");
    if (reply.type === "error") expect(reply.code).toBe("unauthorized");
  });

  it("stays usable when TURN is not configured", async () => {
    delete (env as Record<string, unknown>)["TURN_KEY_ID"];
    delete (env as Record<string, unknown>)["TURN_TOKEN"];

    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    daemon.sendJson({ type: "turn" });
    const reply = await daemon.next();

    // Reported, not fatal: a direct path still works without TURN.
    expect(reply.type).toBe("error");
    if (reply.type === "error") expect(reply.code).toBe("peer_unavailable");
  });
});
