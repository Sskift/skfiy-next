import { describe, expect, it, vi, type Mock } from "vitest";
import { createTmuxSupervisionReport } from "./computer-use/tmux-supervisor.js";
import type { TmuxSupervisionReport } from "./computer-use/tmux-supervisor.js";
import {
  createAutomationRunStore,
  type AutomationRunRecord,
  type AutomationRunStoreIo
} from "./automation-run.js";
import { createAutomationRunSupervisor } from "./automation-run-supervisor.js";
import type { AutomationMonitorDefinition } from "./automation-monitor.js";

const FIXED_NOW = "2026-08-20T09:00:00.000Z";
const MONITOR_ID = "tmux-session:money-run-goal";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PendingObservation {
  sessionName: string;
  deferred: Deferred<TmuxSupervisionReport>;
}

interface FakeTmuxClient {
  observeSession: Mock<(sessionName: string) => Promise<TmuxSupervisionReport>>;
  observations: PendingObservation[];
}

function createFakeTmuxClient(): FakeTmuxClient {
  const observations: PendingObservation[] = [];
  const observeSession = vi.fn((sessionName: string): Promise<TmuxSupervisionReport> => {
    const deferred = createDeferred<TmuxSupervisionReport>();
    observations.push({ sessionName, deferred });
    return deferred.promise;
  });
  return { observeSession, observations };
}

