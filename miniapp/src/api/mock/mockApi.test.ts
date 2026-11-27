import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInvitation } from "../../pairing/invitation";
import { asText, NOW_MS, validWire } from "../../pairing/testing";
import { MemoryBackend } from "../../storage/fakes";
import { PinnedDeviceStore } from "../../storage/pinnedDevices";
import { noTelegramRuntime } from "../../telegram/runtime";
import { canTransition, type TaskState } from "../taskState";
import type { AgentikApi, ApiResult, ConnectionState, TaskEvent, TaskSummary, TaskUpdate } from "../types";
import { APPROVAL_TTL_MS, CANCEL_CONFIRM_MS, createMockApi } from "./mockApi";
import { SCENARIOS, demoDeviceId, readScenario, type ScenarioName } from "./scenarios";

const MAIN = demoDeviceId(1);
const PENDING = demoDeviceId(3);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup(scenario: ScenarioName, backend = new MemoryBackend()) {
  const store = await PinnedDeviceStore.open({ secure: backend, device: null });
  const api = createMockApi({
    scenario,
    store,
    runtime: noTelegramRuntime,
    appVersion: "test",
    describeStorage: () =>
      Promise.resolve({ secureStorage: "available", deviceStorage: "unavailable", active: "secure", note: null }),
  });
  return { api, store, backend };
}

function value<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function connect(api: AgentikApi, id: string, ms = 10_000): Promise<ConnectionState[]> {
  const phases: ConnectionState[] = [];
  api.connect(id, (s) => phases.push(s));
  await vi.advanceTimersByTimeAsync(ms);
  return phases;
}

function collect(api: AgentikApi, computerId: string, taskId: string, afterSeq = 0) {
  const events: TaskEvent[] = [];
  let task: TaskSummary | null = null;
  const stop = api.streamEvents(computerId, taskId, afterSeq, (u: TaskUpdate) => {
    events.push(...u.events);
    task = u.task;
  });
  return { events, latest: () => task, stop };
}

function stateEvents(events: readonly TaskEvent[]): TaskState[] {
  return events.flatMap((e) => (e.kind === "state" ? [e.state] : []));
}

function expectValidPath(states: TaskState[]): void {
  for (let i = 1; i < states.length; i++) {
    expect(canTransition(states[i - 1] as TaskState, states[i] as TaskState), `${states[i - 1]} -> ${states[i]}`).toBe(
      true,
    );
  }
}

let requestCounter = 0;
function start(api: AgentikApi, projectId = "proj_billing", prompt = "Make the tests pass") {
  requestCounter += 1;
  return api.startTask(MAIN, { projectId, agent: "codex", prompt, requestId: `req-${requestCounter}` });
}

describe("scenario selection", () => {
  it("defaults to the happy path and ignores unknown values", () => {
    expect(readScenario("")).toBe("happy");
    expect(readScenario("?scenario=nope")).toBe("happy");
    expect(readScenario("?scenario=revoked")).toBe("revoked");
  });

  it("builds every scenario without invalid task transitions", async () => {
    for (const name of SCENARIOS) {
      const { api } = await setup(name);
      expect(value(await api.listComputers())).toBeInstanceOf(Array);
    }
  });
});

describe("computers", () => {
  it("lists computers with every status in the happy path", async () => {
    const { api } = await setup("happy");
    const computers = value(await api.listComputers());
    expect(computers.map((c) => c.status)).toEqual(["online", "offline", "pending_confirmation", "replaced"]);
  });

  it("has no computers in the empty scenario", async () => {
    const { api } = await setup("empty");
    expect(value(await api.listComputers())).toEqual([]);
  });

  it("pins an invitation as pending confirmation and forgets it", async () => {
    const { api, backend } = await setup("empty");
    const parsed = await parseInvitation(asText(validWire()), NOW_MS);
    if (!parsed.ok) throw new Error("fixture invitation is invalid");
    const computer = value(await api.pairComputer(parsed.value));
    expect(computer.status).toBe("pending_confirmation");
    expect([...backend.data.values()].join()).not.toContain(String(validWire()["invitation_secret"]));
    value(await api.forgetComputer(computer.id));
    expect(value(await api.listComputers())).toEqual([]);
  });

  it("clears every local pin", async () => {
    const { api } = await setup("happy");
    value(await api.clearLocalData());
    expect(value(await api.listComputers())).toEqual([]);
  });
});

