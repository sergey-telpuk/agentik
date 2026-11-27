import { useState } from "react";
import type { AgentikApi, ApprovalDecision, ApprovalRequest } from "../api/types";
import { countdown, sentence } from "./format";
import { Notice, Sheet, useBusy, useNow } from "./kit";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly request: ApprovalRequest;
  readonly now: () => number;
  readonly onDecided: (decision: ApprovalDecision) => void;
  readonly onClose: () => void;
}

const TITLE: Readonly<Record<ApprovalRequest["kind"], string>> = {
  command: "Allow this command?",
  file_change: "Allow this file change?",
  network: "Allow network access?",
};

export function ApprovalSheet({ api, computerId, request, now, onDecided, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ApprovalDecision | null>(null);
  const [busy, run] = useBusy();
  const current = useNow(1000, now);
  const remaining = request.expiresAt - current;
  const expired = remaining <= 0;

  async function decide(decision: ApprovalDecision): Promise<void> {
    setPending(decision);
    // The decision names this request's id and its task; the computer applies
    // it to nothing else.
    const result = await api.respondApproval(computerId, {
      taskId: request.taskId,
      approvalId: request.id,
      decision,
    });
    setPending(null);
    if (result.ok) onDecided(decision);
    else setError(sentence(result.error.message));
  }

  return (
    <Sheet
      title={TITLE[request.kind]}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <div className="button-row">
            <button
              type="button"
              className="button button-destructive"
              disabled={busy || expired}
              onClick={() => void run(() => decide("deny"))}
              aria-busy={pending === "deny"}
            >
              {pending === "deny" ? "Denying…" : "Deny"}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || expired}
              onClick={() => void run(() => decide("approve"))}
              aria-busy={pending === "approve"}
            >
              {pending === "approve" ? "Approving…" : "Approve"}
            </button>
          </div>
          <button type="button" className="button button-ghost button-block" onClick={onClose} disabled={busy}>
            Decide later
          </button>
        </>
      }
    >
      <dl className="facts">
        <dt>Operation</dt>
        <dd>
          <pre className="code">{request.operation}</pre>
        </dd>
        <dt>Scope</dt>
        <dd className="plain">{request.scope}</dd>
        <dt>Reason given by the agent</dt>
        <dd className="plain">{request.reason}</dd>
        <dt>Request</dt>
        <dd>
          <span className="mono">{request.id}</span>
          <span className="hint"> · {expired ? "expired" : `expires in ${countdown(remaining)}`}</span>
        </dd>
      </dl>
      <p className="hint">
        This decision applies only to this request. Any other operation asks again. Denying does not stop the task.
      </p>
      {expired && (
        <Notice tone="warn">
          <p>This request expired. The agent has to ask again.</p>
        </Notice>
      )}
      {error !== null && (
        <Notice tone="bad" alert>
          <p>{error}</p>
        </Notice>
      )}
    </Sheet>
  );
}
