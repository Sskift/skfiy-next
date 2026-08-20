import path from "node:path";
import { DEFAULT_RETENTION_SETTINGS } from "../shared/retention.js";
import { createSkfiyApplicationSupportPath } from "./personal-memory.js";

export type AutomationRunState =
  | "queued"
  | "running"
  | "waiting"
  | "attention"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type AutomationRunTrigger = "manual" | "scheduled" | "local-state" | "cli" | "mcp";

export type AutomationRunConcurrencyPolicy = "skip" | "queue" | "allow";

export type AutomationRunCancellationSource = "pet" | "dashboard" | "cli" | "mcp";

export type AutomationRunTerminalReason =
  | "completed"
  | "retries-exhausted"
  | "non-retryable-error"
  | "cancelled-by-user"
  | "expired-ttl"
  | "interrupted-by-restart"
  | "attention-required";

export type AutomationRunExpiryReason = "expired-ttl" | "interrupted-by-restart";

export type AutomationRunVerificationKind = "tmux-observation" | "manual" | "none";

export type AutomationRunVerificationStatus =
  | "observing"
  | "needs_attention"
  | "blocked"
  | "error";

export type AutomationRunRecoveryActionKind =
  | "send_input"
  | "restart_step"
  | "collect_summary";

/**
 * Bounded projection of a tmux recovery proposal, surfaced through the
 * existing verification channel so the Dashboard/pet can show that recovery
 * is available. The Background Agent never executes recovery — it only
 * observes and transitions attention runs to "review-in-skfiy".
 */
export interface AutomationRunRecoveryProposal {
  proposalId: string;
  actionKind: AutomationRunRecoveryActionKind;
  reason: string;
  risk: "low" | "medium" | "high" | "blocked";
  mutatesSession: boolean;
}

export interface AutomationRunTimelineEntry {
  at: string;
  step: string;
  detail?: string;
}

export interface AutomationRunVerification {
  at: string;
  kind: AutomationRunVerificationKind;
  status: AutomationRunVerificationStatus;
  summary: string;
  recoveryProposals?: AutomationRunRecoveryProposal[];
}

export interface AutomationRunCancellation {
  requestedBy: AutomationRunCancellationSource;
  at: string;
}

export interface AutomationRunConfig {
  sessionName: string;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  runTtlMs: number;
  concurrencyPolicy: AutomationRunConcurrencyPolicy;
  maxConcurrency: number;
}

export interface AutomationRunRecord {
  schemaVersion: 1;
  runId: string;
  monitorId: string;
  trigger: AutomationRunTrigger;
  state: AutomationRunState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
  retryAvailableAt?: string;
  currentStep: string;
  nextAction?: string;
  attempt: number;
  maxAttempts: number;
  timeline: AutomationRunTimelineEntry[];
  latestVerification?: AutomationRunVerification;
  terminalReason?: AutomationRunTerminalReason;
  cancellation?: AutomationRunCancellation;
  error?: string;
  config: AutomationRunConfig;
}

export interface AutomationRunStoreSnapshot {
  schemaVersion: 1;
  sequences: Record<string, number>;
  runs: AutomationRunRecord[];
}

export interface AutomationRunSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  runs: AutomationRunRecord[];
}

export interface AutomationRunStoreIo {
  exists: (filePath: string) => boolean;
  mkdir: (dirPath: string) => void;
  readFile: (filePath: string) => string;
  rename?: (fromPath: string, toPath: string) => void;
  writeFile: (filePath: string, content: string) => void;
}

export interface AutomationRunStore {
  read: () => AutomationRunStoreSnapshot;
  write: (snapshot: AutomationRunStoreSnapshot) => void;
}

export type AutomationRunEvent =
  | { type: "start" }
  | { type: "note"; step: string; detail?: string }
  | { type: "retry-scheduled"; delayMs: number }
  | { type: "retry-attempt" }
  | { type: "verification"; verification: AutomationRunVerification }
  | { type: "fail"; error: string; retryable: boolean; delayMs?: number }
  | { type: "cancel"; requestedBy: AutomationRunCancellationSource }
  | { type: "expire"; reason: AutomationRunExpiryReason };

export const AUTOMATION_RUN_TERMINAL_STATES: readonly AutomationRunState[] = [
  "attention",
  "completed",
  "failed",
  "cancelled",
  "expired"
];

