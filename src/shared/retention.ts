/**
 * Retention settings for local data that can grow without bound: turn replay
 * summaries, Computer Use screenshots in the temp dir, and automation run
 * history. Persisted at `<baseDir>/retention-settings.json`.
 *
 * The run-history defaults mirror the hardcoded caps in automation-run.ts
 * (AUTOMATION_RUN_PER_MONITOR_CAP / AUTOMATION_RUN_GLOBAL_CAP) so behavior is
 * unchanged until the user customizes them.
 */

export const RETENTION_SCHEMA_VERSION = 1;

export interface RetentionReplaySettings {
  enabled: boolean;
  maxTurns: number;
  maxAgeDays: number;
}

export interface RetentionScreenshotsSettings {
  enabled: boolean;
  maxCount: number;
  maxAgeDays: number;
}

export interface RetentionRunHistorySettings {
  enabled: boolean;
  perMonitorCap: number;
  globalCap: number;
  maxAgeDays: number;
}

export interface RetentionSettings {
  schemaVersion: typeof RETENTION_SCHEMA_VERSION;
  replay: RetentionReplaySettings;
  screenshots: RetentionScreenshotsSettings;
  runHistory: RetentionRunHistorySettings;
}

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  schemaVersion: RETENTION_SCHEMA_VERSION,
  replay: { enabled: true, maxTurns: 50, maxAgeDays: 30 },
  screenshots: { enabled: true, maxCount: 200, maxAgeDays: 14 },
  runHistory: { enabled: true, perMonitorCap: 20, globalCap: 200, maxAgeDays: 90 }
};

export interface RetentionSettingsUpdate {
  replay?: Partial<RetentionReplaySettings>;
  screenshots?: Partial<RetentionScreenshotsSettings>;
  runHistory?: Partial<RetentionRunHistorySettings>;
}

const LIMITS = {
  replayMaxTurns: { min: 1, max: 1_000 },
  replayMaxAgeDays: { min: 1, max: 3_650 },
  screenshotsMaxCount: { min: 1, max: 10_000 },
  screenshotsMaxAgeDays: { min: 1, max: 3_650 },
  runHistoryPerMonitorCap: { min: 1, max: 500 },
  runHistoryGlobalCap: { min: 1, max: 5_000 },
  runHistoryMaxAgeDays: { min: 1, max: 3_650 }
} as const;

export function normalizeRetentionSettings(value: unknown): RetentionSettings {
  const defaults = DEFAULT_RETENTION_SETTINGS;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return cloneDefaultRetentionSettings();
  }

  const record = value as Record<string, unknown>;
  return {
    schemaVersion: RETENTION_SCHEMA_VERSION,
    replay: normalizeReplaySettings(record.replay, defaults.replay),
    screenshots: normalizeScreenshotsSettings(record.screenshots, defaults.screenshots),
    runHistory: normalizeRunHistorySettings(record.runHistory, defaults.runHistory)
  };
}

export function isRetentionSettings(value: unknown): value is RetentionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.schemaVersion === RETENTION_SCHEMA_VERSION
    && isReplaySettings(record.replay)
    && isScreenshotsSettings(record.screenshots)
    && isRunHistorySettings(record.runHistory);
}

export function normalizeRetentionSettingsUpdate(value: unknown): RetentionSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const update: RetentionSettingsUpdate = {};
  if (record.replay && typeof record.replay === "object" && !Array.isArray(record.replay)) {
    update.replay = normalizeReplayUpdate(record.replay as Record<string, unknown>);
  }
  if (record.screenshots && typeof record.screenshots === "object" && !Array.isArray(record.screenshots)) {
    update.screenshots = normalizeScreenshotsUpdate(record.screenshots as Record<string, unknown>);
  }
  if (record.runHistory && typeof record.runHistory === "object" && !Array.isArray(record.runHistory)) {
    update.runHistory = normalizeRunHistoryUpdate(record.runHistory as Record<string, unknown>);
  }
  return update;
}

function normalizeReplaySettings(
  value: unknown,
  fallback: RetentionReplaySettings
): RetentionReplaySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    maxTurns: clampInteger(record.maxTurns, fallback.maxTurns, LIMITS.replayMaxTurns),
    maxAgeDays: clampInteger(record.maxAgeDays, fallback.maxAgeDays, LIMITS.replayMaxAgeDays)
  };
}

