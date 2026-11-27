/**
 * Build-time WebRTC configuration. Nothing here names a provider.
 *
 *   VITE_AGENTIK_STUN_URLS             comma separated stun:/stuns: URLs used in
 *                                      addition to what the computer advertises
 *   VITE_AGENTIK_CONNECT_TIMEOUT_MS    how long the DataChannel may take to open
 *   VITE_AGENTIK_ICE_SERVERS_WAIT_MS   how long to wait for the computer's
 *                                      ice_servers (TURN credentials) before offering
 *
 * TURN servers and their time-limited credentials are not configured here:
 * the secret lives on the computer, which sends derived credentials over the
 * signaling channel (AGENTIK.md section 6.3). The signaling URL comes from the
 * pairing invitation and is set on the computer with `--relay`.
 */

export interface WebRtcConfig {
  readonly stunUrls: readonly string[];
  readonly connectTimeoutMs: number;
  readonly iceServersWaitMs: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_ICE_SERVERS_WAIT_MS = 3_000;

type Env = Readonly<Record<string, string | undefined>>;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function readWebRtcConfig(env: Env): WebRtcConfig {
  const stunUrls = (env["VITE_AGENTIK_STUN_URLS"] ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => /^stuns?:[^\s]+$/.test(u));
  return {
    stunUrls,
    connectTimeoutMs: positiveInt(env["VITE_AGENTIK_CONNECT_TIMEOUT_MS"], DEFAULT_CONNECT_TIMEOUT_MS),
    iceServersWaitMs: positiveInt(env["VITE_AGENTIK_ICE_SERVERS_WAIT_MS"], DEFAULT_ICE_SERVERS_WAIT_MS),
  };
}
