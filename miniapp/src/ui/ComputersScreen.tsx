import { useEffect, useState } from "react";
import type { AgentikApi, Computer } from "../api/types";
import agentikIcon from "../assets/agentik-icon.svg";
import type { PersistenceState } from "../storage/pinnedDevices";
import { sentence, shortId } from "./format";
import { Empty, Notice, Page, SkeletonList } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly persistence: PersistenceState;
  readonly onAdd: () => void;
  readonly onOpen: (computer: Computer) => void;
  readonly onSettings: () => void;
}

type Listing =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly computers: Computer[] }
  | { readonly kind: "error"; readonly message: string };

export function ComputersScreen({ api, persistence, onAdd, onOpen, onSettings }: Props) {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reload, setReload] = useState(0);

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
          {listing.computers.map((c) => (
            // The whole row is tappable with a pointer; keyboard and screen reader users reach the same
            // action through the two real buttons. Clicks on them bubble up to this one handler.
            <li key={c.id} className="computer-row" onClick={() => onOpen(c)}>
              <img className="computer-icon" src={agentikIcon} alt="" width={48} height={48} />
              <button type="button" className="computer-row-main">
                <span className="computer-name">{c.name}</span>
                <span className="computer-id mono">{shortId(c.id)}</span>
              </button>
              <button type="button" className="button button-primary button-pill" aria-label={`Open ${c.name}`}>
                OPEN
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
