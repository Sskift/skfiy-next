import path from "node:path";
import type {
  TmuxSupervisionReport,
  TmuxSupervisionStatus
} from "./computer-use/tmux-supervisor.js";
import { createSkfiyApplicationSupportPath } from "./personal-memory.js";
import type {
  AutomationRunCancellationSource,
  AutomationRunConcurrencyPolicy,
  AutomationRunRecord
} from "./automation-run.js";

export type AutomationMonitorKind = "tmux-session";
export type AutomationSchedulerState = "active" | "inactive";
export type AutomationMonitorTriggerMode = "manual" | "scheduled" | "local-state";
export type AutomationMonitorStatus =
  | TmuxSupervisionStatus
  | "idle"
  | "disabled"
  | "error"
  | "scheduler_inactive";
export type AutomationMonitorLastResult = TmuxSupervisionStatus | "error";
export type AutomationSchedulerScope = "app-process";
export type AutomationMonitorRunTrigger = "manual" | "scheduled";
export type AutomationMonitorNotificationOutcome =
  | "attention"
  | "completed"
  | "failure"
  | "approval";

export interface AutomationMonitorNotificationEvent {
  runId: string;
  label: string;
  outcome: AutomationMonitorNotificationOutcome;
}

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
  timeoutMs: number;
  triggerMode: AutomationMonitorTriggerMode;
  sessionName: string;
  preview: AutomationMonitorDefinitionPreview;
  concurrencyPolicy: AutomationRunConcurrencyPolicy;
  maxConcurrency: number;
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  runTtlMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationMonitorDefinitionPreviewConcurrency {
  policy: AutomationRunConcurrencyPolicy;
  max: number;
}

