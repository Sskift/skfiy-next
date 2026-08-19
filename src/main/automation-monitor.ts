import path from "node:path";
import type {
  TmuxSupervisionReport,
  TmuxSupervisionStatus
} from "./computer-use/tmux-supervisor.js";
import { createSkfiyApplicationSupportPath } from "./personal-memory.js";
import type { TmuxSupervisionClient } from "./tmux-supervision-client.js";

export type AutomationMonitorKind = "tmux-session";
export type AutomationSchedulerState = "active" | "inactive";
export type AutomationMonitorStatus =
  | TmuxSupervisionStatus
  | "idle"
  | "disabled"
  | "error"
  | "scheduler_inactive";
export type AutomationMonitorLastResult = TmuxSupervisionStatus | "error";
export type AutomationSchedulerScope = "app-process";

export interface AutomationMonitorSchedulerStatus {
  state: AutomationSchedulerState;
  scope: AutomationSchedulerScope;
  owner: "skfiy";
  activeTimerCount: number;
  mutatesSession: false;
  startedAt?: string;
  reason?: string;
}

export interface AutomationMonitorDefinition {
  id: string;
  kind: AutomationMonitorKind;
  label: string;
  enabled: boolean;
  intervalMs: number;
  sessionName: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationMonitorRuntime extends AutomationMonitorDefinition {
  status: AutomationMonitorStatus;
  checkCount: number;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  lastChangedAt?: string;
  lastSummary?: string;
  lastError?: string;
  lastReport?: TmuxSupervisionReport;
  lastResult?: AutomationMonitorLastResult;
  lastResultAt?: string;
  observedSession?: string;
  schedulerState?: AutomationSchedulerState;
  schedulerScope?: AutomationSchedulerScope;
  mutatesSession?: false;
}

export interface AutomationMonitorSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  activeCount: number;
  attentionCount: number;
  schedulerInactiveCount: number;
  scheduler: AutomationMonitorSchedulerStatus;
  monitors: AutomationMonitorRuntime[];
}

export interface AutomationMonitorStoreSnapshot {
  schemaVersion: 1;
  monitors: AutomationMonitorDefinition[];
  runtimes?: AutomationMonitorRuntime[];
}

export interface AutomationMonitorStoreIo {
  exists: (filePath: string) => boolean;
  mkdir: (dirPath: string) => void;
  readFile: (filePath: string) => string;
  rename?: (fromPath: string, toPath: string) => void;
  writeFile: (filePath: string, content: string) => void;
}

export interface AutomationMonitorStore {
  read: () => AutomationMonitorStoreSnapshot;
  write: (snapshot: AutomationMonitorStoreSnapshot) => void;
}

export type AutomationSetInterval = (
  callback: () => Promise<void>,
  intervalMs: number
) => unknown;

export type AutomationClearInterval = (timer: unknown) => void;

export interface AutomationMonitorManager {
  upsertTmuxSessionMonitor: (input: {
    sessionName: string;
    label?: string;
    intervalMs: number;
    enabled?: boolean;
  }) => AutomationMonitorDefinition;
  start: () => void;
  stop: () => void;
  runMonitorNow: (id: string) => Promise<AutomationMonitorRuntime>;
  readSnapshot: () => AutomationMonitorSnapshot;
}

export function createAutomationMonitorStatePath(homeDir: string): string {
  return path.join(createSkfiyApplicationSupportPath(homeDir), "automation-monitors.json");
}

export function createAutomationMonitorSnapshotFromStoreSnapshot(
  snapshot: unknown,
  fallbackGeneratedAt = new Date().toISOString()
): AutomationMonitorSnapshot {
  const normalized = normalizeAutomationMonitorStoreSnapshot(snapshot);
  const definitions = new Map<string, AutomationMonitorDefinition>();
  const runtimes = new Map<string, AutomationMonitorRuntime>();

  for (const definition of normalized.monitors) {
    definitions.set(definition.id, definition);
  }

  for (const runtime of normalized.runtimes ?? []) {
    runtimes.set(runtime.id, runtime);
  }

  const monitors = Array.from(definitions.values()).map((definition) => (
    runtimes.get(definition.id) ?? createInitialRuntime(definition)
  ));

  return createAutomationMonitorSnapshot(monitors, fallbackGeneratedAt, createInactiveAutomationMonitorScheduler());
}

export function createAutomationMonitorStore({
  filePath,
  io
}: {
  filePath: string;
  io: AutomationMonitorStoreIo;
}): AutomationMonitorStore {
  return {
    read() {
      if (!io.exists(filePath)) {
        return {
          schemaVersion: 1,
          monitors: []
        };
      }

      return normalizeAutomationMonitorStoreSnapshot(JSON.parse(io.readFile(filePath)));
    },
    write(snapshot) {
      const normalized = normalizeAutomationMonitorStoreSnapshot(snapshot);
      const tempPath = `${filePath}.tmp-${Date.now()}`;
      io.mkdir(path.dirname(filePath));
      io.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
      if (io.rename) {
        io.rename(tempPath, filePath);
      } else {
        io.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
      }
    }
  };
}

