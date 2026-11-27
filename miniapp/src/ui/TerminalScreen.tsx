import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentikApi, TerminalClosed } from "../api/types";
import { sentence } from "./format";
import { Notice, Page, StatusChip } from "./kit";
import { TerminalInputQueue } from "./terminal/inputQueue";
import "./terminal/terminal.css";
import { createXtermView, type TerminalSize, type TerminalView, type TerminalViewFactory } from "./terminal/view";

interface Props {
  readonly api: AgentikApi;
  readonly computerId: string;
  readonly projectId: string;
  readonly projectName: string;
  /** Replaceable for tests; defaults to xterm.js, loaded on demand. */
  readonly createView?: TerminalViewFactory;
  readonly onBack: () => void;
}

type Phase =
  | { readonly kind: "opening" }
  | { readonly kind: "open" }
  | ({ readonly kind: "closed" } & TerminalClosed)
  | { readonly kind: "error"; readonly message: string };

/** Keys a phone keyboard lacks, sent as the bytes a terminal would send. */
const KEYS: readonly { readonly label: string; readonly name: string; readonly data: string }[] = [
  { label: "Esc", name: "Escape", data: "\x1b" },
  { label: "Tab", name: "Tab", data: "\t" },
  { label: "^C", name: "Control C", data: "\x03" },
  { label: "^D", name: "Control D", data: "\x04" },
  { label: "↑", name: "Arrow up", data: "\x1b[A" },
  { label: "↓", name: "Arrow down", data: "\x1b[B" },
  { label: "←", name: "Arrow left", data: "\x1b[D" },
  { label: "→", name: "Arrow right", data: "\x1b[C" },
];

const RESIZE_DEBOUNCE_MS = 150;

export function closedText(closed: TerminalClosed): string {
  switch (closed.reason) {
    case "exited":
      return closed.exitCode === null ? "The shell exited." : `The shell exited with code ${closed.exitCode}.`;
    case "closed":
      return "This terminal was closed.";
    case "idle":
      return "The computer closed this terminal after 30 minutes without activity.";
    case "disconnected":
      return "The connection to the computer was lost, so the computer ended this terminal.";
    case "revoked":
      return "The computer revoked this phone.";
    case "shutdown":
      return "Agentik on the computer stopped.";
    case "lost":
      return "The computer no longer knows this terminal.";
    default:
      return `The terminal ended (${closed.reason}).`;
  }
}

export function TerminalScreen({ api, computerId, projectId, projectName, createView = createXtermView, onBack }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "opening" });
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sessionRef = useRef<string | null>(null);
  const queueRef = useRef<TerminalInputQueue | null>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const endedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let view: TerminalView | null = null;
    let offData: (() => void) | null = null;
    let offStream: (() => void) | null = null;
    let sessionId: string | null = null;
    let size: TerminalSize | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    endedRef.current = false;

    const onResize = (): void => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (view === null || sessionId === null || endedRef.current) return;
        const next = view.fit();
        if (size !== null && next.cols === size.cols && next.rows === size.rows) return;
        size = next;
        void api.resizeTerminal(computerId, sessionId, next.cols, next.rows);
      }, RESIZE_DEBOUNCE_MS);
    };

    void (async () => {
      let created: TerminalView;
      try {
        created = await createView(host);
      } catch {
        if (!disposed) setPhase({ kind: "error", message: "The terminal could not be loaded. Check the connection and try again." });
        return;
      }
      if (disposed) {
        created.dispose();
        return;
      }
      view = created;
      viewRef.current = created;
      size = created.fit();

      const opened = await api.openTerminal(computerId, { projectId, cols: size.cols, rows: size.rows });
      if (disposed) {
        if (opened.ok) void api.closeTerminal(computerId, opened.value.sessionId);
        return;
      }
      if (!opened.ok) {
        setPhase({ kind: "error", message: sentence(opened.error.message) });
        return;
      }
      const id = opened.value.sessionId;
      sessionId = id;
      sessionRef.current = id;
      const queue = new TerminalInputQueue(
        (data) => api.sendTerminalInput(computerId, id, data),
        (error) => setNotice(sentence(error.message)),
      );
      queueRef.current = queue;
      offData = created.onData((data) => queue.push(data));
      offStream = api.streamTerminal(computerId, id, {
        onOutput: (data) => created.write(data),
        onClosed: (closed) => {
          endedRef.current = true;
          queue.close();
          setPhase({ kind: "closed", ...closed });
        },
      });
      if (!endedRef.current) setPhase({ kind: "open" });
      window.addEventListener("resize", onResize);
      created.focus();
    })();

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
      offData?.();
      offStream?.();
      queueRef.current?.close();
      queueRef.current = null;
      // Leaving the screen ends the shell: nothing could reattach to it later.
      if (sessionId !== null && !endedRef.current) void api.closeTerminal(computerId, sessionId);
      sessionRef.current = null;
      viewRef.current = null;
      view?.dispose();
    };
  }, [api, computerId, projectId, createView, attempt]);

  const close = useCallback(async () => {
    const id = sessionRef.current;
    if (id === null || endedRef.current) return;
    endedRef.current = true;
    queueRef.current?.close();
    const result = await api.closeTerminal(computerId, id);
    setPhase((current) =>
      current.kind === "closed"
        ? current
        : { kind: "closed", reason: result.ok ? result.value.reason : "closed", exitCode: result.ok ? result.value.exitCode : null },
    );
  }, [api, computerId]);

  const reopen = useCallback(() => {
    setNotice(null);
    setPhase({ kind: "opening" });
    setAttempt((n) => n + 1);
  }, []);

  const sendKey = (data: string): void => {
    queueRef.current?.push(data);
    viewRef.current?.focus();
  };

  const status =
    phase.kind === "open"
      ? { tone: "ok" as const, label: "Connected" }
      : phase.kind === "opening"
        ? { tone: "info" as const, label: "Opening…" }
        : { tone: "neutral" as const, label: "Closed" };

  return (
    <Page
      title="Terminal"
      subtitle={projectName}
      onBack={onBack}
      actions={<StatusChip tone={status.tone} label={status.label} pulse={phase.kind === "opening"} />}
      footer={
        phase.kind === "open" ? (
          <button type="button" className="button button-destructive-outline button-block" onClick={() => void close()}>
            Close terminal
          </button>
        ) : phase.kind === "closed" || phase.kind === "error" ? (
          <button type="button" className="button button-primary button-block" onClick={reopen}>
            Open a new terminal
          </button>
        ) : undefined
      }
    >
      {phase.kind === "error" && (
        <Notice tone="bad" alert title="Could not open a terminal">
          <p>{phase.message}</p>
        </Notice>
      )}
      {phase.kind === "closed" && (
        <Notice tone="neutral" title="Closed">
          <p>{closedText(phase)}</p>
        </Notice>
      )}
      {notice !== null && phase.kind === "open" && (
        <Notice tone="warn" alert>
          <p>{notice}</p>
        </Notice>
      )}
      <div ref={hostRef} className="terminal-host" aria-label="Terminal output" />
      {phase.kind === "open" && (
        <div className="terminal-keys" role="toolbar" aria-label="Special keys">
          {KEYS.map((key) => (
            <button key={key.name} type="button" className="button button-small terminal-key" aria-label={key.name} onClick={() => sendKey(key.data)}>
              {key.label}
            </button>
          ))}
        </div>
      )}
      <p className="hint">
        A full shell on the computer in this project folder, running as your user. It ends when you leave this screen,
        lose the connection, or after 30 minutes without activity.
      </p>
    </Page>
  );
}
