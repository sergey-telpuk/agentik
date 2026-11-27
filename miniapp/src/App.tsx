import { useCallback, useEffect, useRef, useState } from "react";
import { SCENARIOS, SCENARIO_DESCRIPTION } from "./api/mock/scenarios";
import type { AgentikApi, Computer, ConnectionState } from "./api/types";
import { createDefaultServices, type AppServices } from "./services";
import type { PinnedDeviceStore } from "./storage/pinnedDevices";
import { AccessEndedScreen } from "./ui/AccessEndedScreen";
import { ComputerScreen } from "./ui/ComputerScreen";
import { ComputersScreen } from "./ui/ComputersScreen";
import { NewTaskScreen } from "./ui/NewTaskScreen";
import { PairScreen } from "./ui/PairScreen";
import { ProjectScreen } from "./ui/ProjectScreen";
import { ResultScreen } from "./ui/ResultScreen";
import { SettingsScreen, type ScenarioOption } from "./ui/SettingsScreen";
import { TaskScreen } from "./ui/TaskScreen";

type Route =
  | { readonly name: "computers" }
  | { readonly name: "pair" }
  | { readonly name: "settings" }
  /** `session` is unique per visit, so a state from an earlier visit is never shown. */
  | { readonly name: "computer"; readonly computer: Computer; readonly session: number }
  | { readonly name: "project"; readonly computer: Computer; readonly projectId: string; readonly projectName: string }
  | {
      readonly name: "new_task";
      readonly computer: Computer;
      readonly projectId: string;
      readonly projectName: string;
      readonly initialPrompt: string;
    }
  | { readonly name: "task"; readonly computer: Computer; readonly taskId: string; readonly projectId: string; readonly projectName: string }
  | { readonly name: "result"; readonly computer: Computer; readonly taskId: string; readonly projectId: string; readonly projectName: string }
  | { readonly name: "access_ended"; readonly computer: Computer; readonly message: string };

interface Props {
  /** Replaceable for tests; defaults to the real Telegram-backed services. */
  readonly services?: AppServices;
}

interface Ready {
  readonly store: PinnedDeviceStore;
  readonly api: AgentikApi;
}

const HOME: Route = { name: "computers" };

function computerOf(route: Route): Computer | null {
  return "computer" in route ? route.computer : null;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard === undefined) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

let sessionCounter = 0;
function nextSession(): number {
  sessionCounter += 1;
  return sessionCounter;
}

function newRequestId(): string {
  return crypto.randomUUID();
}

