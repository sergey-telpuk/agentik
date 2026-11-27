import { useState } from "react";
import { encodeBase64Url } from "../encoding";
import {
  checkInvitationBindings,
  parseInvitation,
  type UntrustedInvitation,
} from "../pairing/invitation";
import { pinnedDeviceFromInvitation } from "../pairing/pin";
import type { AppServices } from "../services";
import type { PinnedDeviceStore } from "../storage/pinnedDevices";

interface Props {
  readonly services: AppServices;
  readonly store: PinnedDeviceStore;
  readonly onPinned: () => void;
  readonly onCancel: () => void;
}

export function PairScreen({ services, store, onPinned, onCancel }: Props) {
  const [text, setText] = useState("");
  // The invitation (including its one-time secret) lives in component state
  // only. It is never persisted, logged, or put in a URL.
  const [invitation, setInvitation] = useState<UntrustedInvitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsupported = store.persistence.status === "unsupported";
  const canScan = services.runtime.supportsMethod("web_app_open_scan_qr_popup");

  async function check(source: string): Promise<void> {
    setInvitation(null);
    const parsed = parseInvitation(source, services.now());
    if (!parsed.ok) {
      setError(parsed.error.message);
      return;
    }
    const mismatch = await checkInvitationBindings(parsed.value);
    if (mismatch !== null) {
      setError(mismatch.message);
      return;
    }
    setError(null);
    setInvitation(parsed.value);
  }

  async function scan(): Promise<void> {
    try {
      const scanned = await services.runtime.scanQr("Scan the pairing code shown on your computer");
      if (scanned !== null) {
        setText(scanned);
        await check(scanned);
      }
    } catch {
      setError("The QR scanner could not be opened. Paste the invitation instead.");
    }
  }

  async function pin(): Promise<void> {
    if (invitation === null) return;
    const result = await store.pin(pinnedDeviceFromInvitation(invitation, Math.floor(services.now() / 1000)));
    if (result.ok) {
      setText("");
      setInvitation(null);
      onPinned();
    } else {
      setError(result.message);
    }
  }

  return (
    <section>
      <h2>Connect a computer</h2>
      {canScan && (
        <p>
          <button type="button" onClick={() => void scan()}>
            Scan QR code
          </button>
        </p>
      )}
      <label>
        Pairing invitation
        <br />
        <textarea
          rows={5}
          cols={40}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <p>
        <button type="button" onClick={() => void check(text)}>
          Check invitation
        </button>{" "}
        <button type="button" onClick={onCancel}>
          Back
        </button>
      </p>
      {error !== null && <p role="alert">{error}</p>}
      {invitation !== null && (
        <div>
          <h3>Invitation looks valid</h3>
          <p>
            This is <strong>not trusted yet</strong>. Access exists only after your computer confirms this
            phone.
          </p>
          <dl>
            <dt>Computer</dt>
            <dd>
              <code>{invitation.deviceIdText}</code>
            </dd>
            <dt>Relay</dt>
            <dd>{invitation.relayUrl}</dd>
            <dt>Computer key to pin</dt>
            <dd>
              <code>{encodeBase64Url(invitation.noisePublicKey)}</code>
            </dd>
            <dt>Expires</dt>
            <dd>{new Date(invitation.expiresAt * 1000).toLocaleString()}</dd>
          </dl>
          {unsupported && (
            <p role="alert">Persistent access is not supported on this device, so this computer cannot be saved.</p>
          )}
          <button type="button" disabled={unsupported} onClick={() => void pin()}>
            Pin this computer
          </button>
        </div>
      )}
    </section>
  );
}
