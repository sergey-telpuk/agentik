import { useEffect, useId, useState } from "react";
import { MAX_PROMPT_LENGTH, type Agent, type AgentikApi, type AgentId, type Project, type TaskSummary } from "../api/types";
import { sentence } from "./format";
import { Notice, Page, SkeletonList, useBusy } from "./kit";
import { ModelSelect, knownModel } from "./ModelSelect";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly computerName: string;
  readonly projectId: string;
  readonly projectName: string;
  /** Offered as a picker when the conversation is started from the home screen. */
  readonly projects?: readonly Project[];
  readonly onProject?: (projectId: string) => void;
  readonly initialPrompt?: string;
  readonly newRequestId: () => string;
  readonly onStarted: (task: TaskSummary) => void;
  readonly onBack: () => void;
}

export function NewTaskScreen({
  api,
  computerId,
  computerName,
  projectId,
  projectName,
  projects,
  onProject,
  initialPrompt = "",
  newRequestId,
  onStarted,
  onBack,
}: Props) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agent, setAgent] = useState<AgentId>("codex");
  // Empty means the agent's own default model.
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  // One id per submitted content: retrying after a lost response reuses it,
  // so the computer returns the same task instead of starting a second one.
  const [request, setRequest] = useState<{ id: string; content: string } | null>(null);
  const [busy, run] = useBusy();
  const promptId = useId();
  const projectPickerId = useId();
  const counterId = useId();
  const modelId = useId();
  const modelHintId = useId();

  useEffect(() => {
    let cancelled = false;
    void api.listAgents(computerId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAgents(result.value);
        // Start on a usable agent: the first one that can run a task.
        const usable = result.value.find((a) => a.status === "available");
        if (usable !== undefined) setAgent(usable.id);
      } else setError(sentence(result.error.message));
    });
    return () => {
      cancelled = true;
    };
  }, [api, computerId]);

  const available = agents?.filter((a) => a.status === "available") ?? [];
  const unavailable = agents?.filter((a) => a.status !== "available") ?? [];
  const selected = agents?.find((a) => a.id === agent);
  const models = selected?.status === "available" ? (selected.models ?? []) : [];
  // A model from another agent's list (or one that vanished) is never sent.
  const chosenModel = knownModel(models, model);
  const trimmed = prompt.trim();
  const tooLong = trimmed.length > MAX_PROMPT_LENGTH;
  const canSubmit = trimmed !== "" && !tooLong && selected?.status === "available" && !busy;

  async function submit(): Promise<void> {
    const content = JSON.stringify([agent, chosenModel, trimmed]);
    const id = request !== null && request.content === content ? request.id : newRequestId();
    setRequest({ id, content });
    const result = await api.startTask(computerId, {
      projectId,
      agent,
      prompt: trimmed,
      requestId: id,
      ...(chosenModel === "" ? {} : { model: chosenModel }),
    });
    if (result.ok) onStarted(result.value);
    else setError(sentence(result.error.message));
  }

  return (
    <Page
      title="New task"
      subtitle={projectName}
      onBack={onBack}
      footer={
        <button
          type="button"
          className="button button-primary button-block"
          disabled={!canSubmit}
          aria-busy={busy}
          onClick={() => void run(submit)}
        >
          {busy ? "Starting…" : "Start task"}
        </button>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void run(submit);
        }}
      >
        <div className="field">
          <label htmlFor={promptId}>What should the agent do?</label>
          <textarea
            id={promptId}
            rows={6}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setError(null);
            }}
            placeholder="For example: check the failing tests and propose a fix"
            aria-describedby={counterId}
            aria-invalid={tooLong}
            disabled={busy}
          />
          <p id={counterId} className={tooLong ? "hint hint-bad" : "hint"}>
            {`${trimmed.length} / ${MAX_PROMPT_LENGTH} characters`}
          </p>
        </div>

        {projects !== undefined && projects.length > 1 && onProject !== undefined && (
          <div className="field">
            <label htmlFor={projectPickerId}>Folder</label>
            <select
              id={projectPickerId}
              className="select"
              value={projectId}
              onChange={(e) => onProject(e.target.value)}
              disabled={busy}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {agents === null && error === null && <SkeletonList rows={1} label="Loading agents" />}

        {/* With one usable agent there is no choice to make, so naming it is
            enough. The others are only worth listing when picking matters. */}
        {available.length === 1 && selected !== undefined && (
          <p className="hint">
            {selected.name} on {computerName}
            {unavailable.length > 0 && ` · ${unavailable.length} other agent${unavailable.length === 1 ? "" : "s"} found but not supported yet`}
          </p>
        )}

        {available.length > 1 && (
          <fieldset className="field">
            <legend>Agent</legend>
            {agents?.map((a) => (
              <label key={a.id} className={a.status === "available" ? "choice" : "choice choice-disabled"}>
                <input
                  type="radio"
                  name="agent"
                  value={a.id}
                  checked={agent === a.id}
                  onChange={() => {
                    setAgent(a.id);
                    setModel("");
                  }}
                  disabled={busy || a.status !== "available"}
                />
                <span className="choice-text">
                  <span className="choice-title">{a.name}</span>
                  <span className="hint">{agentLine(a, computerName)}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {available.length === 0 && agents !== null && (
          <Notice tone="warn" title="No agent is ready">
            <p>
              {unavailable.length === 0
                ? `No coding agent was found on ${computerName}. Install Codex there and sign in.`
                : `${unavailable.length} agent${unavailable.length === 1 ? " was" : "s were"} found on ${computerName}, but none is usable yet. Install Codex there and sign in.`}
            </p>
          </Notice>
        )}

        {selected?.status === "available" && (
          <div className="field">
            <label htmlFor={modelId}>Model</label>
            <ModelSelect
              id={modelId}
              models={models}
              value={chosenModel}
              onChange={setModel}
              disabled={busy || models.length === 0}
              ariaDescribedBy={modelHintId}
            />
            <p id={modelHintId} className="hint">
              {models.length === 0
                ? (selected.modelsNote ?? `${selected.name} offers no model choice here; it uses its own default model.`)
                : (models.find((m) => m.id === chosenModel)?.description ?? "The agent's own default model is used unless you pick one.")}
            </p>
          </div>
        )}

        {selected !== undefined && selected.status !== "available" && (
          <Notice tone="warn" title={`${selected.name} is not available`}>
            <p>{agentLine(selected, computerName)}</p>
          </Notice>
        )}

        {agents !== null && !agents.some((a) => a.status === "available") && (
          <Notice tone="warn" title="No agent is ready">
            <p>Install a supported agent on the computer and sign in there, then come back.</p>
          </Notice>
        )}

        <p className="hint">
          {`Runs on ${computerName} in project “${projectName}” with your user permissions on that computer. Sensitive operations ask for approval on this phone.`}
        </p>

        {error !== null && (
          <Notice tone="bad" alert title="The task was not started">
            <p>{error}</p>
          </Notice>
        )}
      </form>
    </Page>
  );
}

/** One plain-text line saying whether an agent can be used. */
function agentLine(a: Agent, computerName: string): string {
  switch (a.status) {
    case "available":
      return `Version ${a.version ?? "unknown"} on ${computerName}`;
    case "not_installed":
      return `Not installed on ${computerName}`;
    case "not_authorized":
      return `Not signed in on ${computerName}`;
    case "unknown":
      return `Sign-in state unknown on ${computerName}${a.statusText !== undefined ? `: ${a.statusText}` : ""}`;
    case "unsupported":
      return a.statusText ?? "Detected, not supported yet";
  }
}
