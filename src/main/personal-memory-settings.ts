import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPersonalMemoryRootPath } from "./personal-memory.js";
import { isEnabledEnvFlag } from "./main-ipc-payload.js";

export interface PersonalMemorySettings {
  postTurnLearningEnabled: boolean;
  writeApprovalEnabled: boolean;
}

export interface PersonalMemorySettingsUpdate {
  postTurnLearningEnabled?: boolean;
  writeApprovalEnabled?: boolean;
}

export interface PersonalMemorySettingsReadIo {
  exists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string;
}

export interface PersonalMemorySettingsIo extends PersonalMemorySettingsReadIo {
  mkdir: (targetPath: string) => void;
  writeFile: (targetPath: string, content: string) => void;
}

export interface PersonalMemorySettingsStoreOptions {
  baseDir: string;
  io?: PersonalMemorySettingsIo;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

export const PERSONAL_MEMORY_WRITE_APPROVAL_ENV = "SKFIY_PERSONAL_MEMORY_WRITE_APPROVAL";

interface PersistedPersonalMemorySettings extends PersonalMemorySettings {
  updatedAt?: string;
}

export function createPersonalMemorySettingsFilePath(baseDir: string): string {
  return path.join(createPersonalMemoryRootPath(baseDir), "settings.json");
}

export function readPersonalMemorySettings({
  baseDir,
  io = createDefaultPersonalMemorySettingsIo(),
  env = process.env
}: {
  baseDir: string;
  io?: PersonalMemorySettingsReadIo;
  env?: Record<string, string | undefined>;
}): PersonalMemorySettings {
  return applyWriteApprovalEnv(readPersistedPersonalMemorySettings({ baseDir, io }), env);
}

export function createPersonalMemorySettingsStore({
  baseDir,
  io = createDefaultPersonalMemorySettingsIo(),
  now = () => new Date(),
  env = process.env
}: PersonalMemorySettingsStoreOptions) {
  return {
    read(): PersonalMemorySettings {
      return readPersonalMemorySettings({ baseDir, io, env });
    },
    update(update: PersonalMemorySettingsUpdate): PersonalMemorySettings {
      const current = readPersistedPersonalMemorySettings({ baseDir, io });
      const next = normalizePersistedPersonalMemorySettings({
        postTurnLearningEnabled: update.postTurnLearningEnabled ?? current.postTurnLearningEnabled,
        writeApprovalEnabled: update.writeApprovalEnabled ?? current.writeApprovalEnabled
      });
      writePersonalMemorySettings(baseDir, {
        ...next,
        updatedAt: now().toISOString()
      }, io);
      return applyWriteApprovalEnv(next, env);
    }
  };
}

export function readPersonalMemorySettingsUpdate(value: unknown): PersonalMemorySettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.postTurnLearningEnabled === "boolean"
      ? { postTurnLearningEnabled: record.postTurnLearningEnabled }
      : {}),
    ...(typeof record.writeApprovalEnabled === "boolean"
      ? { writeApprovalEnabled: record.writeApprovalEnabled }
      : {})
  };
}

function readPersistedPersonalMemorySettings({
  baseDir,
  io
}: {
  baseDir: string;
  io: PersonalMemorySettingsReadIo;
}): PersonalMemorySettings {
  const filePath = createPersonalMemorySettingsFilePath(baseDir);
  if (!io.exists(filePath)) {
    return createDefaultPersonalMemorySettings();
  }

  try {
    const parsed = JSON.parse(io.readFile(filePath)) as unknown;
    return normalizePersistedPersonalMemorySettings(parsed);
  } catch {
    return createDefaultPersonalMemorySettings();
  }
}

function writePersonalMemorySettings(
  baseDir: string,
  settings: PersistedPersonalMemorySettings,
  io: PersonalMemorySettingsIo
): void {
  const filePath = createPersonalMemorySettingsFilePath(baseDir);
  io.mkdir(path.dirname(filePath));
  io.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`);
}

function normalizePersistedPersonalMemorySettings(value: unknown): PersonalMemorySettings {
  const defaults = createDefaultPersonalMemorySettings();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const record = value as Record<string, unknown>;
  return {
    postTurnLearningEnabled: typeof record.postTurnLearningEnabled === "boolean"
      ? record.postTurnLearningEnabled
      : defaults.postTurnLearningEnabled,
    writeApprovalEnabled: typeof record.writeApprovalEnabled === "boolean"
      ? record.writeApprovalEnabled
      : defaults.writeApprovalEnabled
  };
}

function applyWriteApprovalEnv(
  settings: PersonalMemorySettings,
  env: Record<string, string | undefined>
): PersonalMemorySettings {
  return {
    ...settings,
    writeApprovalEnabled: settings.writeApprovalEnabled
      || isEnabledEnvFlag(env[PERSONAL_MEMORY_WRITE_APPROVAL_ENV])
  };
}

function createDefaultPersonalMemorySettings(): PersonalMemorySettings {
  return {
    postTurnLearningEnabled: true,
    writeApprovalEnabled: false
  };
}

function createDefaultPersonalMemorySettingsIo(): PersonalMemorySettingsIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8")
  };
}
