import { existsSync, readFileSync } from "node:fs";

import type {
  DataDomain,
  DataExportBundle,
  DataExportPersonalMemory,
  DataExportRuntimeSnapshot
} from "../shared/data-export.js";
import {
  normalizeRetentionSettingsUpdate,
  type RetentionSettings,
  type RetentionSettingsUpdate
} from "../shared/retention.js";
import { DEFAULT_PROFILE_ID, type Profile } from "../shared/profile.js";
import {
  buildDataExportBundle,
  DATA_DOMAIN_ORDER,
  type DataExportBundleDeps
} from "./data-export-bundle.js";
import {
  resetDataDomain,
  type DataDomainResetIo,
  type DataDomainResetResult
} from "./data-domain-reset.js";
import {
  previewDataRestore,
  applyDataRestore,
  type DataRestoreDeps,
  type DataRestorePreview,
  type DataRestoreResult
} from "./data-restore.js";
import { readStorageHealth, type StorageHealthSummary } from "./storage-health.js";
import {
  applyRetention,
  createRetentionSettingsStore,
  type ApplyRetentionResult,
  type RetentionSettingsStore
} from "./retention-controls.js";
import type { ProfileStore } from "./profile-store.js";
import type { ProfileRuntime } from "./profile-runtime.js";
import type { ConversationSessionStore } from "./conversation-session-store.js";
import type {
  AutomationMonitorManager,
  AutomationMonitorStore
} from "./automation-monitor.js";
import type { AutomationRunStore } from "./automation-run.js";
import { readPersonalMemorySnapshot } from "./personal-memory.js";
import { readPersonalMemorySettings } from "./personal-memory-settings.js";
import { readPersonalSkillSettings } from "./personal-skills.js";
import {
  createConversationSessionStorePath,
  parseConversationHistorySnapshot
} from "./conversation-session-store.js";
import {
  createRuntimeSnapshotStatePath,
  RUNTIME_SNAPSHOT_SCHEMA_VERSION
} from "./runtime-snapshot.js";

export interface DataAdminRuntimeDeps {
  baseDir: string;
  homeDir: string;
  appVersion: string;
  io?: DataDomainResetIo;
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
  stopMonitorRuns: (monitorId: string) => void;
  emitRestored?: () => void;
}

export interface DataAdminRuntime {
  exportData(domains?: DataDomain[]): DataExportBundle;
  previewRestore(bundle: unknown): DataRestorePreview;
  restoreData(preview: DataRestorePreview): Promise<DataRestoreResult>;
  resetDomain(domain: DataDomain): DataDomainResetResult;
  readHealth(): StorageHealthSummary;
  getRetention(): RetentionSettings;
  setRetention(update: unknown): RetentionSettings;
  resetRetention(): RetentionSettings;
  applyRetention(): Promise<ApplyRetentionResult>;
}

