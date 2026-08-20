/**
 * CLI Export — the `skfiy export` and `skfiy restore preview` commands.
 *
 * Slim by composition: both commands wire file-reading deps into the existing
 * pure factories (buildDataExportBundle, parseDataExportBundle,
 * previewDataRestore) without re-implementing any validation or redaction.
 *
 * Restore preview NEVER applies — apply stays in the app UI where the user
 * confirms. Schema mismatches fail with a typed, actionable
 * schema-version-mismatch error (exit 3) so agents can detect
 * incompatibility programmatically.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildDataExportBundle,
  parseDataExportBundle,
  DATA_DOMAIN_ORDER,
  type DataExportBundleDeps
} from "../main/data-export-bundle.js";
import {
  previewDataRestore,
  type DataRestoreDeps,
  type DataRestorePreview
} from "../main/data-restore.js";
import {
  DATA_EXPORT_SCHEMA_VERSION,
  isDataDomain,
  type DataDomain,
  type DataExportAutomation,
  type DataExportBundle,
  type DataExportPersonalMemory,
  type DataExportProfiles,
  type DataExportRuntime,
  type DataExportSessions
} from "../shared/data-export.js";
import { createProfileStore, type ProfileStore } from "../main/profile-store.js";
import { captureProfileSettings } from "../main/profile-settings.js";
import { readInitialAppPolicySettings } from "../main/app-policy-settings.js";
import { readInitialAssistantAgentSettingsFromConfig } from "../main/assistant-agent-settings.js";
import { readInitialPlannerProviderSettings } from "../main/planner-provider-settings.js";
import type { ProfileRuntime } from "../main/profile-runtime.js";
import {
  readPersonalMemorySnapshot,
  createSkfiyApplicationSupportPath
} from "../main/personal-memory.js";
import { readPersonalMemorySettings } from "../main/personal-memory-settings.js";
import { readPersonalSkillSettings } from "../main/personal-skills.js";
import {
  createConversationSessionStorePath,
  parseConversationHistorySnapshot
} from "../main/conversation-session-store.js";
import {
  createAutomationMonitorStore,
  createAutomationMonitorManager,
  createAutomationMonitorStatePath,
  type AutomationMonitorManager
} from "../main/automation-monitor.js";
import {
  createAutomationRunStore,
  createAutomationRunStatePath,
  type AutomationRunStore
} from "../main/automation-run.js";
import type { AutomationRunSupervisor } from "../main/automation-run-supervisor.js";
import { createRuntimeSnapshotStatePath } from "../main/runtime-snapshot.js";
import { createCliError, type CliError } from "./cli-contract.js";

export interface CliExportDeps {
  readonly homeDir: string;
  readonly appSupportDir: string;
  readonly appVersion: string;
  readonly exists: (targetPath: string) => boolean;
  readonly readFile: (targetPath: string) => string;
  readonly writeFile: (targetPath: string, content: string) => void;
  readonly mkdir: (targetPath: string) => void;
  readonly now?: () => Date;
}

export interface CliExportSummary {
  readonly path: string;
  readonly domains: readonly DataDomain[];
  readonly redaction: DataExportBundle["redaction"];
}

export type ExportCommandResult =
  | { ok: true; data: DataExportBundle | CliExportSummary }
  | { ok: false; error: CliError };

export type RestorePreviewResult =
  | { ok: true; data: DataRestorePreview }
  | { ok: false; error: CliError };

// ---------------------------------------------------------------------------
// File-reading deps factories
// ---------------------------------------------------------------------------

export function createCliExportBundleDeps(deps: CliExportDeps): DataExportBundleDeps {
  const profileStore = createCliProfileStore(deps);
  const automationStore = createCliAutomationMonitorStore(deps);

  return {
    appVersion: deps.appVersion,
    ...(deps.now ? { now: deps.now } : {}),
    readProfiles: (): DataExportProfiles => ({
      activeProfileId: profileStore.getActiveId() ?? "Default",
      profiles: profileStore.list()
    }),
    readPersonalMemory: (): DataExportPersonalMemory => {
      const baseDir = deps.appSupportDir;
      const snapshot = readPersonalMemorySnapshotSafe(baseDir, deps);
      return {
        scope: "shared",
        userEntries: snapshot.userEntries,
        agentEntries: snapshot.agentEntries,
        settings: readPersonalMemorySettingsSafe(baseDir, deps),
        skills: readPersonalSkillSettingsSafe(baseDir, deps)
      };
    },
    readSessions: (): DataExportSessions => ({
      conversations: readConversationsSafe(deps.appSupportDir, deps)
    }),
    readAutomation: (): DataExportAutomation => ({
      monitors: automationStore.read().monitors.map((monitor) => ({
        ...monitor,
        preview: { ...monitor.preview }
      }))
    }),
    readRuntime: (): DataExportRuntime => {
      const snapshotPath = createRuntimeSnapshotStatePath(deps.homeDir);
      if (!deps.exists(snapshotPath)) {
        return {};
      }
      try {
        const parsed = JSON.parse(deps.readFile(snapshotPath)) as Record<string, unknown>;
        if (parsed.schemaVersion !== 1) {
          return {};
        }
        return { snapshot: parsed as unknown as DataExportRuntime["snapshot"] };
      } catch {
        return {};
      }
    }
  };
}

export function createCliRestoreDeps(deps: CliExportDeps): DataRestoreDeps {
  const profileStore = createCliProfileStore(deps);
  const automationMonitorStore = createCliAutomationMonitorStore(deps);
  const automationRunStore = createCliAutomationRunStore(deps);
  const automationMonitorManager = createAutomationMonitorManager({
    store: automationMonitorStore,
    supervisor: createStubAutomationRunSupervisor()
  });

  return {
    baseDir: deps.appSupportDir,
    homeDir: deps.homeDir,
    profileStore,
    profileRuntime: createStubProfileRuntime(),
    resolveMemoryBaseDir: () => deps.appSupportDir,
    conversationStore: () => null,
    conversationStoreBaseDir: deps.appSupportDir,
    automationMonitorManager,
    automationMonitorStore,
    automationRunStore
  };
}

function createCliProfileStore(deps: CliExportDeps): ProfileStore {
  return createProfileStore({
    baseDir: deps.appSupportDir,
    io: {
      exists: deps.exists,
      mkdir: deps.mkdir,
      readFile: deps.readFile,
      writeFile: deps.writeFile
    },
    ...(deps.now ? { now: deps.now } : {}),
    seed: captureProfileSettings({
      assistantAgent: readInitialAssistantAgentSettingsFromConfig(process.env, {
        cwd: process.cwd()
      }),
      plannerProvider: readInitialPlannerProviderSettings(process.env),
      appPolicy: readInitialAppPolicySettings(),
      personalMemory: { postTurnLearningEnabled: true, writeApprovalEnabled: false },
      defaultManualMode: "active"
    })
  });
}

function createCliAutomationMonitorStore(deps: CliExportDeps) {
  return createAutomationMonitorStore({
    filePath: createAutomationMonitorStatePath(deps.homeDir),
    io: createNodeStoreIo(deps)
  });
}

function createCliAutomationRunStore(deps: CliExportDeps): AutomationRunStore {
  return createAutomationRunStore({
    filePath: createAutomationRunStatePath(deps.homeDir),
    io: createNodeStoreIo(deps)
  });
}

function createNodeStoreIo(deps: CliExportDeps) {
  return {
    exists: deps.exists,
    mkdir: deps.mkdir,
    readFile: deps.readFile,
    writeFile: deps.writeFile
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function runExportCommand(options: {
  domains: readonly DataDomain[];
  outPath?: string;
  deps: CliExportDeps;
}): ExportCommandResult {
  const bundle = buildDataExportBundle(options.domains, createCliExportBundleDeps(options.deps));

  if (options.outPath) {
    options.deps.mkdir(path.dirname(options.outPath));
    options.deps.writeFile(options.outPath, `${JSON.stringify(bundle, null, 2)}\n`);
    const summary: CliExportSummary = {
      path: options.outPath,
      domains: bundle.domains,
      redaction: bundle.redaction
    };
    return { ok: true, data: summary };
  }

  return { ok: true, data: bundle };
}

export function runRestorePreviewCommand(options: {
  inputPath: string;
  deps: CliExportDeps;
}): RestorePreviewResult {
  if (!options.deps.exists(options.inputPath)) {
    return {
      ok: false,
      error: createCliError({
        code: "file-not-found",
        message: `Export bundle not found: ${options.inputPath}`,
        action: "Provide the path to a skfiy data export bundle with --in <file>."
      })
    };
  }

  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(options.deps.readFile(options.inputPath)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    record = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      error: createCliError({
        code: "invalid-bundle",
        message: `Export bundle is not valid JSON: ${readErrorMessage(error)}`,
        action: "Provide a skfiy data export bundle produced by `skfiy export`."
      })
    };
  }

  // Typed, actionable schema-version mismatch (exit 3) — detected before the
  // strict parse so the actual version is reported.
  if (
    typeof record.schemaVersion === "number"
    && record.schemaVersion !== DATA_EXPORT_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      error: createCliError({
        code: "schema-version-mismatch",
        message: `Unsupported data export schema version: ${record.schemaVersion}. This skfiy CLI supports schema v${DATA_EXPORT_SCHEMA_VERSION}.`,
        action: `Upgrade skfiy CLI to a version that supports data export schema v${record.schemaVersion}, or export the data with a skfiy app that produces schema v${DATA_EXPORT_SCHEMA_VERSION}.`,
        expected: DATA_EXPORT_SCHEMA_VERSION,
        actual: record.schemaVersion
      })
    };
  }

  let bundle: DataExportBundle;
  try {
    bundle = parseDataExportBundle(record);
  } catch (error) {
    return {
      ok: false,
      error: createCliError({
        code: "invalid-bundle",
        message: readErrorMessage(error),
        action: "Provide a skfiy data export bundle produced by `skfiy export`."
      })
    };
  }

  try {
    const preview = previewDataRestore(bundle, createCliRestoreDeps(options.deps));
    return { ok: true, data: preview };
  } catch (error) {
    return {
      ok: false,
      error: createCliError({
        code: "internal",
        message: readErrorMessage(error),
        action: "Report this error with the export bundle that triggered it."
      })
    };
  }
}

/** Parses --domains a,b,c into validated DataDomain[]. */
export function parseExportDomains(value: string | undefined): DataDomain[] | CliError {
  if (value === undefined || value.trim().length === 0) {
    return [...DATA_DOMAIN_ORDER];
  }
  const domains: DataDomain[] = [];
  for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (!isDataDomain(entry)) {
      return createCliError({
        code: "unknown-command",
        message: `Unknown export domain: ${entry}`,
        action: `Valid domains: ${DATA_DOMAIN_ORDER.join(", ")}.`
      });
    }
    domains.push(entry);
  }
  return domains.length > 0 ? domains : [...DATA_DOMAIN_ORDER];
}