export function App({ services: provided }: Props) {
  // Created lazily and once: building the Telegram runtime touches the
  // environment, which must not happen at import time.
  const [services] = useState<AppServices>(() => provided ?? createDefaultServices());
  const [ready, setReady] = useState<Ready | null>(null);
  const [stack, setStack] = useState<readonly Route[]>([HOME]);
  const [connection, setConnection] = useState<{
    computerId: string;
    session: number;
    attempt: number;
    state: ConnectionState;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [listKey, setListKey] = useState(0);
  const route = stack.at(-1) ?? HOME;

  useEffect(() => {
    let cancelled = false;
    void services.openStore().then((store) => {
      if (cancelled) return;
      setReady({ store, api: services.createApi(store) });
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    services.runtime.ready();
    return services.runtime.watchTheme((vars) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
    });
  }, [services]);

  const push = useCallback((next: Route) => setStack((s) => [...s, next]), []);
  const replace = useCallback((next: Route) => setStack((s) => [...s.slice(0, -1), next]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const home = useCallback(() => {
    setListKey((n) => n + 1);
    setStack([HOME]);
  }, []);

  // One secure session at a time, kept while any screen of that computer is open.
  const activeComputer = stack.map(computerOf).find((c) => c !== null) ?? null;
  const activeComputerId = route.name === "access_ended" ? null : (activeComputer?.id ?? null);
  const session = stack.find((r) => r.name === "computer")?.session ?? 0;
  const stackRef = useRef(stack);
  useEffect(() => {
    stackRef.current = stack;
  }, [stack]);

  useEffect(() => {
    if (ready === null || activeComputerId === null) return;
    return ready.api.connect(activeComputerId, (state) => {
      setConnection({ computerId: activeComputerId, session, attempt, state });
      if (state.phase === "revoked") {
        const computer = stackRef.current.map(computerOf).find((x) => x?.id === activeComputerId);
        if (computer != null) {
          setStack([HOME, { name: "access_ended", computer, message: state.message }]);
        }
      }
    });
  }, [ready, activeComputerId, session, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (stack.length <= 1) return;
    return services.runtime.showBackButton(back);
  }, [services, stack.length, back]);

  useEffect(() => {
    // Each screen starts at the top; the task screen scrolls itself.
    const el = document.scrollingElement ?? document.documentElement;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: 0 });
  }, [stack.length, route.name]);

  const scenarioOptions: ScenarioOption[] =
    ready?.api.backend === "mock"
      ? SCENARIOS.map((name) => ({ name, description: SCENARIO_DESCRIPTION[name] }))
      : [];

  // A state from an earlier session or attempt is never shown for the current one.
  const state =
    connection !== null &&
    connection.computerId === activeComputerId &&
    connection.session === session &&
    connection.attempt === attempt
      ? connection.state
      : null;

  return (
    <main className="app">
      <h1 className="visually-hidden">Agentik</h1>
      {ready?.api.backend === "mock" && (
        <p className="demo-banner">
          Demo data. No real computer, relay or agent is involved.
        </p>
      )}
      {ready === null ? (
        <div className="boot" role="status">
          <span className="spinner" aria-hidden="true" />
          <p>Starting…</p>
        </div>
      ) : (
        <Screen
          key={stack.length + route.name}
          route={route}
          ready={ready}
          services={services}
          connection={state}
          listKey={listKey}
          scenarios={scenarioOptions}
          push={push}
          replace={replace}
          back={back}
          home={home}
          retry={retry}
        />
      )}
    </main>
  );
}

interface ScreenProps {
  readonly route: Route;
  readonly ready: Ready;
  readonly services: AppServices;
  readonly connection: ConnectionState | null;
  readonly listKey: number;
  readonly scenarios: ScenarioOption[];
  readonly push: (r: Route) => void;
  readonly replace: (r: Route) => void;
  readonly back: () => void;
  readonly home: () => void;
  readonly retry: () => void;
}

function Screen({ route, ready, services, connection, listKey, scenarios, push, replace, back, home, retry }: ScreenProps) {
  const { api, store } = ready;
  const now = services.now;
  switch (route.name) {
    case "computers":
      return (
        <ComputersScreen
          key={listKey}
          api={api}
          persistence={store.persistence}
          onAdd={() => push({ name: "pair" })}
          onOpen={(computer) =>
            computer.status === "revoked"
              ? push({
                  name: "access_ended",
                  computer,
                  message: "The computer rejected this phone the last time it connected.",
                })
              : push({ name: "computer", computer, session: nextSession() })
          }
          onSettings={() => push({ name: "settings" })}
        />
      );
    case "pair":
      return <PairScreen services={services} api={api} persistence={store.persistence} onPinned={home} onCancel={back} />;
    case "settings":
      return <SettingsScreen api={api} scenarios={scenarios} onCleared={() => undefined} onBack={back} />;
    case "computer":
      return (
        <ComputerScreen
          api={api}
          computer={route.computer}
          connection={connection}
          onRetry={retry}
          onForget={() => {
            void api.forgetComputer(route.computer.id).then(home);
          }}
          onOpenProject={(p) => push({ name: "project", computer: route.computer, projectId: p.id, projectName: p.name })}
          onBack={home}
        />
      );
    case "project":
      return (
        <ProjectScreen
          api={api}
          computerId={route.computer.id}
          projectId={route.projectId}
          projectName={route.projectName}
          now={now}
          onNewTask={() => push({ ...route, name: "new_task", initialPrompt: "" })}
          onOpenTask={(t) => push({ ...route, name: "task", taskId: t.id })}
          onBack={back}
        />
      );
    case "new_task":
      return (
        <NewTaskScreen
          api={api}
          computerId={route.computer.id}
          computerName={connection?.phase === "ready" ? connection.computerName : route.computer.name}
          projectId={route.projectId}
          projectName={route.projectName}
          initialPrompt={route.initialPrompt}
          newRequestId={newRequestId}
          onStarted={(task) =>
            replace({
              name: "task",
              computer: route.computer,
              projectId: route.projectId,
              projectName: route.projectName,
              taskId: task.id,
            })
          }
          onBack={back}
        />
      );
    case "task":
      return (
        <TaskScreen
          api={api}
          computerId={route.computer.id}
          taskId={route.taskId}
          projectName={route.projectName}
          now={now}
          onOpenResult={() => push({ ...route, name: "result" })}
          onBack={back}
        />
      );
    case "result":
      return (
        <ResultScreen
          api={api}
          computerId={route.computer.id}
          taskId={route.taskId}
          projectName={route.projectName}
          copyText={copyToClipboard}
          onNewTask={(prompt) =>
            push({
              name: "new_task",
              computer: route.computer,
              projectId: route.projectId,
              projectName: route.projectName,
              initialPrompt: prompt,
            })
          }
          onBack={back}
        />
      );
    case "access_ended":
      return (
        <AccessEndedScreen
          api={api}
          computerId={route.computer.id}
          computerName={route.computer.name}
          message={route.message}
          onDone={home}
        />
      );
  }
}
