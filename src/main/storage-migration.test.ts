import { describe, expect, it } from "vitest";

import {
  runStorageMigrations,
  BACKUP_RETENTION_COUNT,
  type StorageMigrationIo
} from "./storage-migration";

const BASE_DIR = "/app-support/skfiy";
const NOW = new Date("2026-08-20T12:00:00.000Z");

function createMemoryIo(initial: Record<string, string> = {}): StorageMigrationIo & {
  files: Record<string, string>;
  removed: string[];
} {
  const files: Record<string, string> = { ...initial };
  const removed: string[] = [];
  return {
    files,
    removed,
    exists: (targetPath) => Object.prototype.hasOwnProperty.call(files, targetPath)
      || Object.keys(files).some((key) => key.startsWith(`${targetPath}/`)),
    mkdir: () => undefined,
    readFile: (targetPath) => {
      const content = files[targetPath];
      if (content === undefined) {
        throw new Error(`Missing ${targetPath}`);
      }
      return content;
    },
    writeFile: (targetPath, content) => {
      files[targetPath] = content;
    },
    rename: (fromPath, toPath) => {
      files[toPath] = files[fromPath] ?? "";
      delete files[fromPath];
    },
    rm: (targetPath) => {
      removed.push(targetPath);
      for (const key of Object.keys(files)) {
        if (key === targetPath || key.startsWith(`${targetPath}/`)) {
          delete files[key];
        }
      }
    },
    readdir: (dirPath) =>
      Object.keys(files)
        .filter((key) => key.startsWith(`${dirPath}/`))
        .map((key) => key.slice(dirPath.length + 1).split("/")[0])
        .filter((entry, index, all) => all.indexOf(entry) === index)
  };
}

function seedFile(io: StorageMigrationIo & { files: Record<string, string> }, relativePath: string, schemaVersion: number): void {
  io.files[`${BASE_DIR}/${relativePath}`] = JSON.stringify({
    schemaVersion,
    payload: `v${schemaVersion}`
  });
}

describe("storage migration", () => {
  it("backs up every migratable file before migrating", () => {
    const io = createMemoryIo();
    seedFile(io, "profiles/profiles.json", 1);

    const summary = runStorageMigrations({ baseDir: BASE_DIR, io, now: () => NOW });

    expect(summary.backupDir).toContain("pre-migration-");
    const backupPath = `${summary.backupDir}/profiles/profiles.json`;
    expect(io.files[backupPath]).toBeDefined();
    expect(JSON.parse(io.files[backupPath]).schemaVersion).toBe(1);
  });

  it("migrates a file and writes the new schema version, preserving the backup", () => {
    const io = createMemoryIo();
    seedFile(io, "profiles/profiles.json", 0);
    const summary = runStorageMigrations({
      baseDir: BASE_DIR,
      io,
      now: () => NOW,
      migrators: {
        "profiles/profiles.json": {
          expectedSchemaVersion: 1,
          migrate: (value) => ({ ...(value as object), schemaVersion: 1, migrated: true })
        }
      }
    });

    expect(summary.status).toBe("migrated");
    const result = summary.results.find((r) => r.relativePath === "profiles/profiles.json");
    expect(result?.status).toBe("migrated");
    expect(result?.fromSchemaVersion).toBe(0);
    expect(result?.toSchemaVersion).toBe(1);
    const migrated = JSON.parse(io.files[`${BASE_DIR}/profiles/profiles.json`]);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.migrated).toBe(true);
    expect(io.files[`${summary.backupDir}/profiles/profiles.json`]).toBeDefined();
  });

  it("leaves the original file untouched when migration fails, preserving the backup", () => {
    const io = createMemoryIo();
    seedFile(io, "profiles/profiles.json", 0);
    const original = io.files[`${BASE_DIR}/profiles/profiles.json`];
    const summary = runStorageMigrations({
      baseDir: BASE_DIR,
      io,
      now: () => NOW,
      migrators: {
        "profiles/profiles.json": {
          expectedSchemaVersion: 1,
          migrate: () => {
            throw new Error("migration boom");
          }
        }
      }
    });

    expect(summary.status).toBe("failed");
    const result = summary.results.find((r) => r.relativePath === "profiles/profiles.json");
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("migration boom");
    expect(result?.backupPath).toBeDefined();
    expect(io.files[`${BASE_DIR}/profiles/profiles.json`]).toBe(original);
    expect(io.files[`${result?.backupPath}`]).toBe(original);
  });

  it("skips future-schema files instead of downgrading them", () => {
    const io = createMemoryIo();
    seedFile(io, "profiles/profiles.json", 9);
    const summary = runStorageMigrations({ baseDir: BASE_DIR, io, now: () => NOW });

    const result = summary.results.find((r) => r.relativePath === "profiles/profiles.json");
    expect(result?.status).toBe("skipped");
    expect(JSON.parse(io.files[`${BASE_DIR}/profiles/profiles.json`]).schemaVersion).toBe(9);
  });

  it("treats a current-schema file as a no-op", () => {
    const io = createMemoryIo();
    seedFile(io, "profiles/profiles.json", 1);
    const summary = runStorageMigrations({ baseDir: BASE_DIR, io, now: () => NOW });

    const result = summary.results.find((r) => r.relativePath === "profiles/profiles.json");
    expect(result?.status).toBe("current");
    expect(summary.status).toBe("current");
  });

  it("marks missing files as missing", () => {
    const io = createMemoryIo();
    const summary = runStorageMigrations({ baseDir: BASE_DIR, io, now: () => NOW });

    expect(summary.results.every((r) => r.status === "missing")).toBe(true);
    expect(summary.status).toBe("current");
  });

  it("fails on a corrupt file without overwriting it", () => {
    const io = createMemoryIo();
    io.files[`${BASE_DIR}/profiles/profiles.json`] = "not json";
    const summary = runStorageMigrations({ baseDir: BASE_DIR, io, now: () => NOW });

    const result = summary.results.find((r) => r.relativePath === "profiles/profiles.json");
    expect(result?.status).toBe("failed");
    expect(io.files[`${BASE_DIR}/profiles/profiles.json`]).toBe("not json");
  });

  it("prunes old backups, keeping the most recent ones", () => {
    const io = createMemoryIo();
    for (let i = 0; i < BACKUP_RETENTION_COUNT + 5; i += 1) {
      const dir = `${BASE_DIR}/backups/pre-migration-2026-08-${String(10 + i).padStart(2, "0")}T00-00-00-000Z`;
      io.files[`${dir}/profiles/profiles.json`] = "{}";
    }

    runStorageMigrations({ baseDir: BASE_DIR, io, now: () => NOW });

    const remainingBackups = io.removed.filter((path) => path.includes("pre-migration-"));
    expect(remainingBackups).toHaveLength(5);
    const kept = Object.keys(io.files).filter((key) => key.includes("pre-migration-"));
    const uniqueKept = new Set(kept.map((key) => key.split("/backups/")[1]?.split("/")[0]));
    expect(uniqueKept.size).toBe(BACKUP_RETENTION_COUNT);
  });
});
