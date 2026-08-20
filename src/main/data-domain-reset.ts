import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { DEFAULT_PROFILE_ID, type Profile } from "../shared/profile.js";
import {
  CONVERSATION_HISTORY_SCHEMA_VERSION,
  type ConversationHistorySnapshot
} from "../shared/conversation-history.js";
import type { DataDomain } from "../shared/data-export.js";
import { DATA_DOMAIN_DESCRIPTORS } from "./data-export-bundle.js";
import { createDefaultProfileSettings } from "./profile-settings.js";
import type { ProfileStore } from "./profile-store.js";
import {
  writePersonalMemoryEntries
} from "./personal-memory.js";
import { createPersonalMemorySettingsFilePath } from "./personal-memory-settings.js";
import { createPersonalMemoryJournalPath } from "./personal-memory-journal.js";
import { createPendingPersonalMemoryWritePath } from "./personal-memory-pending.js";
import { createPersonalSkillSettingsFilePath } from "./personal-skills.js";
import {
  createConversationSessionStorePath,
  type ConversationSessionStore
} from "./conversation-session-store.js";
import { createSessionMemoryFilePath } from "./session-memory.js";
import type {
  AutomationMonitorManager,
  AutomationMonitorStore
} from "./automation-monitor.js";
import type { AutomationRunStore } from "./automation-run.js";
import {
  createRuntimeSnapshotFromReplay,
  createRuntimeSnapshotStatePath,
  createRuntimeTurnMarker,
  createRuntimeTurnMarkerStatePath
} from "./runtime-snapshot.js";

export interface DataDomainResetIo {
  exists: (targetPath: string) => boolean;
  mkdir: (targetPath: string) => void;
  readFile: (targetPath: string) => string;
  writeFile: (targetPath: string, content: string) => void;
  rename?: (fromPath: string, toPath: string) => void;
}

export interface DataDomainResetDeps {
  baseDir: string;
  homeDir: string;
  io?: DataDomainResetIo;
  now?: () => Date;
  profileStore: ProfileStore;
  resolveMemoryBaseDir: () => string;
  activeProfile: () => Profile | undefined;
  automationMonitorManager: AutomationMonitorManager;
  automationMonitorStore: AutomationMonitorStore;
  automationRunStore: AutomationRunStore;
  stopMonitorRuns: (monitorId: string) => void;
  conversationStore: () => ConversationSessionStore | null;
  conversationStoreBaseDir: string;
}

export interface DataDomainResetResult {
  domain: DataDomain;
  resetImpact: string;
  cleared: string[];
}

/**
 * Resets a single data domain. Unlike a global wipe, only the domain's own
 * files are touched, and every reset returns a summary of what was cleared.
 */
export function resetDataDomain(
  domain: DataDomain,
  deps: DataDomainResetDeps
): DataDomainResetResult {
  switch (domain) {
    case "profiles":
      return resetProfilesDomain(deps);
    case "personal-memory":
      return resetPersonalMemoryDomain(deps);
    case "sessions":
      return resetSessionsDomain(deps);
    case "automation":
      return resetAutomationDomain(deps);
    case "runtime":
      return resetRuntimeDomain(deps);
  }
}

function resetProfilesDomain(deps: DataDomainResetDeps): DataDomainResetResult {
  const active = deps.activeProfile();
  if (active?.memoryScope === "isolated") {
    throw new Error(
      "Cannot reset profiles while an isolated profile is active. Switch to Default first."
    );
  }

  const activeId = deps.profileStore.getActiveId();
  const keep = new Set(
    [DEFAULT_PROFILE_ID, activeId].filter((id): id is string => Boolean(id))
  );
  let removed = 0;
  for (const profile of deps.profileStore.list()) {
    if (!keep.has(profile.id)) {
      deps.profileStore.delete(profile.id);
      removed += 1;
    }
  }
  deps.profileStore.resetDefaultToSeed(createDefaultProfileSettings());

  return {
    domain: "profiles",
    resetImpact: DATA_DOMAIN_DESCRIPTORS.profiles.resetImpact,
    cleared: [
      `Removed ${removed} non-default profile${removed === 1 ? "" : "s"}.`,
      "Reset the Default profile to seed settings."
    ]
  };
}

