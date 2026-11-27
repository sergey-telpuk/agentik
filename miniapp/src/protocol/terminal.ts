/**
 * Terminal methods of the inner protocol (AGENTIK.md section 8.1). Output is
 * pulled with `terminal.read`: each read acknowledges everything up to
 * `after_seq` and may wait up to `wait_ms` for new output.
 */

import type { AgentikRpcClient } from "./client";

export interface TerminalOpenResult {
  readonly session_id: string;
  readonly project_id: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalInputResult {
  readonly session_id: string;
  readonly bytes: number;
}

export interface TerminalResizeResult {
  readonly session_id: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalChunk {
  readonly seq: number;
  /** Standard base64. */
  readonly data: string;
}

export interface TerminalReadResult {
  readonly session_id: string;
  readonly chunks: readonly TerminalChunk[];
  readonly next_seq: number;
  readonly closed: boolean;
  readonly reason?: string;
  readonly exit_code?: number;
  readonly truncated?: boolean;
}

export interface TerminalCloseResult {
  readonly session_id: string;
  readonly closed: boolean;
  readonly reason: string;
  readonly exit_code?: number;
}

/** The longest wait the computer accepts for one read. */
export const TERMINAL_READ_WAIT_MS = 20_000;

export function openTerminal(
  rpc: AgentikRpcClient,
  params: { readonly project_id: string; readonly command?: string; readonly cols: number; readonly rows: number },
): Promise<TerminalOpenResult> {
  const body: Record<string, unknown> = { project_id: params.project_id, cols: params.cols, rows: params.rows };
  if (params.command !== undefined && params.command !== "") body["command"] = params.command;
  return rpc.request("terminal.open", body);
}

export function terminalInput(rpc: AgentikRpcClient, sessionId: string, data: string): Promise<TerminalInputResult> {
  return rpc.request("terminal.input", { session_id: sessionId, data });
}

export function resizeTerminal(rpc: AgentikRpcClient, sessionId: string, cols: number, rows: number): Promise<TerminalResizeResult> {
  return rpc.request("terminal.resize", { session_id: sessionId, cols, rows });
}

export function readTerminal(
  rpc: AgentikRpcClient,
  sessionId: string,
  afterSeq: number,
  waitMs: number,
): Promise<TerminalReadResult> {
  // The client timeout covers the computer's wait plus the round trip.
  return rpc.request("terminal.read", { session_id: sessionId, after_seq: afterSeq, wait_ms: waitMs }, { timeoutMs: waitMs + 15_000 });
}

export function closeTerminal(rpc: AgentikRpcClient, sessionId: string): Promise<TerminalCloseResult> {
  return rpc.request("terminal.close", { session_id: sessionId });
}
