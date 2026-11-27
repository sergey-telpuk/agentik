/**
 * Deterministic demo data for the mock backend.
 *
 * A scenario decides which computers exist, how connecting to them behaves,
 * which tasks are already in their history, and how a new task runs. The
 * scenario is picked with the dev-only `?scenario=` query parameter (see
 * `readScenario`); the default is the happy path.
 */

import { encodeBase32 } from "../../encoding";
import type { AgentId, ApprovalRequest, ComputerStatus } from "../types";
import type { TaskState } from "../taskState";

export const SCENARIOS = [
  "happy",
  "empty",
  "offline",
  "connect_failed",
  "approval",
  "failed",
  "recovery",
  "revoked",
  "codex_missing",
  "no_storage",
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

export const SCENARIO_DESCRIPTION: Readonly<Record<ScenarioName, string>> = {
  happy: "Several computers; new tasks run to success",
  empty: "No paired computers yet",
  offline: "The main computer is offline",
  connect_failed: "The first secure handshake fails, a retry succeeds",
  approval: "Tasks ask for approvals; one is already waiting",
  failed: "New tasks fail with a confirmed error",
  recovery: "New tasks end in recovery_required after a computer restart",
  revoked: "The computer revokes this phone during the session",
  codex_missing: "Codex is not installed on the computer",
  no_storage: "Telegram secure storage is not available",
};

/** Reads `?scenario=` from a query string. Unknown values fall back to the happy path. */
export function readScenario(search: string): ScenarioName {
  const value = new URLSearchParams(search).get("scenario");
  return (SCENARIOS as readonly string[]).includes(value ?? "") ? (value as ScenarioName) : "happy";
}

/** One step of a scripted task run, applied `after` milliseconds after the previous one. */
export type Step =
  | { readonly after: number; readonly kind: "state"; readonly state: TaskState; readonly note?: string }
  | { readonly after: number; readonly kind: "message"; readonly text: string }
  | {
      readonly after: number;
      readonly kind: "command";
      readonly command: string;
      readonly exitCode: number | null;
      readonly output: string;
    }
  | {
      readonly after: number;
      readonly kind: "file_change";
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
    }
  | { readonly after: number; readonly kind: "error"; readonly text: string }
  | {
      readonly after: number;
      readonly kind: "approval";
      readonly request: Pick<ApprovalRequest, "kind" | "operation" | "scope" | "reason">;
      readonly onApprove: readonly Step[];
      readonly onDeny: readonly Step[];
    }
  | {
      readonly after: number;
      readonly kind: "finish";
      readonly state: "succeeded" | "failed" | "recovery_required";
      readonly output: string;
      readonly error?: string;
      readonly recovery?: string;
      readonly diff?: string;
    };

export interface SeedTask {
  readonly projectId: string;
  readonly prompt: string;
  /** How long ago the task was created, in milliseconds. */
  readonly ageMs: number;
  /** Applied instantly at start-up, up to the end or the first approval. */
  readonly steps: readonly Step[];
}

export interface SeedProject {
  readonly id: string;
  readonly name: string;
}

export interface SeedComputer {
  readonly seed: number;
  readonly name: string;
  readonly status: ComputerStatus;
  /** Milliseconds ago, or null if never seen. */
  readonly lastSeenAgoMs: number | null;
  readonly pairedAgoMs: number;
  readonly projects: readonly SeedProject[];
  readonly tasks: readonly SeedTask[];
}

export interface ScenarioData {
  readonly computers: readonly SeedComputer[];
  readonly agentStatus: "available" | "not_installed";
  /** Script for a task started from the phone. */
  newTaskSteps(projectName: string, agent: AgentId): readonly Step[];
  readonly connect: {
    /** Number of initial attempts that fail the handshake before one succeeds. */
    readonly failFirstAttempts: number;
    /** Revoke the phone this many milliseconds after the session is ready. */
    readonly revokeAfterReadyMs: number | null;
  };
  /** Whether Telegram storage is reported as available. */
  readonly storageAvailable: boolean;
}

export const DEMO_RELAY_URL = "wss://relay.agentik.example";

/** A stable, valid-looking base32 device id for a seed number. */
export function demoDeviceId(seed: number): string {
  return encodeBase32(Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + seed * 71 + 3) & 0xff));
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const PROJECTS: readonly SeedProject[] = [
  { id: "proj_agentik", name: "Agentik" },
  { id: "proj_billing", name: "Billing service" },
  { id: "proj_dotfiles", name: "Dotfiles" },
];

const HEALTH_DIFF = `--- a/relay/src/index.ts
+++ b/relay/src/index.ts
@@ -12,6 +12,12 @@ export default {
   async fetch(request: Request, env: Env): Promise<Response> {
     const url = new URL(request.url);
+    if (url.pathname === "/healthz") {
+      return new Response("ok", {
+        headers: { "cache-control": "no-store" },
+      });
+    }
+
     if (url.pathname.startsWith("/v1/")) {
       return route(request, env);
     }`;

