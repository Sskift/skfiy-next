import {
  createPersonalMemoryStore,
  readPersonalMemorySnapshot,
  type PersonalMemoryTarget,
  type PersonalMemoryUsage
} from "./personal-memory.js";
import {
  createPendingPersonalMemoryStore,
  readPendingPersonalMemoryWrites,
  type PendingPersonalMemoryWrite
} from "./personal-memory-pending.js";
import {
  readPersonalMemoryJournalEntries,
  type PersonalMemoryJournalEntry
} from "./personal-memory-journal.js";
import {
  readPersonalMemorySettings,
  type PersonalMemorySettings
} from "./personal-memory-settings.js";
import { readSessionMemoryRecords } from "./session-memory.js";

export interface PersonalMemoryDashboardSnapshot {
  schemaVersion: 1;
  userEntries: string[];
  agentEntries: string[];
  usage: PersonalMemoryUsage;
  pendingWrites: PendingPersonalMemoryWrite[];
  journal: PersonalMemoryJournalEntry[];
  sessionCount: number;
  latestUpdatedAt?: string;
  settings: PersonalMemorySettings;
}

export interface PersonalMemoryDashboardIo {
  exists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string;
  mkdir: (targetPath: string) => void;
  writeFile: (targetPath: string, content: string) => void;
  stat?: (targetPath: string) => { mtimeMs: number };
}

export interface PersonalMemoryDashboardReadOptions {
  baseDir: string;
  io?: PersonalMemoryDashboardIo;
  env?: Record<string, string | undefined>;
}

export type PersonalMemoryForgetResult =
  | { result: "forgotten"; snapshot: PersonalMemoryDashboardSnapshot }
  | { result: "not-found"; snapshot: PersonalMemoryDashboardSnapshot };

export type PersonalMemoryPendingApprovalResult =
  | {
    result: "approved";
    applied: number;
    ignored: number;
    blocked: number;
    snapshot: PersonalMemoryDashboardSnapshot;
  }
  | { result: "not-found"; snapshot: PersonalMemoryDashboardSnapshot };

export type PersonalMemoryPendingRejectResult =
  | { result: "rejected"; snapshot: PersonalMemoryDashboardSnapshot }
  | { result: "not-found"; snapshot: PersonalMemoryDashboardSnapshot };

const MAX_DASHBOARD_PENDING_WRITES = 20;
const MAX_DASHBOARD_JOURNAL_ENTRIES = 20;

export function readPersonalMemoryDashboardSnapshot({
  baseDir,
  io,
  env
}: PersonalMemoryDashboardReadOptions): PersonalMemoryDashboardSnapshot {
  const memory = readPersonalMemorySnapshot({ baseDir, io });
  const pendingWrites = readPendingPersonalMemoryWrites({ baseDir, io })
    .slice(-MAX_DASHBOARD_PENDING_WRITES)
    .reverse();
  const journal = readPersonalMemoryJournalEntries({ baseDir, io })
    .slice(-MAX_DASHBOARD_JOURNAL_ENTRIES)
    .reverse();
  const sessionCount = readSessionMemoryRecords({ baseDir, io }).length;
  const settings = readPersonalMemorySettings({ baseDir, io, env });

  return {
    schemaVersion: 1,
    userEntries: memory.userEntries,
    agentEntries: memory.agentEntries,
    usage: memory.usage ?? createEmptyPersonalMemoryUsage(),
    pendingWrites,
    journal,
    sessionCount,
    ...(memory.latestUpdatedAt ? { latestUpdatedAt: memory.latestUpdatedAt } : {}),
    settings
  };
}

export function forgetPersonalMemoryEntry({
  baseDir,
  target,
  content,
  io,
  env
}: PersonalMemoryDashboardReadOptions & {
  target: PersonalMemoryTarget;
  content: string;
}): PersonalMemoryForgetResult {
  const store = createPersonalMemoryStore({ baseDir, io });
  const result = store.applyOperations([{ action: "remove", target, content }]);

  return {
    result: result.applied > 0 ? "forgotten" : "not-found",
    snapshot: readPersonalMemoryDashboardSnapshot({ baseDir, io, env })
  };
}

export function approvePendingPersonalMemoryWrite({
  baseDir,
  pendingId,
  io,
  env
}: PersonalMemoryDashboardReadOptions & {
  pendingId: string;
}): PersonalMemoryPendingApprovalResult {
  const memoryStore = createPersonalMemoryStore({ baseDir, io });
  const pendingStore = createPendingPersonalMemoryStore({ baseDir, io });
  const result = pendingStore.approve(pendingId, memoryStore);
  const snapshot = readPersonalMemoryDashboardSnapshot({ baseDir, io, env });
  if (result.result === "not-found") {
    return { result: "not-found", snapshot };
  }

  return {
    result: "approved",
    applied: result.applied,
    ignored: result.ignored,
    blocked: result.blocked,
    snapshot
  };
}

export function rejectPendingPersonalMemoryWrite({
  baseDir,
  pendingId,
  io,
  env
}: PersonalMemoryDashboardReadOptions & {
  pendingId: string;
}): PersonalMemoryPendingRejectResult {
  const pendingStore = createPendingPersonalMemoryStore({ baseDir, io });
  const result = pendingStore.reject(pendingId);

  return {
    result: result.result,
    snapshot: readPersonalMemoryDashboardSnapshot({ baseDir, io, env })
  };
}

export function readPersonalMemoryForgetRequest(
  value: unknown
): { target: PersonalMemoryTarget; content: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const target = record.target === "user" || record.target === "agent"
    ? record.target
    : undefined;
  const content = typeof record.content === "string" && record.content.trim().length > 0
    ? record.content
    : undefined;

  return target && content ? { target, content } : undefined;
}

export function readPendingMemoryActionRequest(
  value: unknown
): { pendingId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const pendingId = typeof record.pendingId === "string" && record.pendingId.trim().length > 0
    ? record.pendingId
    : undefined;

  return pendingId ? { pendingId } : undefined;
}

function createEmptyPersonalMemoryUsage(): PersonalMemoryUsage {
  return {
    user: { usedChars: 0, limitChars: 0, percent: 0 },
    agent: { usedChars: 0, limitChars: 0, percent: 0 }
  };
}
