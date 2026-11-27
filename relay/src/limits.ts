/**
 * Relay resource limits: the one place they are defined and documented.
 *
 * The values are the design starting points from AGENTIK.md section 9, not
 * measured capacity. Load testing moves them here.
 *
 * Enforced per connection (in the Durable Object):
 * - signaling payload at most `maxSignalBytes`; a raw message longer than
 *   `maxMessageLength(maxSignalBytes)` is rejected before it is parsed;
 * - at most `maxMessagesPerWindow` messages per `rateWindowMs` from a client,
 *   `maxDeviceMessagesPerWindow` from the device (it serves every client);
 *   keepalive pings are answered by the platform and do not count;
 * - at most `maxBufferedBytes` queued toward a client, signals and the
 *   relay's own replies alike; a slower client is closed instead of
 *   letting the queue grow.
 *
 * Enforced on the device's queue (in the Durable Object), which every client
 * of the device writes into:
 * - at most `maxClientShareBytes` of one client's signals in flight, and at
 *   most `maxDeviceBufferedBytes - deviceReserveBytes` of client signals in
 *   all. A client whose signal does not fit is closed, never the device, so
 *   a peer that knows a device id cannot disconnect the device by flooding
 *   it, and one client cannot take the others' share;
 * - a client may attach only while the device's queue has room for its
 *   arrival notice below `maxDeviceBufferedBytes - deviceReserveBytes / 2`,
 *   which keeps the rest of the reserve for departure notices;
 * - at most `maxDeviceBufferedBytes` queued in all; only the relay's own
 *   messages can reach it, and a device that falls that far behind is
 *   reading too slowly and is closed.
 *
 * Enforced per device (in the Durable Object):
 * - an unauthenticated socket is closed `challengeTtlMs` after connecting;
 * - at most `maxPending` unauthenticated sockets; the oldest is evicted to
 *   admit a new one;
 * - at most `maxClients` attached clients; when full, a client idle for
 *   `clientIdleMs` is evicted, otherwise the newcomer is refused;
 * - one device connection; only proof of the same key replaces it.
 *
 * Enforced per source IP (`CF-Connecting-IP`), through Workers rate-limit
 * bindings configured in wrangler.jsonc. `SOURCE_RATE_LIMITS` mirrors that
 * configuration for tests and documentation; wrangler.jsonc is authoritative.
 * - `CONNECT_LIMITER`: WebSocket upgrades, checked in the Worker before any
 *   Durable Object is woken. Attaching needs its own connection, so this is
 *   also the per-IP attach limit.
 * - `REGISTER_LIMITER`: registration attempts, checked in the Durable Object
 *   before signature verification. This bounds new-device creation, since
 *   every new device must register.
 * The binding counts per Cloudflare location and is eventually consistent,
 * so these are abuse brakes, not exact quotas. Clients behind one shared
 * address (CGNAT, offices) share a budget.
 *
 * Still TODO before a public launch (AGENTIK.md sections 9 and 14):
 * - a global cap on total resource consumption (devices, sockets, messages
 *   per day) that keeps the relay inside the Free-tier quotas;
 * - admission rules for public clients (Telegram identity), so attach is not
 *   open to anyone who knows a device id;
 * - a device-initiated way to drop a client connection that failed the Noise
 *   handshake, so a hostile client cannot keep busy slots occupied by
 *   sending traffic;
 * - a per-device byte budget over longer windows, beyond the per-second
 *   message rate;
 * - longer-window per-IP limits on new devices (the binding supports only
 *   10 s and 60 s periods);
 * - final values from backpressure and load testing.
 */

export const LIMITS = {
  /** Largest signaling payload (offer, answer, ICE) the relay will forward, in bytes. */
  maxSignalBytes: 32 * 1024,
  /**
   * How long a socket may stay unauthenticated (neither registered nor
   * attached). Past it the socket is closed, whether or not it ever sends.
   */
  challengeTtlMs: 30_000,
  /**
   * Unauthenticated sockets per device. When full, the oldest is evicted to
   * admit a new one, so stale sockets cannot lock out a real peer.
   */
  maxPending: 8,
  /** Clients attached to one device at once. */
  maxClients: 4,
  /**
   * A client with no signals forwarded in either direction for this long
   * counts as idle, and may be evicted when all client slots are taken.
   * Malformed or refused messages and keepalive pings do not count.
   */
  clientIdleMs: 30_000,
  /**
   * TURN credentials one device may be issued per day.
   *
   * A device asks once per relay registration, so this is generous for
   * ordinary use and still bounds a device that reconnects in a loop.
   */
  maxTurnIssuesPerDevice: 50,
  /**
   * TURN credentials the relay issues per day in all.
   *
   * The relay's TURN key is billed to whoever runs it, so this is the stop
   * that makes going over the free quota impossible rather than unlikely:
   * past it the relay reports TURN as unavailable and devices fall back to
   * direct paths and STUN.
   */
  maxTurnIssuesPerDay: 5_000,
  /** The window both TURN counters reset on. */
  turnWindowMs: 24 * 60 * 60 * 1000,
  /** Messages per window from one client socket. */
  maxMessagesPerWindow: 120,
  /** Messages per window from the device, which multiplexes every client. */
  maxDeviceMessagesPerWindow: 120 * 4,
  /** Length of the rate-limiting window. */
  rateWindowMs: 1_000,
  /** Bytes allowed to queue toward one client before it is closed. */
  maxBufferedBytes: 256 * 1024,
  /**
   * Bytes of one client's signals allowed in flight toward the device. It
   * holds one signal at the payload limit; a client that would go past it is
   * closed.
   */
  maxClientShareBytes: 64 * 1024,
  /**
   * Part of the device's queue that client signals may not use, kept for the
   * relay's own messages to the device: presence notices and error replies.
   */
  deviceReserveBytes: 64 * 1024,
  /**
   * Bytes allowed to queue toward the device before it is closed: a full
   * share for every client slot plus the reserve.
   */
  maxDeviceBufferedBytes: 4 * 64 * 1024 + 64 * 1024,
} as const;

/** Mirror of the rate-limit bindings in wrangler.jsonc. */
export const SOURCE_RATE_LIMITS = {
  /** CONNECT_LIMITER: WebSocket upgrades per IP per period. */
  connect: { limit: 60, periodSeconds: 60 },
  /** REGISTER_LIMITER: registration attempts per IP per period. */
  register: { limit: 10, periodSeconds: 60 },
} as const;

/**
 * The key a request is rate-limited under.
 *
 * Cloudflare sets CF-Connecting-IP on every request and a client cannot
 * override it. Requests without it (only local tooling) share one bucket
 * rather than escaping the limit.
 */
export function sourceKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