export const AUTOMATION_RUN_ACTIVE_STATES: readonly AutomationRunState[] = [
  "queued",
  "running",
  "waiting"
];

export const MAX_AUTOMATION_RUN_ID_LENGTH = 240;
export const MAX_AUTOMATION_RUN_MONITOR_ID_LENGTH = 200;
export const MAX_AUTOMATION_RUN_STEP_LENGTH = 80;
export const MAX_AUTOMATION_RUN_DETAIL_LENGTH = 300;
export const MAX_AUTOMATION_RUN_ERROR_LENGTH = 300;
export const MAX_AUTOMATION_RUN_NEXT_ACTION_LENGTH = 300;
export const MAX_AUTOMATION_RUN_SUMMARY_LENGTH = 300;
export const MAX_AUTOMATION_RUN_TIMELINE_ENTRIES = 50;
export const MAX_AUTOMATION_RUN_RECOVERY_PROPOSALS = 4;
export const MAX_AUTOMATION_RUN_RECOVERY_REASON_LENGTH = 240;
export const AUTOMATION_RUN_PER_MONITOR_CAP = DEFAULT_RETENTION_SETTINGS.runHistory.perMonitorCap;
export const AUTOMATION_RUN_GLOBAL_CAP = DEFAULT_RETENTION_SETTINGS.runHistory.globalCap;

const AUTOMATION_RUN_ID_PATTERN = /^tmux-session:[A-Za-z0-9_.:-]+:run:\d+$/u;
const AUTOMATION_RUN_MONITOR_ID_PATTERN = /^tmux-session:[A-Za-z0-9_.:-]+$/u;
const EPOCH_ISO = new Date(0).toISOString();

export function createAutomationRunStatePath(homeDir: string): string {
  return path.join(createSkfiyApplicationSupportPath(homeDir), "automation-runs.json");
}

export function createAutomationRunId(monitorId: string, sequence: number): string {
  return `${monitorId}:run:${sequence}`;
}

export function isAutomationRunTerminal(state: AutomationRunState): boolean {
  return AUTOMATION_RUN_TERMINAL_STATES.includes(state);
}

export function isAutomationRunActive(state: AutomationRunState): boolean {
  return AUTOMATION_RUN_ACTIVE_STATES.includes(state);
}

export interface AutomationRunStoreCaps {
  perMonitorCap?: number;
  globalCap?: number;
}

export function createAutomationRunStore({
  filePath,
  io,
  caps
}: {
  filePath: string;
  io: AutomationRunStoreIo;
  caps?: AutomationRunStoreCaps;
}): AutomationRunStore {
  const perMonitorCap = caps?.perMonitorCap;
  const globalCap = caps?.globalCap;
  return {
    read() {
      if (!io.exists(filePath)) {
        return {
          schemaVersion: 1,
          sequences: {},
          runs: []
        };
      }

      return normalizeAutomationRunStoreSnapshot(JSON.parse(io.readFile(filePath)));
    },
    write(snapshot) {
      const normalized = normalizeAutomationRunStoreSnapshot(snapshot);
      const retained = retainAutomationRuns(normalized.runs, { perMonitorCap, globalCap });
      const tempPath = `${filePath}.tmp-${Date.now()}`;
      io.mkdir(path.dirname(filePath));
      io.writeFile(tempPath, `${JSON.stringify({ ...normalized, runs: retained }, null, 2)}\n`);
      if (io.rename) {
        io.rename(tempPath, filePath);
      } else {
        io.writeFile(filePath, `${JSON.stringify({ ...normalized, runs: retained }, null, 2)}\n`);
      }
    }
  };
}

export function normalizeAutomationRunStoreSnapshot(value: unknown): AutomationRunStoreSnapshot {
  const record = readRecord(value);
  const sequenceRecord = readRecord(record?.sequences);
  const sequences: Record<string, number> = {};
  if (sequenceRecord) {
    for (const [monitorId, sequence] of Object.entries(sequenceRecord)) {
      if (
        typeof monitorId === "string"
        && AUTOMATION_RUN_MONITOR_ID_PATTERN.test(monitorId)
        && typeof sequence === "number"
        && Number.isFinite(sequence)
      ) {
        sequences[monitorId] = Math.max(0, Math.round(sequence));
      }
    }
  }
  const runValues = Array.isArray(record?.runs) ? record.runs : [];
  const runs = runValues
    .map(normalizeAutomationRunRecord)
    .filter((run): run is AutomationRunRecord => Boolean(run));

  return {
    schemaVersion: 1,
    sequences,
    runs
  };
}

