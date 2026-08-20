import { describe, expect, it } from "vitest";
import {
  AUTOMATION_RUN_GLOBAL_CAP,
  AUTOMATION_RUN_PER_MONITOR_CAP,
  MAX_AUTOMATION_RUN_DETAIL_LENGTH,
  MAX_AUTOMATION_RUN_TIMELINE_ENTRIES,
  createAutomationRunRecord,
  createAutomationRunStore,
  isAutomationRunActive,
  isAutomationRunTerminal,
  normalizeAutomationRunStoreSnapshot,
  readAutomationRunNotificationOutcome,
  readNextBackoffDelayMs,
  readRemainingBackoffMs,
  retainAutomationRuns,
  transitionAutomationRun,
  type AutomationRunConfig,
  type AutomationRunEvent,
  type AutomationRunRecord,
  type AutomationRunStoreIo
} from "./automation-run.js";

const FIXED_NOW = "2026-08-20T09:00:00.000Z";
const MONITOR_ID = "tmux-session:money-run-goal";

function createConfig(overrides: Partial<AutomationRunConfig> = {}): AutomationRunConfig {
  return {
    sessionName: "money-run-goal",
    timeoutMs: 30_000,
    maxAttempts: 3,
    backoffMs: 30_000,
    backoffMultiplier: 2,
    maxBackoffMs: 300_000,
    runTtlMs: 900_000,
    concurrencyPolicy: "skip",
    maxConcurrency: 1,
    ...overrides
  };
}

function createQueuedRun(sequence = 1): AutomationRunRecord {
  return createAutomationRunRecord({
    monitorId: MONITOR_ID,
    sequence,
    trigger: "manual",
    now: FIXED_NOW,
    config: createConfig()
  });
}

function createMemoryIo(files: Map<string, string> = new Map()): AutomationRunStoreIo {
  return {
    exists: (filePath) => files.has(filePath),
    mkdir: () => undefined,
    readFile: (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        throw new Error(`Missing file: ${filePath}`);
      }
      return content;
    },
    rename: (fromPath, toPath) => {
      const content = files.get(fromPath);
      if (content === undefined) {
        throw new Error(`Missing file: ${fromPath}`);
      }
      files.delete(fromPath);
      files.set(toPath, content);
    },
    writeFile: (filePath, content) => {
      files.set(filePath, content);
    }
  };
}

function startRun(record: AutomationRunRecord, now: string = FIXED_NOW): AutomationRunRecord {
  return transitionAutomationRun(record, { type: "start" }, now);
}

function succeedRun(
  record: AutomationRunRecord,
  now: string = FIXED_NOW,
  summary = "money-run-goal has 1 window, 1 pane, and no obvious block markers."
): AutomationRunRecord {
  return transitionAutomationRun(record, {
    type: "verification",
    verification: {
      at: now,
      kind: "tmux-observation",
      status: "observing",
      summary
    }
  }, now);
}

