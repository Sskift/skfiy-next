import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import type { DataDomain } from "../shared/data-export.js";

/**
 * Generalizes the ConversationSessionStorageError model ("corrupt" |
 * "future-schema" | "write-failed") across every persisted file in the
 * app-support dir. Future-schema files are flagged, never silently
 * downgraded.
 */
export type StorageHealthStatus = "ok" | "missing" | "corrupt" | "future-schema";

export interface StorageFileHealth {
  domain: DataDomain;
  relativePath: string;
  status: StorageHealthStatus;
  schemaVersion?: number;
  expectedSchemaVersion?: number;
  error?: string;
}

export interface StorageHealthSummary {
  status: "ok" | "corrupt" | "future-schema";
  files: StorageFileHealth[];
  counts: {
    total: number;
    ok: number;
    missing: number;
    corrupt: number;
    futureSchema: number;
  };
  recoveryHint?: string;
}

export interface StorageHealthIo {
  exists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string;
}

interface StorageHealthFileSpec {
  domain: DataDomain;
  relativePath: string;
  kind: "json" | "jsonl" | "text";
  expectedSchemaVersion?: number;
}

const STORAGE_HEALTH_FILES: readonly StorageHealthFileSpec[] = [
  { domain: "profiles", relativePath: "profiles/profiles.json", kind: "json", expectedSchemaVersion: 1 },
  { domain: "personal-memory", relativePath: "memory/USER.md", kind: "text" },
  { domain: "personal-memory", relativePath: "memory/AGENT.md", kind: "text" },
  { domain: "personal-memory", relativePath: "memory/settings.json", kind: "json" },
  { domain: "personal-memory", relativePath: "memory/memory-journal.jsonl", kind: "jsonl" },
  { domain: "personal-memory", relativePath: "memory/pending-memory-writes.json", kind: "json", expectedSchemaVersion: 1 },
  { domain: "personal-memory", relativePath: "memory/personal-skills.json", kind: "json" },
  { domain: "sessions", relativePath: "memory/conversation-sessions.json", kind: "json", expectedSchemaVersion: 1 },
  { domain: "sessions", relativePath: "memory/sessions.jsonl", kind: "jsonl" },
  { domain: "automation", relativePath: "automation-monitors.json", kind: "json", expectedSchemaVersion: 1 },
  { domain: "automation", relativePath: "automation-runs.json", kind: "json", expectedSchemaVersion: 1 },
  { domain: "runtime", relativePath: "runtime-snapshot.json", kind: "json", expectedSchemaVersion: 1 },
  { domain: "runtime", relativePath: "runtime-turn-marker.json", kind: "json", expectedSchemaVersion: 1 }
];

export function readStorageHealth({
  baseDir,
  io = createDefaultStorageHealthIo()
}: {
  baseDir: string;
  io?: StorageHealthIo;
}): StorageHealthSummary {
  const files = STORAGE_HEALTH_FILES.map((spec) => checkFile(spec, baseDir, io));
  const counts = {
    total: files.length,
    ok: files.filter((file) => file.status === "ok").length,
    missing: files.filter((file) => file.status === "missing").length,
    corrupt: files.filter((file) => file.status === "corrupt").length,
    futureSchema: files.filter((file) => file.status === "future-schema").length
  };
  const status: StorageHealthSummary["status"] = counts.futureSchema > 0
    ? "future-schema"
    : counts.corrupt > 0
      ? "corrupt"
      : "ok";
  const recoveryHint = status === "ok"
    ? undefined
    : `Restore from a backup under ${path.join(baseDir, "backups")} or reset the affected domain in Settings → Data Admin.`;

  return { status, files, counts, ...(recoveryHint ? { recoveryHint } : {}) };
}

function checkFile(
  spec: StorageHealthFileSpec,
  baseDir: string,
  io: StorageHealthIo
): StorageFileHealth {
  const filePath = path.join(baseDir, spec.relativePath);
  const base: StorageFileHealth = {
    domain: spec.domain,
    relativePath: spec.relativePath,
    status: "missing",
    ...(spec.expectedSchemaVersion !== undefined
      ? { expectedSchemaVersion: spec.expectedSchemaVersion }
      : {})
  };
  if (!io.exists(filePath)) {
    return base;
  }

  const content = io.readFile(filePath);
  if (spec.kind === "text") {
    return { ...base, status: "ok" };
  }
  if (spec.kind === "jsonl") {
    const corruptLine = content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => {
        try {
          JSON.parse(line);
          return false;
        } catch {
          return true;
        }
      });
    return corruptLine
      ? { ...base, status: "corrupt", error: "Invalid JSON line in JSONL file." }
      : { ...base, status: "ok" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      ...base,
      status: "corrupt",
      error: error instanceof Error ? error.message : "JSON parse failed."
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...base, status: "corrupt", error: "Expected a JSON object." };
  }
  if (spec.expectedSchemaVersion === undefined) {
    return { ...base, status: "ok" };
  }
  const record = parsed as Record<string, unknown>;
  const schemaVersion = typeof record.schemaVersion === "number" ? record.schemaVersion : undefined;
  if (schemaVersion === undefined) {
    return { ...base, status: "corrupt", error: "Missing schemaVersion." };
  }
  if (schemaVersion > spec.expectedSchemaVersion) {
    return {
      ...base,
      status: "future-schema",
      schemaVersion,
      error: `File uses schema ${schemaVersion}; this app supports up to ${spec.expectedSchemaVersion}.`
    };
  }
  if (schemaVersion !== spec.expectedSchemaVersion) {
    return {
      ...base,
      status: "corrupt",
      schemaVersion,
      error: `Unsupported schema version ${schemaVersion}.`
    };
  }
  return { ...base, status: "ok", schemaVersion };
}

function createDefaultStorageHealthIo(): StorageHealthIo {
  return {
    exists: existsSync,
    readFile: (targetPath) => readFileSync(targetPath, "utf8")
  };
}
