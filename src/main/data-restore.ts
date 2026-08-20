import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { DataDomain, DataExportBundle } from "../shared/data-export.js";
import { DATA_DOMAIN_ORDER } from "./data-export-bundle.js";
import {
  CONVERSATION_HISTORY_SCHEMA_VERSION,
  type ConversationHistorySnapshot,
  type ConversationSession
} from "../shared/conversation-history.js";
import type { Profile } from "../shared/profile.js";
import {
  DATA_DOMAIN_DESCRIPTORS,
  parseDataExportBundle
} from "./data-export-bundle.js";
import { readInitialAppPolicySettings } from "./app-policy-settings.js";
import type { ProfileStore } from "./profile-store.js";
import type { ProfileRuntime } from "./profile-runtime.js";
import {
  readPersonalMemorySnapshot,
  writePersonalMemoryEntries,
  type PersonalMemorySnapshot
} from "./personal-memory.js";
import { isPersonalSkillId } from "./personal-skills.js";
import {
  createConversationSessionStorePath,
  parseConversationHistorySnapshot,
  type ConversationSessionStore
} from "./conversation-session-store.js";
import type {
  AutomationMonitorDefinition,
  AutomationMonitorManager,
  AutomationMonitorStore
} from "./automation-monitor.js";
import type { AutomationRunStore } from "./automation-run.js";
import {
  createRuntimeSnapshotStatePath,
  RUNTIME_SNAPSHOT_SCHEMA_VERSION
} from "./runtime-snapshot.js";

export interface DataRestoreIo {
  exists: (targetPath: string) => boolean;
  mkdir: (targetPath: string) => void;
  readFile: (targetPath: string) => string;
  writeFile: (targetPath: string, content: string) => void;
  rename?: (fromPath: string, toPath: string) => void;
}

export interface DataRestorePreviewEntry {
  domain: DataDomain;
  action: "replace" | "merge" | "skip";
  currentSummary: string;
  incomingSummary: string;
  conflicts: string[];
  warnings: string[];
}

export interface DataRestorePreview {
  domains: DataRestorePreviewEntry[];
  requiresConfirmation: boolean;
  backupPlan: { path: string; createdAt: string };
  bundle: DataExportBundle;
}

export interface DataRestoreResult {
  appliedDomains: DataDomain[];
  skipped: { domain: DataDomain; reason: string }[];
  backupPath: string;
  restoredAt: string;
}

export interface DataRestoreDeps {
  baseDir: string;
  homeDir: string;
  io?: DataRestoreIo;
  now?: () => Date;
  idFactory?: () => string;
  profileStore: ProfileStore;
  profileRuntime: ProfileRuntime;
  resolveMemoryBaseDir: () => string;
  conversationStore: () => ConversationSessionStore | null;
  conversationStoreBaseDir: string;
  automationMonitorManager: AutomationMonitorManager;
  automationMonitorStore: AutomationMonitorStore;
  automationRunStore: AutomationRunStore;
  emitRestored?: () => void;
}

/**
 * Phase one: parse the bundle and compute per-domain impact without writing
 * anything. The renderer shows this to the user for confirmation.
 */
export function previewDataRestore(
  bundle: unknown,
  deps: DataRestoreDeps
): DataRestorePreview {
  const parsed = parseDataExportBundle(bundle);
  const now = deps.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const backupPlan = {
    path: path.join(deps.baseDir, "backups", `pre-restore-${formatBackupTimestamp(now())}`),
    createdAt
  };
  const io = deps.io ?? createDefaultDataRestoreIo();

  const entries: DataRestorePreviewEntry[] = [];
  for (const domain of DATA_DOMAIN_ORDER) {
    if (!parsed.domains.includes(domain)) {
      continue;
    }
    switch (domain) {
      case "profiles":
        entries.push(previewProfiles(parsed, deps));
        break;
      case "personal-memory":
        entries.push(previewPersonalMemory(parsed, deps, io));
        break;
      case "sessions":
        entries.push(previewSessions(parsed, deps, io));
        break;
      case "automation":
        entries.push(previewAutomation(parsed, deps));
        break;
      case "runtime":
        entries.push(previewRuntime(parsed, deps, io));
        break;
    }
  }

  return {
    domains: entries,
    requiresConfirmation: true,
    backupPlan,
    bundle: parsed
  };
}

