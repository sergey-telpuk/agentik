import { encodeBase64Url } from "../encoding";
import type { PinnedDevice } from "../storage/pinnedDevices";
import type { UntrustedInvitation } from "./invitation";

/**
 * Turns an invitation into the record that gets pinned.
 *
 * Only public material is kept. The invitation secret is deliberately left
 * out: it must never be persisted (AGENTIK.md section 5.3). The pin starts as
 * `unconfirmed` and changes only when the daemon accepts the pairing.
 */
export function pinnedDeviceFromInvitation(
  invitation: UntrustedInvitation,
  nowSeconds: number,
): PinnedDevice {
  return {
    deviceId: invitation.deviceIdText,
    relayUrl: invitation.relayUrl,
    registerPublicKey: encodeBase64Url(invitation.registerPublicKey),
    noisePublicKey: encodeBase64Url(invitation.noisePublicKey),
    pinnedAt: nowSeconds,
    state: "unconfirmed",
  };
}
