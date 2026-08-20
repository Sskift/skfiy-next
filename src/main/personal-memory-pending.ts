import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  PersonalMemoryIo,
  PersonalMemoryOperation
} from "./personal-memory.js";
import { createPersonalMemoryRootPath } from "./personal-memory.js";

export interface PendingPersonalMemoryWrite extends PersonalMemoryOperation {
  id: string;
  createdAt: string;
  source: "post-turn-review" | "dashboard" | string;
}

export interface PendingPersonalMemoryStoreOptions {
  baseDir: string;
  io?: PendingPersonalMemoryIo;
  now?: () => Date;
}

export interface PendingPersonalMemoryReadIo {
  exists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string;
}

export interface PendingPersonalMemoryIo extends PendingPersonalMemoryReadIo {
  mkdir: (targetPath: string) => void;
  writeFile: (targetPath: string, content: string) => void;
}

export interface PendingPersonalMemoryStageOptions {
  source?: PendingPersonalMemoryWrite["source"];
}

export interface PendingPersonalMemoryStageResult {
  staged: number;
  blocked: number;
  ignored: number;
}

export interface PersonalMemoryOperationApplier {
  applyOperations: (operations: PersonalMemoryOperation[]) => {
    applied: number;
    ignored: number;
    blocked: PersonalMemoryOperation[];
  };
}

export type PendingPersonalMemoryApprovalResult =
  | {
    result: "approved";
    applied: number;
    ignored: number;
    blocked: number;
  }
  | { result: "not-found" };

export type PendingPersonalMemoryRejectResult =
  | { result: "rejected" }
  | { result: "not-found" };

interface PendingPersonalMemoryFile {
  schemaVersion?: number;
  writes?: unknown[];
}

const PENDING_PERSONAL_MEMORY_SCHEMA_VERSION = 1;
const MAX_PENDING_MEMORY_WRITES = 50;
const SECRET_LIKE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/u,
  /\btoken[=:]?\s*[A-Za-z0-9._~+/=-]{6,}/iu,
  /\bapi[_-]?key[=:]?\s*[A-Za-z0-9._~+/=-]{6,}/iu,
  /\bpassword[=:]?\s*\S+/iu,
  /\bsk-[A-Za-z0-9._~+/=-]{8,}/u
];
const UNSAFE_MEMORY_PATTERNS = [
  /ignore previous instructions/i,
  /reveal secrets/i,
  /system prompt/i,
  /developer message/i
];

export function createPendingPersonalMemoryWritePath(baseDir: string): string {
  return path.join(createPersonalMemoryRootPath(baseDir), "pending-memory-writes.json");
}

