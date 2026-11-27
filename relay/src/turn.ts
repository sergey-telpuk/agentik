/**
 * TURN credentials, minted by the relay.
 *
 * A pair of networks with no direct path needs a TURN server, and TURN has no
 * anonymous mode: RFC 8656 requires authentication, or the server becomes an
 * open relay for anyone's traffic. Asking every user to create their own key
 * is work they should not have to do, so the relay holds one key and hands
 * out credentials derived from it.
 *
 * The key is a Worker secret and never leaves this code. What reaches a
 * device is a username and credential that expire, and only after the device
 * proved it owns its registration key.
 *
 * A TURN operator relays encrypted traffic; it cannot read or forge it, since
 * the DataChannel carries a Noise session bound to both DTLS fingerprints.
 */

import type { IceServer } from "./messages";

/** Cloudflare Realtime TURN, which mints credentials through its own API. */
const CLOUDFLARE_TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

/** How long issued credentials stay valid. Long enough to set up a call. */
export const TURN_TTL_SECONDS = 3600;

/** Bounds one upstream request, so a device is not left waiting. */
const TURN_REQUEST_TIMEOUT_MS = 5000;

/** Browsers block port 53, and a URL on it only costs ICE time. */
function usable(url: string): boolean {
  return !url.includes(":53?") && !url.endsWith(":53");
}

export interface TurnConfig {
  /** Cloudflare TURN key id. Not a secret. */
  keyId: string | undefined;
  /** The API token for that key. A Worker secret. */
  token: string | undefined;
}

/** Thrown when TURN is not configured, so the caller can say so plainly. */
export class TurnUnavailable extends Error {}

/**
 * Fetches ICE servers with fresh credentials.
 *
 * Errors never carry the response body: it can echo the token back.
 */
export async function mintIceServers(cfg: TurnConfig): Promise<{ iceServers: IceServer[]; expiresIn: number }> {
  if (cfg.keyId === undefined || cfg.keyId === "" || cfg.token === undefined || cfg.token === "") {
    throw new TurnUnavailable("the relay has no TURN key configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${CLOUDFLARE_TURN_API}/${cfg.keyId}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      signal: controller.signal,
    });
  } catch {
    throw new Error("could not reach the TURN provider");
  } finally {
    clearTimeout(timer);
  }

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`the TURN provider refused the request (status ${response.status})`);
  }

  let decoded: { iceServers?: { urls?: string[]; username?: string; credential?: string }[] };
  try {
    decoded = (await response.json()) as typeof decoded;
  } catch {
    throw new Error("the TURN provider sent an unreadable answer");
  }

  const iceServers: IceServer[] = [];
  for (const entry of decoded.iceServers ?? []) {
    const urls = (entry.urls ?? []).filter(usable);
    if (urls.length === 0) continue;
    const server: IceServer = { urls };
    if (entry.username !== undefined) server.username = entry.username;
    if (entry.credential !== undefined) server.credential = entry.credential;
    iceServers.push(server);
  }
  if (iceServers.length === 0) {
    throw new Error("the TURN provider returned no usable servers");
  }
  return { iceServers, expiresIn: TURN_TTL_SECONDS };
}