function normalizeScreenshotsSettings(
  value: unknown,
  fallback: RetentionScreenshotsSettings
): RetentionScreenshotsSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    maxCount: clampInteger(record.maxCount, fallback.maxCount, LIMITS.screenshotsMaxCount),
    maxAgeDays: clampInteger(record.maxAgeDays, fallback.maxAgeDays, LIMITS.screenshotsMaxAgeDays)
  };
}

function normalizeRunHistorySettings(
  value: unknown,
  fallback: RetentionRunHistorySettings
): RetentionRunHistorySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    perMonitorCap: clampInteger(record.perMonitorCap, fallback.perMonitorCap, LIMITS.runHistoryPerMonitorCap),
    globalCap: clampInteger(record.globalCap, fallback.globalCap, LIMITS.runHistoryGlobalCap),
    maxAgeDays: clampInteger(record.maxAgeDays, fallback.maxAgeDays, LIMITS.runHistoryMaxAgeDays)
  };
}

function normalizeReplayUpdate(record: Record<string, unknown>): Partial<RetentionReplaySettings> {
  const update: Partial<RetentionReplaySettings> = {};
  if (typeof record.enabled === "boolean") {
    update.enabled = record.enabled;
  }
  if (record.maxTurns !== undefined) {
    update.maxTurns = clampInteger(record.maxTurns, DEFAULT_RETENTION_SETTINGS.replay.maxTurns, LIMITS.replayMaxTurns);
  }
  if (record.maxAgeDays !== undefined) {
    update.maxAgeDays = clampInteger(record.maxAgeDays, DEFAULT_RETENTION_SETTINGS.replay.maxAgeDays, LIMITS.replayMaxAgeDays);
  }
  return update;
}

function normalizeScreenshotsUpdate(
  record: Record<string, unknown>
): Partial<RetentionScreenshotsSettings> {
  const update: Partial<RetentionScreenshotsSettings> = {};
  if (typeof record.enabled === "boolean") {
    update.enabled = record.enabled;
  }
  if (record.maxCount !== undefined) {
    update.maxCount = clampInteger(record.maxCount, DEFAULT_RETENTION_SETTINGS.screenshots.maxCount, LIMITS.screenshotsMaxCount);
  }
  if (record.maxAgeDays !== undefined) {
    update.maxAgeDays = clampInteger(record.maxAgeDays, DEFAULT_RETENTION_SETTINGS.screenshots.maxAgeDays, LIMITS.screenshotsMaxAgeDays);
  }
  return update;
}

function normalizeRunHistoryUpdate(
  record: Record<string, unknown>
): Partial<RetentionRunHistorySettings> {
  const update: Partial<RetentionRunHistorySettings> = {};
  if (typeof record.enabled === "boolean") {
    update.enabled = record.enabled;
  }
  if (record.perMonitorCap !== undefined) {
    update.perMonitorCap = clampInteger(
      record.perMonitorCap,
      DEFAULT_RETENTION_SETTINGS.runHistory.perMonitorCap,
      LIMITS.runHistoryPerMonitorCap
    );
  }
  if (record.globalCap !== undefined) {
    update.globalCap = clampInteger(
      record.globalCap,
      DEFAULT_RETENTION_SETTINGS.runHistory.globalCap,
      LIMITS.runHistoryGlobalCap
    );
  }
  if (record.maxAgeDays !== undefined) {
    update.maxAgeDays = clampInteger(
      record.maxAgeDays,
      DEFAULT_RETENTION_SETTINGS.runHistory.maxAgeDays,
      LIMITS.runHistoryMaxAgeDays
    );
  }
  return update;
}

function isReplaySettings(value: unknown): value is RetentionReplaySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.enabled === "boolean"
    && isFiniteInteger(record.maxTurns)
    && isFiniteInteger(record.maxAgeDays);
}

function isScreenshotsSettings(value: unknown): value is RetentionScreenshotsSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.enabled === "boolean"
    && isFiniteInteger(record.maxCount)
    && isFiniteInteger(record.maxAgeDays);
}

function isRunHistorySettings(value: unknown): value is RetentionRunHistorySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.enabled === "boolean"
    && isFiniteInteger(record.perMonitorCap)
    && isFiniteInteger(record.globalCap)
    && isFiniteInteger(record.maxAgeDays);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function clampInteger(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

function cloneDefaultRetentionSettings(): RetentionSettings {
  return JSON.parse(JSON.stringify(DEFAULT_RETENTION_SETTINGS)) as RetentionSettings;
}
