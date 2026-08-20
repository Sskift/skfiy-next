import { describe, expect, it, vi } from "vitest";
import { createTmuxSupervisionReport } from "./computer-use/tmux-supervisor.js";
import { createAutomationMonitorCommandService } from "./automation-monitor-command.js";
import type { AutomationMonitorStoreIo } from "./automation-monitor.js";

function createMemoryIo(files: Map<string, string> = new Map()): AutomationMonitorStoreIo {
  return {
    exists: (filePath) => files.has(filePath),
    mkdir: () => undefined,
    readFile: (filePath) => files.get(filePath) ?? "",
    rename: (fromPath, toPath) => {
      files.set(toPath, files.get(fromPath) ?? "");
      files.delete(fromPath);
    },
    writeFile: (filePath, content) => {
      files.set(filePath, content);
    }
  };
}

describe("automation monitor command service", () => {
  it("shares one bounded lifecycle outcome model across list and local definition controls", async () => {
    const service = createAutomationMonitorCommandService({
      filePath: "/state/automation-monitors.json",
      generatedAt: () => "2026-07-13T11:00:00.000Z",
      io: createMemoryIo(),
      tmuxClient: { observeSession: vi.fn() }
    });

    await expect(service.execute({
      action: "upsert-tmux",
      sessionName: "money-run-goal",
      label: "money-run goal",
      intervalMs: 600_000,
      timeoutMs: 12_000
    }, "cli")).resolves.toMatchObject({
      schemaVersion: 1,
      command: "automation monitor",
      source: "cli",
      action: "upsert-tmux",
      result: "configured",
      plannedMutation: true,
      executesSystemMutation: false,
      mutatesSession: false,
      monitorId: "tmux-session:money-run-goal",
      monitor: {
        enabled: true,
        intervalMs: 600_000,
        timeoutMs: 12_000,
        preview: {
          readWriteBehavior: "read-only",
          mutatesSession: false
        }
      }
    });

    await expect(service.execute({ action: "list" }, "mcp")).resolves.toMatchObject({
      source: "mcp",
      action: "list",
      result: "listed",
      plannedMutation: false,
      executesSystemMutation: false,
      mutatesSession: false,
      automation: {
        activeCount: 1,
        monitors: [{ id: "tmux-session:money-run-goal" }]
      }
    });

    await expect(service.execute({
      action: "duplicate",
      monitorId: "tmux-session:money-run-goal"
    }, "mcp")).resolves.toMatchObject({
      source: "mcp",
      action: "duplicate",
      result: "duplicated",
      monitorId: "tmux-session:money-run-goal:copy",
      monitor: {
        id: "tmux-session:money-run-goal:copy",
        label: "money-run goal copy",
        enabled: false,
        checkCount: 0
      },
      automation: {
        activeCount: 1,
        monitors: [
          { id: "tmux-session:money-run-goal" },
          { id: "tmux-session:money-run-goal:copy" }
        ]
      }
    });

    await expect(service.execute({
      action: "upsert-tmux",
      monitorId: "tmux-session:money-run-goal:copy",
      sessionName: "money-run-goal",
      label: "weekday goal observer",
      intervalMs: 900_000,
      timeoutMs: 20_000,
      enabled: false
    }, "cli")).resolves.toMatchObject({
      result: "configured",
      monitorId: "tmux-session:money-run-goal:copy",
      monitor: {
        id: "tmux-session:money-run-goal:copy",
        label: "weekday goal observer",
        intervalMs: 900_000,
        enabled: false
      }
    });

    await expect(service.execute({
      action: "delete",
      monitorId: "tmux-session:money-run-goal:copy"
    }, "mcp")).resolves.toMatchObject({
      result: "deleted",
      automation: { monitors: [{ id: "tmux-session:money-run-goal" }] }
    });

    await expect(service.execute({
      action: "set-enabled",
      monitorId: "tmux-session:money-run-goal",
      enabled: false
    }, "cli")).resolves.toMatchObject({
      result: "paused",
      monitor: { enabled: false, status: "disabled" }
    });
    await expect(service.execute({
      action: "set-enabled",
      monitorId: "tmux-session:money-run-goal",
      enabled: true
    }, "cli")).resolves.toMatchObject({
      result: "resumed",
      monitor: { enabled: true, status: "idle" }
    });
    await expect(service.execute({
      action: "delete",
      monitorId: "tmux-session:money-run-goal"
    }, "cli")).resolves.toMatchObject({
      result: "deleted",
      automation: { monitors: [] }
    });
  });

  it("runs the supported read-only adapter and returns the durable observation outcome", async () => {
    const observeSession = vi.fn(async (sessionName: string) => createTmuxSupervisionReport({
      sessionName,
      hasSession: true,
      windowsOutput: "@4\t1\tzsh\t1\t1",
      panesOutput: `${sessionName}\t@4\t1\tzsh\t%4\t0\t1\t0\tzsh\tworker`,
      paneTails: { "%4": "Working" }
    }));
    const service = createAutomationMonitorCommandService({
      filePath: "/state/automation-monitors.json",
      generatedAt: () => "2026-07-13T11:00:00.000Z",
      io: createMemoryIo(),
      tmuxClient: { observeSession }
    });
    const configured = await service.execute({
      action: "upsert-tmux",
      sessionName: "money-run-goal",
      intervalMs: 600_000,
      timeoutMs: 12_000
    }, "cli");

    await expect(service.execute({
      action: "run-now",
      monitorId: configured.monitorId ?? ""
    }, "cli")).resolves.toMatchObject({
      action: "run-now",
      result: "checked",
      plannedMutation: true,
      executesSystemMutation: false,
      mutatesSession: false,
      monitor: {
        checkCount: 1,
        lastResult: "observing",
        lastSummary: "money-run-goal has 1 window, 1 pane, and no obvious block markers."
      }
    });
    expect(observeSession).toHaveBeenCalledWith("money-run-goal");
  });

  it("rejects lifecycle commands for unknown monitors", async () => {
    const service = createAutomationMonitorCommandService({
      filePath: "/state/automation-monitors.json",
      io: createMemoryIo(),
      tmuxClient: { observeSession: vi.fn() }
    });

    await expect(service.execute({
      action: "run-now",
      monitorId: "tmux-session:missing"
    }, "cli")).rejects.toThrow("Unknown automation monitor");
    await expect(service.execute({
      action: "delete",
      monitorId: "tmux-session:missing"
    }, "cli")).rejects.toThrow("Unknown automation monitor");
  });
});