function createWorkingReport(sessionName: string): TmuxSupervisionReport {
  return createTmuxSupervisionReport({
    sessionName,
    hasSession: true,
    windowsOutput: "@4\t1\tzsh\t1\t1",
    panesOutput: `${sessionName}\t@4\t1\tzsh\t%4\t0\t1\t0\tzsh\tworker`,
    paneTails: { "%4": "Working" }
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

interface TimerHarness {
  setTimeout: (callback: () => void, timeoutMs: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  setInterval: (callback: () => void, intervalMs: number) => unknown;
  clearInterval: (timer: unknown) => void;
  runNextTimeout: () => boolean;
  runAllTimeouts: () => void;
  tickIntervals: () => void;
  pendingTimeoutCount: () => number;
}

function createTimerHarness(): TimerHarness {
  const timeouts = new Map<number, { callback: () => void }>();
  const intervals = new Map<number, { callback: () => void }>();
  let nextId = 1;
  return {
    setTimeout: (callback) => {
      const id = nextId;
      nextId += 1;
      timeouts.set(id, { callback });
      return id;
    },
    clearTimeout: (timer) => {
      timeouts.delete(timer as number);
    },
    setInterval: (callback) => {
      const id = nextId;
      nextId += 1;
      intervals.set(id, { callback });
      return id;
    },
    clearInterval: (timer) => {
      intervals.delete(timer as number);
    },
    runNextTimeout: () => {
      const entry = timeouts.entries().next().value as
        | [number, { callback: () => void }]
        | undefined;
      if (!entry) {
        return false;
      }
      timeouts.delete(entry[0]);
      entry[1].callback();
      return true;
    },
    runAllTimeouts: () => {
      while (timeouts.size > 0) {
        const entry = timeouts.entries().next().value as
          | [number, { callback: () => void }]
          | undefined;
        if (!entry) {
          return;
        }
        timeouts.delete(entry[0]);
        entry[1].callback();
      }
    },
    tickIntervals: () => {
      for (const { callback } of [...intervals.values()]) {
        callback();
      }
    },
    pendingTimeoutCount: () => timeouts.size
  };
}

function createClock(start: string = FIXED_NOW) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(Date.parse(current) + ms).toISOString();
    },
    set: (iso: string) => {
      current = iso;
    }
  };
}

function createDefinition(
  overrides: Partial<AutomationMonitorDefinition> = {}
): AutomationMonitorDefinition {
  return {
    id: MONITOR_ID,
    kind: "tmux-session",
    label: "money-run goal",
    enabled: true,
    intervalMs: 600_000,
    timeoutMs: 30_000,
    triggerMode: "scheduled",
    sessionName: "money-run-goal",
    preview: {
      adapter: "tmux-supervision",
      triggerModes: ["manual", "scheduled"],
      target: { kind: "tmux-session", sessionName: "money-run-goal" },
      requiredPermissions: [],
      readWriteBehavior: "read-only",
      approvalMode: "not-required",
      timeoutMs: 30_000,
      verification: "tmux session, window, pane, and bounded recent pane-output observation",
      mutatesSession: false
    },
    concurrencyPolicy: "skip",
    maxConcurrency: 1,
    maxAttempts: 3,
    backoffMs: 30_000,
    backoffMultiplier: 2,
    maxBackoffMs: 300_000,
    runTtlMs: 900_000,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides
  };
}

function createSupervisor({
  clock = createClock(),
  definition,
  files,
  maxConcurrentObservations,
  onRunTerminal,
  prng = () => 0.5,
  sweepIntervalMs,
  timers = createTimerHarness(),
  tmuxClient
}: {
  clock?: ReturnType<typeof createClock>;
  definition?: AutomationMonitorDefinition;
  files?: Map<string, string>;
  maxConcurrentObservations?: number;
  onRunTerminal?: (event: unknown) => void;
  prng?: () => number;
  sweepIntervalMs?: number;
  timers?: TimerHarness;
  tmuxClient?: FakeTmuxClient;
} = {}) {
  const io = createMemoryIo(files);
  const client = tmuxClient ?? createFakeTmuxClient();
  const supervisor = createAutomationRunSupervisor({
    clearInterval: timers.clearInterval,
    clearTimeout: timers.clearTimeout,
    now: clock.now,
    onRunTerminal,
    prng,
    setInterval: timers.setInterval,
    setTimeout: timers.setTimeout,
    store: createAutomationRunStore({ filePath: "/state/automation-runs.json", io }),
    ...(maxConcurrentObservations === undefined ? {} : { maxConcurrentObservations }),
    ...(sweepIntervalMs === undefined ? {} : { sweepIntervalMs }),
    tmuxClient: client
  });
  return {
    clock,
    definition: definition ?? createDefinition(),
    files: files ?? new Map<string, string>(),
    io,
    supervisor,
    timers,
    tmuxClient: client
  };
}

describe("automation run supervisor skip policy", () => {
  it("drops duplicate triggers while a run is active and counts them", async () => {
    const onRunTerminal = vi.fn();
    const harness = createSupervisor({ onRunTerminal });
    const { supervisor, tmuxClient, definition } = harness;

    const first = supervisor.requestRun({ definition, trigger: "manual" });
    const second = supervisor.requestRun({ definition, trigger: "scheduled" });

    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(1);
    expect(supervisor.readStatus().skipped[definition.id]).toBe(1);
    expect(supervisor.readRuns()).toHaveLength(1);

    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    const firstRecord = await first;
    const secondRecord = await second;

    expect(firstRecord.runId).toBe(secondRecord.runId);
    expect(firstRecord.state).toBe("completed");
    expect(onRunTerminal).toHaveBeenCalledTimes(1);
    expect(onRunTerminal).toHaveBeenCalledWith({
      runId: "tmux-session:money-run-goal:run:1",
      label: "money-run goal",
      outcome: "completed"
    });
  });

  it("never starts a second observation when a scheduled tick overlaps a slow observation", async () => {
    const onRunTerminal = vi.fn();
    const harness = createSupervisor({ onRunTerminal });
    const { supervisor, tmuxClient, definition } = harness;

    const first = supervisor.requestRun({ definition, trigger: "scheduled" });
    // Simulates the manager's setInterval callback firing mid-observation.
    const overlapping = supervisor.requestRun({ definition, trigger: "scheduled" });
    const manual = supervisor.requestRun({ definition, trigger: "manual" });

    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(1);
    expect(supervisor.readStatus().skipped[definition.id]).toBe(2);

    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    await Promise.all([first, overlapping, manual]);

    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(1);
    expect(onRunTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("automation run supervisor queue policy", () => {
  it("queues the second trigger and starts it FIFO when the first completes", async () => {
    const harness = createSupervisor({
      definition: createDefinition({ concurrencyPolicy: "queue" })
    });
    const { supervisor, tmuxClient, definition } = harness;

    const first = supervisor.requestRun({ definition, trigger: "manual" });
    const second = supervisor.requestRun({ definition, trigger: "manual" });

    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(1);
    expect(supervisor.readStatus().queuedCount).toBe(1);
    expect(supervisor.readRuns()).toHaveLength(2);
    expect(supervisor.readRuns().find((candidate) => candidate.state === "queued")?.runId)
      .toBe("tmux-session:money-run-goal:run:2");

    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    await first;

    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(2);
    expect(supervisor.readStatus().queuedCount).toBe(0);

    tmuxClient.observations[1]!.deferred.resolve(createWorkingReport("money-run-goal"));
    const secondRecord = await second;

    expect(secondRecord.runId).toBe("tmux-session:money-run-goal:run:2");
    expect(secondRecord.state).toBe("completed");
  });
});

describe("automation run supervisor allow policy", () => {
  it("runs concurrent observations up to the per-monitor limit", async () => {
    const harness = createSupervisor({
      definition: createDefinition({ concurrencyPolicy: "allow", maxConcurrency: 2 })
    });
    const { supervisor, tmuxClient, definition } = harness;

    const first = supervisor.requestRun({ definition, trigger: "manual" });
    const second = supervisor.requestRun({ definition, trigger: "manual" });
    const third = supervisor.requestRun({ definition, trigger: "manual" });

    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(2);
    expect(supervisor.readStatus().queuedCount).toBe(1);

    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    await first;

    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(3);

    tmuxClient.observations[1]!.deferred.resolve(createWorkingReport("money-run-goal"));
    tmuxClient.observations[2]!.deferred.resolve(createWorkingReport("money-run-goal"));
    const [secondRecord, thirdRecord] = await Promise.all([second, third]);

    expect(secondRecord.state).toBe("completed");
    expect(thirdRecord.state).toBe("completed");
    expect(thirdRecord.runId).toBe("tmux-session:money-run-goal:run:3");
  });

  it("bounds total observations with the global semaphore", async () => {
    const harness = createSupervisor({ maxConcurrentObservations: 1 });
    const { supervisor, tmuxClient } = harness;
    const firstDefinition = createDefinition();
    const secondDefinition = createDefinition({
      id: "tmux-session:side-goal",
      sessionName: "side-goal",
      label: "side goal"
    });

    const first = supervisor.requestRun({ definition: firstDefinition, trigger: "manual" });
    const second = supervisor.requestRun({ definition: secondDefinition, trigger: "manual" });

    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(1);
    expect(supervisor.readStatus().inFlight).toBe(1);

    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    await first;

    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(2);
    tmuxClient.observations[1]!.deferred.resolve(createWorkingReport("side-goal"));
    const secondRecord = await second;
    expect(secondRecord.state).toBe("completed");
  });
});

describe("automation run supervisor retry and timeout", () => {
  it("retries a failing observation at the computed backoff and completes on attempt 2", async () => {
    const harness = createSupervisor();
    const { supervisor, tmuxClient, timers, definition } = harness;

    const run = supervisor.requestRun({ definition, trigger: "manual" });
    tmuxClient.observations[0]!.deferred.reject(new Error("tmux unavailable"));

    let waiting: AutomationRunRecord | undefined;
    await vi.waitFor(() => {
      waiting = supervisor.readRuns()[0];
      expect(waiting?.state).toBe("waiting");
    });
    expect(waiting?.attempt).toBe(1);
    expect(waiting?.nextAction).toMatch(/^retry-after-\d+ms$/);
    expect(waiting?.error).toBe("tmux unavailable");
    expect(timers.pendingTimeoutCount()).toBe(1);

    expect(timers.runNextTimeout()).toBe(true);
    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(2);

    tmuxClient.observations[1]!.deferred.resolve(createWorkingReport("money-run-goal"));
    const record = await run;

    expect(record.state).toBe("completed");
    expect(record.attempt).toBe(2);
    expect(record.timeline.some((entry) => entry.step === "retry-attempt")).toBe(true);
  });

  it("fails permanently after exhausting attempts with exactly one failure event", async () => {
    const onRunTerminal = vi.fn();
    const harness = createSupervisor({
      onRunTerminal,
      definition: createDefinition({ maxAttempts: 2, backoffMs: 1_000 })
    });
    const { supervisor, tmuxClient, timers, definition } = harness;

    const run = supervisor.requestRun({ definition, trigger: "manual" });
    tmuxClient.observations[0]!.deferred.reject(new Error("tmux unavailable"));
    await vi.waitFor(() => {
      expect(supervisor.readRuns()[0]?.state).toBe("waiting");
    });

    timers.runNextTimeout();
    tmuxClient.observations[1]!.deferred.reject(new Error("tmux unavailable"));

    const record = await run;
    expect(record.state).toBe("failed");
    expect(record.terminalReason).toBe("retries-exhausted");
    expect(record.attempt).toBe(2);
    expect(record.error).toBe("tmux unavailable");
    expect(onRunTerminal).toHaveBeenCalledTimes(1);
    expect(onRunTerminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failure"
    }));
  });

  it("fails the attempt when the observation exceeds the timeout", async () => {
    const onRunTerminal = vi.fn();
    const harness = createSupervisor({
      onRunTerminal,
      definition: createDefinition({ timeoutMs: 12_000, maxAttempts: 1 })
    });
    const { supervisor, timers, definition } = harness;

    const run = supervisor.requestRun({ definition, trigger: "manual" });
    expect(timers.runNextTimeout()).toBe(true);

    const record = await run;
    expect(record.state).toBe("failed");
    expect(record.error).toBe("Automation run timed out after 12000ms.");
    expect(onRunTerminal).toHaveBeenCalledTimes(1);
    expect(onRunTerminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failure"
    }));
  });

  it("treats needs_attention and blocked outcomes as terminal attention", async () => {
    const onRunTerminal = vi.fn();
    const harness = createSupervisor({ onRunTerminal });
    const { supervisor, tmuxClient, definition } = harness;

    const run = supervisor.requestRun({ definition, trigger: "manual" });
    tmuxClient.observations[0]!.deferred.resolve({
      ...createWorkingReport("money-run-goal"),
      status: "needs_attention"
    });

    const record = await run;
    expect(record.state).toBe("attention");
    expect(record.terminalReason).toBe("attention-required");
    expect(record.nextAction).toBe("review-in-skfiy");
    expect(onRunTerminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "attention"
    }));
  });
});