describe("automation run state model", () => {
  it("classifies terminal and active states", () => {
    expect(isAutomationRunTerminal("queued")).toBe(false);
    expect(isAutomationRunTerminal("running")).toBe(false);
    expect(isAutomationRunTerminal("waiting")).toBe(false);
    for (const state of ["attention", "completed", "failed", "cancelled", "expired"] as const) {
      expect(isAutomationRunTerminal(state)).toBe(true);
      expect(isAutomationRunActive(state)).toBe(false);
    }
    for (const state of ["queued", "running", "waiting"] as const) {
      expect(isAutomationRunActive(state)).toBe(true);
    }
  });

  it("mints run ids with the persisted sequence convention", () => {
    const run = createQueuedRun(7);
    expect(run.runId).toBe("tmux-session:money-run-goal:run:7");
    expect(run.monitorId).toBe(MONITOR_ID);
    expect(run.state).toBe("queued");
    expect(run.attempt).toBe(1);
    expect(run.maxAttempts).toBe(3);
    expect(run.currentStep).toBe("queued");
    expect(run.nextAction).toBe("wait-for-slot");
    expect(run.timeline).toEqual([{ at: FIXED_NOW, step: "queued" }]);
    expect(run.deadlineAt).toBe("2026-08-20T09:15:00.000Z");
  });

  it("transitions queued to running to completed", () => {
    const running = startRun(createQueuedRun());
    expect(running.state).toBe("running");
    expect(running.startedAt).toBe(FIXED_NOW);
    expect(running.currentStep).toBe("observe");
    expect(running.nextAction).toBeUndefined();
    expect(running.timeline.at(-1)).toEqual({ at: FIXED_NOW, step: "started" });

    const completed = succeedRun(running);
    expect(completed.state).toBe("completed");
    expect(completed.terminalReason).toBe("completed");
    expect(completed.finishedAt).toBe(FIXED_NOW);
    expect(completed.currentStep).toBe("completed");
    expect(completed.nextAction).toBe("none");
    expect(completed.latestVerification).toMatchObject({
      kind: "tmux-observation",
      status: "observing"
    });
    expect(completed.timeline.at(-1)).toEqual({ at: FIXED_NOW, step: "completed" });
  });

  it("transitions running to attention for needs_attention and blocked outcomes", () => {
    for (const status of ["needs_attention", "blocked"] as const) {
      const attention = transitionAutomationRun(startRun(createQueuedRun()), {
        type: "verification",
        verification: {
          at: FIXED_NOW,
          kind: "tmux-observation",
          status,
          summary: "block marker detected"
        }
      }, FIXED_NOW);
      expect(attention.state).toBe("attention");
      expect(attention.terminalReason).toBe("attention-required");
      expect(attention.nextAction).toBe("review-in-skfiy");
      expect(attention.latestVerification?.status).toBe(status);
    }
  });

  it("transitions running to waiting then back to running on retry", () => {
    const running = startRun(createQueuedRun());
    const waiting = transitionAutomationRun(running, {
      type: "fail",
      error: "tmux unavailable",
      retryable: true,
      delayMs: 30_000
    }, FIXED_NOW);

    expect(waiting.state).toBe("waiting");
    expect(waiting.currentStep).toBe("retry-backoff");
    expect(waiting.nextAction).toBe("retry-after-30000ms");
    expect(waiting.retryAvailableAt).toBe("2026-08-20T09:00:30.000Z");
    expect(waiting.error).toBe("tmux unavailable");
    expect(waiting.timeline.at(-1)?.step).toBe("retry-scheduled");

    const retrying = transitionAutomationRun(waiting, { type: "retry-attempt" }, "2026-08-20T09:00:30.000Z");
    expect(retrying.state).toBe("running");
    expect(retrying.attempt).toBe(2);
    expect(retrying.retryAvailableAt).toBeUndefined();
    expect(retrying.timeline.at(-1)).toEqual({
      at: "2026-08-20T09:00:30.000Z",
      step: "retry-attempt",
      detail: "attempt 2 of 3"
    });
  });

  it("fails permanently when retries are exhausted", () => {
    let record = startRun(createQueuedRun());
    record = transitionAutomationRun(record, {
      type: "fail",
      error: "tmux unavailable",
      retryable: true,
      delayMs: 1_000
    }, FIXED_NOW);
    record = transitionAutomationRun(record, { type: "retry-attempt" }, FIXED_NOW);
    record = transitionAutomationRun(record, {
      type: "fail",
      error: "tmux unavailable",
      retryable: true,
      delayMs: 1_000
    }, FIXED_NOW);
    record = transitionAutomationRun(record, { type: "retry-attempt" }, FIXED_NOW);
    const exhausted = transitionAutomationRun(record, {
      type: "fail",
      error: "tmux unavailable",
      retryable: true,
      delayMs: 1_000
    }, FIXED_NOW);

    expect(exhausted.state).toBe("failed");
    expect(exhausted.terminalReason).toBe("retries-exhausted");
    expect(exhausted.attempt).toBe(3);
    expect(exhausted.error).toBe("tmux unavailable");
    expect(exhausted.finishedAt).toBe(FIXED_NOW);
  });

  it("fails immediately for non-retryable errors", () => {
    const failed = transitionAutomationRun(startRun(createQueuedRun()), {
      type: "fail",
      error: "session vanished",
      retryable: false
    }, FIXED_NOW);
    expect(failed.state).toBe("failed");
    expect(failed.terminalReason).toBe("non-retryable-error");
  });

  it("cancels any non-terminal run and records who asked", () => {
    const queued = createQueuedRun();
    const cancelledQueued = transitionAutomationRun(queued, {
      type: "cancel",
      requestedBy: "dashboard"
    }, FIXED_NOW);
    expect(cancelledQueued.state).toBe("cancelled");
    expect(cancelledQueued.terminalReason).toBe("cancelled-by-user");
    expect(cancelledQueued.cancellation).toEqual({ requestedBy: "dashboard", at: FIXED_NOW });

    const waiting = transitionAutomationRun(startRun(createQueuedRun(2)), {
      type: "fail",
      error: "x",
      retryable: true,
      delayMs: 1_000
    }, FIXED_NOW);
    const cancelledWaiting = transitionAutomationRun(waiting, {
      type: "cancel",
      requestedBy: "cli"
    }, FIXED_NOW);
    expect(cancelledWaiting.state).toBe("cancelled");
    expect(cancelledWaiting.cancellation?.requestedBy).toBe("cli");
  });

  it("expires a running run past its deadline", () => {
    const expired = transitionAutomationRun(startRun(createQueuedRun()), {
      type: "expire",
      reason: "expired-ttl"
    }, "2026-08-20T09:16:00.000Z");
    expect(expired.state).toBe("expired");
    expect(expired.terminalReason).toBe("expired-ttl");
    expect(expired.finishedAt).toBe("2026-08-20T09:16:00.000Z");
  });
});

