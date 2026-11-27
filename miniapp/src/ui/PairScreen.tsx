import { useState } from "react";
import type { AgentikApi } from "../api/types";
import { encodeBase64Url } from "../encoding";
import {
  checkInvitationBindings,
  parseInvitation,
  type UntrustedInvitation,
} from "../pairing/invitation";
import type { AppServices } from "../services";
import type { PersistenceState } from "../storage/pinnedDevices";
import { sentence } from "./format";
import { Notice, Page, Section, useBusy } from "./kit";

interface Props {
  readonly services: AppServices;
  readonly api: AgentikApi;
  readonly persistence: PersistenceState;
  readonly onPinned: () => void;
  readonly onCancel: () => void;
}

export function PairScreen({ services, api, persistence, onPinned, onCancel }: Props) {
  const [text, setText] = useState("");
  // The invitation (including its one-time secret) lives in component state
  // only. It is never persisted, logged, or put in a URL.
  const [invitation, setInvitation] = useState<UntrustedInvitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const unsupported = persistence.status === "unsupported";
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
    const result = await api.pairComputer(invitation);
    if (result.ok) {
      setText("");
      setInvitation(null);
      onPinned();
    } else {
      setError(sentence(result.error.message));
    }
  }

  return (
    <Page title="Connect a computer" subtitle="Scan or paste the invitation shown on it" onBack={onCancel}>
      {canScan && (
        <button type="button" className="button button-primary button-block" onClick={() => void run(scan)} disabled={busy}>
          Scan QR code
        </button>
      )}
      <div className="field">
        <label htmlFor="invitation">Pairing invitation</label>
        <textarea
          id="invitation"
          rows={5}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setInvitation(null);
          }}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="agentik-pair-v1:…"
          aria-describedby="invitation-hint"
          aria-invalid={error !== null}
        />
        <p id="invitation-hint" className="hint">
          The invitation is valid for a few minutes and works once. It is never saved on this phone.
        </p>
      </div>
      <div className="button-row">
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>
          Back
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void run(() => check(text))}
          disabled={busy || text.trim() === ""}
        >
          Check invitation
        </button>
      </div>
      {error !== null && (
        <div className="notice notice-bad" role="alert">
          <p className="notice-title">This invitation cannot be used</p>
          <p className="notice-body">{sentence(error)}</p>
        </div>
      )}
      {invitation !== null && (
        <Section title="Invitation looks valid">
          <Notice tone="warn">
            <p>
              This is <strong>not trusted yet</strong>. Access exists only after your computer confirms this phone.
            </p>
          </Notice>
          <dl className="facts">
            <dt>Computer</dt>
            <dd className="mono">{invitation.deviceIdText}</dd>
            <dt>Relay</dt>
            <dd className="mono">{invitation.relayUrl}</dd>
            <dt>Computer key to pin</dt>
            <dd className="mono">{encodeBase64Url(invitation.noisePublicKey)}</dd>
            <dt>Expires</dt>
            <dd>{new Date(invitation.expiresAt * 1000).toLocaleString()}</dd>
          </dl>
          <p className="hint">Compare the first characters of the computer id with the ones shown on the computer.</p>
          {unsupported && (
            <Notice tone="bad" alert>
              <p>Persistent access is not supported on this device, so this computer cannot be saved.</p>
            </Notice>
          )}
          <button
            type="button"
            className="button button-primary button-block"
            disabled={unsupported || busy}
            onClick={() => void run(pin)}
          >
            Pin this computer
          </button>
        </Section>
      )}
    </Page>
  );
}
