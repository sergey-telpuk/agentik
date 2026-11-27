import { useCallback, useEffect, useState } from "react";
import type { AgentikApi, Computer } from "../api/types";
import type { PersistenceState } from "../storage/pinnedDevices";
import { COMPUTER_STATUS, relativeTime, sentence, shortId } from "./format";
import { ConfirmDialog, Empty, Notice, Page, SkeletonList, StatusChip, useBusy, useNow } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly persistence: PersistenceState;
  readonly now: () => number;
  readonly onAdd: () => void;
  readonly onOpen: (computer: Computer) => void;
  readonly onSettings: () => void;
}

type Listing =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly computers: Computer[] }
  | { readonly kind: "error"; readonly message: string };

function seenText(c: Computer, now: number): string {
  if (c.status === "pending_confirmation") return "Confirm this phone on the computer";
  if (c.status === "replaced") return "Presented a different key. Pair again";
  if (c.status === "revoked") return "This phone no longer has access";
  if (c.lastSeenAt === null) return "Never connected";
  return c.status === "online" ? `Seen ${relativeTime(c.lastSeenAt, now)}` : `Last seen ${relativeTime(c.lastSeenAt, now)}`;
}

export function ComputersScreen({ api, persistence, now, onAdd, onOpen, onSettings }: Props) {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [forgetting, setForgetting] = useState<Computer | null>(null);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const current = useNow(30_000, now);

  useEffect(() => {
    let cancelled = false;
    void api.listComputers().then((result) => {
      if (cancelled) return;
      setListing(result.ok ? { kind: "ready", computers: result.value } : { kind: "error", message: sentence(result.error.message) });
    });
    return () => {
      cancelled = true;
    };
  }, [api, reload]);

  const confirmForget = useCallback(async () => {
    if (forgetting === null) return;
    await run(async () => {
      const result = await api.forgetComputer(forgetting.id);
      if (result.ok) {
        setForgetting(null);
        setForgetError(null);
        setReload((n) => n + 1);
      } else {
        setForgetError(sentence(result.error.message));
      }
    });
  }, [api, forgetting, run]);

  const unsupported = persistence.status === "unsupported";

  return (
    <Page
      title="Computers"
      subtitle="Paired with this phone"
      actions={
        <button type="button" className="icon-button" onClick={onSettings} aria-label="Settings and diagnostics">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.1.1-1.4-.1-1.4 2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.4-1.4L14.2 3h-4l-.4 2.7a7.6 7.6 0 0 0-2.4 1.4l-2.4-1-2 3.4 2 1.6-.1 1.4.1 1.4-2 1.6 2 3.4 2.4-1c.7.6 1.5 1 2.4 1.4l.4 2.7h4l.4-2.7c.9-.3 1.7-.8 2.4-1.4l2.4 1 2-3.4-2-1.6Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      }
      footer={
        <button type="button" className="button button-primary button-block" onClick={onAdd} disabled={unsupported}>
          Connect a computer
        </button>
      }
    >
      {persistence.status === "unsupported" && (
        <Notice tone="warn" alert title="Persistent access is not supported">
          <p>
            Persistent access is not supported on this device. {persistence.reason}. Paired computers cannot be saved
            here, and nothing is written to ordinary browser storage.
          </p>
        </Notice>
      )}
      {listing.kind === "loading" && <SkeletonList rows={3} label="Loading computers" />}
      {listing.kind === "error" && (
        <Notice tone="bad" alert title="Could not read paired computers">
          <p>{listing.message}</p>
          <button type="button" className="button button-secondary" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </Notice>
      )}
      {listing.kind === "ready" && listing.computers.length === 0 && (
        <Empty title="No computers paired yet.">
          <ol className="steps">
            <li>Install and start Agentik on your computer.</li>
            <li>It shows a pairing QR code.</li>
            <li>Tap “Connect a computer” below and scan it.</li>
          </ol>
        </Empty>
      )}
      {listing.kind === "ready" && listing.computers.length > 0 && (
        <ul className="card-list">
          {listing.computers.map((c) => {
            const status = COMPUTER_STATUS[c.status];
            return (
              <li key={c.id} className="card computer-card">
                <button type="button" className="card-main" onClick={() => onOpen(c)} aria-label={`Open ${c.name}, ${status.label}`}>
                  <span className="card-title-row">
                    <span className="card-title">{c.name}</span>
                    <StatusChip tone={status.tone} label={status.label} />
                  </span>
                  <span className="card-meta">{seenText(c, current)}</span>
                  <span className="card-meta mono">{shortId(c.id)}</span>
                </button>
                <button
                  type="button"
                  className="button button-ghost button-small"
                  onClick={() => {
                    setForgetError(null);
                    setForgetting(c);
                  }}
                  aria-label={`Forget ${c.name}`}
                >
                  Forget
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {forgetting !== null && (
        <ConfirmDialog
          title={`Forget ${forgetting.name}?`}
          confirmLabel="Forget computer"
          destructive
          busy={busy}
          error={forgetError}
          onConfirm={() => void confirmForget()}
          onCancel={() => setForgetting(null)}
        >
          <p>This removes the pinned key from this phone only.</p>
          <p className="hint">
            The computer keeps its record of this phone until you revoke it there. To use the computer again you need a
            new invitation from it.
          </p>
        </ConfirmDialog>
      )}
    </Page>
  );
}
