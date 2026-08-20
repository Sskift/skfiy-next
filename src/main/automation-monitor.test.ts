import { describe, expect, it, vi } from "vitest";
import type { TmuxSupervisionReport } from "./computer-use/tmux-supervisor.js";
import { createTmuxSupervisionReport } from "./computer-use/tmux-supervisor.js";
import {
  createAutomationMonitorManager,
  createAutomationMonitorStore,
  type AutomationMonitorStoreIo
} from "./automation-monitor.js";

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

function createWorkingReport(
  sessionName: string,
  paneTail = "Working"
): TmuxSupervisionReport {
  return createTmuxSupervisionReport({
    sessionName,
    hasSession: true,
    windowsOutput: "@4\t1\tzsh\t1\t1",
    panesOutput: `${sessionName}\t@4\t1\tzsh\t%4\t0\t1\t0\tzsh\tworker`,
    paneTails: { "%4": paneTail }
  });
}

function createManager(
  tmuxClient: { observeSession: (sessionName: string) => Promise<TmuxSupervisionReport> },
  onRunTerminal: (event: unknown) => void = () => undefined
) {
  return createAutomationMonitorManager({
    now: () => "2026-06-25T10:00:00.000Z",
    onRunTerminal,
    store: createAutomationMonitorStore({
      filePath: "/state/automation-monitors.json",
      io: createMemoryIo()
    }),
    tmuxClient
  });
}

describe("automation monitor manager terminal notifications", () => {
  it("emits one bounded terminal event without observation output", async () => {
    const terminalEvents: unknown[] = [];
    const manager = createManager(
      {
        observeSession: async (sessionName) => createWorkingReport(sessionName, "private pane output")
      },
      (event) => terminalEvents.push(event)
    );
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      label: "Goal observer",
      intervalMs: 600_000
    });

    await manager.runMonitorNow(definition.id);

    expect(terminalEvents).toEqual([{
      runId: "tmux-session:money-run-goal:run:1",
      label: "Goal observer",
      outcome: "completed"
    }]);
    expect(JSON.stringify(terminalEvents)).not.toContain("private pane output");
  });

  it("notifies scheduled runs only when their compact outcome changes", async () => {
    const onRunTerminal = vi.fn();
    const manager = createManager(
      {
        observeSession: async (sessionName) => createWorkingReport(sessionName)
      },
      onRunTerminal
    );
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 600_000
    });

    await manager.runMonitorNow(definition.id, "scheduled");
    await manager.runMonitorNow(definition.id, "scheduled");
    expect(onRunTerminal).toHaveBeenCalledTimes(1);

    await manager.runMonitorNow(definition.id, "manual");
    expect(onRunTerminal).toHaveBeenCalledTimes(2);
  });

  it("notifies again when a scheduled run changes outcome", async () => {
    const onRunTerminal = vi.fn();
    let fail = false;
    const manager = createManager(
      {
        observeSession: async (sessionName) => {
          if (fail) {
            throw new Error("tmux unavailable");
          }
          return createWorkingReport(sessionName);
        }
      },
      onRunTerminal
    );
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 600_000
    });

    await manager.runMonitorNow(definition.id, "scheduled");
    expect(onRunTerminal).toHaveBeenCalledTimes(1);

    fail = true;
    await manager.runMonitorNow(definition.id, "scheduled");
    expect(onRunTerminal).toHaveBeenCalledTimes(2);
    expect(onRunTerminal).toHaveBeenLastCalledWith({
      runId: "tmux-session:money-run-goal:run:2",
      label: "money-run-goal",
      outcome: "failure"
    });
  });

  it("emits a failure event when the observation errors", async () => {
    const onRunTerminal = vi.fn();
    const manager = createManager(
      {
        observeSession: async () => {
          throw new Error("tmux unavailable");
        }
      },
      onRunTerminal
    );
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 600_000
    });

    const runtime = await manager.runMonitorNow(definition.id);

    expect(runtime.lastResult).toBe("error");
    expect(onRunTerminal).toHaveBeenCalledWith({
      runId: "tmux-session:money-run-goal:run:1",
      label: "money-run-goal",
      outcome: "failure"
    });
  });

  it("emits an attention event when the report needs attention", async () => {
    const onRunTerminal = vi.fn();
    const manager = createManager(
      {
        observeSession: async (sessionName) => ({
          ...createWorkingReport(sessionName),
          status: "needs_attention"
        })
      },
      onRunTerminal
    );
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 600_000
    });

    await manager.runMonitorNow(definition.id);

    expect(onRunTerminal).toHaveBeenCalledWith({
      runId: "tmux-session:money-run-goal:run:1",
      label: "money-run-goal",
      outcome: "attention"
    });
  });

  it("does not let notification failures change the durable monitor outcome", async () => {
    const manager = createManager(
      {
        observeSession: async (sessionName) => createWorkingReport(sessionName)
      },
      () => {
        throw new Error("notification center unavailable");
      }
    );
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 600_000
    });

    const runtime = await manager.runMonitorNow(definition.id);

    expect(runtime.lastResult).toBe("observing");
    // The scheduler was never started, so the public status maps to
    // "scheduler_inactive"; the durable terminal result above is what matters.
    expect(runtime.status).toBe("scheduler_inactive");
  });
});