describe("automation run supervisor stopRun", () => {
  it("cancels a queued run immediately without observing", async () => {
    const harness = createSupervisor({
      definition: createDefinition({ concurrencyPolicy: "queue" })
    });
    const { supervisor, tmuxClient, definition } = harness;

    const first = supervisor.requestRun({ definition, trigger: "manual" });
    const second = supervisor.requestRun({ definition, trigger: "manual" });
    void first;
    void second;
    const queuedRunId = supervisor.readRuns().find(
      (candidate) => candidate.state === "queued"
    )!.runId;

    const cancelled = await supervisor.stopRun(queuedRunId, "dashboard");

    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.cancellation).toEqual({
      requestedBy: "dashboard",
      at: cancelled?.cancellation?.at
    });
    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting run and clears its backoff timer", async () => {
    const harness = createSupervisor();
    const { supervisor, tmuxClient, timers, definition } = harness;

    const run = supervisor.requestRun({ definition, trigger: "manual" });
    void run;
    tmuxClient.observations[0]!.deferred.reject(new Error("tmux unavailable"));
    await vi.waitFor(() => {
      expect(supervisor.readRuns()[0]?.state).toBe("waiting");
    });
    expect(timers.pendingTimeoutCount()).toBe(1);

    const waitingRun = supervisor.readRuns()[0]!;
    const cancelled = await supervisor.stopRun(waitingRun.runId, "cli");

    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.cancellation?.requestedBy).toBe("cli");
    expect(timers.pendingTimeoutCount()).toBe(0);
  });

  it("cancels a running run after the in-flight observation settles", async () => {
    const harness = createSupervisor();
    const { supervisor, tmuxClient, definition } = harness;

    const run = supervisor.requestRun({ definition, trigger: "manual" });
    const runningRun = supervisor.readRuns()[0]!;
    expect(runningRun.state).toBe("running");

    const stopped = supervisor.stopRun(runningRun.runId, "pet");
    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));

    const cancelled = await stopped;
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.cancellation?.requestedBy).toBe("pet");
    const record = await run;
    expect(record.state).toBe("cancelled");
  });

  it("is a no-op on terminal runs", async () => {
    const harness = createSupervisor();
    const { supervisor, tmuxClient, definition } = harness;

    const run = supervisor.requestRun({ definition, trigger: "manual" });
    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    const completed = await run;

    const stoppedAgain = await supervisor.stopRun(completed.runId, "dashboard");
    expect(stoppedAgain).toBe(completed);
    expect(stoppedAgain?.state).toBe("completed");
  });

  it("returns undefined for unknown run ids", async () => {
    const harness = createSupervisor();
    await expect(harness.supervisor.stopRun("tmux-session:missing:run:1", "dashboard"))
      .resolves.toBeUndefined();
  });
});

