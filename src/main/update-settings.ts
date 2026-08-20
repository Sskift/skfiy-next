/**
 * Update settings — global (not profile-scoped) updater preferences.
 *
 * Persistence follows the JSON-file store pattern under the skfiy app-support
 * directory: update-settings.json written atomically (tmp + rename) with
 * mkdir -p. The factory mirrors createAssistantAgentSettingsStore: an
 * in-memory store seeded from env, optionally persisted on every set.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import {
  isUpdateChannel,
  type UpdateChannel,
  type UpdateSettings,
  type UpdateSettingsUpdate
} from "../shared/update.js";

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  autoCheck: true,
  channel: "stable"
};

export interface UpdateSettingsEnv {
  SKFIY_UPDATE_AUTO_CHECK?: string;
  SKFIY_UPDATE_CHANNEL?: string;
}

export function readInitialUpdateSettings(env: UpdateSettingsEnv = {}): UpdateSettings {
  const autoCheck = env.SKFIY_UPDATE_AUTO_CHECK === undefined
    ? DEFAULT_UPDATE_SETTINGS.autoCheck
    : env.SKFIY_UPDATE_AUTO_CHECK !== "0";
  const channel: UpdateChannel = env.SKFIY_UPDATE_CHANNEL === "beta" ? "beta" : "stable";
  return { autoCheck, channel };
}

/**
 * Coerce an unknown JSON value into UpdateSettings, dropping unknown fields
 * and falling back to defaults for invalid ones.
 */
export function coerceUpdateSettings(value: unknown): UpdateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_UPDATE_SETTINGS };
  }
  const record = value as Record<string, unknown>;
  const settings: UpdateSettings = {
    autoCheck: typeof record.autoCheck === "boolean"
      ? record.autoCheck
      : DEFAULT_UPDATE_SETTINGS.autoCheck,
    channel: isUpdateChannel(record.channel) ? record.channel : DEFAULT_UPDATE_SETTINGS.channel
  };
  if (typeof record.skippedVersion === "string" && record.skippedVersion.length > 0) {
    settings.skippedVersion = record.skippedVersion;
  }
  if (typeof record.lastCheckAt === "string" && record.lastCheckAt.length > 0) {
    settings.lastCheckAt = record.lastCheckAt;
  }
  if (
    typeof record.lastNotifiedVersion === "string"
    && record.lastNotifiedVersion.length > 0
  ) {
    settings.lastNotifiedVersion = record.lastNotifiedVersion;
  }
  return settings;
}

export function readUpdateSettingsUpdate(value: unknown): UpdateSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const update: UpdateSettingsUpdate = {};
  if (typeof record.autoCheck === "boolean") {
    update.autoCheck = record.autoCheck;
  }
  if (isUpdateChannel(record.channel)) {
    update.channel = record.channel;
  }
  if (record.skippedVersion === null) {
    update.skippedVersion = null;
  } else if (typeof record.skippedVersion === "string" && record.skippedVersion.length > 0) {
    update.skippedVersion = record.skippedVersion;
  }
  if (typeof record.lastCheckAt === "string") {
    update.lastCheckAt = record.lastCheckAt;
  }
  if (typeof record.lastNotifiedVersion === "string") {
    update.lastNotifiedVersion = record.lastNotifiedVersion;
  }
  return update;
}

export function applyUpdateSettings(
  current: UpdateSettings,
  update: UpdateSettingsUpdate
): UpdateSettings {
  const next: UpdateSettings = {
    ...current,
    ...(update.autoCheck === undefined ? {} : { autoCheck: update.autoCheck }),
    ...(update.channel === undefined ? {} : { channel: update.channel })
  };
  if (update.skippedVersion === null) {
    delete next.skippedVersion;
  } else if (update.skippedVersion !== undefined) {
    next.skippedVersion = update.skippedVersion;
  }
  if (update.lastCheckAt !== undefined) {
    next.lastCheckAt = update.lastCheckAt;
  }
  if (update.lastNotifiedVersion !== undefined) {
    next.lastNotifiedVersion = update.lastNotifiedVersion;
  }
  return next;
}

export interface UpdateSettingsIo {
  mkdir: (targetPath: string) => void;
  writeFile: (targetPath: string, content: string) => void;
  rename: (fromPath: string, toPath: string) => void;
}

export interface UpdateSettingsStore {
  get(): UpdateSettings;
  set(update: UpdateSettingsUpdate): UpdateSettings;
}

/**
 * In-memory settings store with optional atomic JSON persistence. When
 * filePath is provided every set() is written as tmp + rename so a crash
 * mid-write never leaves a corrupt settings file.
 */
export function createUpdateSettingsStore(
  initialSettings: UpdateSettings,
  options: { filePath?: string; io?: UpdateSettingsIo } = {}
): UpdateSettingsStore {
  let settings = coerceUpdateSettings(initialSettings);
  const io = options.io ?? createDefaultUpdateSettingsIo();

  return {
    get(): UpdateSettings {
      return settings;
    },
    set(update: UpdateSettingsUpdate): UpdateSettings {
      settings = applyUpdateSettings(settings, update);
      if (options.filePath) {
        persistUpdateSettings(options.filePath, settings, io);
      }
      return settings;
    }
  };
}

/** Load persisted settings, falling back to the provided seed. */
export function loadPersistedUpdateSettings(
  filePath: string,
  fallback: UpdateSettings,
  io: { readFile?: (targetPath: string) => string; exists?: (targetPath: string) => boolean } = {}
): UpdateSettings {
  const exists = io.exists ?? ((targetPath: string) => existsSync(targetPath));
  const readFile = io.readFile ?? ((targetPath: string) => readFileSync(targetPath, "utf8"));
  if (!exists(filePath)) {
    return { ...fallback };
  }
  try {
    return coerceUpdateSettings(JSON.parse(readFile(filePath)) as unknown);
  } catch {
    return { ...fallback };
  }
}

function persistUpdateSettings(
  filePath: string,
  settings: UpdateSettings,
  io: UpdateSettingsIo
): void {
  const lastSlash = filePath.lastIndexOf("/");
  const directory = lastSlash > 0 ? filePath.slice(0, lastSlash) : ".";
  io.mkdir(directory);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  io.writeFile(tmpPath, `${JSON.stringify(settings, null, 2)}\n`);
  io.rename(tmpPath, filePath);
}

function createDefaultUpdateSettingsIo(): UpdateSettingsIo {
  return {
    mkdir: (targetPath: string) => {
      mkdirSync(targetPath, { recursive: true });
    },
    writeFile: (targetPath: string, content: string) => {
      writeFileSync(targetPath, content, "utf8");
    },
    rename: (fromPath: string, toPath: string) => {
      renameSync(fromPath, toPath);
    }
  };
}