export function normalizeAutomationRunRecord(value: unknown): AutomationRunRecord | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  const runId = normalizeAutomationRunId(record.runId);
  const monitorId = normalizeAutomationRunMonitorId(record.monitorId);
  if (!runId || !monitorId) {
    return undefined;
  }

  const state = normalizeAutomationRunState(record.state);
  const attempt = readPositiveInteger(record.attempt, 1);
  const maxAttempts = clampInteger(readFiniteNumber(record.maxAttempts, 3), 1, 10);
  const timeline = normalizeAutomationRunTimeline(record.timeline);
  const config = normalizeAutomationRunConfig(record.config, record, maxAttempts);
  if (!config) {
    return undefined;
  }

  const normalized: AutomationRunRecord = {
    schemaVersion: 1,
    runId,
    monitorId,
    trigger: normalizeAutomationRunTrigger(record.trigger),
    state,
    createdAt: readIsoTimestamp(record.createdAt),
    updatedAt: readIsoTimestamp(record.updatedAt),
    currentStep: readBoundedString(record.currentStep, MAX_AUTOMATION_RUN_STEP_LENGTH, "queued"),
    attempt,
    maxAttempts,
    timeline,
    config
  };

  const startedAt = readOptionalIsoTimestamp(record.startedAt);
  const finishedAt = readOptionalIsoTimestamp(record.finishedAt);
  const deadlineAt = readOptionalIsoTimestamp(record.deadlineAt);
  const retryAvailableAt = readOptionalIsoTimestamp(record.retryAvailableAt);
  const nextAction = readOptionalBoundedString(
    record.nextAction,
    MAX_AUTOMATION_RUN_NEXT_ACTION_LENGTH
  );
  const error = readOptionalBoundedString(record.error, MAX_AUTOMATION_RUN_ERROR_LENGTH);
  const verification = normalizeAutomationRunVerification(record.latestVerification);
  const terminalReason = normalizeAutomationRunTerminalReason(record.terminalReason);
  const cancellation = normalizeAutomationRunCancellation(record.cancellation);

  return {
    ...normalized,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(retryAvailableAt ? { retryAvailableAt } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(error ? { error } : {}),
    ...(verification ? { latestVerification: verification } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    ...(cancellation ? { cancellation } : {})
  };
}

export function createAutomationRunRecord({
  monitorId,
  sequence,
  trigger,
  now,
  config
}: {
  monitorId: string;
  sequence: number;
  trigger: AutomationRunTrigger;
  now: string;
  config: AutomationRunConfig;
}): AutomationRunRecord {
  const createdAt = readIsoTimestamp(now);
  return {
    schemaVersion: 1,
    runId: createAutomationRunId(monitorId, sequence),
    monitorId,
    trigger,
    state: "queued",
    createdAt,
    updatedAt: createdAt,
    deadlineAt: addMilliseconds(createdAt, config.runTtlMs),
    currentStep: "queued",
    nextAction: "wait-for-slot",
    attempt: 1,
    maxAttempts: config.maxAttempts,
    timeline: [{ at: createdAt, step: "queued" }],
    config
  };
}

export function transitionAutomationRun(
  record: AutomationRunRecord,
  event: AutomationRunEvent,
  now: string
): AutomationRunRecord {
  if (isAutomationRunTerminal(record.state)) {
    // Terminal finality: a stopped or expired run can never silently resume.
    // A new trigger always mints a new runId via the per-monitor sequence.
    return record;
  }

  const at = readIsoTimestamp(now);
  switch (event.type) {
    case "start": {
      if (record.state !== "queued") {
        return record;
      }
      return {
        ...record,
        state: "running",
        startedAt: record.startedAt ?? at,
        updatedAt: at,
        currentStep: "observe",
        nextAction: undefined,
        timeline: appendTimeline(record.timeline, { at, step: "started" })
      };
    }
    case "note": {
      return {
        ...record,
        updatedAt: at,
        currentStep: readBoundedString(event.step, MAX_AUTOMATION_RUN_STEP_LENGTH, record.currentStep),
        timeline: appendTimeline(record.timeline, {
          at,
          step: readBoundedString(event.step, MAX_AUTOMATION_RUN_STEP_LENGTH, record.currentStep),
          ...(event.detail ? { detail: readBoundedString(event.detail, MAX_AUTOMATION_RUN_DETAIL_LENGTH, "") } : {})
        })
      };
    }
    case "retry-scheduled": {
      if (record.state !== "running") {
        return record;
      }
      const delayMs = Math.max(0, Math.round(event.delayMs));
      return {
        ...record,
        state: "waiting",
        updatedAt: at,
        currentStep: "retry-backoff",
        nextAction: `retry-after-${delayMs}ms`,
        retryAvailableAt: addMilliseconds(at, delayMs),
        timeline: appendTimeline(record.timeline, {
          at,
          step: "retry-scheduled",
          detail: `attempt ${record.attempt} of ${record.maxAttempts} failed; retry in ${delayMs}ms`
        })
      };
    }
    case "retry-attempt": {
      if (record.state !== "waiting") {
        return record;
      }
      return {
        ...record,
        state: "running",
        attempt: record.attempt + 1,
        updatedAt: at,
        currentStep: "observe",
        nextAction: undefined,
        retryAvailableAt: undefined,
        timeline: appendTimeline(record.timeline, {
          at,
          step: "retry-attempt",
          detail: `attempt ${record.attempt + 1} of ${record.maxAttempts}`
        })
      };
    }
    case "verification": {
      if (record.state !== "running") {
        return record;
      }
      const verification = normalizeAutomationRunVerification(event.verification);
      if (!verification) {
        return record;
      }
      if (verification.status === "observing") {
        return finishRun(record, {
          at,
          state: "completed",
          terminalReason: "completed",
          currentStep: "completed",
          nextAction: "none",
          verification
        });
      }
      if (verification.status === "needs_attention" || verification.status === "blocked") {
        return finishRun(record, {
          at,
          state: "attention",
          terminalReason: "attention-required",
          currentStep: "attention",
          nextAction: "review-in-skfiy",
          verification
        });
      }
      return finishRun(record, {
        at,
        state: "failed",
        terminalReason: "non-retryable-error",
        currentStep: "failed",
        nextAction: "none",
        verification,
        error: verification.summary
      });
    }
    case "fail": {
      if (record.state !== "running") {
        return record;
      }
      const error = readBoundedString(event.error, MAX_AUTOMATION_RUN_ERROR_LENGTH, "run failed");
      if (
        event.retryable
        && record.attempt < record.maxAttempts
        && typeof event.delayMs === "number"
        && Number.isFinite(event.delayMs)
      ) {
        const delayMs = Math.max(0, Math.round(event.delayMs));
        return {
          ...record,
          state: "waiting",
          updatedAt: at,
          currentStep: "retry-backoff",
          nextAction: `retry-after-${delayMs}ms`,
          retryAvailableAt: addMilliseconds(at, delayMs),
          error,
          timeline: appendTimeline(record.timeline, {
            at,
            step: "retry-scheduled",
            detail: `${error}; retry in ${delayMs}ms`
          })
        };
      }
      return finishRun(record, {
        at,
        state: "failed",
        terminalReason: event.retryable ? "retries-exhausted" : "non-retryable-error",
        currentStep: "failed",
        nextAction: "none",
        error
      });
    }
    case "cancel": {
      return finishRun(record, {
        at,
        state: "cancelled",
        terminalReason: "cancelled-by-user",
        currentStep: "cancelled",
        nextAction: "none",
        cancellation: { requestedBy: event.requestedBy, at }
      });
    }
    case "expire": {
      return finishRun(record, {
        at,
        state: "expired",
        terminalReason: event.reason,
        currentStep: "expired",
        nextAction: "none"
      });
    }
  }
}

export function readNextBackoffDelayMs(
  attempt: number,
  config: Pick<AutomationRunConfig, "backoffMs" | "backoffMultiplier" | "maxBackoffMs">,
  prng: () => number = Math.random
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = Math.min(
    config.backoffMs * Math.pow(config.backoffMultiplier, safeAttempt - 1),
    config.maxBackoffMs
  );
  const jittered = base * (0.8 + prng() * 0.4);
  return Math.max(0, Math.round(jittered));
}

export function retainAutomationRuns(
  runs: AutomationRunRecord[],
  options: {
    perMonitorCap?: number;
    globalCap?: number;
  } = {}
): AutomationRunRecord[] {
  const perMonitorCap = Math.max(1, options.perMonitorCap ?? AUTOMATION_RUN_PER_MONITOR_CAP);
  const globalCap = Math.max(1, options.globalCap ?? AUTOMATION_RUN_GLOBAL_CAP);
  const activeRuns = runs.filter((run) => isAutomationRunActive(run.state));
  const terminalRuns = runs
    .filter((run) => isAutomationRunTerminal(run.state))
    .sort(compareRunRecency);

  const activeByMonitor = new Map<string, number>();
  for (const run of activeRuns) {
    activeByMonitor.set(run.monitorId, (activeByMonitor.get(run.monitorId) ?? 0) + 1);
  }

  const keptTerminal: AutomationRunRecord[] = [];
  const keptByMonitor = new Map<string, number>(activeByMonitor);
  for (const run of terminalRuns) {
    const monitorCount = keptByMonitor.get(run.monitorId) ?? 0;
    if (monitorCount >= perMonitorCap) {
      continue;
    }
    keptByMonitor.set(run.monitorId, monitorCount + 1);
    keptTerminal.push(run);
  }

  const activeTotal = activeRuns.length;
  const globalTerminalBudget = Math.max(0, globalCap - activeTotal);
  const globallyKept = keptTerminal.slice(0, globalTerminalBudget);

  return [...activeRuns, ...globallyKept];
}

export function readAutomationRunNotificationOutcome(
  record: AutomationRunRecord
): "attention" | "completed" | "failure" | undefined {
  if (record.state === "completed") {
    return "completed";
  }
  if (record.state === "attention") {
    return "attention";
  }
  if (record.state === "failed") {
    return "failure";
  }
  return undefined;
}

export function readRemainingBackoffMs(
  record: AutomationRunRecord,
  nowIso: string
): number | undefined {
  if (record.state !== "waiting" || !record.retryAvailableAt) {
    return undefined;
  }
  const retryAt = Date.parse(record.retryAvailableAt);
  const currentAt = Date.parse(nowIso);
  if (!Number.isFinite(retryAt) || !Number.isFinite(currentAt)) {
    return 0;
  }
  return Math.max(0, retryAt - currentAt);
}

export function isAutomationRunPastDeadline(
  record: AutomationRunRecord,
  nowIso: string
): boolean {
  if (!record.deadlineAt) {
    return false;
  }
  const deadline = Date.parse(record.deadlineAt);
  const currentAt = Date.parse(nowIso);
  if (!Number.isFinite(deadline) || !Number.isFinite(currentAt)) {
    return false;
  }
  return deadline <= currentAt;
}

function finishRun(
  record: AutomationRunRecord,
  update: {
    at: string;
    state: AutomationRunState;
    terminalReason: AutomationRunTerminalReason;
    currentStep: string;
    nextAction?: string;
    verification?: AutomationRunVerification;
    error?: string;
    cancellation?: AutomationRunCancellation;
  }
): AutomationRunRecord {
  const { at, state, terminalReason, currentStep, nextAction, verification, error, cancellation } =
    update;
  return {
    ...record,
    state,
    updatedAt: at,
    finishedAt: record.finishedAt ?? at,
    currentStep,
    nextAction,
    terminalReason,
    timeline: appendTimeline(record.timeline, { at, step: currentStep }),
    ...(verification ? { latestVerification: verification } : {}),
    ...(error ? { error } : {}),
    ...(cancellation ? { cancellation } : {})
  };
}

function appendTimeline(
  timeline: AutomationRunTimelineEntry[],
  entry: AutomationRunTimelineEntry
): AutomationRunTimelineEntry[] {
  const boundedEntry: AutomationRunTimelineEntry = {
    at: entry.at,
    step: readBoundedString(entry.step, MAX_AUTOMATION_RUN_STEP_LENGTH, "note"),
    ...(entry.detail
      ? { detail: readBoundedString(entry.detail, MAX_AUTOMATION_RUN_DETAIL_LENGTH, "") }
      : {})
  };
  const next = [...timeline, boundedEntry];
  return next.length > MAX_AUTOMATION_RUN_TIMELINE_ENTRIES
    ? next.slice(next.length - MAX_AUTOMATION_RUN_TIMELINE_ENTRIES)
    : next;
}

function compareRunRecency(left: AutomationRunRecord, right: AutomationRunRecord): number {
  const leftAt = Date.parse(left.finishedAt ?? left.updatedAt ?? left.createdAt);
  const rightAt = Date.parse(right.finishedAt ?? right.updatedAt ?? right.createdAt);
  if (leftAt === rightAt) {
    return right.runId.localeCompare(left.runId);
  }
  return rightAt - leftAt;
}

function normalizeAutomationRunId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= MAX_AUTOMATION_RUN_ID_LENGTH
    && AUTOMATION_RUN_ID_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

function normalizeAutomationRunMonitorId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= MAX_AUTOMATION_RUN_MONITOR_ID_LENGTH
    && AUTOMATION_RUN_MONITOR_ID_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

function normalizeAutomationRunState(value: unknown): AutomationRunState {
  return (
    value === "queued"
    || value === "running"
    || value === "waiting"
    || value === "attention"
    || value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "expired"
  )
    ? value
    : "expired";
}

function normalizeAutomationRunTrigger(value: unknown): AutomationRunTrigger {
  return (
    value === "manual"
    || value === "scheduled"
    || value === "local-state"
    || value === "cli"
    || value === "mcp"
  )
    ? value
    : "manual";
}

function normalizeAutomationRunTerminalReason(
  value: unknown
): AutomationRunTerminalReason | undefined {
  return (
    value === "completed"
    || value === "retries-exhausted"
    || value === "non-retryable-error"
    || value === "cancelled-by-user"
    || value === "expired-ttl"
    || value === "interrupted-by-restart"
    || value === "attention-required"
  )
    ? value
    : undefined;
}

function normalizeAutomationRunTimeline(value: unknown): AutomationRunTimelineEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries = value.flatMap((entryValue): AutomationRunTimelineEntry[] => {
    const record = readRecord(entryValue);
    if (!record || typeof record.at !== "string" || typeof record.step !== "string") {
      return [];
    }
    const at = readIsoTimestamp(record.at);
    const step = readBoundedString(record.step, MAX_AUTOMATION_RUN_STEP_LENGTH, "");
    if (!step) {
      return [];
    }
    return [{
      at,
      step,
      ...(typeof record.detail === "string" && record.detail.length > 0
        ? { detail: readBoundedString(record.detail, MAX_AUTOMATION_RUN_DETAIL_LENGTH, "") }
        : {})
    }];
  });
  return entries.length > MAX_AUTOMATION_RUN_TIMELINE_ENTRIES
    ? entries.slice(entries.length - MAX_AUTOMATION_RUN_TIMELINE_ENTRIES)
    : entries;
}