describe("automation monitor manager lifecycle", () => {
  it("persists pause and resume while keeping paused monitors inert after restart", () => {
    const io = createMemoryIo();
    const cleared: unknown[] = [];
    const firstScheduled: unknown[] = [];
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
      tmuxClient: {
        observeSession: vi.fn()
      }
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
      tmuxClient: {
        observeSession: vi.fn()
      }
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
      tmuxClient: {
        observeSession: vi.fn()
      }
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
      tmuxClient: {
        observeSession: vi.fn()
      }
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

  it("publishes a bounded read-only definition preview and fails a timed-out check", async () => {
    let timeoutCallback: (() => void) | undefined;
    const clearTimeout = vi.fn();
    const manager = createAutomationMonitorManager({
      now: () => "2026-06-25T10:05:00.000Z",
      setTimeout: (callback, timeoutMs) => {
        expect(timeoutMs).toBe(12_000);
        timeoutCallback = callback;
        return "monitor-timeout";
      },
      clearTimeout,
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io: createMemoryIo()
      }),
      tmuxClient: {
        observeSession: vi.fn(() => new Promise<never>(() => undefined))
      }
    });
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 123_000,
      timeoutMs: 12_000
    });

    expect(definition).toMatchObject({
      timeoutMs: 12_000,
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
        mutatesSession: false
      }
    });

    const pending = manager.runMonitorNow(definition.id);
    timeoutCallback?.();
    await expect(pending).resolves.toMatchObject({
      status: "error",
      lastError: "Automation monitor timed out after 12000ms.",
      lastResult: "error"
    });
    expect(clearTimeout).toHaveBeenCalledWith("monitor-timeout");
  });

  it("keeps disabled monitors inert when the tmux provider fails", async () => {
    const observeSession = vi.fn(async () => {
      throw new Error("tmux unavailable");
    });
    const manager = createAutomationMonitorManager({
      now: () => "2026-06-25T10:05:00.000Z",
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io: createMemoryIo()
      }),
      tmuxClient: { observeSession }
    });
    const definition = manager.upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 123_000,
      enabled: false
    });

    const runtime = await manager.runMonitorNow(definition.id);

    expect(observeSession).not.toHaveBeenCalled();
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
      tmuxClient: {
        observeSession: vi.fn()
      }
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

  it("round-trips timeout, trigger mode, and preview through the store", () => {
    const io = createMemoryIo();
    createAutomationMonitorManager({
      now: () => "2026-06-25T10:05:00.000Z",
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io
      }),
      tmuxClient: {
        observeSession: vi.fn()
      }
    }).upsertTmuxSessionMonitor({
      sessionName: "money-run-goal",
      intervalMs: 123_000,
      timeoutMs: 45_000,
      triggerMode: "manual"
    });

    const restored = createAutomationMonitorManager({
      now: () => "2026-06-25T10:06:00.000Z",
      store: createAutomationMonitorStore({
        filePath: "/state/automation-monitors.json",
        io
      }),
      tmuxClient: {
        observeSession: vi.fn()
      }
    });

    expect(restored.readSnapshot().monitors[0]).toMatchObject({
      id: "tmux-session:money-run-goal",
      timeoutMs: 45_000,
      triggerMode: "manual",
      preview: {
        adapter: "tmux-supervision",
        readWriteBehavior: "read-only",
        timeoutMs: 45_000
      }
    });
  });
});
