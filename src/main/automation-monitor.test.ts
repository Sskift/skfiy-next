import { describe, expect, it, vi } from "vitest";
import {
  createAutomationRunConfig,
  createAutomationRunRecord,
  transitionAutomationRun,
  type AutomationRunCancellationSource,
  type AutomationRunRecord
} from "./automation-run.js";
import {
  createAutomationMonitorManager,
  createAutomationMonitorStore,
  type AutomationMonitorDefinition,
  type AutomationMonitorRunTrigger,
  type AutomationMonitorStoreIo
} from "./automation-monitor.js";

const FIXED_NOW = "2026-06-25T10:00:00.000Z";

function createMemoryIo(files: Map<string, string> = new Map()): AutomationMonitorStoreIo {
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

function createRunConfig(definition: AutomationMonitorDefinition) {
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

function createTerminalRun(
  definition: AutomationMonitorDefinition,
  state: "completed" | "attention" | "failed" | "cancelled" | "expired",
  overrides: { error?: string; summary?: string; blocked?: boolean } = {}
): AutomationRunRecord {
  let record = createAutomationRunRecord({
    monitorId: definition.id,
    sequence: 1,
    trigger: "manual",
    now: FIXED_NOW,
    config: createRunConfig(definition)
  });
  record = transitionAutomationRun(record, { type: "start" }, FIXED_NOW);
  if (state === "completed") {
    return transitionAutomationRun(record, {
      type: "verification",
      verification: {
        at: FIXED_NOW,
        kind: "tmux-observation",
        status: "observing",
        summary: overrides.summary ?? "money-run-goal has 1 window, 1 pane, and no obvious block markers."
      }
    }, FIXED_NOW);
  }
  if (state === "attention") {
    return transitionAutomationRun(record, {
      type: "verification",
      verification: {
        at: FIXED_NOW,
        kind: "tmux-observation",
        status: overrides.blocked ? "blocked" : "needs_attention",
        summary: overrides.summary ?? "block marker detected"
      }
    }, FIXED_NOW);
  }
  if (state === "failed") {
    return transitionAutomationRun(record, {
      type: "fail",
      error: overrides.error ?? "tmux unavailable",
      retryable: false
    }, FIXED_NOW);
  }
  if (state === "cancelled") {
    return transitionAutomationRun(record, { type: "cancel", requestedBy: "dashboard" }, FIXED_NOW);
  }
  return transitionAutomationRun(record, { type: "expire", reason: "expired-ttl" }, FIXED_NOW);
}

interface MockSupervisor {
  requestRun: (input: {
    definition: AutomationMonitorDefinition;
    trigger: AutomationMonitorRunTrigger;
  }) => Promise<AutomationRunRecord>;
  stopMonitorRuns: (
    monitorId: string,
    requestedBy: AutomationRunCancellationSource
  ) => void;
  requests: Array<{ definition: AutomationMonitorDefinition; trigger: AutomationMonitorRunTrigger }>;
  stopped: Array<{ monitorId: string; requestedBy: AutomationRunCancellationSource }>;
  setNextRecord: (record: AutomationRunRecord | undefined) => void;
}

function createMockSupervisor(): MockSupervisor {
  const requests: Array<{
    definition: AutomationMonitorDefinition;
    trigger: AutomationMonitorRunTrigger;
  }> = [];
  const stopped: Array<{ monitorId: string; requestedBy: AutomationRunCancellationSource }> = [];
  let nextRecord: AutomationRunRecord | undefined;
  const requestRun = vi.fn(
    async (input: {
      definition: AutomationMonitorDefinition;
      trigger: AutomationMonitorRunTrigger;
    }): Promise<AutomationRunRecord> => {
      requests.push(input);
      return nextRecord ?? createTerminalRun(input.definition, "completed");
    }
  );
  const stopMonitorRuns = vi.fn(
    (monitorId: string, requestedBy: AutomationRunCancellationSource) => {
      stopped.push({ monitorId, requestedBy });
    }
  );
  return {
    requestRun,
    stopMonitorRuns,
    requests,
    stopped,
    setNextRecord: (record) => {
      nextRecord = record;
    }
  };
}

function createManager(supervisor: MockSupervisor = createMockSupervisor()) {
  return {
    supervisor,
    manager: createAutomationMonitorManager({
      now: () => FIXED_NOW,
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io: createMemoryIo()
      }),
      supervisor
    })
  };
}