function normalizeAutomationRunVerification(
  value: unknown
): AutomationRunVerification | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  const kind = record.kind === "tmux-observation" || record.kind === "manual" || record.kind === "none"
    ? record.kind
    : "none";
  const status = record.status === "observing"
    || record.status === "needs_attention"
    || record.status === "blocked"
    || record.status === "error"
    ? record.status
    : "error";
  const summary = readBoundedString(record.summary, MAX_AUTOMATION_RUN_SUMMARY_LENGTH, "");
  if (!summary) {
    return undefined;
  }
  const recoveryProposals = normalizeAutomationRunRecoveryProposals(
    record.recoveryProposals
  );
  return {
    at: readIsoTimestamp(record.at),
    kind,
    status,
    summary,
    ...(recoveryProposals.length > 0 ? { recoveryProposals } : {})
  };
}

function normalizeAutomationRunRecoveryProposals(
  value: unknown
): AutomationRunRecoveryProposal[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const proposals: AutomationRunRecoveryProposal[] = [];
  for (const entry of value) {
    if (proposals.length >= MAX_AUTOMATION_RUN_RECOVERY_PROPOSALS) {
      break;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const proposalId = readBoundedString(record.proposalId, MAX_AUTOMATION_RUN_ID_LENGTH, "");
    const actionKind = record.actionKind === "send_input"
      || record.actionKind === "restart_step"
      || record.actionKind === "collect_summary"
      ? record.actionKind
      : undefined;
    const risk = record.risk === "low"
      || record.risk === "medium"
      || record.risk === "high"
      || record.risk === "blocked"
      ? record.risk
      : undefined;
    if (!proposalId || !actionKind || !risk) {
      continue;
    }
    proposals.push({
      proposalId,
      actionKind,
      reason: readBoundedString(
        record.reason,
        MAX_AUTOMATION_RUN_RECOVERY_REASON_LENGTH,
        ""
      ),
      risk,
      mutatesSession: record.mutatesSession === true
    });
  }
  return proposals;
}

function normalizeAutomationRunCancellation(
  value: unknown
): AutomationRunCancellation | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  const requestedBy = record.requestedBy === "pet"
    || record.requestedBy === "dashboard"
    || record.requestedBy === "cli"
    || record.requestedBy === "mcp"
    ? record.requestedBy
    : undefined;
  if (!requestedBy) {
    return undefined;
  }
  return {
    requestedBy,
    at: readIsoTimestamp(record.at)
  };
}