describe("automation run terminal finality", () => {
  const terminalStates = ["attention", "completed", "failed", "cancelled", "expired"] as const;

  for (const terminalState of terminalStates) {
    it(`never transitions out of ${terminalState}`, () => {
      let record = startRun(createQueuedRun());
      if (terminalState === "completed") {
        record = succeedRun(record);
      } else if (terminalState === "attention") {
        record = transitionAutomationRun(record, {
          type: "verification",
          verification: {
            at: FIXED_NOW,
            kind: "tmux-observation",
            status: "needs_attention",
            summary: "review"
          }
        }, FIXED_NOW);
      } else if (terminalState === "failed") {
        record = transitionAutomationRun(record, {
          type: "fail",
          error: "boom",
          retryable: false
        }, FIXED_NOW);
      } else if (terminalState === "cancelled") {
        record = transitionAutomationRun(record, {
          type: "cancel",
          requestedBy: "pet"
        }, FIXED_NOW);
      } else {
        record = transitionAutomationRun(record, {
          type: "expire",
          reason: "expired-ttl"
        }, FIXED_NOW);
      }

      const events: AutomationRunEvent[] = [
        { type: "start" },
        { type: "retry-attempt" },
        { type: "cancel", requestedBy: "mcp" },
        { type: "expire", reason: "expired-ttl" },
        {
          type: "fail",
          error: "zombie",
          retryable: true,
          delayMs: 1_000
        },
        {
          type: "verification",
          verification: {
            at: FIXED_NOW,
            kind: "tmux-observation",
            status: "observing",
            summary: "zombie"
          }
        }
      ];

      for (const event of events) {
        expect(transitionAutomationRun(record, event, FIXED_NOW)).toBe(record);
      }
    });
  }
});