function previewProfiles(
  bundle: DataExportBundle,
  deps: DataRestoreDeps
): DataRestorePreviewEntry {
  const payload = bundle.profiles;
  const incoming = payload?.profiles ?? [];
  const current = deps.profileStore.list();
  const currentNames = new Set(
    current.map((profile) => profile.name.trim().toLocaleLowerCase())
  );
  const conflicts = incoming
    .map((profile) => profile.name)
    .filter((name) => currentNames.has(name.trim().toLocaleLowerCase()))
    .map((name) => `Profile name "${name}" already exists and will be imported with a unique name.`);
  const warnings: string[] = [];
  const activeId = deps.profileStore.getActiveId();
  if (
    payload
    && incoming.some((profile) => profile.id === payload.activeProfileId)
    && payload.activeProfileId !== activeId
  ) {
    warnings.push("Restoring this bundle switches the active profile to the imported active profile.");
  }
  return {
    domain: "profiles",
    action: "merge",
    currentSummary: `${current.length} profile${current.length === 1 ? "" : "s"}: ${current.map((p) => p.name).join(", ") || "none"}`,
    incomingSummary: `${incoming.length} profile${incoming.length === 1 ? "" : "s"}: ${incoming.map((p) => p.name).join(", ") || "none"}`,
    conflicts,
    warnings
  };
}

function previewPersonalMemory(
  bundle: DataExportBundle,
  deps: DataRestoreDeps,
  io: DataRestoreIo
): DataRestorePreviewEntry {
  const payload = bundle.personalMemory;
  const memoryBaseDir = deps.resolveMemoryBaseDir();
  const current = readPersonalMemorySnapshotSafe(memoryBaseDir, io);
  const incomingUser = payload?.userEntries.length ?? 0;
  const incomingAgent = payload?.agentEntries.length ?? 0;
  const scope = payload?.scope === "isolated" ? "isolated" : "shared";
  return {
    domain: "personal-memory",
    action: "replace",
    currentSummary: `${current.userEntries.length} user entries, ${current.agentEntries.length} agent entries (${scope} scope).`,
    incomingSummary: `${incomingUser} user entries, ${incomingAgent} agent entries (${scope} scope).`,
    conflicts: [],
    warnings: ["Existing USER.md and AGENT.md entries are replaced, not merged."]
  };
}

function previewSessions(
  bundle: DataExportBundle,
  deps: DataRestoreDeps,
  io: DataRestoreIo
): DataRestorePreviewEntry {
  const payload = bundle.sessions;
  const memoryBaseDir = deps.resolveMemoryBaseDir();
  const current = readConversationsSafe(memoryBaseDir, io);
  const incoming = payload?.conversations.length ?? 0;
  return {
    domain: "sessions",
    action: "replace",
    currentSummary: `${current.length} conversation${current.length === 1 ? "" : "s"}.`,
    incomingSummary: `${incoming} conversation${incoming === 1 ? "" : "s"}.`,
    conflicts: [],
    warnings: ["Existing conversation sessions are replaced, not merged."]
  };
}

function previewAutomation(
  bundle: DataExportBundle,
  deps: DataRestoreDeps
): DataRestorePreviewEntry {
  const payload = bundle.automation;
  const incoming = payload?.monitors ?? [];
  const current = deps.automationMonitorManager.readSnapshot().monitors;
  const currentSessions = new Set(current.map((monitor) => monitor.sessionName));
  const conflicts = incoming
    .map((monitor) => monitor.sessionName)
    .filter((sessionName) => currentSessions.has(sessionName))
    .map((sessionName) => `A monitor for tmux session "${sessionName}" already exists and will be replaced.`);
  return {
    domain: "automation",
    action: "merge",
    currentSummary: `${current.length} monitor${current.length === 1 ? "" : "s"}: ${current.map((m) => m.label).join(", ") || "none"}`,
    incomingSummary: `${incoming.length} monitor${incoming.length === 1 ? "" : "s"}: ${incoming.map((m) => m.label).join(", ") || "none"}`,
    conflicts,
    warnings: ["Run history is cleared; monitor definitions are re-created."]
  };
}

function previewRuntime(
  bundle: DataExportBundle,
  deps: DataRestoreDeps,
  io: DataRestoreIo
): DataRestorePreviewEntry {
  const hasSnapshot = Boolean(bundle.runtime?.snapshot);
  const snapshotPath = createRuntimeSnapshotStatePath(deps.homeDir);
  const currentExists = io.exists(snapshotPath);
  return {
    domain: "runtime",
    action: "replace",
    currentSummary: currentExists ? "A runtime snapshot is persisted." : "No runtime snapshot is persisted.",
    incomingSummary: hasSnapshot ? "A runtime snapshot is included." : "No runtime snapshot is included.",
    conflicts: [],
    warnings: hasSnapshot && currentExists
      ? ["The current runtime snapshot will be overwritten."]
      : []
  };
}

/**
 * Phase two: re-validate the bundle, back up every affected file, then apply
 * each domain atomically. A failed domain is reported in `skipped` with the
 * backup path so the user can recover manually; already-applied domains are
 * not rolled back.
 */