function normalizeAutomationRunConfig(
  value: unknown,
  fallback: Record<string, unknown>,
  fallbackMaxAttempts: number
): AutomationRunConfig | undefined {
  const record = readRecord(value);
  const sessionName = typeof record?.sessionName === "string"
    ? record.sessionName.trim()
    : typeof fallback.sessionName === "string"
      ? fallback.sessionName.trim()
      : "";
  if (!sessionName || !/^[A-Za-z0-9_.:-]+$/u.test(sessionName)) {
    return undefined;
  }
  const timeoutMs = clampInteger(
    readFiniteNumber(record?.timeoutMs, readFiniteNumber(fallback.timeoutMs, 30_000)),
    1_000,
    300_000
  );
  const maxAttempts = clampInteger(
    readFiniteNumber(record?.maxAttempts, fallbackMaxAttempts),
    1,
    10
  );
  const backoffMs = clampInteger(
    readFiniteNumber(record?.backoffMs, readFiniteNumber(fallback.backoffMs, 30_000)),
    1_000,
    300_000
  );
  const backoffMultiplier = clampNumber(
    readFiniteNumber(record?.backoffMultiplier, readFiniteNumber(fallback.backoffMultiplier, 2)),
    1,
    5
  );
  const maxBackoffMs = clampInteger(
    readFiniteNumber(record?.maxBackoffMs, readFiniteNumber(fallback.maxBackoffMs, 300_000)),
    1_000,
    3_600_000
  );
  const runTtlMs = clampInteger(
    readFiniteNumber(record?.runTtlMs, readFiniteNumber(fallback.runTtlMs, 900_000)),
    60_000,
    3_600_000
  );
  const concurrencyPolicy = record?.concurrencyPolicy === "skip"
    || record?.concurrencyPolicy === "queue"
    || record?.concurrencyPolicy === "allow"
    ? record.concurrencyPolicy
    : fallback.concurrencyPolicy === "queue" || fallback.concurrencyPolicy === "allow"
      ? fallback.concurrencyPolicy
      : "skip";
  const maxConcurrency = clampInteger(
    readFiniteNumber(record?.maxConcurrency, readFiniteNumber(fallback.maxConcurrency, 1)),
    1,
    8
  );
  return {
    sessionName,
    timeoutMs,
    maxAttempts,
    backoffMs,
    backoffMultiplier,
    maxBackoffMs,
    runTtlMs,
    concurrencyPolicy,
    maxConcurrency
  };
}

export function createAutomationRunConfig(input: {
  sessionName: string;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  runTtlMs: number;
  concurrencyPolicy: AutomationRunConcurrencyPolicy;
  maxConcurrency: number;
}): AutomationRunConfig {
  const config = normalizeAutomationRunConfig(input, {}, input.maxAttempts);
  if (!config) {
    throw new Error("Automation run config requires a valid tmux session name.");
  }
  return config;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.round(value))
    : fallback;
}

function readIsoTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    return EPOCH_ISO;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : EPOCH_ISO;
}

function readOptionalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function readBoundedString(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function readOptionalBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function addMilliseconds(isoDate: string, intervalMs: number): string {
  const time = Date.parse(isoDate);
  if (!Number.isFinite(time)) {
    return new Date(Date.now() + intervalMs).toISOString();
  }
  return new Date(time + intervalMs).toISOString();
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
