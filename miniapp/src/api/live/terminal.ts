/**
 * The terminal part of the live `AgentikApi` (AGENTIK.md section 8.1).
 *
 * Output is pulled in a loop of long-polling `terminal.read` calls, one at a
 * time, so each read acknowledges the previous one and a slow phone slows the
 * computer down instead of piling up output.
 */

import { decodeBase64, encodeBase64 } from "../../encoding";
import { RpcError, RpcTimeoutError, type AgentikRpcClient } from "../../protocol/client";
import * as wire from "../../protocol/terminal";
import { MAX_TERMINAL_INPUT_BYTES, type AgentikApi, type ApiError, type ApiResult, type TerminalClosed } from "../types";
import { apiErrorFrom, isUnsupportedMethod } from "./mapping";

type TerminalApi = Pick<AgentikApi, "openTerminal" | "sendTerminalInput" | "resizeTerminal" | "closeTerminal" | "streamTerminal">;

export interface LiveTerminalDeps {
  /** The ready RPC client of a computer, or why there is none. */
  readonly session: (computerId: string) => ApiResult<AgentikRpcClient>;
  readonly readWaitMs?: number;
}

/** Timeouts in a row after which a stream gives up. */
const MAX_READ_TIMEOUTS = 3;

function terminalError(err: unknown): ApiError {
  if (isUnsupportedMethod(err)) {
    return { code: "invalid", message: "This computer has no terminal yet. Update Agentik on the computer." };
  }
  if (err instanceof RpcError) {
    switch (err.code) {
      case "terminal_closed":
        return { code: "not_found", message: "The terminal session has ended." };
      case "terminal_busy":
        return { code: "busy", message: "The terminal is not reading input right now. Try again." };
      case "too_many_terminals":
        return { code: "busy", message: "Too many terminals are open on this computer. Close one first." };
    }
  }
  return apiErrorFrom(err);
}

export function createLiveTerminal(deps: LiveTerminalDeps): TerminalApi {
  const readWaitMs = deps.readWaitMs ?? wire.TERMINAL_READ_WAIT_MS;

  async function call<T>(computerId: string, work: (rpc: AgentikRpcClient) => Promise<T>): Promise<ApiResult<T>> {
    const rpc = deps.session(computerId);
    if (!rpc.ok) return rpc;
    try {
      return { ok: true, value: await work(rpc.value) };
    } catch (err) {
      return { ok: false, error: terminalError(err) };
    }
  }

  return {
    async openTerminal(computerId, input) {
      return call(computerId, async (rpc) => {
        const opened = await wire.openTerminal(rpc, {
          project_id: input.projectId,
          cols: input.cols,
          rows: input.rows,
          ...(input.command === undefined ? {} : { command: input.command }),
        });
        return { sessionId: opened.session_id, projectId: opened.project_id };
      });
    },

    async sendTerminalInput(computerId, sessionId, data) {
      if (data.length === 0 || data.length > MAX_TERMINAL_INPUT_BYTES) {
        return { ok: false, error: { code: "invalid", message: `Terminal input must be 1 to ${MAX_TERMINAL_INPUT_BYTES} bytes.` } };
      }
      return call(computerId, async (rpc) => {
        await wire.terminalInput(rpc, sessionId, encodeBase64(data));
        return null;
      });
    },

    async resizeTerminal(computerId, sessionId, cols, rows) {
      return call(computerId, async (rpc) => {
        await wire.resizeTerminal(rpc, sessionId, cols, rows);
        return null;
      });
    },

    async closeTerminal(computerId, sessionId) {
      return call(computerId, async (rpc): Promise<TerminalClosed> => {
        const closed = await wire.closeTerminal(rpc, sessionId);
        return { reason: closed.reason, exitCode: closed.exit_code ?? null };
      });
    },

    streamTerminal(computerId, sessionId, handlers) {
      let stopped = false;
      let after = 0;
      const finish = (closed: TerminalClosed): void => {
        if (stopped) return;
        stopped = true;
        handlers.onClosed(closed);
      };

      const loop = async (): Promise<void> => {
        let timeouts = 0;
        while (!stopped) {
          const rpc = deps.session(computerId);
          if (!rpc.ok) {
            // The computer ends a terminal when its secure session closes.
            finish({ reason: "disconnected", exitCode: null });
            return;
          }
          let res: wire.TerminalReadResult;
          try {
            res = await wire.readTerminal(rpc.value, sessionId, after, readWaitMs);
          } catch (err) {
            if (stopped) return;
            if (err instanceof RpcTimeoutError && ++timeouts < MAX_READ_TIMEOUTS) continue;
            const error = terminalError(err);
            finish({ reason: error.code === "not_found" ? "lost" : "disconnected", exitCode: null });
            return;
          }
          if (stopped) return;
          timeouts = 0;
          for (const chunk of res.chunks) {
            if (chunk.seq <= after) continue;
            after = chunk.seq;
            const bytes = decodeBase64(chunk.data);
            if (bytes !== null && bytes.length > 0) handlers.onOutput(bytes);
          }
          after = Math.max(after, res.next_seq);
          if (res.closed) {
            finish({ reason: res.reason ?? "closed", exitCode: res.exit_code ?? null });
            return;
          }
        }
      };
      void loop();
      return () => {
        stopped = true;
      };
    },
  };
}
