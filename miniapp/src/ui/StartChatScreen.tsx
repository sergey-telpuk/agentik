/**
 * Starting a conversation from the home screen.
 *
 * The user's intent is "tell an agent what to do", not "pick a computer, then
 * a project, then write". So this screen resolves that context itself — the
 * folder used last, or the only one there is — and shows the message box
 * straight away. Picking a different folder stays possible, but is not a step
 * on the way.
 */

import { useEffect, useState } from "react";
import type { AgentikApi, Computer, Project, TaskSummary } from "../api/types";
import { sentence } from "./format";
import { Empty, Notice, Page, SkeletonList } from "./kit";
import { NewTaskScreen } from "./NewTaskScreen";

interface Props {
  readonly api: AgentikApi;
  readonly newRequestId: () => string;
  /** Where the conversation that was just started should open. */
  readonly onStarted: (computer: Computer, project: Project, task: TaskSummary) => void;
  /** The computers screen, for pairing when there is nothing to write to. */
  readonly onComputers: () => void;
  readonly onBack: () => void;
}

/**
 * The folder a conversation was last started in, so the next one defaults to
 * it. Kept in memory for this run only: nothing about the user's computers is
 * written to web storage.
 */
let lastProject: { computerId: string; projectId: string } | null = null;

export function rememberLastProject(computerId: string, projectId: string): void {
  lastProject = { computerId, projectId };
}

interface Target {
  readonly computer: Computer;
  readonly projects: readonly Project[];
  readonly project: Project;
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly target: Target }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

export function StartChatScreen({ api, newRequestId, onStarted, onComputers, onBack }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const listed = await api.listComputers();
      if (cancelled) return;
      if (!listed.ok) {
        setState({ kind: "error", message: sentence(listed.error.message) });
        return;
      }
      // A computer that has not confirmed this phone cannot run anything yet.
      const usable = listed.value.filter((c) => c.status !== "pending_confirmation" && c.status !== "revoked" && c.status !== "replaced");
      if (usable.length === 0) {
        setState({ kind: "empty" });
        return;
      }
      const last = lastProject;
      const preferred = usable.find((c) => c.id === last?.computerId) ?? usable[0];
      if (preferred === undefined) {
        setState({ kind: "empty" });
        return;
      }
      const projects = await api.listProjects(preferred.id);
      if (cancelled) return;
      if (!projects.ok) {
        setState({ kind: "error", message: sentence(projects.error.message) });
        return;
      }
      if (projects.value.length === 0) {
        setState({ kind: "empty" });
        return;
      }
      const project = projects.value.find((p) => p.id === last?.projectId) ?? projects.value[0];
      if (project === undefined) {
        setState({ kind: "empty" });
        return;
      }
      setState({ kind: "ready", target: { computer: preferred, projects: projects.value, project } });
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (state.kind === "loading") {
    return (
      <Page title="New conversation" onBack={onBack}>
        <SkeletonList rows={3} label="Preparing" />
      </Page>
    );
  }

  if (state.kind === "error") {
    return (
      <Page title="New conversation" onBack={onBack}>
        <Notice tone="bad" alert title="Could not start">
          <p>{state.message}</p>
        </Notice>
      </Page>
    );
  }

  if (state.kind === "empty") {
    return (
      <Page title="New conversation" onBack={onBack}>
        <Empty
          title="Nothing to write to yet."
          action={
            <button type="button" className="button button-primary" onClick={onComputers}>
              Open computers
            </button>
          }
        >
          <p>Pair a computer and share a folder with this phone to start a conversation.</p>
        </Empty>
      </Page>
    );
  }

  const { computer, projects } = state.target;
  const project = projects.find((p) => p.id === chosen) ?? state.target.project;

  return (
    <NewTaskScreen
      api={api}
      computerId={computer.id}
      computerName={computer.name}
      projectId={project.id}
      projectName={project.name}
      projects={projects}
      onProject={(id) => setChosen(id)}
      newRequestId={newRequestId}
      onStarted={(task) => {
        rememberLastProject(computer.id, project.id);
        onStarted(computer, project, task);
      }}
      onBack={onBack}
    />
  );
}
