import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalView } from "./view";

export function mountXterm(container: HTMLElement): TerminalView {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: "#1e1e1e", foreground: "#e6e6e6" },
    // Output is untrusted: OSC 8 hyperlinks must not navigate the Mini App.
    linkHandler: { activate: () => undefined },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const fit = (): { cols: number; rows: number } => {
    try {
      fitAddon.fit();
    } catch {
      // A hidden or zero-sized container cannot be measured; keep the last size.
    }
    return { cols: term.cols, rows: term.rows };
  };
  fit();

  return {
    write: (data) => term.write(data),
    onData: (handler) => {
      const sub = term.onData(handler);
      return () => sub.dispose();
    },
    fit,
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
}
