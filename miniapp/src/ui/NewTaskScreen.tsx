import { useEffect, useId, useState } from "react";
import { MAX_PROMPT_LENGTH, type Agent, type AgentikApi, type AgentId, type TaskSummary } from "../api/types";
import { sentence } from "./format";
import { Notice, Page, SkeletonList, useBusy } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly computerName: string;
  readonly projectId: string;
  readonly projectName: string;
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
  initialPrompt = "",
  newRequestId,
  onStarted,
  onBack,
}: Props) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agent, setAgent] = useState<AgentId>("codex");
  const [error, setError] = useState<string | null>(null);
  // One id per submitted content: retrying after a lost response reuses it,
  // so the computer returns the same task instead of starting a second one.
  const [request, setRequest] = useState<{ id: string; content: string } | null>(null);
  const [busy, run] = useBusy();
  const promptId = useId();
  const counterId = useId();

  useEffect(() => {
    let cancelled = false;
    void api.listAgents(computerId).then((result) => {
      if (cancelled) return;
      if (result.ok) setAgents(result.value);
      else setError(sentence(result.error.message));
    });
    return () => {
      cancelled = true;
    };
  }, [api, computerId]);

  const selected = agents?.find((a) => a.id === agent);
  const trimmed = prompt.trim();
  const tooLong = trimmed.length > MAX_PROMPT_LENGTH;
  const canSubmit = trimmed !== "" && !tooLong && selected?.status === "available" && !busy;

  async function submit(): Promise<void> {
    const content = JSON.stringify([agent, trimmed]);
    const id = request !== null && request.content === content ? request.id : newRequestId();
    setRequest({ id, content });
    const result = await api.startTask(computerId, { projectId, agent, prompt: trimmed, requestId: id });
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

        <fieldset className="field">
          <legend>Agent</legend>
          {agents === null && error === null && <SkeletonList rows={1} label="Loading agents" />}
          {agents?.map((a) => (
            <label key={a.id} className={a.status === "available" ? "choice" : "choice choice-disabled"}>
              <input
                type="radio"
                name="agent"
                value={a.id}
                checked={agent === a.id}
                onChange={() => setAgent(a.id)}
                disabled={busy}
              />
              <span className="choice-text">
                <span className="choice-title">{a.name}</span>
                <span className="hint">
                  {a.status === "available"
                    ? `Version ${a.version ?? "unknown"} on ${computerName}`
                    : a.status === "not_installed"
                      ? `Not installed on ${computerName}`
                      : `Not signed in on ${computerName}`}
                </span>
              </span>
            </label>
          ))}
          <p className="hint">Only Codex is supported in this version.</p>
        </fieldset>

        {selected !== undefined && selected.status !== "available" && (
          <Notice tone="warn" title="Codex is not available">
            <p>Install Codex on the computer and sign in there, then come back.</p>
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
