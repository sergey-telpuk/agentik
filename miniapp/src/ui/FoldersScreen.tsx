/**
 * The folders an agent may work in on one computer.
 *
 * The computer decides what is permitted, but the decision is made from here:
 * the daemon needs no command-line flags, so this screen is the only way to
 * add one. A path typed here becomes an agent's working directory, which the
 * screen says plainly rather than leaving it to be discovered.
 *
 * Everything from the computer is untrusted and shown as plain text.
 */

import { useEffect, useId, useState } from "react";
import type { AgentikApi, Project } from "../api/types";
import { sentence } from "./format";
import { ConfirmDialog, Empty, Notice, Page, SkeletonList, useBusy } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly computerName: string;
  readonly onBack: () => void;
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly projects: readonly Project[] }
  | { readonly kind: "error"; readonly message: string };

export function FoldersScreen({ api, computerId, computerName, onBack }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<Project | null>(null);
  const [adding, runAdd] = useBusy();
  const [removing, runRemove] = useBusy();
  const [reload, setReload] = useState(0);
  const pathId = useId();

  useEffect(() => {
    let cancelled = false;
    void api.listProjects(computerId).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { kind: "ready", projects: result.value }
          : { kind: "error", message: sentence(result.error.message) },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, computerId, reload]);

  const trimmed = path.trim();

  async function add(): Promise<void> {
    const result = await api.addProject(computerId, trimmed);
    if (!result.ok) {
      setError(sentence(result.error.message));
      return;
    }
    setPath("");
    setError(null);
    setReload((n) => n + 1);
  }

  async function remove(): Promise<void> {
    const project = pendingRemove;
    if (project === null) return;
    const result = await api.removeProject(computerId, project.id);
    setPendingRemove(null);
    if (!result.ok) {
      setError(sentence(result.error.message));
      return;
    }
    setReload((n) => n + 1);
  }

  const projects = state.kind === "ready" ? state.projects : [];

  return (
    <Page title="Folders" subtitle={computerName} onBack={onBack}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed !== "" && !adding) void runAdd(add);
        }}
      >
        <div className="field">
          <label htmlFor={pathId}>Add a folder</label>
          <input
            id={pathId}
            className="input"
            type="text"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
            placeholder="/Users/you/Projects/my-app"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={adding}
          />
          <p className="hint">
            The full path on {computerName}. An agent you start here runs with your permissions on that computer and
            can change anything in the folder.
          </p>
        </div>
        <button type="submit" className="button button-primary button-block" disabled={trimmed === "" || adding} aria-busy={adding}>
          {adding ? "Adding…" : "Add folder"}
        </button>
      </form>

      {error !== null && (
        <Notice tone="bad" alert title="Could not do that">
          <p>{error}</p>
        </Notice>
      )}

      {state.kind === "loading" && <SkeletonList rows={3} label="Loading folders" />}

      {state.kind === "error" && (
        <Notice tone="bad" alert title="Could not load folders">
          <p>{state.message}</p>
        </Notice>
      )}

      {state.kind === "ready" && projects.length === 0 && (
        <Empty title="No folders yet.">
          <p>Add one above, then start a conversation in it.</p>
        </Empty>
      )}

      {projects.length > 0 && (
        <ul className="chat-list">
          {projects.map((p) => (
            <li key={p.id} className="chat-item">
              <span className="chat-open">
                <span className="chat-title">{p.name}</span>
                {p.activeTasks > 0 && (
                  <span className="chat-sub">
                    <span className="dot dot-pulse" aria-hidden="true" />
                    {p.activeTasks === 1 ? "an agent is working" : `${p.activeTasks} agents working`}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="chat-delete"
                onClick={() => setPendingRemove(p)}
                aria-label={`Remove folder: ${p.name}`}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    d="M5 7h14M10 7V5.5h4V7M6.5 7l.8 12h9.4l.8-12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingRemove !== null && (
        <ConfirmDialog
          title={`Remove “${pendingRemove.name}”?`}
          confirmLabel="Remove"
          destructive
          busy={removing}
          onConfirm={() => void runRemove(remove)}
          onCancel={() => setPendingRemove(null)}
        >
          <p>
            Agents can no longer work in this folder. Nothing in it is deleted, and the conversations that ran there
            are kept.
          </p>
        </ConfirmDialog>
      )}
    </Page>
  );
}
