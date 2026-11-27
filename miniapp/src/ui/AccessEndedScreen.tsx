import { useState } from "react";
import type { AgentikApi } from "../api/types";
import { sentence } from "./format";
import { ConfirmDialog, Page, useBusy } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly computerName: string;
  readonly message: string;
  readonly onDone: () => void;
}

export function AccessEndedScreen({ api, computerId, computerName, message, onDone }: Props) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, run] = useBusy();

  async function forget(): Promise<void> {
    const result = await api.forgetComputer(computerId);
    if (result.ok) onDone();
    else setError(sentence(result.error.message));
  }

  return (
    <Page
      title="Access ended"
      subtitle={computerName}
      onBack={onDone}
      footer={
        <div className="stack">
          <button type="button" className="button button-destructive-outline button-block" onClick={() => setConfirm(true)}>
            Forget this computer
          </button>
          <button type="button" className="button button-secondary button-block" onClick={onDone}>
            Back to computers
          </button>
        </div>
      }
    >
      <div className="hero hero-bad" role="alert">
        <svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5 19 19 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <p className="hero-title">{computerName} ended access for this phone</p>
        <p className="plain">{message}</p>
      </div>
      <ul className="bullets">
        <li>This phone can no longer read projects or start tasks on {computerName}.</li>
        <li>Tasks already running on the computer are not changed by this.</li>
        <li>Access is not restored automatically. To use this computer again, create a new invitation on it and pair again.</li>
      </ul>
      {confirm && (
        <ConfirmDialog
          title={`Forget ${computerName}?`}
          confirmLabel="Forget computer"
          destructive
          busy={busy}
          error={error}
          onConfirm={() => void run(forget)}
          onCancel={() => setConfirm(false)}
        >
          <p>This removes the pinned key from this phone.</p>
        </ConfirmDialog>
      )}
    </Page>
  );
}
