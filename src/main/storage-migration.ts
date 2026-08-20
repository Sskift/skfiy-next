import path from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import type { DataDomain } from "../shared/data-export.js";

/**
 * Backup-before-migrate storage migrations. Every migratable file is copied
 * into `<baseDir>/backups/pre-migration-<timestamp>/` before a migration
 * runs, so a failed migration never destroys the previous local data — the
 * user can recover from the backup. Future-schema files are skipped, never
 * downgraded.
 */
export type StorageMigrationStatus = "current" | "migrated" | "skipped" | "failed" | "missing";

export interface StorageMigrationResult {
  domain: DataDomain;
  relativePath: string;
  status: StorageMigrationStatus;
  fromSchemaVersion?: number;
  toSchemaVersion: number;
  backupPath?: string;
  error?: string;
}

export interface StorageMigrationSummary {
  status: "current" | "migrated" | "failed";
  backupDir: string;
  results: StorageMigrationResult[];
}

export interface StorageMigrator {
  expectedSchemaVersion: number;
  migrate: (value: unknown, fromSchemaVersion: number) => unknown;
}

export interface StorageMigrationIo {
  exists: (targetPath: string) => boolean;
  mkdir: (targetPath: string) => void;
  readFile: (targetPath: string) => string;
  writeFile: (targetPath: string, content: string) => void;
  rename?: (fromPath: string, toPath: string) => void;
  rm?: (targetPath: string) => void;
  readdir?: (dirPath: string) => string[];
}

interface StorageMigrationFileSpec {
  domain: DataDomain;
  relativePath: string;
  expectedSchemaVersion: number;
}

const STORAGE_MIGRATION_FILES: readonly StorageMigrationFileSpec[] = [
  { domain: "profiles", relativePath: "profiles/profiles.json", expectedSchemaVersion: 1 },
  { domain: "personal-memory", relativePath: "memory/pending-memory-writes.json", expectedSchemaVersion: 1 },
  { domain: "sessions", relativePath: "memory/conversation-sessions.json", expectedSchemaVersion: 1 },
  { domain: "automation", relativePath: "automation-monitors.json", expectedSchemaVersion: 1 },
  { domain: "automation", relativePath: "automation-runs.json", expectedSchemaVersion: 1 },
  { domain: "runtime", relativePath: "runtime-snapshot.json", expectedSchemaVersion: 1 },
  { domain: "runtime", relativePath: "runtime-turn-marker.json", expectedSchemaVersion: 1 }
];

export const BACKUP_RETENTION_COUNT = 10;

export function runStorageMigrations({
  baseDir,
  io = createDefaultStorageMigrationIo(),
  now = () => new Date(),
  migrators = {}
}: {
  baseDir: string;
  io?: StorageMigrationIo;
  now?: () => Date;
  migrators?: Record<string, StorageMigrator>;
}): StorageMigrationSummary {
  const backupDir = path.join(
    baseDir,
    "backups",
    `pre-migration-${formatBackupTimestamp(now())}`
  );
  const results: StorageMigrationResult[] = [];

  for (const spec of STORAGE_MIGRATION_FILES) {
    results.push(migrateFile(spec, baseDir, backupDir, io, migrators));
  }

  pruneBackups(baseDir, io);

  const status: StorageMigrationSummary["status"] = results.some((r) => r.status === "failed")
    ? "failed"
    : results.some((r) => r.status === "migrated")
      ? "migrated"
      : "current";

  return { status, backupDir, results };
}

function migrateFile(
  spec: StorageMigrationFileSpec,
  baseDir: string,
  backupDir: string,
  io: StorageMigrationIo,
  migrators: Record<string, StorageMigrator>
): StorageMigrationResult {
  const filePath = path.join(baseDir, spec.relativePath);
  const result: StorageMigrationResult = {
    domain: spec.domain,
    relativePath: spec.relativePath,
    status: "missing",
    toSchemaVersion: spec.expectedSchemaVersion
  };
  if (!io.exists(filePath)) {
    return result;
  }

  const backupPath = path.join(backupDir, spec.relativePath);
  io.mkdir(path.dirname(backupPath));
  io.writeFile(backupPath, io.readFile(filePath));
  result.backupPath = backupPath;
  result.status = "current";

  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readFile(filePath));
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : "JSON parse failed.";
    return result;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    result.status = "failed";
    result.error = "Expected a JSON object.";
    return result;
  }
  const record = parsed as Record<string, unknown>;
  const schemaVersion = typeof record.schemaVersion === "number" ? record.schemaVersion : undefined;
  if (schemaVersion === undefined) {
    result.status = "failed";
    result.error = "Missing schemaVersion.";
    return result;
  }
  result.fromSchemaVersion = schemaVersion;
  if (schemaVersion === spec.expectedSchemaVersion) {
    return result;
  }
  if (schemaVersion > spec.expectedSchemaVersion) {
    result.status = "skipped";
    result.error = `Future schema ${schemaVersion}; skipping downgrade.`;
    return result;
  }

  const migrator = migrators[spec.relativePath];
  if (!migrator) {
    result.status = "failed";
    result.error = `No migrator registered for ${spec.relativePath}.`;
    return result;
  }

  let migrated: unknown;
  try {
    migrated = migrator.migrate(parsed, schemaVersion);
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : "Migration failed.";
    return result;
  }

  writeAtomic(io, filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  result.status = "migrated";
  return result;
}

export function pruneBackups(baseDir: string, io: StorageMigrationIo): void {
  const backupsDir = path.join(baseDir, "backups");
  if (!io.exists(backupsDir) || !io.readdir || !io.rm) {
    return;
  }
  const entries = io.readdir(backupsDir);
  for (const prefix of ["pre-migration-", "pre-restore-"]) {
    const matching = entries
      .filter((entry) => entry.startsWith(prefix))
      .sort()
      .reverse();
    for (const stale of matching.slice(BACKUP_RETENTION_COUNT)) {
      io.rm(path.join(backupsDir, stale));
    }
  }
}

function writeAtomic(io: StorageMigrationIo, filePath: string, content: string): void {
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

function createDefaultStorageMigrationIo(): StorageMigrationIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8"),
    rename: renameSync,
    rm: (targetPath) => rmSync(targetPath, { recursive: true, force: true }),
    readdir: (dirPath) => readdirSync(dirPath)
  };
}
