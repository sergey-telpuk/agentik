import { useEffect, useState } from "react";
import type { AgentikApi, ClearLocalDataResult, Diagnostics, StorageAvailability } from "../api/types";
import { sentence } from "./format";
import { ConfirmDialog, Notice, Page, Section, SkeletonList, StatusChip, useBusy, type Tone } from "./kit";

export interface ScenarioOption {
  readonly name: string;
  readonly description: string;
}

interface Props {
  readonly api: AgentikApi;
  /** Demo scenarios to switch between, or empty for the live backend. */
  readonly scenarios: readonly ScenarioOption[];
  readonly onCleared: () => void;
  readonly onBack: () => void;
}

const AVAILABILITY: Readonly<Record<StorageAvailability, { tone: Tone; label: string }>> = {
  available: { tone: "ok", label: "available" },
  unavailable: { tone: "neutral", label: "not supported by this client" },
  failed: { tone: "bad", label: "advertised but failing" },
};

const ACTIVE: Readonly<Record<Diagnostics["storage"]["active"], string>> = {
  secure: "Telegram SecureStorage",
  device: "Telegram DeviceStorage",
  memory: "Memory only (demo)",
  none: "None",
};

export function SettingsScreen({ api, scenarios, onCleared, onBack }: Props) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState<ClearLocalDataResult | null>(null);
  const [busy, run] = useBusy();

  useEffect(() => {
    let cancelled = false;
    void api.getDiagnostics().then((d) => {
      if (!cancelled) setDiagnostics(d);
    });
    return () => {
      cancelled = true;
    };
  }, [api, reload]);

  async function clear(): Promise<void> {
    const result = await api.clearLocalData();
    if (result.ok) {
      setConfirm(false);
      setCleared(result.value);
      setReload((n) => n + 1);
      onCleared();
    } else {
      setError(sentence(result.error.message));
    }
  }

  return (
    <Page title="Settings" subtitle="Diagnostics and local data" onBack={onBack}>
      {diagnostics === null && <SkeletonList rows={5} label="Loading diagnostics" />}
      {diagnostics !== null && (
        <>
          <Section title="App">
            <dl className="facts facts-inline">
              <dt>Version</dt>
              <dd className="mono">{diagnostics.appVersion}</dd>
              <dt>Backend</dt>
              <dd>
                {diagnostics.backend === "mock" ? `Demo data (scenario “${diagnostics.scenario ?? "happy"}”)` : "Live"}
              </dd>
              <dt>Telegram</dt>
              <dd>
                {diagnostics.telegram.isMiniApp
                  ? `Mini App, Bot API ${diagnostics.telegram.platformVersion ?? "unknown"}`
                  : "Not running inside Telegram"}
              </dd>
              <dt>Launch data</dt>
              <dd>{diagnostics.telegram.initDataAvailable ? "Available" : "Not available"}</dd>
            </dl>
          </Section>

          <Section title="Storage">
            <dl className="facts facts-inline">
              <dt>SecureStorage</dt>
              <dd>
                <StatusChip {...AVAILABILITY[diagnostics.storage.secureStorage]} />
              </dd>
              <dt>DeviceStorage</dt>
              <dd>
                <StatusChip {...AVAILABILITY[diagnostics.storage.deviceStorage]} />
              </dd>
              <dt>Pins kept in</dt>
              <dd>{ACTIVE[diagnostics.storage.active]}</dd>
            </dl>
            {diagnostics.storage.active === "none" && (
              <Notice tone="warn" title="Persistent access is not supported">
                <p>{diagnostics.storage.note}</p>
              </Notice>
            )}
            {diagnostics.storage.active === "memory" && (
              <Notice tone="info">
                <p>{diagnostics.storage.note}</p>
              </Notice>
            )}
            <p className="hint">Keys and pins are never written to ordinary browser storage.</p>
          </Section>

          <Section title="Relay">
            {diagnostics.relayUrls.length === 0 ? (
              <p className="hint">No paired computers, so no relay is in use.</p>
            ) : (
              <ul className="plain-list">
                {diagnostics.relayUrls.map((url) => (
                  <li key={url} className="mono">
                    {url}
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">The relay only forwards encrypted messages. It never sees prompts, results or keys.</p>
          </Section>

          <Section title="Local data">
            <p className="hint">
              Removes every pinned computer from this phone. Computers keep their own record of this phone until you
              revoke it on them. If the phone&apos;s own key is unreadable, it is replaced with a new one; a readable key
              is kept.
            </p>
            <button type="button" className="button button-destructive-outline button-block" onClick={() => setConfirm(true)}>
              Clear local pinned data
            </button>
            {cleared !== null && (
              <p className="hint" role="status">
                Local pinned data cleared.
                {cleared.phoneKeyRegenerated &&
                  " The phone key could not be read, so a new one was generated. Every computer must pair this phone again."}
              </p>
            )}
          </Section>

          {scenarios.length > 0 && (
            <Section title="Demo scenarios">
              <p className="hint">Developer preview only. Each link reloads the app with different mock data.</p>
              <ul className="card-list">
                {scenarios.map((s) => (
                  <li key={s.name} className="card">
                    <a
                      className="card-main"
                      href={`?scenario=${encodeURIComponent(s.name)}${window.location.hash}`}
                      aria-current={s.name === diagnostics.scenario ? "true" : undefined}
                    >
                      <span className="card-title-row">
                        <span className="card-title mono">{s.name}</span>
                        {s.name === diagnostics.scenario && <StatusChip tone="info" label="current" />}
                      </span>
                      <span className="card-meta">{s.description}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title="Clear local pinned data?"
          confirmLabel="Clear data"
          destructive
          busy={busy}
          error={error}
          onConfirm={() => void run(clear)}
          onCancel={() => setConfirm(false)}
        >
          <p>Every paired computer will have to be paired again with a new invitation.</p>
        </ConfirmDialog>
      )}
    </Page>
  );
}
