/**
 * CLI Status — the `skfiy status` and `skfiy readiness` commands.
 *
 * Status combines: runtime snapshot panels (file, always available offline),
 * binary readiness (file existence), task control (loopback, only when the
 * app is running), and a readiness projection derived from the diagnostic
 * report. Offline is NOT an error: when the loopback is unreachable the
 * command returns result=ok with taskControl omitted and
 * readiness.state="app-not-running".
 */

import {
  readRuntimeSnapshotPanels,
  type RuntimeSnapshotReadIo
} from "../main/runtime-snapshot.js";
import type { DiagnosticReport, DiagnosticReportState } from "../shared/diagnostic-report.js";
import type { TaskControlSnapshot } from "../shared/task-control.js";
import { isTaskControlSnapshot } from "../shared/task-control.js";
import type { ControlClient } from "./control-client.js";
import { ControlClientError } from "./control-client.js";
import {
  createFileDiagnosticReportSources,
  runDoctorCommand,
  type CliDiagnosticDeps
} from "./cli-diagnostic.js";
import type { DiagnosticReportSources } from "../main/diagnostic-report.js";

export interface CliBinaryReadiness {
  readonly app: { readonly installed: boolean; readonly path: string };
  readonly helper: { readonly installed: boolean; readonly path: string | null };
  readonly cli: { readonly installed: boolean; readonly path: string };
}

export interface CliReadiness {
  readonly state: "ready" | "blocked" | "app-not-running";
  readonly overallState: DiagnosticReportState;
  readonly blockerCount: number;
  readonly nextAction?: string;
}

export interface CliStatusData {
  readonly readiness: CliReadiness;
  readonly runtime: {
    readonly currentTurn: Record<string, unknown>;
    readonly replay: Record<string, unknown>;
    readonly routeOutcome?: unknown;
  };
  readonly binaries: CliBinaryReadiness;
  readonly taskControl?: TaskControlSnapshot | null;
}

export interface CliStatusDeps {
  readonly homeDir: string;
  readonly appVersion: string;
  readonly appPath: string;
  readonly helperPath: string | null;
  readonly cliShimPath: string;
  readonly exists: (targetPath: string) => boolean;
  readonly readFile: (targetPath: string) => string;
  readonly controlClient: ControlClient | null;
  readonly diagnosticSources?: DiagnosticReportSources;
}

export function readBinaryReadiness(
  deps: Pick<CliStatusDeps, "appPath" | "helperPath" | "cliShimPath" | "exists">
): CliBinaryReadiness {
  return {
    app: { installed: deps.exists(deps.appPath), path: deps.appPath },
    helper: {
      installed: deps.helperPath !== null && deps.exists(deps.helperPath),
      path: deps.helperPath
    },
    cli: { installed: deps.exists(deps.cliShimPath), path: deps.cliShimPath }
  };
}

/** Projects a diagnostic report into the compact readiness summary. */
export function projectReadiness(
  report: DiagnosticReport,
  appRunning: boolean
): CliReadiness {
  const firstBlocker = report.blockers[0];
  const blocked = report.overallState === "blocked" || report.overallState === "action-required";
  return {
    state: appRunning ? (blocked ? "blocked" : "ready") : "app-not-running",
    overallState: report.overallState,
    blockerCount: report.blockers.length,
    ...(firstBlocker ? { nextAction: firstBlocker.nextAction } : {})
  };
}

async function readDiagnosticSources(
  deps: CliStatusDeps
): Promise<DiagnosticReportSources> {
  if (deps.diagnosticSources) {
    return deps.diagnosticSources;
  }
  const diagnosticDeps: CliDiagnosticDeps = {
    homeDir: deps.homeDir,
    appVersion: deps.appVersion,
    helperPath: deps.helperPath,
    cliShimPath: deps.cliShimPath,
    exists: deps.exists
  };
  return createFileDiagnosticReportSources(diagnosticDeps);
}

export async function runStatusCommand(deps: CliStatusDeps): Promise<CliStatusData> {
  const io: RuntimeSnapshotReadIo = {
    exists: deps.exists,
    readFile: deps.readFile
  };
  const runtime = readRuntimeSnapshotPanels({ homeDir: deps.homeDir, io });

  const binaries = readBinaryReadiness(deps);

  let appRunning = false;
  let taskControl: TaskControlSnapshot | null | undefined;
  if (deps.controlClient) {
    try {
      appRunning = await deps.controlClient.ping();
      if (appRunning) {
        const snapshot = await deps.controlClient.readTaskControl();
        taskControl = snapshot && isTaskControlSnapshot(snapshot) ? snapshot : null;
      }
    } catch (error) {
      if (error instanceof ControlClientError && error.code === "unauthorized") {
        throw error;
      }
      appRunning = false;
    }
  }

  const sources = await readDiagnosticSources(deps);
  const report = await runDoctorCommand(sources);

  return {
    readiness: projectReadiness(report, appRunning),
    runtime: {
      currentTurn: runtime.currentTurn,
      replay: runtime.replay,
      ...(runtime.routeOutcome ? { routeOutcome: runtime.routeOutcome } : {})
    },
    binaries,
    ...(taskControl !== undefined ? { taskControl } : {})
  };
}

export interface CliReadinessData {
  readonly readiness: CliReadiness;
}

export async function runReadinessCommand(deps: CliStatusDeps): Promise<CliReadinessData> {
  const sources = await readDiagnosticSources(deps);
  const report = await runDoctorCommand(sources);
  const appRunning = deps.controlClient ? await deps.controlClient.ping() : false;
  return { readiness: projectReadiness(report, appRunning) };
}