export function createAutomationMonitorManager({
  clearInterval = globalThis.clearInterval as AutomationClearInterval,
  now = () => new Date().toISOString(),
  setInterval = globalThis.setInterval as unknown as AutomationSetInterval,
  store,
  tmuxClient
}: {
  clearInterval?: AutomationClearInterval;
  now?: () => string;
  setInterval?: AutomationSetInterval;
  store: AutomationMonitorStore;
  tmuxClient: TmuxSupervisionClient;
}): AutomationMonitorManager {
  const definitions = new Map<string, AutomationMonitorDefinition>();
  const runtimes = new Map<string, AutomationMonitorRuntime>();
  const timers = new Map<string, unknown>();
  let started = false;
  let startedAt: string | undefined;

  const storeSnapshot = store.read();
  const persistedRuntimes = new Map<string, AutomationMonitorRuntime>();

  for (const runtime of storeSnapshot.runtimes ?? []) {
    persistedRuntimes.set(runtime.id, runtime);
  }

  for (const definition of storeSnapshot.monitors) {
    definitions.set(definition.id, definition);
    runtimes.set(definition.id, persistedRuntimes.get(definition.id) ?? createInitialRuntime(definition));
  }

  function persist() {
    store.write({
      schemaVersion: 1,
      monitors: Array.from(definitions.values()),
      runtimes: Array.from(runtimes.values())
    });
  }

  function schedule(definition: AutomationMonitorDefinition) {
    if (!started || !definition.enabled || timers.has(definition.id)) {
      return;
    }

    timers.set(definition.id, setInterval(async () => {
      await runMonitorNow(definition.id);
    }, definition.intervalMs));
  }

  function unschedule(id: string) {
    const timer = timers.get(id);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    timers.delete(id);
  }

  async function runMonitorNow(id: string): Promise<AutomationMonitorRuntime> {
    const definition = definitions.get(id);
    if (!definition) {
      throw new Error(`Unknown automation monitor: ${id}`);
    }

    if (!definition.enabled) {
      updateRuntime(definition, {
        status: "disabled"
      });
      return readSnapshotRuntime(definition.id);
    }

    const checkedAt = now();
    try {
      const report = await tmuxClient.observeSession(definition.sessionName);
      updateRuntime(definition, {
        checkCount: readRuntime(definition).checkCount + 1,
        lastCheckedAt: checkedAt,
        lastReport: report,
        lastResult: report.status,
        lastResultAt: checkedAt,
        lastSummary: report.recommendation.reason,
        nextCheckAt: addMilliseconds(checkedAt, definition.intervalMs),
        status: report.status
      });
      return readSnapshotRuntime(definition.id);
    } catch (error) {
      updateRuntime(definition, {
        checkCount: readRuntime(definition).checkCount + 1,
        lastCheckedAt: checkedAt,
        lastError: error instanceof Error ? error.message : String(error),
        lastResult: "error",
        lastResultAt: checkedAt,
        nextCheckAt: addMilliseconds(checkedAt, definition.intervalMs),
        status: "error"
      });
      return readSnapshotRuntime(definition.id);
    }
  }

  function readRuntime(definition: AutomationMonitorDefinition): AutomationMonitorRuntime {
    return runtimes.get(definition.id) ?? createInitialRuntime(definition);
  }

  function updateRuntime(
    definition: AutomationMonitorDefinition,
    update: Partial<AutomationMonitorRuntime>
  ): AutomationMonitorRuntime {
    const previous = readRuntime(definition);
    const status = update.status ?? previous.status;
    const runtime: AutomationMonitorRuntime = {
      ...previous,
      ...definition,
      ...update,
      status,
      ...(status !== previous.status ? { lastChangedAt: now() } : {})
    };
    runtimes.set(definition.id, runtime);
    persist();
    return runtime;
  }

  function readSchedulerStatus(): AutomationMonitorSchedulerStatus {
    if (!started) {
      return createInactiveAutomationMonitorScheduler();
    }

    return {
      state: "active",
      scope: "app-process",
      owner: "skfiy",
      activeTimerCount: timers.size,
      mutatesSession: false,
      ...(startedAt ? { startedAt } : {})
    };
  }

  function readSnapshotRuntime(id: string): AutomationMonitorRuntime {
    const monitor = readManagerSnapshot().monitors.find((candidate) => candidate.id === id);
    if (monitor) {
      return monitor;
    }

    const definition = definitions.get(id);
    if (definition) {
      return readRuntime(definition);
    }

    throw new Error(`Unknown automation monitor: ${id}`);
  }

  function readManagerSnapshot(): AutomationMonitorSnapshot {
    const monitors = Array.from(definitions.values()).map((definition) => readRuntime(definition));
    return createAutomationMonitorSnapshot(monitors, now(), readSchedulerStatus());
  }

  return {
    upsertTmuxSessionMonitor(input) {
      const sessionName = normalizeMonitorSessionName(input.sessionName);
      const nowIso = now();
      const id = createTmuxMonitorId(sessionName);
      const previous = definitions.get(id);
      const definition: AutomationMonitorDefinition = {
        id,
        kind: "tmux-session",
        label: readMonitorLabel(input.label, sessionName),
        enabled: input.enabled ?? previous?.enabled ?? true,
        intervalMs: normalizeMonitorIntervalMs(input.intervalMs),
        sessionName,
        createdAt: previous?.createdAt ?? nowIso,
        updatedAt: nowIso
      };

      definitions.set(id, definition);
      runtimes.set(id, {
        ...createInitialRuntime(definition),
        ...(runtimes.get(id) ?? {})
      });
      persist();
      unschedule(id);
      schedule(definition);
      return definition;
    },
    start() {
      if (!started) {
        startedAt = now();
      }
      started = true;
      for (const definition of definitions.values()) {
        schedule(definition);
      }
    },
    stop() {
      started = false;
      for (const timer of timers.values()) {
        clearInterval(timer);
      }
      timers.clear();
    },
    runMonitorNow,
    readSnapshot: readManagerSnapshot
  };
}

