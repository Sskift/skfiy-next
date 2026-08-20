import type { AutomationMonitorDefinition } from "./automation-monitor.js";
import type { TmuxRecoveryProposal } from "./computer-use/tmux-recovery.js";
import type { TmuxSupervisionClient } from "./tmux-supervision-client.js";
import type { TmuxSupervisionReport } from "./computer-use/tmux-supervisor.js";
import {
  createAutomationRunConfig,
  createAutomationRunRecord,
  isAutomationRunActive,
  isAutomationRunPastDeadline,
  isAutomationRunTerminal,
  readAutomationRunNotificationOutcome,
  readNextBackoffDelayMs,
  readRemainingBackoffMs,
  retainAutomationRuns,
  transitionAutomationRun,
  MAX_AUTOMATION_RUN_ERROR_LENGTH,
  MAX_AUTOMATION_RUN_SUMMARY_LENGTH,
  MAX_AUTOMATION_RUN_RECOVERY_PROPOSALS,
  MAX_AUTOMATION_RUN_RECOVERY_REASON_LENGTH,
  MAX_AUTOMATION_RUN_ID_LENGTH,
  type AutomationRunCancellationSource,
  type AutomationRunConfig,
  type AutomationRunRecoveryActionKind,
  type AutomationRunRecoveryProposal,
  type AutomationRunRecord,
  type AutomationRunSnapshot,
  type AutomationRunStore,
  type AutomationRunTrigger
} from "./automation-run.js";
import type { AutomationMonitorNotificationEvent } from "./automation-monitor.js";

export type AutomationRunSetInterval = (callback: () => void, intervalMs: number) => unknown;
export type AutomationRunClearInterval = (timer: unknown) => void;
export type AutomationRunSetTimeout = (callback: () => void, timeoutMs: number) => unknown;
export type AutomationRunClearTimeout = (timer: unknown) => void;

export interface AutomationRunSupervisorStatus {
  inFlight: number;
  activeRunCount: number;
  queuedCount: number;
  skipped: Record<string, number>;
}

export interface AutomationRunSupervisor {
  requestRun: (input: {
    definition: AutomationMonitorDefinition;
    trigger: AutomationRunTrigger;
  }) => Promise<AutomationRunRecord>;
  stopRun: (
    runId: string,
    requestedBy: AutomationRunCancellationSource
  ) => Promise<AutomationRunRecord | undefined>;
  stopMonitorRuns: (
    monitorId: string,
    requestedBy: AutomationRunCancellationSource
  ) => void;
  readRuns: (filter?: { monitorId?: string }) => AutomationRunRecord[];
  readSnapshot: () => AutomationRunSnapshot;
  readStatus: () => AutomationRunSupervisorStatus;
  start: () => void;
  stop: () => void;
}

interface SlotWaiter {
  runId: string;
  proceed: () => void;
}

const MAX_SKIPPED_TRIGGERS_REMEMBERED = 64;

