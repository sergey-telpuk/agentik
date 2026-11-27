/**
 * The task event timeline.
 *
 * Every string here comes from the agent or the computer and is untrusted.
 * It is rendered only as React text children, so markup in it is shown
 * literally and never parsed (AGENTIK.md section 8, "dangerous agent output").
 */

import { memo } from "react";
import { TASK_STATE_LABEL } from "../api/taskState";
import type { TaskEvent } from "../api/types";
import { clockTime, sentence } from "./format";

const KIND_LABEL: Readonly<Record<TaskEvent["kind"], string>> = {
  state: "State",
  message: "Message",
  command: "Command",
  file_change: "File changed",
  approval_requested: "Approval requested",
  approval_resolved: "Decision",
  error: "Error",
};

function Body({ event }: { event: TaskEvent }) {
  switch (event.kind) {
    case "state":
      return (
        <p className="event-text">
          <strong>{sentence(TASK_STATE_LABEL[event.state])}</strong>
          {event.note !== null && <span className="hint"> · {event.note}</span>}
        </p>
      );
    case "message":
      return <p className="event-text plain">{event.text}</p>;
    case "command":
      return (
        <div className="event-command">
          <pre className="code">
            <span aria-hidden="true">$ </span>
            {event.command}
          </pre>
          {event.output !== "" && <pre className="code code-output">{event.output}</pre>}
          {event.exitCode !== null && (
            <p className={event.exitCode === 0 ? "hint" : "hint hint-bad"}>Exit code {event.exitCode}</p>
          )}
        </div>
      );
    case "file_change":
      return (
        <p className="event-text">
          <span className="mono">{event.path}</span>{" "}
          <span className="diffstat">
            <span className="add">+{event.additions}</span> <span className="del">−{event.deletions}</span>
          </span>
        </p>
      );
    case "approval_requested":
      return (
        <div>
          <pre className="code">{event.approval.operation}</pre>
          <p className="hint plain">{event.approval.reason}</p>
        </div>
      );
    case "approval_resolved":
      return (
        <p className="event-text">
          {event.outcome.decision === "approve" ? "You approved this request." : "You denied this request."}
        </p>
      );
    case "error":
      return <p className="event-text plain error-text">{event.text}</p>;
  }
}

function who(event: TaskEvent): string {
  if (event.kind === "message") return event.role === "user" ? "You" : "Codex";
  return KIND_LABEL[event.kind];
}

export const TimelineEvent = memo(function TimelineEvent({ event }: { event: TaskEvent }) {
  return (
    <li className={`event event-${event.kind}${event.kind === "message" ? ` event-${event.role}` : ""}`}>
      <div className="event-head">
        <span className="event-who">{who(event)}</span>
        <time className="event-time" dateTime={new Date(event.at).toISOString()}>
          {clockTime(event.at)}
        </time>
      </div>
      <Body event={event} />
    </li>
  );
});

export function Timeline({ events }: { events: readonly TaskEvent[] }) {
  return (
    <ol className="timeline" aria-label="Task events">
      {events.map((e) => (
        <TimelineEvent key={e.seq} event={e} />
      ))}
    </ol>
  );
}
