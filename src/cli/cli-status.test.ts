import { describe, expect, it } from "vitest";
import {
  projectReadiness,
  readBinaryReadiness,
  runReadinessCommand,
  runStatusCommand,
  type CliStatusDeps
} from "./cli-status.js";
import type { ControlClient } from "./control-client.js";
import type { DiagnosticReport } from "../shared/diagnostic-report.js";
import type { TaskControlSnapshot } from "../shared/task-control.js";

const HOME_DIR = "/tmp/skfiy-cli-status-test-home";
const APP_SUPPORT = `${HOME_DIR}/Library/Application Support/skfiy`;

function createSnapshotFile(files: Map<string, string>): void {
  const snapshot = {
    schemaVersion: 1,
    observedAt: "2026-08-20T00:00:00.000Z",
    currentTurn: { state: "idle", source: "runtime-snapshot" },
    routeOutcome: {
      kind: "idle",
      title: "Idle",
      value: "idle",
      detail: "No active turn.",
      tone: "neutral",
      source: "runtime-snapshot",
      routeLabel: "none",
      state: "idle"
    },
    replay: { state: "empty", source: "runtime-snapshot" }
  };
  files.set(`${APP_SUPPORT}/runtime-snapshot.json`, JSON.stringify(snapshot));
}

function createDeps(
  files: Map<string, string>,
  overrides: Partial<CliStatusDeps> = {}
): CliStatusDeps {
  return {
    homeDir: HOME_DIR,
    appVersion: "0.1.0",
    appPath: "/Applications/skfiy.app",
    helperPath: `${APP_SUPPORT}/dist/skfiy-helper`,
    cliShimPath: "/repo/bin/skfiy.mjs",
    exists: (targetPath) => files.has(targetPath),
    readFile: (targetPath) => files.get(targetPath) ?? "",
    controlClient: null,
    diagnosticSources: {
      readComponentVersions: async () => []
    },
    ...overrides
  };
}

function createFakeControlClient(
  snapshot: TaskControlSnapshot | null
): ControlClient {
  return {
    readTaskControl: async () => snapshot,
    readTurnReplay: async () => null,
    approveTask: async () => ({ result: "no-pending-approval" }),
    stopTask: async () => ({
      result: "no-active-task",
      stopDecision: { cancellationReason: "Task stopped.", delivery: "transient", route: null },
      taskControl: snapshot
    }),
    ping: async () => true
  };
}

describe("CLI status", () => {
  it("returns currentTurn, replay, and routeOutcome from the runtime snapshot file", async () => {
    const files = new Map<string, string>();
    createSnapshotFile(files);
    const status = await runStatusCommand(createDeps(files));

    expect(status.runtime.currentTurn.state).toBe("idle");
    expect(status.runtime.replay.state).toBe("empty");
    expect(status.runtime.routeOutcome).toBeDefined();
    expect((status.runtime.routeOutcome as { kind: string }).kind).toBe("idle");
  });

  it("returns app-not-running readiness when no snapshot and no loopback (offline is ok)", async () => {
    const files = new Map<string, string>();
    const status = await runStatusCommand(createDeps(files));

    expect(status.readiness.state).toBe("app-not-running");
    expect(status.taskControl).toBeUndefined();
  });

  it("includes taskControl when the loopback control client is reachable", async () => {
    const files = new Map<string, string>();
    createSnapshotFile(files);
    const snapshot = {
      schemaVersion: 1 as const,
      executionId: "exec-1",
      phase: "executing" as const,
      status: "executing" as const,
      message: "Running",
      plan: {
        planId: "plan-1",
        route: "ghostty" as const,
        appName: "Ghostty",
        target: "window",
        risk: { level: "low" as const, reason: "read-only", requiresApproval: false },
        approvalRequired: false,
        expectedVerification: "terminal marker",
        mutating: false
      },
      sideEffectState: "none" as const,
      replayAvailable: false,
      recoveryActions: []
    };
    const status = await runStatusCommand(
      createDeps(files, { controlClient: createFakeControlClient(snapshot) })
    );

    expect(status.taskControl).toEqual(snapshot);
    expect(status.readiness.state).toBe("ready");
  });

  it("reports binary readiness for app/helper/cli", () => {
    const files = new Map<string, string>([
      ["/Applications/skfiy.app", ""],
      ["/repo/bin/skfiy.mjs", ""]
    ]);
    const binaries = readBinaryReadiness({
      appPath: "/Applications/skfiy.app",
      helperPath: "/missing/helper",
      cliShimPath: "/repo/bin/skfiy.mjs",
      exists: (targetPath) => files.has(targetPath)
    });

    expect(binaries.app.installed).toBe(true);
    expect(binaries.helper.installed).toBe(false);
    expect(binaries.cli.installed).toBe(true);
  });

  it("readiness command projects the diagnostic report", async () => {
    const files = new Map<string, string>();
    const report: DiagnosticReport = {
      schemaVersion: 1,
      generatedAt: "2026-08-20T00:00:00.000Z",
      overallState: "blocked",
      sections: [],
      blockers: [
        {
          id: "screen-recording-denied",
          type: "screen-recording-denied",
          severity: "blocked",
          title: "Screen Recording denied",
          detail: "denied",
          nextAction: "Grant Screen Recording.",
          copyable: "screen-recording-denied: denied — Grant Screen Recording."
        }
      ],
      componentVersions: [],
      redactionSummary: [],
      exportPreview: ""
    };
    const readiness = await runReadinessCommand(
      createDeps(files, {
        diagnosticSources: {
          readComponentVersions: async () => []
        }
      })
    );
    // Without a loopback, readiness is app-not-running even with a blocked report.
    expect(readiness.readiness.state).toBe("app-not-running");

    const projected = projectReadiness(report, true);
    expect(projected.state).toBe("blocked");
    expect(projected.blockerCount).toBe(1);
    expect(projected.nextAction).toBe("Grant Screen Recording.");
  });
});
