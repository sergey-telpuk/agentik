import { useEffect, useState } from "react";
import type { AgentikApi, Computer } from "../api/types";
import agentikIcon from "../assets/agentik-icon.svg";
import type { PersistenceState } from "../storage/pinnedDevices";
import { sentence, shortId } from "./format";
import { Empty, Notice, Page, SettingsButton, SkeletonList } from "./kit";

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
      actions={<SettingsButton onClick={onSettings} />}
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
            <li key={c.id} className="row computer-row" onClick={() => onOpen(c)}>
              <img className="row-icon computer-icon" src={agentikIcon} alt="" width={48} height={48} />
              <button type="button" className="row-main computer-row-main">
                <span className="row-title computer-name">{c.name}</span>
                <span className="row-secondary computer-id mono">{shortId(c.id)}</span>
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