export function createAutomationRunSupervisor({
  clearInterval = globalThis.clearInterval as AutomationRunClearInterval,
  clearTimeout = globalThis.clearTimeout as AutomationRunClearTimeout,
  maxConcurrentObservations = 8,
  now = () => new Date().toISOString(),
  onRunTerminal = () => undefined,
  prng = Math.random,
  setInterval = globalThis.setInterval as unknown as AutomationRunSetInterval,
  setTimeout = globalThis.setTimeout as unknown as AutomationRunSetTimeout,
  store,
  sweepIntervalMs = 15_000,
  tmuxClient
}: {
  clearInterval?: AutomationRunClearInterval;
  clearTimeout?: AutomationRunClearTimeout;
  maxConcurrentObservations?: number;
  now?: () => string;
  onRunTerminal?: (event: AutomationMonitorNotificationEvent) => void;
  prng?: () => number;
  setInterval?: AutomationRunSetInterval;
  setTimeout?: AutomationRunSetTimeout;
  store: AutomationRunStore;
  sweepIntervalMs?: number;
  tmuxClient: TmuxSupervisionClient;
}): AutomationRunSupervisor {
  const runs = new Map<string, AutomationRunRecord>();
  const sequences = new Map<string, number>();
  const inFlight = new Map<string, Set<string>>();
  const queued = new Map<string, string[]>();
  const backoffTimers = new Map<string, unknown>();
  const abortControllers = new Map<string, AbortController>();
  const settlePromises = new Map<string, Promise<void>>();
  const stopRequested = new Set<string>();
  const completers = new Map<string, (record: AutomationRunRecord) => void>();
  const terminalPromises = new Map<string, Promise<AutomationRunRecord>>();
  const skipped = new Map<string, number>();
  const labels = new Map<string, string>();
  const globalWaiters: SlotWaiter[] = [];
  const boundedMaxConcurrent = Math.max(1, Math.floor(maxConcurrentObservations));
  let globalInFlight = 0;
  let sweepTimer: unknown;
  let started = false;
  let stopped = false;

  reconcile();

  function persist() {
    const sequenceRecord: Record<string, number> = {};
    for (const [monitorId, sequence] of sequences) {
      sequenceRecord[monitorId] = sequence;
    }
    store.write({
      schemaVersion: 1,
      sequences: sequenceRecord,
      runs: retainAutomationRuns([...runs.values()])
    });
  }

  function applyTransition(
    runId: string,
    event: Parameters<typeof transitionAutomationRun>[1]
  ): AutomationRunRecord | undefined {
    const record = runs.get(runId);
    if (!record) {
      return undefined;
    }
    const next = transitionAutomationRun(record, event, now());
    if (next !== record) {
      runs.set(runId, next);
      persist();
      if (isAutomationRunTerminal(next.state)) {
        finalizeRun(runId, next);
      }
    }
    return next;
  }

  function finalizeRun(runId: string, record: AutomationRunRecord) {
    emitTerminal(record);
    const completer = completers.get(runId);
    if (completer) {
      completers.delete(runId);
      terminalPromises.delete(runId);
      completer(record);
    }
    removeInFlight(record.monitorId, runId);
    drainMonitor(record.monitorId);
  }

  function emitTerminal(record: AutomationRunRecord) {
    const outcome = readAutomationRunNotificationOutcome(record);
    if (!outcome) {
      return;
    }
    if (record.trigger === "scheduled") {
      const previous = readPreviousOutcome(record);
      if (previous === outcome) {
        return;
      }
    }
    try {
      onRunTerminal({
        runId: record.runId,
        label: labels.get(record.monitorId) ?? record.monitorId,
        outcome
      });
    } catch {
      // Native notification failures must not change the durable run outcome.
    }
  }

  function readPreviousOutcome(
    record: AutomationRunRecord
  ): AutomationMonitorNotificationEvent["outcome"] | undefined {
    const currentSequence = readRunSequence(record.runId);
    let previousOutcome: AutomationMonitorNotificationEvent["outcome"] | undefined;
    let previousSequence = -1;
    for (const candidate of runs.values()) {
      if (candidate.monitorId !== record.monitorId) {
        continue;
      }
      const candidateSequence = readRunSequence(candidate.runId);
      if (candidateSequence >= currentSequence || candidateSequence <= previousSequence) {
        continue;
      }
      const outcome = readAutomationRunNotificationOutcome(candidate);
      if (outcome) {
        previousOutcome = outcome;
        previousSequence = candidateSequence;
      }
    }
    return previousOutcome;
  }

  function addInFlight(monitorId: string, runId: string) {
    const set = inFlight.get(monitorId) ?? new Set<string>();
    set.add(runId);
    inFlight.set(monitorId, set);
  }

  function removeInFlight(monitorId: string, runId: string) {
    const set = inFlight.get(monitorId);
    if (!set) {
      return;
    }
    set.delete(runId);
    if (set.size === 0) {
      inFlight.delete(monitorId);
    }
  }

  function countActive(monitorId: string): number {
    return (inFlight.get(monitorId)?.size ?? 0) + (queued.get(monitorId)?.length ?? 0);
  }

  function mintRun(
    definition: AutomationMonitorDefinition,
    trigger: AutomationRunTrigger,
    config: AutomationRunConfig
  ): AutomationRunRecord {
    const sequence = (sequences.get(definition.id) ?? 0) + 1;
    sequences.set(definition.id, sequence);
    const record = createAutomationRunRecord({
      monitorId: definition.id,
      sequence,
      trigger,
      now: now(),
      config
    });
    runs.set(record.runId, record);
    labels.set(definition.id, definition.label);
    terminalPromises.set(record.runId, new Promise<AutomationRunRecord>((resolve) => {
      completers.set(record.runId, resolve);
    }));
    persist();
    return record;
  }

  function requestRun({
    definition,
    trigger
  }: {
    definition: AutomationMonitorDefinition;
    trigger: AutomationRunTrigger;
  }): Promise<AutomationRunRecord> {
    const config = readConfigFromDefinition(definition);
    labels.set(definition.id, definition.label);
    const activeCount = countActive(definition.id);

    if (config.concurrencyPolicy === "skip" && activeCount >= 1) {
      const activeRunId = readMostRecentActiveRunId(definition.id);
      if (activeRunId) {
        rememberSkipped(definition.id);
        const terminal = terminalPromises.get(activeRunId);
        if (terminal) {
          return terminal;
        }
        const activeRecord = runs.get(activeRunId);
        if (activeRecord) {
          return Promise.resolve(activeRecord);
        }
      }
    }

    const record = mintRun(definition, trigger, config);

    if (
      config.concurrencyPolicy === "queue"
      || (config.concurrencyPolicy === "allow" && activeCount >= config.maxConcurrency)
    ) {
      enqueueRun(definition.id, record.runId);
      persist();
      drainMonitor(definition.id);
    } else {
      startRun(record.runId);
    }

    return terminalPromises.get(record.runId) ?? Promise.resolve(record);
  }

  function rememberSkipped(monitorId: string) {
    skipped.set(monitorId, (skipped.get(monitorId) ?? 0) + 1);
    if (skipped.size > MAX_SKIPPED_TRIGGERS_REMEMBERED) {
      const oldest = skipped.keys().next().value;
      if (oldest) {
        skipped.delete(oldest);
      }
    }
  }

  function readMostRecentActiveRunId(monitorId: string): string | undefined {
    let mostRecent: string | undefined;
    let mostRecentSequence = -1;
    for (const runId of [...(inFlight.get(monitorId) ?? []), ...(queued.get(monitorId) ?? [])]) {
      const sequence = readRunSequence(runId);
      if (sequence > mostRecentSequence) {
        mostRecent = runId;
        mostRecentSequence = sequence;
      }
    }
    return mostRecent;
  }

  function enqueueRun(monitorId: string, runId: string) {
    const queue = queued.get(monitorId) ?? [];
    queue.push(runId);
    queued.set(monitorId, queue);
  }

  function startRun(runId: string) {
    const record = runs.get(runId);
    if (!record || record.state !== "queued") {
      return;
    }
    const next = applyTransition(runId, { type: "start" });
    if (!next || next.state !== "running") {
      return;
    }
    addInFlight(record.monitorId, runId);
    void acquireSlotAndExecute(runId);
  }

  function acquireSlotAndExecute(runId: string) {
    if (stopped) {
      return;
    }
    if (globalInFlight < boundedMaxConcurrent) {
      globalInFlight += 1;
      executeAttempt(runId);
      return;
    }
    globalWaiters.push({
      runId,
      proceed: () => {
        globalInFlight += 1;
        executeAttempt(runId);
      }
    });
  }

  function releaseSlot() {
    if (globalInFlight > 0) {
      globalInFlight -= 1;
    }
    const waiter = globalWaiters.shift();
    if (waiter) {
      waiter.proceed();
    }
  }

  function executeAttempt(runId: string) {
    const record = runs.get(runId);
    if (!record || record.state !== "running") {
      releaseSlot();
      return;
    }
    const abort = new AbortController();
    abortControllers.set(runId, abort);
    const attempt = observeWithTimeout(record.config, abort);
    const settled = attempt.then(
      (report) => {
        onAttemptSettled(runId, { ok: true, report });
      },
      (error: unknown) => {
        onAttemptSettled(runId, { ok: false, error });
      }
    );
    settlePromises.set(runId, settled);
  }

  function observeWithTimeout(
    config: AutomationRunConfig,
    abort: AbortController
  ): Promise<TmuxSupervisionReport> {
    return new Promise<TmuxSupervisionReport>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Automation run timed out after ${config.timeoutMs}ms.`));
      }, config.timeoutMs);
      abort.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Automation run was stopped."));
      }, { once: true });
      void tmuxClient.observeSession(config.sessionName).then(
        (report) => {
          clearTimeout(timer);
          resolve(report);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function onAttemptSettled(
    runId: string,
    outcome: { ok: true; report: TmuxSupervisionReport } | { ok: false; error: unknown }
  ) {
    const record = runs.get(runId);
    abortControllers.delete(runId);
    settlePromises.delete(runId);
    if (!record) {
      releaseSlot();
      return;
    }
    if (stopped || stopRequested.has(runId) || record.state !== "running") {
      stopRequested.delete(runId);
      releaseSlot();
      return;
    }

    if (outcome.ok) {
      const report = outcome.report;
      const recoveryProposals = readVerificationRecoveryProposals(
        report.recoveryProposals
      );
      const verification = {
        at: now(),
        kind: "tmux-observation" as const,
        status: report.status,
        summary: boundString(report.recommendation.reason, MAX_AUTOMATION_RUN_SUMMARY_LENGTH),
        // Surface proposals through the existing verification channel. The
        // supervisor stays read-only: it never executes recovery itself.
        ...(recoveryProposals.length > 0 ? { recoveryProposals } : {})
      };
      applyTransition(runId, { type: "verification", verification });
      releaseSlot();
      return;
    }

    const message = boundString(
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      MAX_AUTOMATION_RUN_ERROR_LENGTH
    );
    if (record.attempt < record.maxAttempts) {
      const delayMs = readNextBackoffDelayMs(record.attempt, record.config, prng);
      const next = applyTransition(runId, {
        type: "fail",
        error: message,
        retryable: true,
        delayMs
      });
      releaseSlot();
      if (next?.state === "waiting") {
        armBackoff(runId, delayMs);
      }
      return;
    }

    applyTransition(runId, { type: "fail", error: message, retryable: true });
    releaseSlot();
  }

  function armBackoff(runId: string, delayMs: number) {
    if (stopped) {
      return;
    }
    const timer = setTimeout(() => {
      backoffTimers.delete(runId);
      onBackoffFired(runId);
    }, delayMs);
    backoffTimers.set(runId, timer);
  }

  function onBackoffFired(runId: string) {
    const record = runs.get(runId);
    if (!record || record.state !== "waiting" || stopped) {
      return;
    }
    if (isAutomationRunPastDeadline(record, now())) {
      applyTransition(runId, { type: "expire", reason: "expired-ttl" });
      removeInFlight(record.monitorId, runId);
      drainMonitor(record.monitorId);
      return;
    }
    const next = applyTransition(runId, { type: "retry-attempt" });
    if (next?.state === "running") {
      void acquireSlotAndExecute(runId);
    }
  }

  function drainMonitor(monitorId: string) {
    if (stopped) {
      return;
    }
    const queue = queued.get(monitorId);
    while (queue && queue.length > 0) {
      const nextRunId = queue[0]!;
      const record = runs.get(nextRunId);
      if (!record || record.state !== "queued") {
        queue.shift();
        continue;
      }
      const activeCount = inFlight.get(monitorId)?.size ?? 0;
      if (activeCount >= record.config.maxConcurrency) {
        return;
      }
      queue.shift();
      startRun(nextRunId);
    }
  }

  async function stopRun(
    runId: string,
    requestedBy: AutomationRunCancellationSource
  ): Promise<AutomationRunRecord | undefined> {
    const record = runs.get(runId);
    if (!record) {
      return undefined;
    }
    if (isAutomationRunTerminal(record.state)) {
      return record;
    }

    if (record.state === "queued") {
      removeFromQueue(record.monitorId, runId);
      const cancelled = applyTransition(runId, { type: "cancel", requestedBy });
      drainMonitor(record.monitorId);
      return cancelled;
    }

    if (record.state === "waiting") {
      clearBackoffTimer(runId);
      const cancelled = applyTransition(runId, { type: "cancel", requestedBy });
      removeInFlight(record.monitorId, runId);
      drainMonitor(record.monitorId);
      return cancelled;
    }

    stopRequested.add(runId);
    const abort = abortControllers.get(runId);
    if (abort) {
      abort.abort();
    }
    const settled = settlePromises.get(runId);
    if (settled) {
      await settled;
    }
    stopRequested.delete(runId);
    const cancelled = applyTransition(runId, { type: "cancel", requestedBy });
    removeInFlight(record.monitorId, runId);
    drainMonitor(record.monitorId);
    return cancelled;
  }

  function stopMonitorRuns(
    monitorId: string,
    requestedBy: AutomationRunCancellationSource
  ): void {
    const activeRunIds = [
      ...(inFlight.get(monitorId) ?? []),
      ...(queued.get(monitorId) ?? [])
    ];
    for (const runId of activeRunIds) {
      void stopRun(runId, requestedBy);
    }
  }

  function removeFromQueue(monitorId: string, runId: string) {
    const queue = queued.get(monitorId);
    if (!queue) {
      return;
    }
    const index = queue.indexOf(runId);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    if (queue.length === 0) {
      queued.delete(monitorId);
    }
  }

  function clearBackoffTimer(runId: string) {
    const timer = backoffTimers.get(runId);
    if (timer !== undefined) {
      clearTimeout(timer);
      backoffTimers.delete(runId);
    }
  }

  function sweep() {
    if (stopped) {
      return;
    }
    const at = now();
    for (const record of [...runs.values()]) {
      if (!isAutomationRunActive(record.state) || !isAutomationRunPastDeadline(record, at)) {
        continue;
      }
      if (record.state === "running") {
        stopRequested.add(record.runId);
        abortControllers.get(record.runId)?.abort();
      } else if (record.state === "waiting") {
        clearBackoffTimer(record.runId);
      } else {
        removeFromQueue(record.monitorId, record.runId);
      }
      applyTransition(record.runId, { type: "expire", reason: "expired-ttl" });
      removeInFlight(record.monitorId, record.runId);
      drainMonitor(record.monitorId);
    }
  }

  function reconcile() {
    const snapshot = store.read();
    for (const [monitorId, sequence] of Object.entries(snapshot.sequences)) {
      sequences.set(monitorId, sequence);
    }
    let changed = false;
    for (const record of snapshot.runs) {
      runs.set(record.runId, record);
      terminalPromises.set(record.runId, new Promise<AutomationRunRecord>((resolve) => {
        completers.set(record.runId, resolve);
      }));
      if (record.state === "running") {
        runs.set(record.runId, transitionAutomationRun(
          record,
          { type: "expire", reason: "interrupted-by-restart" },
          now()
        ));
        changed = true;
        continue;
      }
      if (record.state === "waiting") {
        if (isAutomationRunPastDeadline(record, now())) {
          runs.set(record.runId, transitionAutomationRun(
            record,
            { type: "expire", reason: "expired-ttl" },
            now()
          ));
          changed = true;
          continue;
        }
        addInFlight(record.monitorId, record.runId);
        const remainingMs = readRemainingBackoffMs(record, now()) ?? 0;
        armBackoff(record.runId, remainingMs);
        continue;
      }
      if (record.state === "queued") {
        if (isAutomationRunPastDeadline(record, now())) {
          runs.set(record.runId, transitionAutomationRun(
            record,
            { type: "expire", reason: "expired-ttl" },
            now()
          ));
          changed = true;
          continue;
        }
        enqueueRun(record.monitorId, record.runId);
      }
    }
    if (changed) {
      persist();
    }
  }

  function readRuns(filter?: { monitorId?: string }): AutomationRunRecord[] {
    const values = [...runs.values()].filter((record) =>
      filter?.monitorId ? record.monitorId === filter.monitorId : true
    );
    return values.sort(compareRunRecency);
  }

  function readSnapshot(): AutomationRunSnapshot {
    return {
      schemaVersion: 1,
      generatedAt: now(),
      runs: readRuns()
    };
  }

  function readStatus(): AutomationRunSupervisorStatus {
    let activeRunCount = 0;
    for (const set of inFlight.values()) {
      activeRunCount += set.size;
    }
    let queuedCount = 0;
    for (const queue of queued.values()) {
      queuedCount += queue.length;
    }
    const skippedRecord: Record<string, number> = {};
    for (const [monitorId, count] of skipped) {
      skippedRecord[monitorId] = count;
    }
    return {
      inFlight: globalInFlight,
      activeRunCount,
      queuedCount,
      skipped: skippedRecord
    };
  }

  function start() {
    if (started) {
      return;
    }
    started = true;
    stopped = false;
    sweepTimer = setInterval(() => {
      sweep();
    }, sweepIntervalMs);
    for (const monitorId of queued.keys()) {
      drainMonitor(monitorId);
    }
  }

  function stop() {
    if (!started) {
      return;
    }
    started = false;
    stopped = true;
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
    for (const timer of backoffTimers.values()) {
      clearTimeout(timer);
    }
    backoffTimers.clear();
    for (const [runId, abort] of abortControllers) {
      stopRequested.add(runId);
      abort.abort();
    }
    globalWaiters.length = 0;
  }

  return {
    requestRun,
    stopRun,
    stopMonitorRuns,
    readRuns,
    readSnapshot,
    readStatus,
    start,
    stop
  };
}

function readConfigFromDefinition(
  definition: AutomationMonitorDefinition
): AutomationRunConfig {
  return createAutomationRunConfig({
    sessionName: definition.sessionName,
    timeoutMs: definition.timeoutMs,
    maxAttempts: definition.maxAttempts,
    backoffMs: definition.backoffMs,
    backoffMultiplier: definition.backoffMultiplier,
    maxBackoffMs: definition.maxBackoffMs,
    runTtlMs: definition.runTtlMs,
    concurrencyPolicy: definition.concurrencyPolicy,
    maxConcurrency: definition.maxConcurrency
  });
}

function readRunSequence(runId: string): number {
  const marker = runId.lastIndexOf(":run:");
  if (marker < 0) {
    return -1;
  }
  const sequence = Number.parseInt(runId.slice(marker + 5), 10);
  return Number.isFinite(sequence) ? sequence : -1;
}

function compareRunRecency(left: AutomationRunRecord, right: AutomationRunRecord): number {
  const leftAt = Date.parse(left.updatedAt);
  const rightAt = Date.parse(right.updatedAt);
  if (leftAt === rightAt) {
    return right.runId.localeCompare(left.runId);
  }
  return rightAt - leftAt;
}

function boundString(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function readVerificationRecoveryProposals(
  proposals: readonly TmuxRecoveryProposal[]
): AutomationRunRecoveryProposal[] {
  const result: AutomationRunRecoveryProposal[] = [];
  for (const proposal of proposals) {
    if (result.length >= MAX_AUTOMATION_RUN_RECOVERY_PROPOSALS) {
      break;
    }
    const actionKind: AutomationRunRecoveryActionKind = proposal.action.kind;
    result.push({
      proposalId: boundString(proposal.proposalId, MAX_AUTOMATION_RUN_ID_LENGTH),
      actionKind,
      reason: boundString(proposal.reason, MAX_AUTOMATION_RUN_RECOVERY_REASON_LENGTH),
      risk: proposal.risk.level,
      mutatesSession: proposal.mutatesSession
    });
  }
  return result;
}