describe("automation run backoff math", () => {
  it("computes exponential backoff with deterministic jitter", () => {
    const config = createConfig({ backoffMs: 10_000, backoffMultiplier: 2, maxBackoffMs: 100_000 });
    const fixedPrng = () => 0.5;

    expect(readNextBackoffDelayMs(1, config, fixedPrng)).toBe(10_000);
    expect(readNextBackoffDelayMs(2, config, fixedPrng)).toBe(20_000);
    expect(readNextBackoffDelayMs(3, config, fixedPrng)).toBe(40_000);
    expect(readNextBackoffDelayMs(4, config, fixedPrng)).toBe(80_000);
    expect(readNextBackoffDelayMs(5, config, fixedPrng)).toBe(100_000);
  });

  it("keeps jitter within +/- 20%", () => {
    const config = createConfig({ backoffMs: 30_000, backoffMultiplier: 1, maxBackoffMs: 300_000 });
    expect(readNextBackoffDelayMs(1, config, () => 0)).toBe(24_000);
    expect(readNextBackoffDelayMs(1, config, () => 1)).toBe(36_000);
    for (let seed = 0; seed < 50; seed += 1) {
      const value = readNextBackoffDelayMs(1, config, () => ((seed * 7919) % 100) / 100);
      expect(value).toBeGreaterThanOrEqual(24_000);
      expect(value).toBeLessThanOrEqual(36_000);
    }
  });

  it("reports remaining backoff for waiting runs only", () => {
    const waiting = transitionAutomationRun(startRun(createQueuedRun()), {
      type: "fail",
      error: "x",
      retryable: true,
      delayMs: 30_000
    }, FIXED_NOW);
    expect(readRemainingBackoffMs(waiting, "2026-08-20T09:00:10.000Z")).toBe(20_000);
    expect(readRemainingBackoffMs(waiting, "2026-08-20T09:00:31.000Z")).toBe(0);
    expect(readRemainingBackoffMs(startRun(createQueuedRun()), FIXED_NOW)).toBeUndefined();
  });
});

describe("automation run notification outcomes", () => {
  it("maps terminal states to the frozen notification contract", () => {
    expect(readAutomationRunNotificationOutcome(succeedRun(startRun(createQueuedRun()))))
      .toBe("completed");
    expect(readAutomationRunNotificationOutcome(
      transitionAutomationRun(startRun(createQueuedRun()), {
        type: "verification",
        verification: {
          at: FIXED_NOW,
          kind: "tmux-observation",
          status: "needs_attention",
          summary: "review"
        }
      }, FIXED_NOW)
    )).toBe("attention");
    expect(readAutomationRunNotificationOutcome(
      transitionAutomationRun(startRun(createQueuedRun()), {
        type: "fail",
        error: "boom",
        retryable: false
      }, FIXED_NOW)
    )).toBe("failure");
    expect(readAutomationRunNotificationOutcome(
      transitionAutomationRun(createQueuedRun(), { type: "cancel", requestedBy: "pet" }, FIXED_NOW)
    )).toBeUndefined();
    expect(readAutomationRunNotificationOutcome(createQueuedRun())).toBeUndefined();
  });
});