function resetPersonalMemoryDomain(deps: DataDomainResetDeps): DataDomainResetResult {
  const io = deps.io ?? createDefaultDataDomainResetIo();
  const now = deps.now ?? (() => new Date());
  const memoryBaseDir = deps.resolveMemoryBaseDir();

  writePersonalMemoryEntries(memoryBaseDir, "user", [], io);
  writePersonalMemoryEntries(memoryBaseDir, "agent", [], io);
  writeAtomic(
    io,
    createPersonalMemorySettingsFilePath(memoryBaseDir),
    `${JSON.stringify({
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false,
      updatedAt: now().toISOString()
    }, null, 2)}\n`
  );
  writeAtomic(io, createPersonalMemoryJournalPath(memoryBaseDir), "");
  writeAtomic(
    io,
    createPendingPersonalMemoryWritePath(memoryBaseDir),
    `${JSON.stringify({ schemaVersion: 1, writes: [] }, null, 2)}\n`
  );
  writeAtomic(
    io,
    createPersonalSkillSettingsFilePath(memoryBaseDir),
    `${JSON.stringify({ disabledSkillIds: [], updatedAt: now().toISOString() }, null, 2)}\n`
  );

  return {
    domain: "personal-memory",
    resetImpact: DATA_DOMAIN_DESCRIPTORS["personal-memory"].resetImpact,
    cleared: [
      "Cleared USER.md and AGENT.md entries.",
      "Emptied the memory journal and pending writes.",
      "Reset personal memory settings and personal skills."
    ]
  };
}

function resetSessionsDomain(deps: DataDomainResetDeps): DataDomainResetResult {
  const io = deps.io ?? createDefaultDataDomainResetIo();
  const memoryBaseDir = deps.resolveMemoryBaseDir();
  const fresh: ConversationHistorySnapshot = {
    schemaVersion: CONVERSATION_HISTORY_SCHEMA_VERSION,
    lastActiveSessionId: null,
    sessions: []
  };

  const liveStore = deps.conversationStore();
  if (liveStore && deps.conversationStoreBaseDir === memoryBaseDir) {
    liveStore.replaceSnapshot(fresh);
  } else {
    writeAtomic(
      io,
      createConversationSessionStorePath(memoryBaseDir),
      `${JSON.stringify(fresh, null, 2)}\n`
    );
  }
  writeAtomic(io, createSessionMemoryFilePath(memoryBaseDir), "");

  return {
    domain: "sessions",
    resetImpact: DATA_DOMAIN_DESCRIPTORS.sessions.resetImpact,
    cleared: [
      "Cleared all conversation sessions.",
      "Cleared legacy session records."
    ]
  };
}

function resetAutomationDomain(deps: DataDomainResetDeps): DataDomainResetResult {
  const snapshot = deps.automationMonitorManager.readSnapshot();
  let stopped = 0;
  for (const monitor of snapshot.monitors) {
    deps.stopMonitorRuns(monitor.id);
    if (deps.automationMonitorManager.deleteMonitor(monitor.id)) {
      stopped += 1;
    }
  }
  deps.automationMonitorManager.stop();
  deps.automationMonitorStore.write({ schemaVersion: 1, monitors: [] });
  deps.automationRunStore.write({ schemaVersion: 1, sequences: {}, runs: [] });
  // Restart the scheduler so monitors created after the reset still schedule.
  deps.automationMonitorManager.start();

  return {
    domain: "automation",
    resetImpact: DATA_DOMAIN_DESCRIPTORS.automation.resetImpact,
    cleared: [
      `Stopped and removed ${stopped} automation monitor${stopped === 1 ? "" : "s"}.`,
      "Cleared automation run history."
    ]
  };
}

function resetRuntimeDomain(deps: DataDomainResetDeps): DataDomainResetResult {
  const io = deps.io ?? createDefaultDataDomainResetIo();
  const now = deps.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const snapshot = createRuntimeSnapshotFromReplay({ replay: null, observedAt });
  const marker = createRuntimeTurnMarker({ currentTurn: { state: "idle" }, observedAt });

  writeAtomic(
    io,
    createRuntimeSnapshotStatePath(deps.homeDir),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
  writeAtomic(
    io,
    createRuntimeTurnMarkerStatePath(deps.homeDir),
    `${JSON.stringify(marker, null, 2)}\n`
  );

  return {
    domain: "runtime",
    resetImpact: DATA_DOMAIN_DESCRIPTORS.runtime.resetImpact,
    cleared: [
      "Cleared the persisted runtime snapshot.",
      "Cleared the runtime turn marker."
    ]
  };
}

function writeAtomic(io: DataDomainResetIo, filePath: string, content: string): void {
  io.mkdir(path.dirname(filePath));
  if (io.rename) {
    const tempPath = `${filePath}.tmp-${Date.now()}`;
    io.writeFile(tempPath, content);
    io.rename(tempPath, filePath);
  } else {
    io.writeFile(filePath, content);
  }
}

export function createDefaultDataDomainResetIo(): DataDomainResetIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8"),
    rename: renameSync
  };
}
