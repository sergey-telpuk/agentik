/**
 * Per-source-IP limits on connecting and on registering new devices.
 *
 * The rate-limit binding uses fixed windows aligned to the wall clock, so a
 * window may roll over during a test. Each test therefore allows up to two
 * windows' worth of attempts before expecting a refusal.
 */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  TestPeer,
  buildRegister,
  connectRegisteredDevice,
  createDevice,
  uniqueSourceIp,
} from "./helpers";
import { SOURCE_RATE_LIMITS } from "../src/limits";

async function upgrade(deviceIdText: string, sourceIp: string): Promise<Response> {
  return SELF.fetch(`https://relay.test/v1/connect?device=${deviceIdText}`, {
    headers: { Upgrade: "websocket", "CF-Connecting-IP": sourceIp },
  });
}

describe("per-source limits", () => {
  it("refuses connections from an address over the connect limit", async () => {
    const device = await createDevice();
    const ip = uniqueSourceIp();

    let refused: Response | null = null;
    for (let i = 0; i < 2 * SOURCE_RATE_LIMITS.connect.limit + 2; i++) {
      const response = await upgrade(device.deviceIdText, ip);
      if (response.status === 429) {
        refused = response;
        break;
      }
      expect(response.status).toBe(101);
      response.webSocket?.accept();
      response.webSocket?.close();
    }
    expect(refused).not.toBeNull();

    // Another address is unaffected.
    const other = await upgrade(device.deviceIdText, uniqueSourceIp());
    expect(other.status).toBe(101);
    other.webSocket?.accept();
    other.webSocket?.close();
  });

  it("refuses registrations from an address creating devices too fast", async () => {
    const ip = uniqueSourceIp();

    let refusal: { code: string; closeCode: number } | null = null;
    for (let i = 0; i < 2 * SOURCE_RATE_LIMITS.register.limit + 2; i++) {
      const device = await createDevice();
      const peer = await TestPeer.connect(device.deviceIdText, ip);
      const challenge = await peer.challenge();
      peer.send(await buildRegister(device, { challenge }));
      const reply = await peer.next();
      if (reply.type === "error") {
        refusal = { code: reply.code, closeCode: (await peer.waitClosed()).code };
        break;
      }
      expect(reply.type).toBe("registered");
      peer.close();
    }
    expect(refusal).toEqual({ code: "rate_limited", closeCode: 4001 });

    // A device registering from another address is unaffected.
    const elsewhere = await connectRegisteredDevice(await createDevice());
    elsewhere.close();
  });
});