export function createDataAdminRuntime(deps: DataAdminRuntimeDeps): DataAdminRuntime {
  const now = deps.now ?? (() => new Date());
  const io = deps.io;
  const retentionStore: RetentionSettingsStore = createRetentionSettingsStore({
    baseDir: deps.baseDir,
    ...(io ? { io: toSettingsIo(io) } : {}),
    now
  });

  function activeProfile(): Profile | undefined {
    const activeId = deps.profileStore.getActiveId();
    return activeId ? deps.profileStore.get(activeId) : undefined;
  }

  function memoryBaseDir(): string {
    return deps.resolveMemoryBaseDir();
  }

  function readFileIfExists(filePath: string): string | undefined {
    if (io) {
      return io.exists(filePath) ? io.readFile(filePath) : undefined;
    }
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
  }

  const exportDeps: DataExportBundleDeps = {
    appVersion: deps.appVersion,
    now,
    readProfiles: () => ({
      activeProfileId: deps.profileStore.getActiveId() ?? DEFAULT_PROFILE_ID,
      profiles: deps.profileStore.list()
    }),
    readPersonalMemory: () => {
      const baseDir = memoryBaseDir();
      const profile = activeProfile();
      const scope = profile?.memoryScope === "isolated" ? "isolated" : "shared";
      const payload: DataExportPersonalMemory = {
        scope,
        ...(scope === "isolated" && profile ? { profileId: profile.id } : {}),
        userEntries: readPersonalMemorySnapshotSafe(baseDir).userEntries,
        agentEntries: readPersonalMemorySnapshotSafe(baseDir).agentEntries,
        settings: readPersonalMemorySettingsSafe(baseDir),
        skills: readPersonalSkillSettingsSafe(baseDir)
      };
      return payload;
    },
    readSessions: () => ({ conversations: readConversationsSafe(memoryBaseDir()) }),
    readAutomation: () => ({
      monitors: deps.automationMonitorStore.read().monitors.map((monitor) => ({
        ...monitor,
        preview: { ...monitor.preview }
      }))
    }),
    readRuntime: () => {
      const snapshot = readRuntimeSnapshotSafe();
      return snapshot ? { snapshot } : {};
    }
  };

  function readPersonalMemorySnapshotSafe(baseDir: string) {
    try {
      return readPersonalMemorySnapshot({ baseDir, ...(io ? { io } : {}) });
    } catch {
      return { userEntries: [] as string[], agentEntries: [] as string[] };
    }
  }

  function readPersonalMemorySettingsSafe(baseDir: string) {
    try {
      return readPersonalMemorySettings({ baseDir, ...(io ? { io } : {}) });
    } catch {
      return { postTurnLearningEnabled: true, writeApprovalEnabled: false };
    }
  }

  function readPersonalSkillSettingsSafe(baseDir: string) {
    try {
      return readPersonalSkillSettings({ baseDir, ...(io ? { io } : {}) });
    } catch {
      return { disabledSkillIds: [] as string[] };
    }
  }

  function readConversationsSafe(baseDir: string) {
    const content = readFileIfExists(createConversationSessionStorePath(baseDir));
    if (content === undefined) {
      return [];
    }
    try {
      return parseConversationHistorySnapshot(content).sessions;
    } catch {
      return [];
    }
  }

  function readRuntimeSnapshotSafe(): DataExportRuntimeSnapshot | undefined {
    const content = readFileIfExists(createRuntimeSnapshotStatePath(deps.homeDir));
    if (content === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.schemaVersion !== RUNTIME_SNAPSHOT_SCHEMA_VERSION) {
        return undefined;
      }
      return parsed as unknown as DataExportRuntimeSnapshot;
    } catch {
      return undefined;
    }
  }

  const restoreDeps: DataRestoreDeps = {
    baseDir: deps.baseDir,
    homeDir: deps.homeDir,
    ...(io ? { io } : {}),
    now,
    ...(deps.idFactory ? { idFactory: deps.idFactory } : {}),
    profileStore: deps.profileStore,
    profileRuntime: deps.profileRuntime,
    resolveMemoryBaseDir: memoryBaseDir,
    conversationStore: deps.conversationStore,
    conversationStoreBaseDir: deps.conversationStoreBaseDir,
    automationMonitorManager: deps.automationMonitorManager,
    automationMonitorStore: deps.automationMonitorStore,
    automationRunStore: deps.automationRunStore,
    ...(deps.emitRestored ? { emitRestored: deps.emitRestored } : {})
  };

  return {
    exportData(domains: DataDomain[] = [...DATA_DOMAIN_ORDER]): DataExportBundle {
      return buildDataExportBundle(domains, exportDeps);
    },

    previewRestore(bundle: unknown): DataRestorePreview {
      return previewDataRestore(bundle, restoreDeps);
    },

    restoreData(preview: DataRestorePreview): Promise<DataRestoreResult> {
      return applyDataRestore(preview, restoreDeps);
    },

    resetDomain(domain: DataDomain): DataDomainResetResult {
      return resetDataDomain(domain, {
        baseDir: deps.baseDir,
        homeDir: deps.homeDir,
        ...(io ? { io } : {}),
        now,
        profileStore: deps.profileStore,
        resolveMemoryBaseDir: memoryBaseDir,
        activeProfile,
        automationMonitorManager: deps.automationMonitorManager,
        automationMonitorStore: deps.automationMonitorStore,
        automationRunStore: deps.automationRunStore,
        stopMonitorRuns: deps.stopMonitorRuns,
        conversationStore: deps.conversationStore,
        conversationStoreBaseDir: deps.conversationStoreBaseDir
      });
    },

    readHealth(): StorageHealthSummary {
      return readStorageHealth({
        baseDir: deps.baseDir,
        ...(io ? { io: { exists: io.exists, readFile: io.readFile } } : {})
      });
    },

    getRetention(): RetentionSettings {
      return retentionStore.read();
    },

    setRetention(update: unknown): RetentionSettings {
      const normalized: RetentionSettingsUpdate = normalizeRetentionSettingsUpdate(update);
      return retentionStore.update(normalized);
    },

    resetRetention(): RetentionSettings {
      return retentionStore.reset();
    },

    applyRetention(): Promise<ApplyRetentionResult> {
      return applyRetention({
        homeDir: deps.homeDir,
        settings: retentionStore.read(),
        ...(io ? { io: toRunIo(io) } : {}),
        now
      });
    }
  };
}

function toSettingsIo(io: DataDomainResetIo) {
  return {
    exists: io.exists,
    mkdir: io.mkdir,
    readFile: io.readFile,
    writeFile: io.writeFile,
    ...(io.rename ? { rename: io.rename } : {})
  };
}

function toRunIo(io: DataDomainResetIo) {
  return {
    exists: io.exists,
    mkdir: io.mkdir,
    readFile: io.readFile,
    writeFile: io.writeFile,
    ...(io.rename ? { rename: io.rename } : {})
  };
}