describe("automation run normalization", () => {
  it("drops malformed records and keeps valid ones", () => {
    const snapshot = normalizeAutomationRunStoreSnapshot({
      schemaVersion: 1,
      sequences: { [MONITOR_ID]: 3, "not-a-monitor": 9 },
      runs: [
        null,
        "garbage",
        { runId: "bad" },
        { runId: "tmux-session:money-run-goal:run:1", monitorId: MONITOR_ID, state: "running", sessionName: "money-run-goal" },
        {
          runId: "tmux-session:money-run-goal:run:2",
          monitorId: MONITOR_ID,
          state: "mystery-state",
          config: { sessionName: "money-run-goal" }
        }
      ]
    });

    expect(snapshot.sequences).toEqual({ [MONITOR_ID]: 3 });
    expect(snapshot.runs).toHaveLength(2);
    expect(snapshot.runs[0]?.runId).toBe("tmux-session:money-run-goal:run:1");
    expect(snapshot.runs[1]?.state).toBe("expired");
  });

  it("recovers config from legacy records and clamps bounded fields", () => {
    const longDetail = "x".repeat(MAX_AUTOMATION_RUN_DETAIL_LENGTH + 50);
    const snapshot = normalizeAutomationRunStoreSnapshot({
      schemaVersion: 1,
      sequences: {},
      runs: [{
        runId: "tmux-session:money-run-goal:run:1",
        monitorId: MONITOR_ID,
        state: "running",
        attempt: 2,
        maxAttempts: 99,
        currentStep: "observe",
        timeline: [
          { at: FIXED_NOW, step: "started" },
          { at: FIXED_NOW, step: "observe", detail: longDetail }
        ],
        nextAction: `retry-after-${"1".repeat(400)}ms`,
        error: "y".repeat(500),
        sessionName: "money-run-goal",
        timeoutMs: 12_000,
        backoffMs: 20_000,
        runTtlMs: 600_000
      }]
    });

    const run = snapshot.runs[0]!;
    expect(run.config).toMatchObject({
      sessionName: "money-run-goal",
      timeoutMs: 12_000,
      maxAttempts: 10,
      backoffMs: 20_000,
      runTtlMs: 600_000
    });
    expect(run.maxAttempts).toBe(10);
    expect(run.attempt).toBe(2);
    expect(run.timeline[1]?.detail).toHaveLength(MAX_AUTOMATION_RUN_DETAIL_LENGTH);
    expect(run.nextAction).toHaveLength(300);
    expect(run.error).toHaveLength(300);
  });

  it("evicts oldest timeline entries beyond the cap", () => {
    const timeline = Array.from({ length: MAX_AUTOMATION_RUN_TIMELINE_ENTRIES + 10 }, (_unused, index) => ({
      at: FIXED_NOW,
      step: `step-${index}`
    }));
    const snapshot = normalizeAutomationRunStoreSnapshot({
      schemaVersion: 1,
      sequences: {},
      runs: [{
        runId: "tmux-session:money-run-goal:run:1",
        monitorId: MONITOR_ID,
        state: "running",
        timeline,
        config: { sessionName: "money-run-goal" }
      }]
    });

    const run = snapshot.runs[0]!;
    expect(run.timeline).toHaveLength(MAX_AUTOMATION_RUN_TIMELINE_ENTRIES);
    expect(run.timeline[0]?.step).toBe("step-10");
    expect(run.timeline.at(-1)?.step).toBe(`step-${MAX_AUTOMATION_RUN_TIMELINE_ENTRIES + 9}`);
  });

  it("round-trips through the store with atomic tmp and rename", () => {
    const files = new Map<string, string>();
    const io = createMemoryIo(files);
    const store = createAutomationRunStore({ filePath: "/state/automation-runs.json", io });
    const run = succeedRun(startRun(createQueuedRun()));

    store.write({ schemaVersion: 1, sequences: { [MONITOR_ID]: 1 }, runs: [run] });

    expect(files.has("/state/automation-runs.json")).toBe(true);
    expect([...files.keys()].some((key) => key.includes(".tmp-"))).toBe(false);

    const restored = store.read();
    expect(restored.sequences).toEqual({ [MONITOR_ID]: 1 });
    expect(restored.runs).toHaveLength(1);
    expect(restored.runs[0]).toMatchObject({
      runId: run.runId,
      state: "completed",
      terminalReason: "completed"
    });
  });

  it("never persists raw pane output in a record", () => {
    const run = succeedRun(startRun(createQueuedRun()), FIXED_NOW, "clean summary");
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain("private pane output");
    expect(serialized).not.toContain("token=secret");
  });

  it("honors a configurable per-monitor cap override", () => {
    const files = new Map<string, string>();
    const io = createMemoryIo(files);
    const store = createAutomationRunStore({
      filePath: "/state/automation-runs.json",
      io,
      caps: { perMonitorCap: 3 }
    });
    const runs = Array.from({ length: 8 }, (_unused, index) =>
      succeedRun(startRun(createQueuedRun(index + 1)), FIXED_NOW)
    );

    store.write({ schemaVersion: 1, sequences: {}, runs });

    const restored = store.read();
    expect(restored.runs).toHaveLength(3);
  });

  it("honors a configurable global cap override", () => {
    const files = new Map<string, string>();
    const io = createMemoryIo(files);
    const store = createAutomationRunStore({
      filePath: "/state/automation-runs.json",
      io,
      caps: { globalCap: 5 }
    });
    const runs = Array.from({ length: 12 }, (_unused, index) =>
      succeedRun(
        startRun(createAutomationRunRecord({
          monitorId: `tmux-session:session-${index % 6}`,
          sequence: index + 1,
          trigger: "manual",
          now: FIXED_NOW,
          config: createConfig()
        })),
        FIXED_NOW
      )
    );

    store.write({ schemaVersion: 1, sequences: {}, runs });

    const restored = store.read();
    expect(restored.runs.length).toBeLessThanOrEqual(5);
  });

  it("falls back to the default caps when no override is provided", () => {
    const files = new Map<string, string>();
    const io = createMemoryIo(files);
    const store = createAutomationRunStore({
      filePath: "/state/automation-runs.json",
      io
    });
    const runs = Array.from(
      { length: AUTOMATION_RUN_PER_MONITOR_CAP + 5 },
      (_unused, index) => succeedRun(startRun(createQueuedRun(index + 1)), FIXED_NOW)
    );

    store.write({ schemaVersion: 1, sequences: {}, runs });

    expect(store.read().runs).toHaveLength(AUTOMATION_RUN_PER_MONITOR_CAP);
  });
});

