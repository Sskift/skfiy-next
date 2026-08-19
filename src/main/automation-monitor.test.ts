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