describe("connect", () => {
  it("reaches a secure session on an online computer", async () => {
    const { api } = await setup("happy");
    expect((await api.listProjects(MAIN)).ok).toBe(false);
    const phases = await connect(api, MAIN);
    expect(phases.map((p) => p.phase)).toEqual(["connecting", "handshaking", "synchronizing", "ready"]);
    const projects = value(await api.listProjects(MAIN));
    expect(projects.map((p) => p.id)).toEqual(["proj_agentik", "proj_billing", "proj_dotfiles"]);
    expect(JSON.stringify(projects)).not.toMatch(/\/Users|\\|~\//);
  });

  it("fails with a retryable error when the computer is offline", async () => {
    const { api } = await setup("offline");
    const last = (await connect(api, MAIN)).at(-1);
    expect(last).toMatchObject({ phase: "failed", reason: "computer_offline", retryable: true });
    expect(await api.listProjects(MAIN)).toMatchObject({ ok: false, error: { code: "not_connected" } });
  });

  it("refuses a replaced key without offering a retry", async () => {
    const { api } = await setup("happy");
    const last = (await connect(api, demoDeviceId(4))).at(-1);
    expect(last).toMatchObject({ phase: "failed", reason: "key_mismatch", retryable: false });
  });

  it("succeeds on retry after a failed handshake", async () => {
    const { api } = await setup("connect_failed");
    expect((await connect(api, MAIN)).at(-1)).toMatchObject({ phase: "failed", reason: "handshake_failed" });
    expect((await connect(api, MAIN)).at(-1)).toMatchObject({ phase: "ready" });
  });

  it("waits for local approval on a pending computer, then marks it online", async () => {
    const { api } = await setup("happy");
    const phases = await connect(api, PENDING);
    expect(phases.map((p) => p.phase)).toContain("awaiting_local_approval");
    expect(phases.at(-1)?.phase).toBe("ready");
    const computers = value(await api.listComputers());
    expect(computers.find((c) => c.id === PENDING)?.status).toBe("online");
  });

  it("ends access when the computer revokes the phone", async () => {
    const { api } = await setup("revoked");
    const phases = await connect(api, MAIN, 20_000);
    expect(phases.at(-1)?.phase).toBe("revoked");
    expect(await api.listProjects(MAIN)).toMatchObject({ ok: false, error: { code: "revoked" } });
    expect(value(await api.listComputers()).find((c) => c.id === MAIN)?.status).toBe("revoked");
    expect((await connect(api, MAIN)).at(-1)?.phase).toBe("revoked");
  });
});

describe("tasks", () => {
  it("runs a new task to success through valid states and keeps a result", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    const task = value(await start(api));
    expect(task.state).toBe("accepted");
    const stream = collect(api, MAIN, task.id);
    await vi.advanceTimersByTimeAsync(30_000);
    const states = stateEvents(stream.events);
    expect(states[0]).toBe("accepted");
    expect(states.at(-1)).toBe("succeeded");
    expectValidPath(states);
    expect(stream.events.map((e) => e.seq)).toEqual(stream.events.map((_, i) => i + 1));
    const result = value(await api.getResult(MAIN, task.id));
    expect(result.output).toContain("/healthz");
    expect(result.changes).toEqual([{ path: "relay/src/index.ts", additions: 6, deletions: 0 }]);
  });

  it("keeps running after the stream is closed", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    const task = value(await start(api));
    const stream = collect(api, MAIN, task.id);
    await vi.advanceTimersByTimeAsync(1000);
    stream.stop();
    const seen = stream.events.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stream.events.length).toBe(seen);
    expect(value(await api.getTask(MAIN, task.id)).state).toBe("succeeded");
    // Reopening replays only what was missed.
    const resumed = collect(api, MAIN, task.id, seen);
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed.events[0]?.seq).toBe(seen + 1);
  });

  it("returns the original task for a repeated request id and rejects changed content", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    const input = { projectId: "proj_billing", agent: "codex" as const, prompt: "Fix it", requestId: "same" };
    const first = value(await api.startTask(MAIN, input));
    expect(value(await api.startTask(MAIN, input)).id).toBe(first.id);
    expect(await api.startTask(MAIN, { ...input, prompt: "Something else" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("validates the chosen agent and model, and a different model under one request id conflicts", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    const agents = value(await api.listAgents(MAIN));
    expect(agents.map((a) => [a.id, a.status])).toEqual([
      ["codex", "available"],
      ["claude", "unsupported"],
    ]);
    const base = { projectId: "proj_billing", agent: "codex", prompt: "Fix it" };
    expect(await api.startTask(MAIN, { ...base, model: "nope", requestId: "m1" })).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await api.startTask(MAIN, { ...base, agent: "claude", requestId: "m2" })).toMatchObject({
      ok: false,
      error: { code: "agent_unavailable" },
    });
    const first = value(await api.startTask(MAIN, { ...base, model: "mock-small", requestId: "m3" }));
    expect(value(await api.startTask(MAIN, { ...base, model: "mock-small", requestId: "m3" })).id).toBe(first.id);
    expect(await api.startTask(MAIN, { ...base, model: "mock-large", requestId: "m3" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("continues a conversation with a chosen model, validates it, and reports the model of each turn", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    const first = value(await start(api, "proj_billing", "Look at the invoice rounding"));
    await vi.advanceTimersByTimeAsync(30_000);
    const follow = { projectId: "proj_billing", agent: "codex", sessionId: first.sessionId };

    // An unknown model is rejected and does not start a turn.
    expect(
      await api.startTask(MAIN, { ...follow, prompt: "Which rounding?", model: "nope", requestId: "f-bad" }),
    ).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(value(await api.getSession(MAIN, "proj_billing", first.sessionId)).turns).toHaveLength(1);

    const small = value(
      await api.startTask(MAIN, { ...follow, prompt: "Which rounding?", model: "mock-small", requestId: "f-small" }),
    );
    expect(small.model).toBe("mock-small");
    await vi.advanceTimersByTimeAsync(30_000);
    const plain = value(await api.startTask(MAIN, { ...follow, prompt: "And the tax?", requestId: "f-plain" }));
    expect(plain.model).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);

    const turns = value(await api.getSession(MAIN, "proj_billing", first.sessionId)).turns;
    expect(turns.map((t) => t.model)).toEqual([undefined, "mock-small", undefined]);
  });

  it("reports busy while another task is active in the same project", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    value(await start(api));
    expect(await start(api)).toMatchObject({ ok: false, error: { code: "busy" } });
  });

  it("requests a stop first and confirms cancellation later", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    const task = value(await start(api));
    await vi.advanceTimersByTimeAsync(2000);
    expect(value(await api.cancelTask(MAIN, task.id)).state).toBe("cancel_requested");
    expect(await api.cancelTask(MAIN, task.id)).toMatchObject({ ok: false, error: { code: "invalid" } });
    await vi.advanceTimersByTimeAsync(CANCEL_CONFIRM_MS);
    expect(value(await api.getTask(MAIN, task.id)).state).toBe("cancelled");
  });

  it("ends a failed run with the confirmed error", async () => {
    const { api } = await setup("failed");
    await connect(api, MAIN);
    const task = value(await start(api));
    await vi.advanceTimersByTimeAsync(30_000);
    const result = value(await api.getResult(MAIN, task.id));
    expect(result.state).toBe("failed");
    expect(result.error).toContain("usage limit");
  });

  it("marks an unknown launch outcome as recovery_required and never retries it", async () => {
    const { api } = await setup("recovery");
    await connect(api, MAIN);
    const task = value(await start(api));
    const stream = collect(api, MAIN, task.id);
    await vi.advanceTimersByTimeAsync(30_000);
    const after = stream.events.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(stream.events.length).toBe(after);
    expect(stateEvents(stream.events)).not.toContain("running");
    const result = value(await api.getResult(MAIN, task.id));
    expect(result.state).toBe("recovery_required");
    expect(result.recovery).toContain("not started again automatically");
  });

  it("refuses to start a task when Codex is missing", async () => {
    const { api } = await setup("codex_missing");
    await connect(api, MAIN);
    expect(value(await api.listAgents(MAIN))[0]?.status).toBe("not_installed");
    expect(await start(api)).toMatchObject({ ok: false, error: { code: "agent_unavailable" } });
  });
});

describe("conversations", () => {
  it("seeds a multi-turn conversation in the happy path, oldest turn first", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    const tasks = value(await api.listTasks(MAIN, "proj_agentik"));
    const first = tasks.find((t) => t.prompt === "Add a health check endpoint to the relay");
    expect(first).toBeDefined();
    const session = value(await api.getSession(MAIN, "proj_agentik", first?.sessionId ?? ""));
    expect(session.turns.map((t) => t.prompt)).toEqual([
      "Add a health check endpoint to the relay",
      "Now add a regression test for it",
      "Did you touch anything else?",
    ]);
    expect(new Set(session.turns.map((t) => t.sessionId)).size).toBe(1);
    expect(session.turns.every((t) => t.state === "succeeded")).toBe(true);
    const second = value(await api.getResult(MAIN, session.turns[1]?.id ?? ""));
    expect(second.changes).toEqual([{ path: "relay/src/index.test.ts", additions: 7, deletions: 0 }]);
  });

  it("lists the seeded conversation as one row with its first message and turn count", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    const listing = value(await api.listConversations(MAIN, "proj_agentik"));
    expect(listing.source).toBe("computer");
    expect(listing.warning).toBeNull();
    const seeded = listing.conversations.find((c) => c.title === "Add a health check endpoint to the relay");
    expect(seeded).toMatchObject({ turns: 3, latestState: "succeeded", projectId: "proj_agentik" });
    expect(new Set(listing.conversations.map((c) => c.sessionId)).size).toBe(listing.conversations.length);
    expect(value(await api.listConversations(MAIN, "proj_unknown")).conversations).toEqual([]);
  });

  it("continues a conversation in the same session and refuses an unknown one", async () => {
    const { api } = await setup("happy");
    await connect(api, MAIN);
    const first = value(await start(api, "proj_billing", "Look at the invoice rounding"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(value(await api.getTask(MAIN, first.id)).state).toBe("succeeded");

    const follow = value(
      await api.startTask(MAIN, {
        projectId: "proj_billing",
        agent: "codex",
        prompt: "And the tax rounding?",
        requestId: "follow-1",
        sessionId: first.sessionId,
      }),
    );
    expect(follow.sessionId).toBe(first.sessionId);
    expect(follow.id).not.toBe(first.id);
    // A repeated request id returns the same turn; changed content is a conflict.
    const again = await api.startTask(MAIN, {
      projectId: "proj_billing",
      agent: "codex",
      prompt: "And the tax rounding?",
      requestId: "follow-1",
      sessionId: first.sessionId,
    });
    expect(value(again).id).toBe(follow.id);
    expect(
      await api.startTask(MAIN, {
        projectId: "proj_billing",
        agent: "codex",
        prompt: "And the tax rounding?",
        requestId: "follow-1",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    // The previous turn must finish before the next one starts.
    expect(
      await api.startTask(MAIN, {
        projectId: "proj_billing",
        agent: "codex",
        prompt: "Too early",
        requestId: "follow-2",
        sessionId: first.sessionId,
      }),
    ).toMatchObject({ ok: false, error: { code: "busy" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(value(await api.getSession(MAIN, "proj_billing", first.sessionId)).turns.map((t) => t.id)).toEqual([
      first.id,
      follow.id,
    ]);

    expect(
      await api.startTask(MAIN, {
        projectId: "proj_billing",
        agent: "codex",
        prompt: "Hello?",
        requestId: "follow-3",
        sessionId: "ses_unknown",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await api.getSession(MAIN, "proj_billing", "ses_unknown")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("approvals", () => {
  async function twoPendingApprovals() {
    const { api } = await setup("approval");
    await connect(api, MAIN);
    const waiting = value(await api.listTasks(MAIN, "proj_agentik")).find((t) => t.state === "awaiting_approval");
    if (waiting?.pendingApproval == null) throw new Error("approval scenario has no waiting task");
    const other = value(await start(api, "proj_billing"));
    await vi.advanceTimersByTimeAsync(10_000);
    const otherTask = value(await api.getTask(MAIN, other.id));
    if (otherTask.pendingApproval === null) throw new Error("second task did not ask for approval");
    return { api, first: waiting, second: otherTask };
  }

  it("applies a decision only to the request it names", async () => {
    const { api, first, second } = await twoPendingApprovals();
    const firstApproval = first.pendingApproval;
    const secondApproval = second.pendingApproval;
    if (firstApproval === null || secondApproval === null) throw new Error("missing approvals");
    expect(firstApproval.id).not.toBe(secondApproval.id);

    // The second task's approval id cannot decide the first task's request.
    expect(
      await api.respondApproval(MAIN, { taskId: first.id, approvalId: secondApproval.id, decision: "approve" }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(value(await api.getTask(MAIN, first.id)).pendingApproval?.id).toBe(firstApproval.id);

    value(await api.respondApproval(MAIN, { taskId: first.id, approvalId: firstApproval.id, decision: "approve" }));
    expect(value(await api.getTask(MAIN, first.id)).state).toBe("running");
    // The other task is still waiting on its own request.
    const untouched = value(await api.getTask(MAIN, second.id));
    expect(untouched.state).toBe("awaiting_approval");
    expect(untouched.pendingApproval?.id).toBe(secondApproval.id);
  });

  it("rejects a repeated decision and does not carry it over to the next request", async () => {
    const { api, first } = await twoPendingApprovals();
    const approvalId = first.pendingApproval?.id ?? "";
    value(await api.respondApproval(MAIN, { taskId: first.id, approvalId, decision: "approve" }));
    expect(await api.respondApproval(MAIN, { taskId: first.id, approvalId, decision: "approve" })).toMatchObject({
      ok: false,
      error: { code: "already_resolved" },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const next = value(await api.getTask(MAIN, first.id));
    expect(next.state).toBe("awaiting_approval");
    expect(next.pendingApproval?.id).not.toBe(approvalId);
    expect(await api.respondApproval(MAIN, { taskId: first.id, approvalId, decision: "deny" })).toMatchObject({
      ok: false,
      error: { code: "already_resolved" },
    });
    expect(value(await api.getTask(MAIN, first.id)).state).toBe("awaiting_approval");
  });

  it("rejects an expired decision", async () => {
    const { api, second } = await twoPendingApprovals();
    await vi.advanceTimersByTimeAsync(APPROVAL_TTL_MS + 1000);
    expect(
      await api.respondApproval(MAIN, {
        taskId: second.id,
        approvalId: second.pendingApproval?.id ?? "",
        decision: "approve",
      }),
    ).toMatchObject({ ok: false, error: { code: "expired" } });
  });

  it("withdraws a pending approval when the task is stopped", async () => {
    const { api, second } = await twoPendingApprovals();
    const stopped = value(await api.cancelTask(MAIN, second.id));
    expect(stopped.state).toBe("cancel_requested");
    expect(stopped.pendingApproval).toBeNull();
    expect(
      await api.respondApproval(MAIN, {
        taskId: second.id,
        approvalId: second.pendingApproval?.id ?? "",
        decision: "approve",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