function happySteps(projectName: string): Step[] {
  return [
    { after: 600, kind: "state", state: "starting" },
    { after: 900, kind: "state", state: "running", note: "Codex started a new turn" },
    { after: 700, kind: "message", text: `Reading the ${projectName} project structure and the failing test output.` },
    { after: 1200, kind: "command", command: "git status --short", exitCode: 0, output: " M relay/src/index.ts" },
    {
      after: 1500,
      kind: "command",
      command: "npm test -- --run relay",
      exitCode: 1,
      output: "FAIL relay/src/index.test.ts > responds to /healthz\nExpected 200, received 404",
    },
    {
      after: 1400,
      kind: "message",
      text: "The relay has no health route. Adding one that never touches the Durable Object.",
    },
    { after: 1300, kind: "file_change", path: "relay/src/index.ts", additions: 6, deletions: 0 },
    { after: 1600, kind: "command", command: "npm test -- --run relay", exitCode: 0, output: "Test Files  4 passed (4)\nTests  31 passed (31)" },
    {
      after: 1200,
      kind: "finish",
      state: "succeeded",
      output:
        "Added a /healthz route to the relay.\n\n- It answers before routing, so it never wakes a Durable Object.\n- The response is marked no-store.\n- Relay tests pass (31 tests).",
      diff: HEALTH_DIFF,
    },
  ];
}

function approvalSteps(projectName: string): Step[] {
  return [
    { after: 600, kind: "state", state: "starting" },
    { after: 800, kind: "state", state: "running", note: "Codex started a new turn" },
    { after: 800, kind: "message", text: `The ${projectName} lockfile is out of date. I need to reinstall dependencies.` },
    {
      after: 1000,
      kind: "approval",
      request: {
        kind: "command",
        operation: "npm ci --no-audit --no-fund",
        scope: `Project "${projectName}", working directory: project root. Network access to the npm registry.`,
        reason: "Install the exact dependency versions from package-lock.json before running the tests.",
      },
      onApprove: [
        { after: 1500, kind: "command", command: "npm ci --no-audit --no-fund", exitCode: 0, output: "added 214 packages in 6s" },
        { after: 900, kind: "message", text: "Dependencies installed. One test fixture needs to be regenerated." },
        {
          after: 900,
          kind: "approval",
          request: {
            kind: "file_change",
            operation: "Overwrite protocol/vectors/noise-xx.json (412 lines)",
            scope: `Project "${projectName}", one file: protocol/vectors/noise-xx.json`,
            reason: "The stored vectors were produced by an older prologue format.",
          },
          onApprove: [
            { after: 900, kind: "file_change", path: "protocol/vectors/noise-xx.json", additions: 206, deletions: 206 },
            {
              after: 1200,
              kind: "finish",
              state: "succeeded",
              output: "Reinstalled dependencies and regenerated the Noise XX test vectors. All tests pass.",
            },
          ],
          onDeny: [
            { after: 800, kind: "message", text: "Understood. I will leave the vectors unchanged." },
            {
              after: 900,
              kind: "finish",
              state: "succeeded",
              output: "Dependencies are installed. The test vectors were not changed, so 2 vector tests still fail.",
            },
          ],
        },
      ],
      onDeny: [
        { after: 800, kind: "message", text: "Understood. I will not install anything." },
        {
          after: 1000,
          kind: "finish",
          state: "succeeded",
          output: "No changes made. Dependencies must be installed before the tests can run.",
        },
      ],
    },
  ];
}

function failedSteps(projectName: string): Step[] {
  return [
    { after: 600, kind: "state", state: "starting" },
    { after: 800, kind: "state", state: "running", note: "Codex started a new turn" },
    { after: 900, kind: "message", text: `Running the ${projectName} build first.` },
    {
      after: 1500,
      kind: "command",
      command: "go build ./...",
      exitCode: 1,
      output: "internal/secure/noise.go:88:2: undefined: handshakeState",
    },
    { after: 900, kind: "error", text: "Codex ended the turn with an error: the model request was rejected (usage limit reached)." },
    {
      after: 400,
      kind: "finish",
      state: "failed",
      output: "",
      error: "Codex stopped: usage limit reached. Nothing was changed in the project.",
    },
  ];
}

const RECOVERY_TEXT =
  "The computer restarted while the agent was being launched. Agentik cannot confirm whether Codex started or what it changed, so the task is not started again automatically. Check the project on the computer, then start a new task if needed.";