// ---------------------------------------------------------------------------
// Safe readers (degrade to empty on any read error)
// ---------------------------------------------------------------------------

function readPersonalMemorySnapshotSafe(
  baseDir: string,
  deps: CliExportDeps
): { userEntries: string[]; agentEntries: string[] } {
  try {
    return readPersonalMemorySnapshot({
      baseDir,
      io: { exists: deps.exists, readFile: deps.readFile }
    });
  } catch {
    return { userEntries: [], agentEntries: [] };
  }
}

function readPersonalMemorySettingsSafe(
  baseDir: string,
  deps: CliExportDeps
): DataExportPersonalMemory["settings"] {
  try {
    return readPersonalMemorySettings({
      baseDir,
      io: { exists: deps.exists, readFile: deps.readFile }
    });
  } catch {
    return { postTurnLearningEnabled: true, writeApprovalEnabled: false };
  }
}

function readPersonalSkillSettingsSafe(
  baseDir: string,
  deps: CliExportDeps
): DataExportPersonalMemory["skills"] {
  try {
    return readPersonalSkillSettings({
      baseDir,
      io: { exists: deps.exists, readFile: deps.readFile }
    });
  } catch {
    return { disabledSkillIds: [] };
  }
}

function readConversationsSafe(
  baseDir: string,
  deps: CliExportDeps
): DataExportSessions["conversations"] {
  const filePath = createConversationSessionStorePath(baseDir);
  if (!deps.exists(filePath)) {
    return [];
  }
  try {
    return parseConversationHistorySnapshot(deps.readFile(filePath)).sessions;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stubs for interfaces restore preview never calls
// ---------------------------------------------------------------------------

function createStubProfileRuntime(): ProfileRuntime {
  const unsupported = (): never => {
    throw new Error("Profile mutations are not available from the skfiy CLI.");
  };
  return {
    snapshot: unsupported,
    switchProfile: async () => unsupported(),
    createProfile: unsupported,
    updateProfile: unsupported,
    deleteProfile: unsupported,
    captureActiveProfile: unsupported,
    exportProfile: unsupported,
    importProfile: unsupported
  };
}

function createStubAutomationRunSupervisor(): AutomationRunSupervisor {
  return {
    requestRun: async () => {
      throw new Error("Automation runs are not available from the skfiy CLI.");
    },
    stopRun: async () => undefined,
    stopMonitorRuns: () => undefined,
    readRuns: () => [],
    readSnapshot: () => ({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runs: []
    }),
    readStatus: () => ({ inFlight: 0, activeRunCount: 0, queuedCount: 0, skipped: {} }),
    start: () => undefined,
    stop: () => undefined
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-export so the surface can resolve the app-support dir for --home.
export { createSkfiyApplicationSupportPath };

// Default node IO for the surface entry point.
export function createDefaultCliExportDeps(input: {
  homeDir: string;
  appVersion: string;
  now?: () => Date;
}): CliExportDeps {
  return {
    homeDir: input.homeDir,
    appSupportDir: createSkfiyApplicationSupportPath(input.homeDir),
    appVersion: input.appVersion,
    exists: existsSync,
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8"),
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    ...(input.now ? { now: input.now } : {})
  };
}