export interface AutomationMonitorDefinitionPreviewRetry {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface AutomationMonitorDefinitionPreview {
  adapter: "tmux-supervision";
  triggerModes: ["manual", "scheduled"];
  target: {
    kind: "tmux-session";
    sessionName: string;
  };
  requiredPermissions: [];
  readWriteBehavior: "read-only";
  approvalMode: "not-required";
  timeoutMs: number;
  verification: "tmux session, window, pane, and bounded recent pane-output observation";
  mutatesSession: false;
  concurrency?: AutomationMonitorDefinitionPreviewConcurrency;
  retry?: AutomationMonitorDefinitionPreviewRetry;
  runTtlMs?: number;
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

export interface AutomationRunSupervisorLike {
  requestRun: (input: {
    definition: AutomationMonitorDefinition;
    trigger: AutomationMonitorRunTrigger;
  }) => Promise<AutomationRunRecord>;
  stopMonitorRuns: (
    monitorId: string,
    requestedBy: AutomationRunCancellationSource
  ) => void;
}

export interface AutomationMonitorManager {
  upsertTmuxSessionMonitor: (input: {
    monitorId?: string;
    sessionName: string;
    label?: string;
    intervalMs: number;
    timeoutMs?: number;
    triggerMode?: AutomationMonitorTriggerMode;
    enabled?: boolean;
    concurrencyPolicy?: AutomationRunConcurrencyPolicy;
    maxConcurrency?: number;
    maxAttempts?: number;
    backoffMs?: number;
    backoffMultiplier?: number;
    maxBackoffMs?: number;
    runTtlMs?: number;
  }) => AutomationMonitorDefinition;
  duplicateMonitor: (id: string) => AutomationMonitorDefinition;
  setMonitorEnabled: (id: string, enabled: boolean) => AutomationMonitorRuntime;
  deleteMonitor: (id: string) => boolean;
  start: () => void;
  stop: () => void;
  runMonitorNow: (
    id: string,
    trigger?: AutomationMonitorRunTrigger
  ) => Promise<AutomationMonitorRuntime>;
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
  supervisor
}: {
  clearInterval?: AutomationClearInterval;
  now?: () => string;
  setInterval?: AutomationSetInterval;
  store: AutomationMonitorStore;
  supervisor: AutomationRunSupervisorLike;
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
    if (
      !started
      || !definition.enabled
      || definition.triggerMode !== "scheduled"
      || timers.has(definition.id)
    ) {
      return;
    }

    timers.set(definition.id, setInterval(async () => {
      await runMonitorNow(definition.id, "scheduled");
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

  async function runMonitorNow(
    id: string,
    trigger: AutomationMonitorRunTrigger = "manual"
  ): Promise<AutomationMonitorRuntime> {
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
    const record = await supervisor.requestRun({ definition, trigger });
    const runtime = readRuntime(definition);
    updateRuntime(definition, {
      checkCount: runtime.checkCount + 1,
      lastCheckedAt: checkedAt,
      nextCheckAt: addMilliseconds(checkedAt, definition.intervalMs),
      ...projectAutomationRunOntoRuntime(record, record.finishedAt ?? checkedAt)
    });
    return readSnapshotRuntime(definition.id);
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
      const requestedId = input.monitorId?.trim();
      const previous = requestedId
        ? definitions.get(requestedId)
        : definitions.get(createTmuxMonitorId(sessionName));
      if (requestedId && !previous) {
        throw new Error(`Unknown automation monitor: ${requestedId}`);
      }
      if (previous && previous.sessionName !== sessionName) {
        throw new Error("An existing automation monitor cannot change its tmux session target.");
      }
      const id = previous?.id ?? createTmuxMonitorId(sessionName);
      const timeoutMs = normalizeMonitorTimeoutMs(input.timeoutMs ?? previous?.timeoutMs);
      const triggerMode = normalizeMonitorTriggerMode(input.triggerMode ?? previous?.triggerMode);
      const concurrencyPolicy = normalizeAutomationConcurrencyPolicy(
        input.concurrencyPolicy ?? previous?.concurrencyPolicy
      );
      const maxConcurrency = normalizeAutomationMaxConcurrency(
        input.maxConcurrency ?? previous?.maxConcurrency
      );
      const maxAttempts = normalizeAutomationMaxAttempts(input.maxAttempts ?? previous?.maxAttempts);
      const backoffMs = normalizeAutomationBackoffMs(input.backoffMs ?? previous?.backoffMs);
      const backoffMultiplier = normalizeAutomationBackoffMultiplier(
        input.backoffMultiplier ?? previous?.backoffMultiplier
      );
      const maxBackoffMs = normalizeAutomationMaxBackoffMs(
        input.maxBackoffMs ?? previous?.maxBackoffMs
      );
      const runTtlMs = normalizeAutomationRunTtlMs(input.runTtlMs ?? previous?.runTtlMs);
      const definition: AutomationMonitorDefinition = {
        id,
        kind: "tmux-session",
        label: readMonitorLabel(input.label, sessionName),
        enabled: input.enabled ?? previous?.enabled ?? true,
        intervalMs: normalizeMonitorIntervalMs(input.intervalMs),
        timeoutMs,
        triggerMode,
        sessionName,
        preview: createTmuxAutomationMonitorPreview(sessionName, timeoutMs, {
          concurrencyPolicy,
          maxConcurrency,
          maxAttempts,
          backoffMs,
          maxBackoffMs,
          runTtlMs
        }),
        concurrencyPolicy,
        maxConcurrency,
        maxAttempts,
        backoffMs,
        backoffMultiplier,
        maxBackoffMs,
        runTtlMs,
        createdAt: previous?.createdAt ?? nowIso,
        updatedAt: nowIso
      };

      definitions.set(id, definition);
      runtimes.set(id, {
        ...(runtimes.get(id) ?? createInitialRuntime(definition)),
        ...definition,
        ...(!definition.enabled ? { status: "disabled" as const, nextCheckAt: undefined } : {})
      });
      persist();
      unschedule(id);
      schedule(definition);
      return definition;
    },
    duplicateMonitor(id) {
      const source = definitions.get(id);
      if (!source) {
        throw new Error(`Unknown automation monitor: ${id}`);
      }

      const duplicateIdentity = createDuplicateMonitorIdentity(source, definitions);
      const nowIso = now();
      const definition: AutomationMonitorDefinition = {
        ...source,
        id: duplicateIdentity.id,
        label: duplicateIdentity.label,
        enabled: false,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      definitions.set(definition.id, definition);
      runtimes.set(definition.id, createInitialRuntime(definition));
      persist();
      return definition;
    },
    setMonitorEnabled(id, enabled) {
      const previous = definitions.get(id);
      if (!previous) {
        throw new Error(`Unknown automation monitor: ${id}`);
      }

      const definition: AutomationMonitorDefinition = {
        ...previous,
        enabled,
        updatedAt: now()
      };
      definitions.set(id, definition);
      unschedule(id);
      if (!enabled) {
        supervisor.stopMonitorRuns(id, "dashboard");
      }
      updateRuntime(definition, {
        status: enabled ? "idle" : "disabled",
        nextCheckAt: undefined
      });
      schedule(definition);
      return readSnapshotRuntime(id);
    },
    deleteMonitor(id) {
      if (!definitions.has(id)) {
        return false;
      }

      unschedule(id);
      supervisor.stopMonitorRuns(id, "dashboard");
      definitions.delete(id);
      runtimes.delete(id);
      persist();
      return true;
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
  const timeoutMs = normalizeMonitorTimeoutMs(record.timeoutMs);
  const triggerMode = normalizeMonitorTriggerMode(record.triggerMode);
  const concurrencyPolicy = normalizeAutomationConcurrencyPolicy(record.concurrencyPolicy);
  const maxConcurrency = normalizeAutomationMaxConcurrency(record.maxConcurrency);
  const maxAttempts = normalizeAutomationMaxAttempts(record.maxAttempts);
  const backoffMs = normalizeAutomationBackoffMs(record.backoffMs);
  const backoffMultiplier = normalizeAutomationBackoffMultiplier(record.backoffMultiplier);
  const maxBackoffMs = normalizeAutomationMaxBackoffMs(record.maxBackoffMs);
  const runTtlMs = normalizeAutomationRunTtlMs(record.runTtlMs);
  return {
    id: typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : createTmuxMonitorId(sessionName),
    kind: "tmux-session",
    label: readMonitorLabel(typeof record.label === "string" ? record.label : undefined, sessionName),
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    intervalMs: normalizeMonitorIntervalMs(record.intervalMs),
    timeoutMs,
    triggerMode,
    sessionName,
    preview: createTmuxAutomationMonitorPreview(sessionName, timeoutMs, {
      concurrencyPolicy,
      maxConcurrency,
      maxAttempts,
      backoffMs,
      maxBackoffMs,
      runTtlMs
    }),
    concurrencyPolicy,
    maxConcurrency,
    maxAttempts,
    backoffMs,
    backoffMultiplier,
    maxBackoffMs,
    runTtlMs,
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

function projectAutomationRunOntoRuntime(
  record: AutomationRunRecord,
  at: string
): Partial<AutomationMonitorRuntime> {
  if (record.state === "completed") {
    const summary = record.latestVerification?.summary;
    return {
      status: "observing",
      lastResult: "observing",
      lastResultAt: at,
      ...(summary ? { lastSummary: summary } : {}),
      lastError: undefined
    };
  }
  if (record.state === "attention") {
    const status = record.latestVerification?.status === "blocked" ? "blocked" : "needs_attention";
    const summary = record.latestVerification?.summary;
    return {
      status,
      lastResult: status,
      lastResultAt: at,
      ...(summary ? { lastSummary: summary } : {}),
      lastError: undefined
    };
  }
  if (record.state === "failed") {
    return {
      status: "error",
      lastResult: "error",
      lastResultAt: at,
      ...(record.error ? { lastError: record.error } : {})
    };
  }
  if (record.state === "expired") {
    return {
      status: "error",
      lastResult: "error",
      lastResultAt: at,
      lastError: "Automation run expired before completion."
    };
  }
  // Cancelled runs and non-terminal records carry no new observation outcome.
  return { status: "idle" };
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

export function normalizeMonitorTimeoutMs(value: unknown): number {
  const timeoutMs = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : 30_000;
  return Math.min(300_000, Math.max(1_000, timeoutMs));
}

function normalizeMonitorTriggerMode(value: unknown): AutomationMonitorTriggerMode {
  return value === "manual" || value === "scheduled" || value === "local-state"
    ? value
    : "scheduled";
}

export function createTmuxAutomationMonitorPreview(
  sessionName: string,
  timeoutMs: number,
  options?: {
    concurrencyPolicy?: AutomationRunConcurrencyPolicy;
    maxConcurrency?: number;
    maxAttempts?: number;
    backoffMs?: number;
    maxBackoffMs?: number;
    runTtlMs?: number;
  }
): AutomationMonitorDefinitionPreview {
  const concurrencyPolicy = normalizeAutomationConcurrencyPolicy(options?.concurrencyPolicy);
  const maxConcurrency = normalizeAutomationMaxConcurrency(options?.maxConcurrency);
  const maxAttempts = normalizeAutomationMaxAttempts(options?.maxAttempts);
  const backoffMs = normalizeAutomationBackoffMs(options?.backoffMs);
  const maxBackoffMs = normalizeAutomationMaxBackoffMs(options?.maxBackoffMs);
  const runTtlMs = normalizeAutomationRunTtlMs(options?.runTtlMs);
  return {
    adapter: "tmux-supervision",
    triggerModes: ["manual", "scheduled"],
    target: {
      kind: "tmux-session",
      sessionName
    },
    requiredPermissions: [],
    readWriteBehavior: "read-only",
    approvalMode: "not-required",
    timeoutMs,
    verification: "tmux session, window, pane, and bounded recent pane-output observation",
    mutatesSession: false,
    concurrency: {
      policy: concurrencyPolicy,
      max: maxConcurrency
    },
    retry: {
      maxAttempts,
      backoffMs,
      maxBackoffMs
    },
    runTtlMs
  };
}

export function normalizeAutomationConcurrencyPolicy(
  value: unknown
): AutomationRunConcurrencyPolicy {
  return value === "skip" || value === "queue" || value === "allow" ? value : "skip";
}

export function normalizeAutomationMaxConcurrency(value: unknown): number {
  const maxConcurrency = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : 1;
  return Math.min(8, Math.max(1, maxConcurrency));
}

export function normalizeAutomationMaxAttempts(value: unknown): number {
  const maxAttempts = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : 3;
  return Math.min(10, Math.max(1, maxAttempts));
}

export function normalizeAutomationBackoffMs(value: unknown): number {
  const backoffMs = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : 30_000;
  return Math.min(300_000, Math.max(1_000, backoffMs));
}

export function normalizeAutomationBackoffMultiplier(value: unknown): number {
  const multiplier = typeof value === "number" && Number.isFinite(value) ? value : 2;
  return Math.min(5, Math.max(1, multiplier));
}

export function normalizeAutomationMaxBackoffMs(value: unknown): number {
  const maxBackoffMs = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : 300_000;
  return Math.min(3_600_000, Math.max(1_000, maxBackoffMs));
}

export function normalizeAutomationRunTtlMs(value: unknown): number {
  const runTtlMs = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : 900_000;
  return Math.min(3_600_000, Math.max(60_000, runTtlMs));
}

function createTmuxMonitorId(sessionName: string): string {
  return `tmux-session:${sessionName}`;
}

function createDuplicateMonitorIdentity(
  source: AutomationMonitorDefinition,
  definitions: Map<string, AutomationMonitorDefinition>
): { id: string; label: string } {
  let copyNumber = 1;
  while (true) {
    const suffix = copyNumber === 1 ? ":copy" : `:copy-${copyNumber}`;
    const id = `${source.id}${suffix}`;
    if (!definitions.has(id)) {
      return {
        id,
        label: `${source.label} copy${copyNumber === 1 ? "" : ` ${copyNumber}`}`
      };
    }
    copyNumber += 1;
  }
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