describe("automation monitor manager supervisor delegation", () => {
  it("delegates runMonitorNow to the supervisor with definition and trigger", async () => {
    const { manager, supervisor } = createManager();
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      label: "Goal observer",
      intervalMs: 600_000
    });

    await manager.runMonitorNow(definition.id, "scheduled");

    expect(supervisor.requestRun).toHaveBeenCalledTimes(1);
    expect(supervisor.requests[0]).toMatchObject({
      trigger: "scheduled"
    });
    expect(supervisor.requests[0]?.definition.id).toBe(definition.id);
    expect(supervisor.requests[0]?.definition.sessionName).toBe("money-run-goal");
  });

  it("projects a completed run onto the runtime snapshot fields", async () => {
    const { manager } = createManager();
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 600_000
    });

    const runtime = await manager.runMonitorNow(definition.id);

    // The scheduler was never started, so the public status maps to
    // "scheduler_inactive"; the durable terminal result below is what matters.
    expect(runtime).toMatchObject({
      status: "scheduler_inactive",
      lastResult: "observing",
      lastResultAt: FIXED_NOW,
      lastSummary: "money-run-goal has 1 window, 1 pane, and no obvious block markers.",
      checkCount: 1,
      lastCheckedAt: FIXED_NOW,
      nextCheckAt: "2026-06-25T10:10:00.000Z"
    });
    expect(runtime.lastError).toBeUndefined();
  });

  it("projects failed, attention, cancelled, and expired runs", async () => {
    const { manager, supervisor } = createManager();
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 600_000
    });

    supervisor.setNextRecord(createTerminalRun(definition, "failed", {
      error: "tmux unavailable"
    }));
    await expect(manager.runMonitorNow(definition.id)).resolves.toMatchObject({
      status: "error",
      lastResult: "error",
      lastError: "tmux unavailable"
    });

    supervisor.setNextRecord(createTerminalRun(definition, "attention"));
    await expect(manager.runMonitorNow(definition.id)).resolves.toMatchObject({
      status: "needs_attention",
      lastResult: "needs_attention"
    });

    supervisor.setNextRecord(createTerminalRun(definition, "attention", { blocked: true }));
    await expect(manager.runMonitorNow(definition.id)).resolves.toMatchObject({
      status: "blocked",
      lastResult: "blocked"
    });

    supervisor.setNextRecord(createTerminalRun(definition, "cancelled"));
    await expect(manager.runMonitorNow(definition.id)).resolves.toMatchObject({
      status: "idle"
    });

    supervisor.setNextRecord(createTerminalRun(definition, "expired"));
    await expect(manager.runMonitorNow(definition.id)).resolves.toMatchObject({
      status: "error",
      lastResult: "error",
      lastError: "Automation run expired before completion."
    });
  });

  it("never calls the supervisor for disabled monitors", async () => {
    const { manager, supervisor } = createManager();
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 600_000,
      enabled: false
    });

    const runtime = await manager.runMonitorNow(definition.id);

    expect(supervisor.requestRun).not.toHaveBeenCalled();
    expect(runtime).toMatchObject({
      id: definition.id,
      enabled: false,
      status: "disabled",
      checkCount: 0
    });
  });

  it("cancels in-flight runs when pausing or deleting a monitor", () => {
    const { manager, supervisor } = createManager();
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 600_000
    });

    manager.setMonitorEnabled(definition.id, false);
    expect(supervisor.stopMonitorRuns).toHaveBeenCalledWith(definition.id, "dashboard");

    expect(manager.deleteMonitor(definition.id)).toBe(true);
    expect(supervisor.stopMonitorRuns).toHaveBeenLastCalledWith(definition.id, "dashboard");
  });
});

