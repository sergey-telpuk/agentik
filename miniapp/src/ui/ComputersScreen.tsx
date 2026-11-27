import { useEffect, useState } from "react";
import type { AgentikApi, Computer } from "../api/types";
import agentikIcon from "../assets/agentik-icon.svg";
import type { PersistenceState } from "../storage/pinnedDevices";
import { sentence, shortId } from "./format";
import { Empty, Notice, Page, Section, SettingsButton, SkeletonList } from "./kit";

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

const DOWNLOADS_BASE = `${import.meta.env.BASE_URL}downloads/`;

const DOWNLOAD_LINKS: readonly { readonly label: string; readonly href: string }[] = [
  { label: "Apple Silicon (arm64)", href: `${DOWNLOADS_BASE}agentik-darwin-arm64` },
  { label: "Intel (amd64)", href: `${DOWNLOADS_BASE}agentik-darwin-amd64` },
  { label: "Checksums (SHA256SUMS)", href: `${DOWNLOADS_BASE}SHA256SUMS` },
  { label: "All files and instructions", href: DOWNLOADS_BASE },
];

/** Shown only in the empty state: what to download, how pairing works, and what protects the link. */
function GetStarted() {
  return (
    <div className="get-started">
      <Section title="What to download">
        <ul className="plain-list download-links">
          {DOWNLOAD_LINKS.map((l) => (
            <li key={l.href}>
              <a className="download-link" href={l.href} target="_blank" rel="noopener noreferrer">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="How it works">
        <ol className="steps">
          <li>Download the file for your Mac and check the checksum.</li>
          <li>
            In Terminal on your Mac, run the daemon with <code>-pair</code>.
          </li>
          <li>Paste the invitation or scan the QR code here.</li>
          <li>Confirm the pairing with “y” in Terminal on your Mac.</li>
        </ol>
      </Section>
      <Section title="How secure it is">
        <ul className="bullets">
          <li>
            Pairing needs a one-time invitation and your confirmation on your Mac. A phone that was never paired cannot
            connect.
          </li>
          <li>
            Messages between your phone and your Mac are encrypted end to end (Noise protocol). The relay forwards
            encrypted bytes and cannot read them.
          </li>
          <li>Your Mac does not accept incoming connections. The daemon connects outwards.</li>
          <li>
            The files are built from the public source by GitHub Actions. Check the SHA256 checksum before you run a
            file.
          </li>
          <li>
            The files are not signed by Apple yet. macOS may ask you to confirm the first run if you download in a
            browser.
          </li>
        </ul>
      </Section>
    </div>
  );
}

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
          <GetStarted />
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