describe("automation run supervisor TTL expiry", () => {
  it("sweeps a running run past its deadline to expired", async () => {
    const clock = createClock();
    const harness = createSupervisor({
      clock,
      definition: createDefinition({ runTtlMs: 60_000 })
    });
    const { supervisor, tmuxClient, timers, definition } = harness;
    supervisor.start();

    const run = supervisor.requestRun({ definition, trigger: "manual" });
    clock.advance(61_000);
    timers.tickIntervals();

    const record = supervisor.readRuns()[0]!;
    expect(record.state).toBe("expired");
    expect(record.terminalReason).toBe("expired-ttl");

    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    const settled = await run;
    expect(settled.state).toBe("expired");
    expect(tmuxClient.observeSession).toHaveBeenCalledTimes(1);
    supervisor.stop();
  });
});

describe("automation run supervisor restart reconciliation", () => {
  it("expires running runs interrupted by restart and re-arms waiting runs", async () => {
    const files = new Map<string, string>();
    const firstHarness = createSupervisor({ files });
    const { supervisor: firstSupervisor, tmuxClient, definition } = firstHarness;

    const run = firstSupervisor.requestRun({ definition, trigger: "manual" });
    void run;
    tmuxClient.observations[0]!.deferred.reject(new Error("tmux unavailable"));
    await vi.waitFor(() => {
      expect(firstSupervisor.readRuns()[0]?.state).toBe("waiting");
    });

    const restored = createSupervisor({
      files,
      clock: createClock("2026-08-20T09:00:05.000Z")
    });
    const records = restored.supervisor.readRuns();
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("waiting");
    expect(restored.timers.pendingTimeoutCount()).toBe(1);
    expect(restored.tmuxClient.observeSession).not.toHaveBeenCalled();
  });

  it("marks interrupted running runs as expired with the restart reason", async () => {
    const files = new Map<string, string>();
    const firstHarness = createSupervisor({ files });
    const { supervisor: firstSupervisor, definition } = firstHarness;

    const run = firstSupervisor.requestRun({ definition, trigger: "manual" });
    expect(firstSupervisor.readRuns()[0]?.state).toBe("running");
    void run;

    const restored = createSupervisor({ files });
    const records = restored.supervisor.readRuns();
    expect(records[0]?.state).toBe("expired");
    expect(records[0]?.terminalReason).toBe("interrupted-by-restart");
  });

  it("expires waiting runs whose deadline passed during restart", async () => {
    const files = new Map<string, string>();
    const firstHarness = createSupervisor({
      files,
      definition: createDefinition({ runTtlMs: 60_000 })
    });
    const { supervisor: firstSupervisor, tmuxClient, definition } = firstHarness;

    const run = firstSupervisor.requestRun({ definition, trigger: "manual" });
    void run;
    tmuxClient.observations[0]!.deferred.reject(new Error("tmux unavailable"));
    await vi.waitFor(() => {
      expect(firstSupervisor.readRuns()[0]?.state).toBe("waiting");
    });

    const restored = createSupervisor({
      files,
      clock: createClock("2026-08-20T09:01:01.000Z")
    });
    expect(restored.supervisor.readRuns()[0]?.state).toBe("expired");
    expect(restored.timers.pendingTimeoutCount()).toBe(0);
  });

  it("re-queues queued runs and drains them on start", () => {
    const files = new Map<string, string>();
    const firstHarness = createSupervisor({
      files,
      definition: createDefinition({ concurrencyPolicy: "queue" })
    });
    const { supervisor: firstSupervisor, definition } = firstHarness;

    firstSupervisor.requestRun({ definition, trigger: "manual" });
    firstSupervisor.requestRun({ definition, trigger: "manual" });
    expect(firstHarness.tmuxClient.observeSession).toHaveBeenCalledTimes(1);

    const restored = createSupervisor({ files });
    expect(restored.supervisor.readStatus().queuedCount).toBe(1);
    expect(restored.tmuxClient.observeSession).not.toHaveBeenCalled();

    restored.supervisor.start();
    expect(restored.tmuxClient.observeSession).toHaveBeenCalledTimes(1);
    restored.supervisor.stop();
  });
});