export function readPendingPersonalMemoryWrites({
  baseDir,
  io = createDefaultPendingPersonalMemoryIo()
}: {
  baseDir: string;
  io?: PendingPersonalMemoryReadIo;
}): PendingPersonalMemoryWrite[] {
  const filePath = createPendingPersonalMemoryWritePath(baseDir);
  if (!io.exists(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(io.readFile(filePath)) as PendingPersonalMemoryFile;
    return Array.isArray(parsed.writes)
      ? parsed.writes.flatMap(readPendingPersonalMemoryWrite)
      : [];
  } catch {
    return [];
  }
}

export function createPendingPersonalMemoryStore({
  baseDir,
  io = createDefaultPendingPersonalMemoryIo(),
  now = () => new Date()
}: PendingPersonalMemoryStoreOptions) {
  return {
    read(): PendingPersonalMemoryWrite[] {
      return readPendingPersonalMemoryWrites({ baseDir, io });
    },
    stageOperations(
      operations: PersonalMemoryOperation[],
      options: PendingPersonalMemoryStageOptions = {}
    ): PendingPersonalMemoryStageResult {
      const existing = readPendingPersonalMemoryWrites({ baseDir, io });
      const next = [...existing];
      let staged = 0;
      let blocked = 0;
      let ignored = 0;

      for (const operation of operations) {
        const normalized = normalizePendingMemoryOperation(operation);
        if (!normalized || isUnsafePendingMemoryOperation(normalized)) {
          blocked += 1;
          continue;
        }

        if (next.some((entry) => isSamePendingOperation(entry, normalized))) {
          ignored += 1;
          continue;
        }

        next.push({
          ...normalized,
          id: createPendingMemoryId(now(), next.length + 1),
          createdAt: now().toISOString(),
          source: options.source ?? "post-turn-review"
        });
        staged += 1;
      }

      if (staged > 0 || ignored > 0) {
        writePendingPersonalMemoryWrites(baseDir, next.slice(-MAX_PENDING_MEMORY_WRITES), io);
      }

      return { staged, blocked, ignored };
    },
    approve(
      id: string,
      memoryStore: PersonalMemoryOperationApplier
    ): PendingPersonalMemoryApprovalResult {
      const existing = readPendingPersonalMemoryWrites({ baseDir, io });
      const match = existing.find((write) => write.id === id);
      if (!match) {
        return { result: "not-found" };
      }

      const result = memoryStore.applyOperations([readOperationFromPendingWrite(match)]);
      if (result.blocked.length === 0) {
        writePendingPersonalMemoryWrites(baseDir, existing.filter((write) => write.id !== id), io);
      }

      return {
        result: "approved",
        applied: result.applied,
        ignored: result.ignored,
        blocked: result.blocked.length
      };
    },
    reject(id: string): PendingPersonalMemoryRejectResult {
      const existing = readPendingPersonalMemoryWrites({ baseDir, io });
      if (!existing.some((write) => write.id === id)) {
        return { result: "not-found" };
      }

      writePendingPersonalMemoryWrites(baseDir, existing.filter((write) => write.id !== id), io);
      return { result: "rejected" };
    }
  };
}

function writePendingPersonalMemoryWrites(
  baseDir: string,
  writes: PendingPersonalMemoryWrite[],
  io: PendingPersonalMemoryIo
): void {
  const filePath = createPendingPersonalMemoryWritePath(baseDir);
  io.mkdir(path.dirname(filePath));
  io.writeFile(filePath, `${JSON.stringify({
    schemaVersion: PENDING_PERSONAL_MEMORY_SCHEMA_VERSION,
    writes
  }, null, 2)}\n`);
}

function readPendingPersonalMemoryWrite(value: unknown): PendingPersonalMemoryWrite[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const operation = normalizePendingMemoryOperation({
    action: record.action,
    target: record.target,
    content: record.content,
    previousContent: record.previousContent
  } as PersonalMemoryOperation);
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt.trim() : "";
  const source = typeof record.source === "string" ? record.source.trim() : "post-turn-review";

  if (!id || !createdAt || !operation || isUnsafePendingMemoryOperation(operation)) {
    return [];
  }

  return [{
    ...operation,
    id,
    createdAt,
    source
  }];
}

function normalizePendingMemoryOperation(
  operation: PersonalMemoryOperation
): PersonalMemoryOperation | undefined {
  if (!isMemoryAction(operation.action) || !isMemoryTarget(operation.target)) {
    return undefined;
  }

  const content = normalizeMemoryText(operation.content);
  const previousContent = normalizeMemoryText(operation.previousContent);
  if (!content || (operation.action === "replace" && !previousContent)) {
    return undefined;
  }

  return {
    action: operation.action,
    target: operation.target,
    content,
    ...(previousContent ? { previousContent } : {})
  };
}

function isMemoryAction(value: unknown): value is PersonalMemoryOperation["action"] {
  return value === "add" || value === "replace" || value === "remove";
}

function isMemoryTarget(value: unknown): value is PersonalMemoryOperation["target"] {
  return value === "user" || value === "agent";
}

function normalizeMemoryText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().replace(/\s+/gu, " ")
    : undefined;
}

function isUnsafePendingMemoryOperation(operation: PersonalMemoryOperation): boolean {
  return [operation.content, operation.previousContent ?? ""].some((value) => (
    SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(value))
    || UNSAFE_MEMORY_PATTERNS.some((pattern) => pattern.test(value))
  ));
}

function isSamePendingOperation(
  left: PendingPersonalMemoryWrite,
  right: PersonalMemoryOperation
): boolean {
  return left.action === right.action
    && left.target === right.target
    && left.content === right.content
    && (left.previousContent ?? "") === (right.previousContent ?? "");
}

function readOperationFromPendingWrite(write: PendingPersonalMemoryWrite): PersonalMemoryOperation {
  return {
    action: write.action,
    target: write.target,
    content: write.content,
    ...(write.previousContent ? { previousContent: write.previousContent } : {})
  };
}

function createPendingMemoryId(date: Date, index: number): string {
  const timestamp = date.toISOString().replace(/[^0-9A-Za-z]/gu, "");
  return `pmw-${timestamp}-${index}`;
}

function createDefaultPendingPersonalMemoryIo(): PendingPersonalMemoryIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8")
  };
}
