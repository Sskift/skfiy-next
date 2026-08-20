import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createPersonalMemoryRootPath,
  type PersonalMemoryAction,
  type PersonalMemoryOperation,
  type PersonalMemoryTarget
} from "./personal-memory.js";

export type PersonalMemoryJournalStage = "durable" | "pending";

export interface PersonalMemoryJournalEntry {
  id: string;
  createdAt: string;
  source: "post-turn-review" | "local-fallback" | string;
  stage: PersonalMemoryJournalStage;
  turnId: string;
  providerLabel: string;
  userInput: string;
  action: PersonalMemoryAction;
  target: PersonalMemoryTarget;
  content: string;
  previousContent?: string;
}

export interface PersonalMemoryJournalContext {
  providerLabel: string;
  source: PersonalMemoryJournalEntry["source"];
  stage: PersonalMemoryJournalStage;
  turnId: string;
  userInput: string;
}

export interface PersonalMemoryJournalReadIo {
  exists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string;
}

export interface PersonalMemoryJournalIo extends PersonalMemoryJournalReadIo {
  mkdir: (targetPath: string) => void;
  writeFile: (targetPath: string, content: string) => void;
}

export interface PersonalMemoryJournalStoreOptions {
  baseDir: string;
  io?: PersonalMemoryJournalIo;
  now?: () => Date;
}

const MAX_JOURNAL_OPERATION_LENGTH = 500;

export function createPersonalMemoryJournalPath(baseDir: string): string {
  return path.join(createPersonalMemoryRootPath(baseDir), "memory-journal.jsonl");
}

export function readPersonalMemoryJournalEntries({
  baseDir,
  io = createDefaultPersonalMemoryJournalIo()
}: {
  baseDir: string;
  io?: PersonalMemoryJournalReadIo;
}): PersonalMemoryJournalEntry[] {
  const filePath = createPersonalMemoryJournalPath(baseDir);
  if (!io.exists(filePath)) {
    return [];
  }

  return io.readFile(filePath)
    .split(/\r?\n/u)
    .flatMap((line) => readPersonalMemoryJournalEntry(line));
}

export function createPersonalMemoryJournalStore({
  baseDir,
  io = createDefaultPersonalMemoryJournalIo(),
  now = () => new Date()
}: PersonalMemoryJournalStoreOptions) {
  return {
    read(): PersonalMemoryJournalEntry[] {
      return readPersonalMemoryJournalEntries({ baseDir, io });
    },
    appendOperations(
      operations: PersonalMemoryOperation[],
      context: PersonalMemoryJournalContext
    ): PersonalMemoryJournalEntry[] {
      const existing = readPersonalMemoryJournalEntries({ baseDir, io });
      const createdAt = now().toISOString();
      const entries = operations.flatMap((operation, index) => createJournalEntry(
        operation,
        context,
        createdAt,
        existing.length + index + 1
      ));

      if (entries.length === 0) {
        return [];
      }

      const filePath = createPersonalMemoryJournalPath(baseDir);
      io.mkdir(path.dirname(filePath));
      io.writeFile(filePath, serializeJournalEntries([...existing, ...entries]));
      return entries;
    }
  };
}

function createJournalEntry(
  operation: PersonalMemoryOperation,
  context: PersonalMemoryJournalContext,
  createdAt: string,
  index: number
): PersonalMemoryJournalEntry[] {
  const content = normalizeJournalText(operation.content);
  const previousContent = normalizeJournalText(operation.previousContent);
  const providerLabel = normalizeJournalText(context.providerLabel);
  const turnId = normalizeJournalText(context.turnId);
  const userInput = normalizeJournalText(context.userInput);
  const source = normalizeJournalText(context.source);

  if (!content || !providerLabel || !turnId || !source || !userInput) {
    return [];
  }

  if (!isMemoryAction(operation.action) || !isMemoryTarget(operation.target)) {
    return [];
  }

  return [{
    id: createPersonalMemoryJournalId(createdAt, index),
    createdAt,
    source,
    stage: context.stage,
    turnId,
    providerLabel,
    userInput,
    action: operation.action,
    target: operation.target,
    content,
    ...(previousContent ? { previousContent } : {})
  }];
}

function serializeJournalEntries(entries: PersonalMemoryJournalEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function readPersonalMemoryJournalEntry(line: string): PersonalMemoryJournalEntry[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const createdAt = normalizeJournalText(parsed.createdAt);
    const id = normalizeJournalText(parsed.id);
    const source = normalizeJournalText(parsed.source);
    const turnId = normalizeJournalText(parsed.turnId);
    const providerLabel = normalizeJournalText(parsed.providerLabel);
    const userInput = normalizeJournalText(parsed.userInput);
    const content = normalizeJournalText(parsed.content);
    const previousContent = normalizeJournalText(parsed.previousContent);
    if (
      !id
      || !createdAt
      || !source
      || !turnId
      || !providerLabel
      || !userInput
      || !content
      || !isJournalStage(parsed.stage)
      || !isMemoryAction(parsed.action)
      || !isMemoryTarget(parsed.target)
    ) {
      return [];
    }

    return [{
      id,
      createdAt,
      source,
      stage: parsed.stage,
      turnId,
      providerLabel,
      userInput,
      action: parsed.action,
      target: parsed.target,
      content,
      ...(previousContent ? { previousContent } : {})
    }];
  } catch {
    return [];
  }
}

function createPersonalMemoryJournalId(createdAt: string, index: number): string {
  return `pmj-${createdAt.replace(/[-:.]/gu, "")}-${index}`;
}

function normalizeJournalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_JOURNAL_OPERATION_LENGTH) : undefined;
}

function isJournalStage(value: unknown): value is PersonalMemoryJournalStage {
  return value === "durable" || value === "pending";
}

function isMemoryAction(value: unknown): value is PersonalMemoryAction {
  return value === "add" || value === "replace" || value === "remove";
}

function isMemoryTarget(value: unknown): value is PersonalMemoryTarget {
  return value === "user" || value === "agent";
}

function createDefaultPersonalMemoryJournalIo(): PersonalMemoryJournalIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8")
  };
}