describe("automation run supervisor persistence", () => {
  it("round-trips runs and sequences through the store with atomic writes", async () => {
    const files = new Map<string, string>();
    const harness = createSupervisor({ files });
    const { supervisor, tmuxClient, definition, io } = harness;

    const run = supervisor.requestRun({ definition, trigger: "manual" });
    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    await run;

    expect([...files.keys()].some((key) => key.includes(".tmp-"))).toBe(false);
    const persisted = JSON.parse(files.get("/state/automation-runs.json") ?? "{}");
    expect(persisted.sequences).toEqual({ [MONITOR_ID]: 1 });
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0]).toMatchObject({
      runId: "tmux-session:money-run-goal:run:1",
      state: "completed"
    });

    const restored = createSupervisor({ files });
    const next = restored.supervisor.requestRun({ definition, trigger: "manual" });
    restored.tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    const nextRecord = await next;
    expect(nextRecord.runId).toBe("tmux-session:money-run-goal:run:2");
    void io;
  });

  it("emits exactly one terminal event per run and dedups unchanged scheduled outcomes", async () => {
    const onRunTerminal = vi.fn();
    const harness = createSupervisor({ onRunTerminal });
    const { supervisor, tmuxClient, definition } = harness;

    const first = supervisor.requestRun({ definition, trigger: "scheduled" });
    tmuxClient.observations[0]!.deferred.resolve(createWorkingReport("money-run-goal"));
    await first;

    const second = supervisor.requestRun({ definition, trigger: "scheduled" });
    tmuxClient.observations[1]!.deferred.resolve(createWorkingReport("money-run-goal"));
    await second;

    expect(onRunTerminal).toHaveBeenCalledTimes(1);

    const third = supervisor.requestRun({ definition, trigger: "manual" });
    tmuxClient.observations[2]!.deferred.resolve(createWorkingReport("money-run-goal"));
    await third;

    expect(onRunTerminal).toHaveBeenCalledTimes(2);
  });
});
