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

/** How long issued credentials are treated as valid. */
export const TURN_TTL_SECONDS = 3600;

/** Bounds one upstream request, so a device is not left waiting. */
const TURN_REQUEST_TIMEOUT_MS = 5000;

/** Browsers block port 53, and a URL on it only costs ICE time. */
function usable(url: string): boolean {
  return !url.includes(":53?") && !url.endsWith(":53");
}

export interface TurnConfig {
  /**
   * A ready-made ICE server list as JSON, for a provider that issues
   * long-lived credentials rather than an API. Used in preference to the
   * endpoint when both are set, because it costs no request.
   */
  servers?: string | undefined;
  /**
   * The provider's credential endpoint. Metered takes the API key in the
   * query string of a GET; a provider that wants a bearer token takes the
   * token below instead. Nothing here names a provider, so switching one
   * out is configuration rather than a change here.
   */
  endpoint?: string | undefined;
  /** A bearer token, for providers that authenticate that way. */
  token?: string | undefined;
}

/**
 * Reads an ICE server list from whatever shape a provider used: a bare array
 * (Metered) or an object with `iceServers` (Cloudflare), and `urls` as a
 * string or an array of them.
 */
function readIceServers(decoded: unknown): IceServer[] {
  const entries: unknown[] = Array.isArray(decoded)
    ? decoded
    : ((decoded as { iceServers?: unknown[] } | null)?.iceServers ?? []);

  const iceServers: IceServer[] = [];
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { urls?: string | string[]; username?: string; credential?: string };
    const urls = (typeof entry.urls === "string" ? [entry.urls] : (entry.urls ?? [])).filter(usable);
    if (urls.length === 0) continue;
    const server: IceServer = { urls };
    if (typeof entry.username === "string") server.username = entry.username;
    if (typeof entry.credential === "string") server.credential = entry.credential;
    iceServers.push(server);
  }
  return iceServers;
}

/** Thrown when TURN is not configured, so the caller can say so plainly. */
export class TurnUnavailable extends Error {}

/** Thrown when a quota stop was hit, which is a limit rather than a fault. */
export class TurnQuotaReached extends Error {}

/**
 * A daily counter kept in Durable Object storage.
 *
 * Counting issues rather than bytes is deliberate: the relay cannot see how
 * much traffic a credential goes on to carry, but it can bound how many are
 * handed out, and that is what keeps the bill predictable.
 */
export async function countIssue(
  storage: DurableObjectStorage,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<boolean> {
  const stored = (await storage.get<{ windowStart: number; count: number }>(key)) ?? { windowStart: now, count: 0 };
  const windowStart = now - stored.windowStart >= windowMs ? now : stored.windowStart;
  const count = windowStart === stored.windowStart ? stored.count : 0;
  if (count >= limit) return false;
  await storage.put(key, { windowStart, count: count + 1 });
  return true;
}

/**
 * Fetches ICE servers with fresh credentials.
 *
 * Errors never carry the response body: it can echo the token back.
 */
export async function mintIceServers(cfg: TurnConfig): Promise<{ iceServers: IceServer[]; expiresIn: number }> {
  // A configured list needs no request at all.
  if (cfg.servers !== undefined && cfg.servers !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cfg.servers);
    } catch {
      throw new Error("the configured TURN server list is not valid JSON");
    }
    const configured = readIceServers(parsed);
    if (configured.length === 0) {
      throw new Error("the configured TURN server list has nothing usable in it");
    }
    return { iceServers: configured, expiresIn: TURN_TTL_SECONDS };
  }

  if (cfg.endpoint === undefined || cfg.endpoint === "") {
    throw new TurnUnavailable("the relay has no TURN endpoint configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    const headers: Record<string, string> = {};
    if (cfg.token !== undefined && cfg.token !== "") headers["Authorization"] = `Bearer ${cfg.token}`;
    response = await fetch(cfg.endpoint, { method: "GET", headers, signal: controller.signal });
  } catch {
    throw new Error("could not reach the TURN provider");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // The body can echo the key back, so only the status is reported.
    throw new Error(`the TURN provider refused the request (status ${response.status})`);
  }

  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch {
    throw new Error("the TURN provider sent an unreadable answer");
  }

  const iceServers = readIceServers(decoded);
  if (iceServers.length === 0) {
    throw new Error("the TURN provider returned no usable servers");
  }
  return { iceServers, expiresIn: TURN_TTL_SECONDS };
}