describe("automation monitor manager lifecycle", () => {
  it("persists pause and resume while keeping paused monitors inert after restart", () => {
    const io = createMemoryIo();
    const cleared: unknown[] = [];
    const firstScheduled: unknown[] = [];
    const supervisor = createMockSupervisor();
    const manager = createAutomationMonitorManager({
      now: () => "2026-06-25T10:05:00.000Z",
      setInterval: (_callback, intervalMs) => {
        const timer = `first-${intervalMs}`;
        firstScheduled.push(timer);
        return timer;
      },
      clearInterval: (timer) => cleared.push(timer),
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io
      }),
      supervisor
    });

    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 123_000
    });
    manager.start();
    const paused = manager.setMonitorEnabled(definition.id, false);

    expect(firstScheduled).toEqual(["first-123000"]);
    expect(cleared).toEqual(["first-123000"]);
    expect(paused).toMatchObject({
      id: definition.id,
      enabled: false,
      status: "disabled",
      nextCheckAt: undefined
    });
    expect(manager.readSnapshot()).toMatchObject({
      activeCount: 0,
      scheduler: {
        activeTimerCount: 0
      },
      monitors: [
        {
          enabled: false,
          status: "disabled"
        }
      ]
    });

    const restoredScheduled: unknown[] = [];
    const restored = createAutomationMonitorManager({
      now: () => "2026-06-25T10:06:00.000Z",
      setInterval: (_callback, intervalMs) => {
        const timer = `restored-${intervalMs}`;
        restoredScheduled.push(timer);
        return timer;
      },
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io
      }),
      supervisor: createMockSupervisor()
    });

    restored.start();
    expect(restoredScheduled).toEqual([]);

    const resumed = restored.setMonitorEnabled(definition.id, true);
    expect(restoredScheduled).toEqual(["restored-123000"]);
    expect(resumed).toMatchObject({
      id: definition.id,
      enabled: true,
      status: "idle"
    });
    expect(restored.readSnapshot()).toMatchObject({
      activeCount: 1,
      scheduler: {
        activeTimerCount: 1
      }
    });
  });

  it("deletes a monitor definition and its persisted runtime", () => {
    const files = new Map<string, string>();
    const io = createMemoryIo(files);
    const manager = createAutomationMonitorManager({
      now: () => "2026-06-25T10:05:00.000Z",
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io
      }),
      supervisor: createMockSupervisor()
    });
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 123_000
    });

    expect(manager.deleteMonitor(definition.id)).toBe(true);
    expect(manager.deleteMonitor(definition.id)).toBe(false);
    expect(manager.readSnapshot()).toMatchObject({
      activeCount: 0,
      monitors: []
    });
    expect(JSON.parse(files.get("/state/automation-monitors.json") ?? "{}")).toEqual({
      schemaVersion: 1,
      monitors: [],
      runtimes: []
    });
  });

  it("duplicates a monitor as an independent paused definition and edits it by id", () => {
    const files = new Map<string, string>();
    const io = createMemoryIo(files);
    const manager = createAutomationMonitorManager({
      now: () => "2026-06-25T10:05:00.000Z",
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io
      }),
      supervisor: createMockSupervisor()
    });
    const original = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      label: "money-run goal",
      intervalMs: 600_000,
      timeoutMs: 30_000,
      enabled: true
    });

    const firstCopy = manager.duplicateMonitor(original.id);
    const secondCopy = manager.duplicateMonitor(original.id);

    expect(firstCopy).toMatchObject({
      id: "tmux-session:money-run-goal:copy",
      sessionName: "money-run-goal",
      label: "money-run goal copy",
      intervalMs: 600_000,
      timeoutMs: 30_000,
      enabled: false
    });
    expect(secondCopy).toMatchObject({
      id: "tmux-session:money-run-goal:copy-2",
      label: "money-run goal copy 2",
      enabled: false
    });
    expect(manager.readSnapshot()).toMatchObject({
      activeCount: 1,
      monitors: [
        { id: original.id, enabled: true },
        { id: firstCopy.id, enabled: false, status: "disabled", checkCount: 0 },
        { id: secondCopy.id, enabled: false, status: "disabled", checkCount: 0 }
      ]
    });

    manager.upsertTmuxSessionMonitor({
      monitorId: firstCopy.id,
      sessionName: "money-run-goal",
      label: "weekday goal observer",
      intervalMs: 900_000,
      timeoutMs: 12_000,
      enabled: true
    });

    expect(manager.readSnapshot().monitors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: original.id,
        label: "money-run goal",
        intervalMs: 600_000
      }),
      expect.objectContaining({
        id: firstCopy.id,
        label: "weekday goal observer",
        intervalMs: 900_000,
        timeoutMs: 12_000,
        enabled: true
      })
    ]));
    expect(() => manager.upsertTmuxSessionMonitor({
      monitorId: firstCopy.id,
      sessionName: "another-session",
      intervalMs: 900_000
    })).toThrow("cannot change its tmux session target");
    expect(() => manager.upsertTmuxSessionMonitor({
      monitorId: "tmux-session:missing",
      sessionName: "money-run-goal",
      intervalMs: 900_000
    })).toThrow("Unknown automation monitor");
    expect(JSON.parse(files.get("/state/automation-monitors.json") ?? "{}")).toMatchObject({
      monitors: [
        { id: original.id },
        { id: firstCopy.id, label: "weekday goal observer" },
        { id: secondCopy.id }
      ],
      runtimes: [
        { id: original.id },
        { id: firstCopy.id, checkCount: 0 },
        { id: secondCopy.id, checkCount: 0 }
      ]
    });
  });

  it("publishes a bounded read-only definition preview with run lifecycle rows", () => {
    const { manager } = createManager();
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 123_000,
      timeoutMs: 12_000,
      concurrencyPolicy: "queue",
      maxConcurrency: 2,
      maxAttempts: 5,
      backoffMs: 20_000,
      runTtlMs: 600_000
    });

    expect(definition).toMatchObject({
      timeoutMs: 12_000,
      concurrencyPolicy: "queue",
      maxConcurrency: 2,
      maxAttempts: 5,
      backoffMs: 20_000,
      runTtlMs: 600_000,
      preview: {
        adapter: "tmux-supervision",
        triggerModes: ["manual", "scheduled"],
        target: {
          kind: "tmux-session",
          sessionName: "money-run-goal"
        },
        requiredPermissions: [],
        readWriteBehavior: "read-only",
        approvalMode: "not-required",
        timeoutMs: 12_000,
        verification: "tmux session, window, pane, and bounded recent pane-output observation",
        mutatesSession: false,
        concurrency: {
          policy: "queue",
          max: 2
        },
        retry: {
          maxAttempts: 5,
          backoffMs: 20_000,
          maxBackoffMs: 300_000
        },
        runTtlMs: 600_000
      }
    });
  });

  it("keeps disabled monitors inert without touching the supervisor", async () => {
    const { manager, supervisor } = createManager();
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 123_000,
      enabled: false
    });

    const runtime = await manager.runMonitorNow(definition.id);

    expect(supervisor.requestRun).not.toHaveBeenCalled();
    expect(runtime).toMatchObject({
      id: definition.id,
      enabled: false,
      status: "disabled",
      checkCount: 0
    });
    expect(runtime.lastError).toBeUndefined();
  });

  it("never arms a timer for manual trigger mode monitors", () => {
    const scheduled: Array<{ intervalMs: number }> = [];
    const manager = createAutomationMonitorManager({
      now: () => "2026-06-25T10:05:00.000Z",
      setInterval: (callback, intervalMs) => {
        scheduled.push({ intervalMs });
        return `timer-${scheduled.length}`;
      },
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io: createMemoryIo()
      }),
      supervisor: createMockSupervisor()
    });
    manager.upsertTmuxSessionMonitor({
      sessionName: "manual-goal",
      intervalMs: 123_000,
      triggerMode: "manual"
    });
    manager.upsertTmuxSessionMonitor({
      sessionName: "local-goal",
      intervalMs: 456_000,
      triggerMode: "local-state"
    });

    manager.start();

    expect(scheduled).toEqual([]);
    expect(manager.readSnapshot()).toMatchObject({
      scheduler: {
        state: "active",
        activeTimerCount: 0
      },
      monitors: [
        { id: "tmux-session:manual-goal", triggerMode: "manual" },
        { id: "tmux-session:local-goal", triggerMode: "local-state" }
      ]
    });
  });

  it("round-trips timeout, trigger mode, and run lifecycle config through the store", () => {
    const io = createMemoryIo();
    createAutomationMonitorManager({
      now: () => "2026-06-25T10:05:00.000Z",
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io
      }),
      supervisor: createMockSupervisor()
    }).upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 123_000,
      timeoutMs: 45_000,
      triggerMode: "manual",
      concurrencyPolicy: "allow",
      maxConcurrency: 3,
      maxAttempts: 4,
      backoffMs: 15_000,
      backoffMultiplier: 3,
      maxBackoffMs: 120_000,
      runTtlMs: 1_200_000
    });

    const restored = createAutomationMonitorManager({
      now: () => "2026-06-25T10:06:00.000Z",
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io
      }),
      supervisor: createMockSupervisor()
    });

    expect(restored.readSnapshot().monitors[0]).toMatchObject({
      id: "tmux-session:money-run-goal",
      timeoutMs: 45_000,
      triggerMode: "manual",
      concurrencyPolicy: "allow",
      maxConcurrency: 3,
      maxAttempts: 4,
      backoffMs: 15_000,
      backoffMultiplier: 3,
      maxBackoffMs: 120_000,
      runTtlMs: 1_200_000,
      preview: {
        adapter: "tmux-supervision",
        readWriteBehavior: "read-only",
        timeoutMs: 45_000,
        concurrency: {
          policy: "allow",
          max: 3
        },
        retry: {
          maxAttempts: 4,
          backoffMs: 15_000,
          maxBackoffMs: 120_000
        },
        runTtlMs: 1_200_000
      }
    });
  });
});