function recoverySteps(): Step[] {
  return [
    { after: 700, kind: "state", state: "starting" },
    { after: 2500, kind: "error", text: "Lost contact with the agent process during launch." },
    { after: 600, kind: "finish", state: "recovery_required", output: "", recovery: RECOVERY_TEXT },
  ];
}

const HISTORY: readonly SeedTask[] = [
  {
    projectId: "proj_agentik",
    prompt: "Add a health check endpoint to the relay",
    ageMs: 2 * HOUR,
    steps: happySteps("Agentik"),
  },
  {
    projectId: "proj_agentik",
    prompt: "Upgrade the Go toolchain and fix the build",
    ageMs: DAY,
    steps: failedSteps("Agentik"),
  },
  {
    projectId: "proj_agentik",
    prompt: "Regenerate the protocol test vectors",
    ageMs: 3 * DAY,
    steps: recoverySteps(),
  },
  {
    projectId: "proj_agentik",
    prompt: "Rewrite the README in a friendlier tone",
    ageMs: 4 * DAY,
    steps: [
      { after: 500, kind: "state", state: "starting" },
      { after: 700, kind: "state", state: "running" },
      { after: 2000, kind: "message", text: "Drafting a new introduction." },
      { after: 1000, kind: "state", state: "cancel_requested", note: "Stop requested from the phone" },
      { after: 1000, kind: "state", state: "cancelled", note: "The agent stopped" },
    ],
  },
  {
    projectId: "proj_dotfiles",
    prompt: "Add an alias for git worktree list",
    ageMs: 6 * DAY,
    steps: [
      { after: 500, kind: "state", state: "starting" },
      { after: 600, kind: "state", state: "running" },
      { after: 900, kind: "file_change", path: "zsh/aliases.zsh", additions: 1, deletions: 0 },
      { after: 600, kind: "finish", state: "succeeded", output: "Added `gwl` for `git worktree list`." },
    ],
  },
];

const WAITING_APPROVAL_TASK: SeedTask = {
  projectId: "proj_agentik",
  prompt: "Fix the failing protocol tests",
  ageMs: 90_000,
  steps: approvalSteps("Agentik"),
};

function computers(main: ComputerStatus, tasks: readonly SeedTask[]): SeedComputer[] {
  return [
    {
      seed: 1,
      name: "Work MacBook",
      status: main,
      lastSeenAgoMs: main === "offline" ? 3 * HOUR : MIN,
      pairedAgoMs: 30 * DAY,
      projects: PROJECTS,
      tasks,
    },
    {
      seed: 2,
      name: "Home Linux box",
      status: "offline",
      lastSeenAgoMs: 2 * DAY,
      pairedAgoMs: 60 * DAY,
      projects: [{ id: "proj_homelab", name: "Homelab" }],
      tasks: [],
    },
    {
      seed: 3,
      name: "Studio Mac mini",
      status: "pending_confirmation",
      lastSeenAgoMs: null,
      pairedAgoMs: 5 * MIN,
      projects: [{ id: "proj_site", name: "Studio website" }],
      tasks: [],
    },
    {
      seed: 4,
      name: "Old ThinkPad",
      status: "replaced",
      lastSeenAgoMs: 12 * DAY,
      pairedAgoMs: 200 * DAY,
      projects: [],
      tasks: [],
    },
  ];
}

export function scenarioData(name: ScenarioName): ScenarioData {
  const base: ScenarioData = {
    computers: computers("online", HISTORY),
    agentStatus: "available",
    newTaskSteps: (projectName) => happySteps(projectName),
    connect: { failFirstAttempts: 0, revokeAfterReadyMs: null },
    storageAvailable: true,
  };
  switch (name) {
    case "happy":
      return base;
    case "empty":
      return { ...base, computers: [] };
    case "offline":
      return { ...base, computers: computers("offline", HISTORY) };
    case "connect_failed":
      return { ...base, connect: { failFirstAttempts: 1, revokeAfterReadyMs: null } };
    case "approval":
      return {
        ...base,
        computers: computers("online", [WAITING_APPROVAL_TASK, ...HISTORY]),
        newTaskSteps: (projectName) => approvalSteps(projectName),
      };
    case "failed":
      return { ...base, newTaskSteps: (projectName) => failedSteps(projectName) };
    case "recovery":
      return { ...base, newTaskSteps: () => recoverySteps() };
    case "revoked":
      return { ...base, connect: { failFirstAttempts: 0, revokeAfterReadyMs: 6000 } };
    case "codex_missing":
      return { ...base, agentStatus: "not_installed" };
    case "no_storage":
      return { ...base, computers: [], storageAvailable: false };
  }
}

/** Projects offered by a computer the user paired during this session. */
export const PAIRED_COMPUTER_PROJECTS: readonly SeedProject[] = [{ id: "proj_new", name: "My project" }];
