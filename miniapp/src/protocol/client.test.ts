import { describe, expect, it } from "vitest";
import type { SecureSession } from "../secure/seam";
import { AgentikRpcClient, RpcClientClosedError, RpcError, RpcTimeoutError } from "./client";
import type { ServerEvent } from "./messages";

function createFakeSession(): {
  session: SecureSession;
  sent: unknown[];
  deliver: (msg: unknown) => void;
} {
  const sent: unknown[] = [];
  const handlers = new Set<(pt: Uint8Array) => void>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    sent,
    deliver: (msg) => {
      const bytes = encoder.encode(typeof msg === "string" ? msg : JSON.stringify(msg));
      for (const h of handlers) h(bytes);
    },
    session: {
      send: (pt) => sent.push(JSON.parse(decoder.decode(pt))),
      onMessage: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close: () => undefined,
    },
  };
}

describe("AgentikRpcClient", () => {
  it("correlates task.start requests and responses over SecureSession", async () => {
    const { session, sent, deliver } = createFakeSession();
    const rpc = new AgentikRpcClient(session);

    const promise = rpc.startTask(
      {
        project_id: "proj-1",
        session_id: null,
        agent: "codex",
        prompt: "Check tests",
      },
      "req-fixed-1",
    );

    expect(sent).toEqual([
      {
        v: 1,
        request_id: "req-fixed-1",
        method: "task.start",
        params: {
          project_id: "proj-1",
          session_id: null,
          agent: "codex",
          prompt: "Check tests",
        },
      },
    ]);

    deliver({
      v: 1,
      type: "response",
      request_id: "req-fixed-1",
      ok: true,
      result: {
        deduplicated: false,
        task: {
          task_id: "task-1",
          session_id: "sess-1",
          project_id: "proj-1",
          agent: "codex",
          prompt: "Check tests",
          state: "accepted",
          result_text: "",
          error_message: "",
          pending_approval: null,
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      },
    });

    const res = await promise;
    expect(res.task.task_id).toBe("task-1");
    expect(res.task.state).toBe("accepted");
    rpc.close();
  });

  it("maps error responses to RpcError and delivers server events", async () => {
    const { session, sent, deliver } = createFakeSession();
    const rpc = new AgentikRpcClient(session);
    const events: ServerEvent[] = [];
    rpc.onEvent((e) => events.push(e));

    const req = rpc.listProjects();
    const reqId = (sent[0] as { request_id: string }).request_id;

    deliver({
      v: 1,
      type: "event",
      event: "session.event",
      data: {
        session_id: "sess-1",
        task_id: "task-1",
        seq: 1,
        kind: "delta",
        payload: { text: "hi" },
        created_at: 1700000000,
      },
    });

    deliver({
      v: 1,
      type: "response",
      request_id: reqId,
      ok: false,
      error: { code: "unauthorized", message: "client not paired" },
    });

    await expect(req).rejects.toEqual(new RpcError("unauthorized", "client not paired"));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("session.event");
    rpc.close();
  });

  it("rejects timed-out and closed requests cleanly", async () => {
    const { session } = createFakeSession();
    const rpc = new AgentikRpcClient(session, { timeoutMs: 20 });

    await expect(rpc.deviceInfo()).rejects.toBeInstanceOf(RpcTimeoutError);

    const pending = rpc.listAgents();
    rpc.close();
    await expect(pending).rejects.toBeInstanceOf(RpcClientClosedError);
  });
});