function createAutomationMonitorSnapshot(
  monitors: AutomationMonitorRuntime[],
  fallbackGeneratedAt: string,
  scheduler: AutomationMonitorSchedulerStatus
): AutomationMonitorSnapshot {
  const publicMonitors = monitors.map((monitor) => createPublicAutomationMonitorRuntime(monitor, scheduler));

  return {
    schemaVersion: 1,
    generatedAt: readLatestRuntimeTimestamp(publicMonitors) ?? fallbackGeneratedAt,
    activeCount: publicMonitors.filter((monitor) => monitor.enabled).length,
    attentionCount: publicMonitors.filter((monitor) => (
      monitor.status === "needs_attention"
      || monitor.status === "blocked"
      || monitor.status === "error"
      || monitor.status === "scheduler_inactive"
    )).length,
    schedulerInactiveCount: publicMonitors.filter((monitor) => monitor.status === "scheduler_inactive").length,
    scheduler,
    monitors: publicMonitors
  };
}

function createInitialRuntime(definition: AutomationMonitorDefinition): AutomationMonitorRuntime {
  return {
    ...definition,
    status: definition.enabled ? "idle" : "disabled",
    checkCount: 0,
    observedSession: definition.sessionName,
    mutatesSession: false
  };
}

function createInactiveAutomationMonitorScheduler(): AutomationMonitorSchedulerStatus {
  return {
    state: "inactive",
    scope: "app-process",
    owner: "skfiy",
    activeTimerCount: 0,
    mutatesSession: false,
    reason: "Open skfiy to resume interval checks."
  };
}

function createPublicAutomationMonitorRuntime(
  monitor: AutomationMonitorRuntime,
  scheduler: AutomationMonitorSchedulerStatus
): AutomationMonitorRuntime {
  const lastResult = monitor.lastResult ?? readMonitorLastResult(monitor.status);
  const lastResultAt = monitor.lastResultAt ?? monitor.lastCheckedAt;
  const status = readPublicAutomationMonitorStatus(monitor, scheduler);

  return {
    ...monitor,
    status,
    observedSession: monitor.observedSession ?? monitor.sessionName,
    schedulerState: scheduler.state,
    schedulerScope: scheduler.scope,
    mutatesSession: false,
    ...(lastResult ? { lastResult } : {}),
    ...(lastResultAt ? { lastResultAt } : {})
  };
}

function readPublicAutomationMonitorStatus(
  monitor: AutomationMonitorRuntime,
  scheduler: AutomationMonitorSchedulerStatus
): AutomationMonitorStatus {
  if (!monitor.enabled) {
    return "disabled";
  }

  if (scheduler.state === "inactive" && monitor.status === "observing") {
    return "scheduler_inactive";
  }

  return monitor.status;
}

