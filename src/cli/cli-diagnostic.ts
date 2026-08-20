/**
 * CLI Diagnostic — the `skfiy doctor` command.
 *
 * Thin projection over createDiagnosticReport/readDiagnosticReportForRenderer.
 * Sources are injectable so tests can assert the projection without a live
 * app; the default factory wires file-reading sources (permissions via the
 * helper CLI, browser readiness via native host manifest files, provider
 * states via the provider registry).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  createDiagnosticReport,
  readDiagnosticReportForRenderer,
  type DiagnosticReportSources
} from "../main/diagnostic-report.js";
import { readBrowserReadinessEvidence } from "../main/main-browser-readiness.js";
import { readAssistantAgentProviderStates } from "../main/assistant-agent.js";
import { readInitialAssistantAgentSettingsFromConfig } from "../main/assistant-agent-settings.js";
import { DesktopHelperClient } from "../main/computer-use/desktop-helper.js";
import {
  readPermissionDiagnosticsForRenderer,
  UNKNOWN_PERMISSION_SUMMARY
} from "../main/permissions.js";
import { DIAGNOSTIC_REPORT_SCHEMA_VERSION } from "../shared/diagnostic-report.js";
import type { DiagnosticReport } from "../shared/diagnostic-report.js";

export { DIAGNOSTIC_REPORT_SCHEMA_VERSION };

export interface CliDiagnosticDeps {
  homeDir: string;
  appVersion: string;
  /** Absolute path to the helper binary, or null when it is not built. */
  helperPath: string | null;
  /** Absolute path to the bin/skfiy.mjs shim (native host manifest probe). */
  cliShimPath: string;
  exists?: (targetPath: string) => boolean;
}

/**
 * Default file-reading sources. Every source is guarded: a source that
 * cannot be read offline degrades to the report's "unknown" section instead
 * of failing the whole command.
 */
export function createFileDiagnosticReportSources(
  deps: CliDiagnosticDeps
): DiagnosticReportSources {
  const execFileAsync = promisify(execFile);
  const exists = deps.exists ?? existsSync;
  const helperPath = deps.helperPath;

  return {
    readPermissions: helperPath && exists(helperPath)
      ? async () => {
          const helper = new DesktopHelperClient({
            helperPath,
            runner: async (filePath, args) => {
              const result = await execFileAsync(filePath, args, { timeout: 15_000 });
              return {
                stdout: typeof result.stdout === "string" ? result.stdout : "",
                stderr: typeof result.stderr === "string" ? result.stderr : "",
                exitCode: 0
              };
            }
          });
          const active = await helper.getPermissions();
          return readPermissionDiagnosticsForRenderer({
            active,
            appProcess: UNKNOWN_PERMISSION_SUMMARY,
            helper: { getPermissions: async () => active },
            identity: {
              appPath: process.execPath,
              executablePath: process.execPath,
              helperPath,
              resourcesPath: process.cwd(),
              isPackaged: false
            }
          });
        }
      : undefined,
    readBrowserReadiness: () => readBrowserReadinessEvidence({
      homeDir: deps.homeDir,
      cliShimPath: deps.cliShimPath
    }),
    readProviderStates: () => readAssistantAgentProviderStates(
      readInitialAssistantAgentSettingsFromConfig(process.env, { cwd: process.cwd() })
    ),
    readStartupWarnings: async () => [],
    readComponentVersions: async () => [
      { component: "app", version: deps.appVersion, source: "package.json", state: "available" },
      { component: "cli", version: deps.appVersion, source: "package.json", state: "available" },
      ...(deps.helperPath
        ? [{ component: "helper" as const, version: null, source: "macos-helper", state: "unknown" as const }]
        : [{ component: "helper" as const, version: null, source: "macos-helper", state: "missing" as const }])
    ]
  };
}

export async function runDoctorCommand(
  sources: DiagnosticReportSources
): Promise<DiagnosticReport> {
  return readDiagnosticReportForRenderer({ sources });
}

/** Builds a report directly from an input object (used by readiness). */
export function buildDoctorReport(input: Parameters<typeof createDiagnosticReport>[0]): DiagnosticReport {
  return createDiagnosticReport(input);
}