describe("automation run retention", () => {
  function terminalRun(sequence: number, finishedAt: string, monitorId = MONITOR_ID): AutomationRunRecord {
    const record = startRun(createQueuedRun(sequence));
    const completed = succeedRun({ ...record, monitorId }, FIXED_NOW);
    return { ...completed, finishedAt };
  }

  it("evicts oldest terminal runs per monitor first", () => {
    const runs = Array.from({ length: AUTOMATION_RUN_PER_MONITOR_CAP + 5 }, (_unused, index) =>
      terminalRun(index + 1, `2026-08-20T09:${String(index).padStart(2, "0")}:00.000Z`)
    );

    const retained = retainAutomationRuns(runs);

    expect(retained).toHaveLength(AUTOMATION_RUN_PER_MONITOR_CAP);
    expect(retained.map((run) => run.runId)).toContain("tmux-session:money-run-goal:run:25");
    expect(retained.map((run) => run.runId)).not.toContain("tmux-session:money-run-goal:run:1");
  });

  it("evicts oldest terminal runs globally and never evicts active runs", () => {
    const runs: AutomationRunRecord[] = [];
    for (let index = 0; index < GLOBAL_RUN_COUNT; index += 1) {
      runs.push(terminalRun(
        index + 1,
        `2026-08-20T09:00:${String(index % 60).padStart(2, "0")}.000Z`,
        `tmux-session:session-${index % 15}`
      ));
    }
    const queued = createAutomationRunRecord({
      monitorId: "tmux-session:active-session",
      sequence: 1,
      trigger: "scheduled",
      now: FIXED_NOW,
      config: createConfig()
    });
    const running = startRun(createAutomationRunRecord({
      monitorId: "tmux-session:running-session",
      sequence: 1,
      trigger: "scheduled",
      now: FIXED_NOW,
      config: createConfig()
    }));
    runs.push(queued, running);

    const retained = retainAutomationRuns(runs);

    expect(retained).toHaveLength(AUTOMATION_RUN_GLOBAL_CAP);
    expect(retained).toContain(queued);
    expect(retained).toContain(running);
  });
});

const GLOBAL_RUN_COUNT = 240;