export async function applyDataRestore(
  preview: DataRestorePreview,
  deps: DataRestoreDeps
): Promise<DataRestoreResult> {
  const parsed = parseDataExportBundle(preview.bundle);
  const io = deps.io ?? createDefaultDataRestoreIo();
  const now = deps.now ?? (() => new Date());
  const backupPath = preview.backupPlan.path;
  const domains = parsed.domains;

  backupAffectedFiles(domains, backupPath, deps, io);

  const appliedDomains: DataDomain[] = [];
  const skipped: DataRestoreResult["skipped"] = [];

  for (const domain of DATA_DOMAIN_ORDER) {
    if (!domains.includes(domain)) {
      continue;
    }
    try {
      switch (domain) {
        case "profiles":
          await applyProfilesRestore(parsed, deps);
          break;
        case "personal-memory":
          applyPersonalMemoryRestore(parsed, deps, io, now);
          break;
        case "sessions":
          applySessionsRestore(parsed, deps, io);
          break;
        case "automation":
          applyAutomationRestore(parsed, deps);
          break;
        case "runtime":
          applyRuntimeRestore(parsed, deps, io);
          break;
      }
      appliedDomains.push(domain);
    } catch (error) {
      skipped.push({
        domain,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  deps.emitRestored?.();

  return {
    appliedDomains,
    skipped,
    backupPath,
    restoredAt: now().toISOString()
  };
}

function backupAffectedFiles(
  domains: readonly DataDomain[],
  backupPath: string,
  deps: DataRestoreDeps,
  io: DataRestoreIo
): void {
  const memoryBaseDir = deps.resolveMemoryBaseDir();
  for (const domain of domains) {
    for (const relativePath of DATA_DOMAIN_DESCRIPTORS[domain].files) {
      const sourcePath = domain === "personal-memory" || domain === "sessions"
        ? resolveMemoryFilePath(memoryBaseDir, relativePath)
        : path.join(deps.baseDir, relativePath);
      if (!io.exists(sourcePath)) {
        continue;
      }
      const destination = path.join(backupPath, path.relative(deps.baseDir, sourcePath));
      io.mkdir(path.dirname(destination));
      io.writeFile(destination, io.readFile(sourcePath));
    }
  }
}

function resolveMemoryFilePath(memoryBaseDir: string, relativePath: string): string {
  const memoryPrefix = `memory${path.sep}`;
  const suffix = relativePath.startsWith(memoryPrefix)
    ? relativePath.slice(memoryPrefix.length)
    : relativePath;
  return path.join(memoryBaseDir, "memory", suffix);
}

async function applyProfilesRestore(
  bundle: DataExportBundle,
  deps: DataRestoreDeps
): Promise<void> {
  const payload = bundle.profiles;
  if (!payload) {
    return;
  }
  const idFactory = deps.idFactory ?? (() => `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const defaultAppPolicy = {
    apps: readInitialAppPolicySettings().apps.map((entry) => ({ ...entry }))
  };
  const idMap = new Map<string, string>();

  for (const incoming of payload.profiles) {
    const imported: Profile = {
      ...incoming,
      id: idFactory(),
      name: uniqueImportedName(deps.profileStore, incoming.name),
      createdAt: timestamp,
      updatedAt: timestamp,
      memoryScope: "isolated",
      appPolicy: defaultAppPolicy
    };
    deps.profileStore.upsert(imported);
    idMap.set(incoming.id, imported.id);
  }

  const activeImportId = idMap.get(payload.activeProfileId);
  if (activeImportId) {
    await deps.profileRuntime.switchProfile({ profileId: activeImportId, confirm: true });
  }
}

function uniqueImportedName(store: ProfileStore, name: string): string {
  const existing = new Set(
    store.list().map((profile) => profile.name.trim().toLocaleLowerCase())
  );
  if (!existing.has(name.trim().toLocaleLowerCase())) {
    return name;
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${name} (${suffix})`;
    if (!existing.has(candidate.trim().toLocaleLowerCase())) {
      return candidate;
    }
  }
  return `${name} (${Date.now()})`;
}

function applyPersonalMemoryRestore(
  bundle: DataExportBundle,
  deps: DataRestoreDeps,
  io: DataRestoreIo,
  now: () => Date
): void {
  const payload = bundle.personalMemory;
  if (!payload) {
    return;
  }
  const memoryBaseDir = deps.resolveMemoryBaseDir();
  writePersonalMemoryEntries(memoryBaseDir, "user", payload.userEntries, io);
  writePersonalMemoryEntries(memoryBaseDir, "agent", payload.agentEntries, io);

  const settings = payload.settings ?? {
    postTurnLearningEnabled: true,
    writeApprovalEnabled: false
  };
  writeAtomic(
    io,
    path.join(memoryBaseDir, "memory", "settings.json"),
    `${JSON.stringify({ ...settings, updatedAt: now().toISOString() }, null, 2)}\n`
  );

  const disabledSkillIds = (payload.skills?.disabledSkillIds ?? [])
    .filter(isPersonalSkillId);
  writeAtomic(
    io,
    path.join(memoryBaseDir, "memory", "personal-skills.json"),
    `${JSON.stringify({ disabledSkillIds: disabledSkillIds, updatedAt: now().toISOString() }, null, 2)}\n`
  );
}

function applySessionsRestore(
  bundle: DataExportBundle,
  deps: DataRestoreDeps,
  io: DataRestoreIo
): void {
  const payload = bundle.sessions;
  if (!payload) {
    return;
  }
  const memoryBaseDir = deps.resolveMemoryBaseDir();
  const snapshot: ConversationHistorySnapshot = {
    schemaVersion: CONVERSATION_HISTORY_SCHEMA_VERSION,
    lastActiveSessionId: payload.conversations[0]?.id ?? null,
    sessions: payload.conversations
  };
  const liveStore = deps.conversationStore();
  if (liveStore && deps.conversationStoreBaseDir === memoryBaseDir) {
    liveStore.replaceSnapshot(snapshot);
  } else {
    writeAtomic(
      io,
      createConversationSessionStorePath(memoryBaseDir),
      `${JSON.stringify(snapshot, null, 2)}\n`
    );
  }
}

function applyAutomationRestore(
  bundle: DataExportBundle,
  deps: DataRestoreDeps
): void {
  const payload = bundle.automation;
  deps.automationMonitorManager.stop();
  for (const monitor of deps.automationMonitorManager.readSnapshot().monitors) {
    deps.automationMonitorManager.deleteMonitor(monitor.id);
  }

  const seenSessions = new Set<string>();
  const definitions: AutomationMonitorDefinition[] = [];
  for (const monitor of payload?.monitors ?? []) {
    if (seenSessions.has(monitor.sessionName)) {
      continue;
    }
    seenSessions.add(monitor.sessionName);
    const definition = deps.automationMonitorManager.upsertTmuxSessionMonitor({
      sessionName: monitor.sessionName,
      label: monitor.label,
      intervalMs: monitor.intervalMs,
      timeoutMs: monitor.timeoutMs,
      triggerMode: normalizeTriggerMode(monitor.triggerMode),
      enabled: monitor.enabled,
      concurrencyPolicy: normalizeConcurrencyPolicy(monitor.concurrencyPolicy),
      maxConcurrency: monitor.maxConcurrency,
      maxAttempts: monitor.maxAttempts,
      backoffMs: monitor.backoffMs,
      backoffMultiplier: monitor.backoffMultiplier,
      maxBackoffMs: monitor.maxBackoffMs,
      runTtlMs: monitor.runTtlMs
    });
    definitions.push(definition);
  }

  deps.automationRunStore.write({ schemaVersion: 1, sequences: {}, runs: [] });
  deps.automationMonitorStore.write({ schemaVersion: 1, monitors: definitions });
  deps.automationMonitorManager.start();
}

function applyRuntimeRestore(
  bundle: DataExportBundle,
  deps: DataRestoreDeps,
  io: DataRestoreIo
): void {
  const snapshot = bundle.runtime?.snapshot;
  if (!snapshot) {
    return;
  }
  if (snapshot.schemaVersion !== RUNTIME_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime snapshot schema: ${String(snapshot.schemaVersion)}.`);
  }
  writeAtomic(
    io,
    createRuntimeSnapshotStatePath(deps.homeDir),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
}

function normalizeTriggerMode(value: string): "manual" | "scheduled" | "local-state" {
  return value === "scheduled" || value === "local-state" ? value : "manual";
}

function normalizeConcurrencyPolicy(value: string): "skip" | "queue" | "allow" {
  return value === "queue" || value === "allow" ? value : "skip";
}

function readPersonalMemorySnapshotSafe(
  baseDir: string,
  io: DataRestoreIo
): PersonalMemorySnapshot {
  try {
    return readPersonalMemorySnapshot({ baseDir, io });
  } catch {
    return { userEntries: [], agentEntries: [] };
  }
}

function readConversationsSafe(
  baseDir: string,
  io: DataRestoreIo
): ConversationSession[] {
  const filePath = createConversationSessionStorePath(baseDir);
  if (!io.exists(filePath)) {
    return [];
  }
  try {
    return parseConversationHistorySnapshot(io.readFile(filePath)).sessions;
  } catch {
    return [];
  }
}

function writeAtomic(io: DataRestoreIo, filePath: string, content: string): void {
  io.mkdir(path.dirname(filePath));
  if (io.rename) {
    const tempPath = `${filePath}.tmp-${Date.now()}`;
    io.writeFile(tempPath, content);
    io.rename(tempPath, filePath);
  } else {
    io.writeFile(filePath, content);
  }
}

function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createDefaultDataRestoreIo(): DataRestoreIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8"),
    rename: renameSync
  };
}