function normalizeAutomationMonitorStoreSnapshot(value: unknown): AutomationMonitorStoreSnapshot {
  const record = readRecord(value);
  const monitors = Array.isArray(record?.monitors) ? record.monitors : [];
  const definitions = monitors
    .map(normalizeAutomationMonitorDefinition)
    .filter((monitor): monitor is AutomationMonitorDefinition => Boolean(monitor));
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const runtimeValues = Array.isArray(record?.runtimes) ? record.runtimes : [];
  const runtimes = runtimeValues
    .map((runtime) => normalizeAutomationMonitorRuntime(runtime, definitionsById))
    .filter((runtime): runtime is AutomationMonitorRuntime => Boolean(runtime));

  return {
    schemaVersion: 1,
    monitors: definitions,
    runtimes
  };
}

function normalizeAutomationMonitorDefinition(value: unknown): AutomationMonitorDefinition | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  const sessionName = typeof record.sessionName === "string"
    ? normalizeMonitorSessionName(record.sessionName)
    : undefined;
  if (!sessionName) {
    return undefined;
  }

  const nowIso = new Date(0).toISOString();
  return {
    id: typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : createTmuxMonitorId(sessionName),
    kind: "tmux-session",
    label: readMonitorLabel(typeof record.label === "string" ? record.label : undefined, sessionName),
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    intervalMs: normalizeMonitorIntervalMs(record.intervalMs),
    sessionName,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : nowIso,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso
  };
}

function normalizeAutomationMonitorRuntime(
  value: unknown,
  definitionsById: Map<string, AutomationMonitorDefinition>
): AutomationMonitorRuntime | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  const id = typeof record.id === "string" ? record.id.trim() : "";
  const definition = definitionsById.get(id) ?? normalizeAutomationMonitorDefinition(value);
  if (!definition) {
    return undefined;
  }

  const status = normalizeAutomationMonitorStatus(record.status);
  const lastResult = normalizeAutomationMonitorLastResult(record.lastResult);
  const checkCount = typeof record.checkCount === "number" && Number.isFinite(record.checkCount)
    ? Math.max(0, Math.round(record.checkCount))
    : 0;
  const lastReport = readRecord(record.lastReport);

  return {
    ...createInitialRuntime(definition),
    ...definition,
    status,
    checkCount,
    ...(typeof record.lastCheckedAt === "string" ? { lastCheckedAt: record.lastCheckedAt } : {}),
    ...(typeof record.nextCheckAt === "string" ? { nextCheckAt: record.nextCheckAt } : {}),
    ...(typeof record.lastChangedAt === "string" ? { lastChangedAt: record.lastChangedAt } : {}),
    ...(typeof record.lastSummary === "string" ? { lastSummary: record.lastSummary } : {}),
    ...(typeof record.lastError === "string" ? { lastError: record.lastError } : {}),
    ...(lastResult ? { lastResult } : {}),
    ...(typeof record.lastResultAt === "string" ? { lastResultAt: record.lastResultAt } : {}),
    ...(lastReport ? { lastReport: lastReport as unknown as TmuxSupervisionReport } : {})
  };
}

function normalizeAutomationMonitorStatus(value: unknown): AutomationMonitorStatus {
  return (
    value === "observing"
    || value === "needs_attention"
    || value === "blocked"
    || value === "idle"
    || value === "disabled"
    || value === "error"
    || value === "scheduler_inactive"
  )
    ? value
    : "idle";
}

function normalizeAutomationMonitorLastResult(value: unknown): AutomationMonitorLastResult | undefined {
  return (
    value === "observing"
    || value === "needs_attention"
    || value === "blocked"
    || value === "error"
  )
    ? value
    : undefined;
}

function readMonitorLastResult(status: AutomationMonitorStatus): AutomationMonitorLastResult | undefined {
  return normalizeAutomationMonitorLastResult(status);
}

function normalizeMonitorSessionName(value: string): string {
  const sessionName = value.trim();
  if (!/^[A-Za-z0-9_.:-]+$/u.test(sessionName)) {
    throw new Error("Automation monitor tmux session name is invalid.");
  }
  return sessionName;
}

function readMonitorLabel(label: string | undefined, sessionName: string): string {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : sessionName;
}

function normalizeMonitorIntervalMs(value: unknown): number {
  const intervalMs = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : 300_000;
  return Math.max(30_000, intervalMs);
}

function createTmuxMonitorId(sessionName: string): string {
  return `tmux-session:${sessionName}`;
}

function addMilliseconds(isoDate: string, intervalMs: number): string {
  const time = Date.parse(isoDate);
  if (!Number.isFinite(time)) {
    return new Date(Date.now() + intervalMs).toISOString();
  }
  return new Date(time + intervalMs).toISOString();
}

function readLatestRuntimeTimestamp(monitors: AutomationMonitorRuntime[]): string | undefined {
  const timestamps = monitors
    .flatMap((monitor) => [
      monitor.lastCheckedAt,
      monitor.lastChangedAt,
      monitor.lastResultAt
    ])
    .filter((value): value is string => typeof value === "string")
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left));

  return timestamps[0];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
