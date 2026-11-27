/**
 * What the terminal screen needs from a terminal emulator. The real one is
 * xterm.js, loaded on demand; tests use a recording fake.
 */

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalView {
  /** Writes untrusted output; the emulator interprets it, never as HTML. */
  write(data: Uint8Array): void;
  /** Keyboard input as the emulator encodes it for the shell. */
  onData(handler: (data: string) => void): () => void;
  /** Fits the emulator to its container and reports the resulting size. */
  fit(): TerminalSize;
  focus(): void;
  dispose(): void;
}

export type TerminalViewFactory = (container: HTMLElement) => Promise<TerminalView>;

/** Loads xterm.js only when a terminal is opened, keeping it out of the main bundle. */
export const createXtermView: TerminalViewFactory = async (container) => {
  const { mountXterm } = await import("./xtermView");
  return mountXterm(container);
};
