/**
 * Wire format for the unified local data export bundle. Mirrors the
 * profile-export pattern: a schema-versioned, plain-JSON bundle that is
 * strictly validated on parse, sanitized/capped/deduped on build, and
 * inspectable (deterministic key order, a `domains` declaration, and a
 * `redaction` block reporting what was scrubbed).
 *
 * The domain payload types are declared here (not reused from the main-side
 * stores) so the export format stays decoupled from internal storage shapes.
 */

import type { Profile } from "./profile.js";
import type { ConversationSession } from "./conversation-history.js";
import type { RouteOutcome } from "./route-outcome.js";

export const DATA_EXPORT_SCHEMA_VERSION = 1;
export const DATA_EXPORT_EXPORTER_APP = "skfiy";

export type DataDomain = "profiles" | "personal-memory" | "sessions" | "automation" | "runtime";

export const DATA_DOMAINS: readonly DataDomain[] = [
  "profiles",
  "personal-memory",
  "sessions",
  "automation",
  "runtime"
];

export function isDataDomain(value: unknown): value is DataDomain {
  return value === "profiles"
    || value === "personal-memory"
    || value === "sessions"
    || value === "automation"
    || value === "runtime";
}

export interface DataExportRedaction {
  patterns: string[];
  entriesRedacted: number;
}

export interface DataExportProfiles {
  activeProfileId: string;
  profiles: Profile[];
}

export interface DataExportPersonalMemorySettings {
  postTurnLearningEnabled: boolean;
  writeApprovalEnabled: boolean;
}

export interface DataExportPersonalSkillSettings {
  disabledSkillIds: string[];
  updatedAt?: string;
}

export interface DataExportPersonalMemory {
  scope: "shared" | "isolated";
  profileId?: string;
  userEntries: string[];
  agentEntries: string[];
  settings?: DataExportPersonalMemorySettings;
  skills?: DataExportPersonalSkillSettings;
}

export interface DataExportSessions {
  conversations: ConversationSession[];
}

export interface DataExportAutomationMonitorPreviewConcurrency {
  policy: string;
  max: number;
}

export interface DataExportAutomationMonitorPreviewRetry {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface DataExportAutomationMonitorPreview {
  adapter: string;
  triggerModes: string[];
  target: { kind: string; sessionName: string };
  requiredPermissions: string[];
  readWriteBehavior: string;
  approvalMode: string;
  timeoutMs: number;
  verification: string;
  mutatesSession: boolean;
  concurrency?: DataExportAutomationMonitorPreviewConcurrency;
  retry?: DataExportAutomationMonitorPreviewRetry;
  runTtlMs?: number;
}

export interface DataExportAutomationMonitor {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  triggerMode: string;
  sessionName: string;
  preview: DataExportAutomationMonitorPreview;
  concurrencyPolicy: string;
  maxConcurrency: number;
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  runTtlMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportAutomation {
  monitors: DataExportAutomationMonitor[];
}

export interface DataExportRuntimeSnapshot {
  schemaVersion: number;
  observedAt: string;
  currentTurn: Record<string, unknown>;
  routeOutcome: RouteOutcome;
  replay: Record<string, unknown>;
}

export interface DataExportRuntime {
  snapshot?: DataExportRuntimeSnapshot;
}

export interface DataExportBundle {
  schemaVersion: typeof DATA_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  exporter: { app: typeof DATA_EXPORT_EXPORTER_APP; version: string };
  domains: DataDomain[];
  profiles?: DataExportProfiles;
  personalMemory?: DataExportPersonalMemory;
  sessions?: DataExportSessions;
  automation?: DataExportAutomation;
  runtime?: DataExportRuntime;
  redaction: DataExportRedaction;
}

/**
 * Shallow structural guard for the renderer/preload boundary. Deep
 * validation of every domain payload is parseDataExportBundle's job in the
 * main process; this guard only proves the envelope is well-formed.
 */
export function isDataExportBundle(value: unknown): value is DataExportBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== DATA_EXPORT_SCHEMA_VERSION) {
    return false;
  }
  if (typeof record.exportedAt !== "string" || record.exportedAt.length === 0) {
    return false;
  }
  if (!record.exporter || typeof record.exporter !== "object" || Array.isArray(record.exporter)) {
    return false;
  }
  const exporter = record.exporter as Record<string, unknown>;
  if (exporter.app !== DATA_EXPORT_EXPORTER_APP || typeof exporter.version !== "string") {
    return false;
  }
  if (!Array.isArray(record.domains) || !record.domains.every(isDataDomain)) {
    return false;
  }
  if (!record.redaction || typeof record.redaction !== "object" || Array.isArray(record.redaction)) {
    return false;
  }
  const redaction = record.redaction as Record<string, unknown>;
  return Array.isArray(redaction.patterns)
    && redaction.patterns.every((pattern) => typeof pattern === "string")
    && typeof redaction.entriesRedacted === "number";
}
