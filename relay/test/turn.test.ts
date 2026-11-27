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
    const minted = await mintIceServers({ endpoint: "https://provider.example/creds?apiKey=secret-token" });

    expect(minted.expiresIn).toBe(TURN_TTL_SECONDS);
    expect(minted.iceServers).toHaveLength(2);
    expect(minted.iceServers[1]?.username).toBe("minted-user");
    for (const server of minted.iceServers) {
      for (const url of server.urls) expect(url).not.toContain(":53");
    }

    // The relay's key authenticates it to the provider and must not travel
    // any further than that request.
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("secret-token");
    expect(JSON.stringify(minted)).not.toContain("secret-token");
  });

  it("reads a provider that answers with a bare array and string urls", async () => {
    // Metered answers that way; Cloudflare wraps it in an object and uses
    // arrays. Both have to work, because the provider is configuration.
    stubProvider([
      { urls: "stun:turn.example:80" },
      { urls: "turn:turn.example:443?transport=tcp", username: "u", credential: "c" },
    ]);
    const minted = await mintIceServers({ endpoint: "https://provider.example/creds?apiKey=k" });
    expect(minted.iceServers).toHaveLength(2);
    expect(minted.iceServers[0]?.urls).toEqual(["stun:turn.example:80"]);
    expect(minted.iceServers[1]?.credential).toBe("c");
  });

  it("uses a configured server list without calling anyone", async () => {
    // Metered issues long-lived credentials as a ready-made list; there is
    // no request to make, and no key to spend.
    const fetchMock = stubProvider([]);
    const minted = await mintIceServers({
      servers: JSON.stringify([
        { urls: "stun:stun.relay.metered.ca:80" },
        { urls: "turn:global.relay.metered.ca:443", username: "u", credential: "c" },
      ]),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(minted.iceServers).toHaveLength(2);
    expect(minted.iceServers[1]?.username).toBe("u");
  });

  it("refuses a configured list that is unusable", async () => {
    await expect(mintIceServers({ servers: "not json" })).rejects.toThrow(/not valid JSON/);
    await expect(mintIceServers({ servers: "[]" })).rejects.toThrow(/nothing usable/);
  });

  it("says plainly when no key is configured", async () => {
    await expect(mintIceServers({ endpoint: undefined })).rejects.toBeInstanceOf(TurnUnavailable);
    await expect(mintIceServers({ endpoint: "" })).rejects.toBeInstanceOf(TurnUnavailable);
  });

  it("never repeats the provider's answer, which can echo the token", async () => {
    stubProvider({ error: "bad token secret-token" }, 401);
    await expect(mintIceServers({ endpoint: "https://provider.example/creds?apiKey=secret-token" })).rejects.toThrow(/status 401/);
    try {
      await mintIceServers({ endpoint: "https://provider.example/creds?apiKey=secret-token" });
    } catch (err) {
      expect(String(err)).not.toContain("secret-token");
    }
  });

  it("refuses an answer with nothing usable in it", async () => {
    stubProvider({ iceServers: [] });
    await expect(mintIceServers({ endpoint: "https://provider.example/creds?apiKey=t" })).rejects.toThrow(/no usable servers/);
  });
});

describe("who may ask the relay for credentials", () => {
  it("answers a registered device", async () => {
    stubProvider(CLOUDFLARE_REPLY);
    (env as Record<string, unknown>)["TURN_ENDPOINT"] = "https://provider.example/creds?apiKey=secret-token";

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
    delete (env as Record<string, unknown>)["TURN_ENDPOINT"];

    const device = await createDevice();
    const daemon = await connectRegisteredDevice(device);
    daemon.sendJson({ type: "turn" });
    const reply = await daemon.next();

    // Reported, not fatal: a direct path still works without TURN.
    expect(reply.type).toBe("error");
    if (reply.type === "error") expect(reply.code).toBe("peer_unavailable");
  });
});
