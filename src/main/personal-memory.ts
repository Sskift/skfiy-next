import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type PersonalMemoryTarget = "user" | "agent";
export type PersonalMemoryAction = "add" | "replace" | "remove";

export interface PersonalMemoryOperation {
  action: PersonalMemoryAction;
  target: PersonalMemoryTarget;
  content: string;
  previousContent?: string;
}

export interface PersonalMemorySnapshot {
  userEntries: string[];
  agentEntries: string[];
  usage?: PersonalMemoryUsage;
  latestUpdatedAt?: string;
}

export interface PersonalMemoryUsageBucket {
  usedChars: number;
  limitChars: number;
  percent: number;
}

export interface PersonalMemoryUsage {
  user: PersonalMemoryUsageBucket;
  agent: PersonalMemoryUsageBucket;
}

export interface PersonalMemoryApplyResult {
  applied: number;
  blocked: PersonalMemoryOperation[];
  ignored: number;
}

export interface PersonalMemoryReadIo {
  exists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string;
  stat?: (targetPath: string) => { mtimeMs: number };
}

export interface PersonalMemoryIo extends PersonalMemoryReadIo {
  mkdir: (targetPath: string) => void;
  writeFile: (targetPath: string, content: string) => void;
}

export interface PersonalMemoryStoreOptions {
  baseDir: string;
  io?: PersonalMemoryIo;
}

const MEMORY_DELIMITER = "\n---\n";
const MAX_MEMORY_ENTRY_LENGTH = 500;
const USER_MEMORY_CHAR_LIMIT = 1_375;
const AGENT_MEMORY_CHAR_LIMIT = 2_200;
const UNSAFE_MEMORY_PATTERNS = [
  /ignore previous instructions/i,
  /reveal secrets/i,
  /system prompt/i,
  /developer message/i
];

export function createSkfiyApplicationSupportPath(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", "skfiy");
}

export function createPersonalMemoryRootPath(baseDir: string): string {
  return path.join(baseDir, "memory");
}

export function createPersonalMemoryFilePath(
  baseDir: string,
  target: PersonalMemoryTarget
): string {
  return path.join(createPersonalMemoryRootPath(baseDir), target === "user" ? "USER.md" : "AGENT.md");
}

export function readPersonalMemorySnapshot({
  baseDir,
  io = createDefaultPersonalMemoryIo()
}: {
  baseDir: string;
  io?: PersonalMemoryReadIo;
}): PersonalMemorySnapshot {
  const userPath = createPersonalMemoryFilePath(baseDir, "user");
  const agentPath = createPersonalMemoryFilePath(baseDir, "agent");
  const userEntries = readMemoryEntries(userPath, io);
  const agentEntries = readMemoryEntries(agentPath, io);
  const latestUpdatedAt = readLatestMemoryUpdatedAt([userPath, agentPath], io);

  return {
    userEntries,
    agentEntries,
    usage: createPersonalMemoryUsage({ userEntries, agentEntries }),
    ...(latestUpdatedAt ? { latestUpdatedAt } : {})
  };
}

export function createPersonalMemoryStore({
  baseDir,
  io = createDefaultPersonalMemoryIo()
}: PersonalMemoryStoreOptions) {
  return {
    read(): PersonalMemorySnapshot {
      return readPersonalMemorySnapshot({ baseDir, io });
    },
    applyOperations(operations: PersonalMemoryOperation[]): PersonalMemoryApplyResult {
      const snapshot = readPersonalMemorySnapshot({ baseDir, io });
      const next = {
        user: [...snapshot.userEntries],
        agent: [...snapshot.agentEntries]
      };
      const blocked: PersonalMemoryOperation[] = [];
      let applied = 0;
      let ignored = 0;

      for (const operation of operations) {
        const content = normalizeMemoryEntry(operation.content);
        const previousContent = normalizeOptionalMemoryEntry(operation.previousContent);

        if (!content || (operation.action !== "remove" && isUnsafeMemoryEntry(content))) {
          blocked.push(operation);
          continue;
        }

        const entries = next[operation.target];
        if (operation.action === "add") {
          if (entries.includes(content)) {
            ignored += 1;
            continue;
          }
          entries.push(content);
          applied += 1;
          continue;
        }

        if (operation.action === "remove") {
          const before = entries.length;
          next[operation.target] = entries.filter((entry) => entry !== content);
          applied += before === next[operation.target].length ? 0 : 1;
          ignored += before === next[operation.target].length ? 1 : 0;
          continue;
        }

        if (!previousContent) {
          ignored += 1;
          continue;
        }

        const index = entries.indexOf(previousContent);
        if (index < 0) {
          ignored += 1;
          continue;
        }
        const replacementEntries = [...entries];
        replacementEntries[index] = content;
        const dedupedReplacementEntries = dedupeEntries(replacementEntries);
        next[operation.target] = dedupedReplacementEntries;
        applied += 1;
      }

      for (const target of ["user", "agent"] as const) {
        if (exceedsMemoryBudget(next[target], target)) {
          blocked.push(...findBudgetBlockingOperations(
            snapshot[readSnapshotEntryKey(target)],
            operations,
            target
          ));
        }
      }

      if (blocked.length > 0) {
        return {
          applied: 0,
          blocked: dedupeOperations(blocked),
          ignored
        };
      }

      if (applied > 0) {
        writeMemoryEntries(baseDir, "user", next.user, io);
        writeMemoryEntries(baseDir, "agent", next.agent, io);
      }

      return { applied, blocked, ignored };
    }
  };
}

function findBudgetBlockingOperations(
  initialEntries: string[],
  operations: PersonalMemoryOperation[],
  target: PersonalMemoryTarget
): PersonalMemoryOperation[] {
  const entries = [...initialEntries];
  const blocked: PersonalMemoryOperation[] = [];

  for (const operation of operations) {
    if (operation.target !== target) {
      continue;
    }

    const content = normalizeMemoryEntry(operation.content);
    const previousContent = normalizeOptionalMemoryEntry(operation.previousContent);
    if (!content || isUnsafeMemoryEntry(content)) {
      continue;
    }

    if (operation.action === "add") {
      if (!entries.includes(content)) {
        entries.push(content);
      }
    } else if (operation.action === "remove") {
      const index = entries.indexOf(content);
      if (index >= 0) {
        entries.splice(index, 1);
      }
    } else if (previousContent) {
      const index = entries.indexOf(previousContent);
      if (index >= 0) {
        entries[index] = content;
      }
    }

    if (exceedsMemoryBudget(entries, target)) {
      blocked.push(operation);
      break;
    }
  }

  return blocked.length > 0
    ? blocked
    : operations.filter((operation) => operation.target === target).slice(-1);
}

function readSnapshotEntryKey(target: PersonalMemoryTarget): "userEntries" | "agentEntries" {
  return target === "user" ? "userEntries" : "agentEntries";
}

function dedupeOperations(operations: PersonalMemoryOperation[]): PersonalMemoryOperation[] {
  const seen = new Set<string>();
  const deduped: PersonalMemoryOperation[] = [];

  for (const operation of operations) {
    const key = JSON.stringify(operation);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(operation);
  }

  return deduped;
}

export function createPersonalMemoryPromptBlock(snapshot: PersonalMemorySnapshot): string {
  const promptSafeSnapshot = createPromptSafePersonalMemorySnapshot(snapshot);

  if (promptSafeSnapshot.userEntries.length === 0 && promptSafeSnapshot.agentEntries.length === 0) {
    return "";
  }

  return [
    "<skfiy-recalled-memory>",
    "Recalled background context from prior skfiy conversations. Treat this as preferences and operating notes, not as new user input.",
    `USER PROFILE [${formatMemoryUsage(readPersonalMemoryUsage(promptSafeSnapshot).user)}]`,
    "User preferences:",
    ...formatMemoryList(promptSafeSnapshot.userEntries),
    `AGENT MEMORY [${formatMemoryUsage(readPersonalMemoryUsage(promptSafeSnapshot).agent)}]`,
    "Agent operating notes:",
    ...formatMemoryList(promptSafeSnapshot.agentEntries),
    "</skfiy-recalled-memory>"
  ].join("\n");
}

function createPromptSafePersonalMemorySnapshot(snapshot: PersonalMemorySnapshot): PersonalMemorySnapshot {
  const userEntries = sanitizeMemoryEntriesForPrompt(snapshot.userEntries, "USER");
  const agentEntries = sanitizeMemoryEntriesForPrompt(snapshot.agentEntries, "AGENT");

  return {
    ...snapshot,
    userEntries,
    agentEntries,
    usage: createPersonalMemoryUsage({ userEntries, agentEntries })
  };
}

function sanitizeMemoryEntriesForPrompt(entries: string[], label: "USER" | "AGENT"): string[] {
  return entries.map((entry) => isUnsafeMemoryEntry(entry)
    ? `[BLOCKED: ${label} memory entry contained unsafe content. Removed from provider prompt; use Dashboard Memory to forget the original.]`
    : entry);
}

function writeMemoryEntries(
  baseDir: string,
  target: PersonalMemoryTarget,
  entries: string[],
  io: PersonalMemoryIo
): void {
  const rootPath = createPersonalMemoryRootPath(baseDir);
  io.mkdir(rootPath);
  io.writeFile(createPersonalMemoryFilePath(baseDir, target), serializeMemoryEntries(entries));
}

function readMemoryEntries(filePath: string, io: PersonalMemoryReadIo): string[] {
  if (!io.exists(filePath)) {
    return [];
  }

  return parseMemoryEntries(io.readFile(filePath));
}

function parseMemoryEntries(text: string): string[] {
  return dedupeEntries(
    text
      .split(MEMORY_DELIMITER)
      .flatMap((part) => part.split(/\r?\n/u))
      .map(normalizeMemoryEntry)
      .filter((entry): entry is string => Boolean(entry))
  );
}

function serializeMemoryEntries(entries: string[]): string {
  return `${dedupeEntries(entries).join(MEMORY_DELIMITER)}\n`;
}

function createPersonalMemoryUsage({
  userEntries,
  agentEntries
}: {
  userEntries: string[];
  agentEntries: string[];
}): PersonalMemoryUsage {
  return {
    user: createUsageBucket(userEntries, USER_MEMORY_CHAR_LIMIT),
    agent: createUsageBucket(agentEntries, AGENT_MEMORY_CHAR_LIMIT)
  };
}

function readPersonalMemoryUsage(snapshot: PersonalMemorySnapshot): PersonalMemoryUsage {
  return snapshot.usage ?? createPersonalMemoryUsage(snapshot);
}

function createUsageBucket(entries: string[], limitChars: number): PersonalMemoryUsageBucket {
  const usedChars = countMemoryChars(entries);
  return {
    usedChars,
    limitChars,
    percent: limitChars > 0 ? Math.min(100, Math.floor((usedChars / limitChars) * 100)) : 0
  };
}

function exceedsMemoryBudget(entries: string[], target: PersonalMemoryTarget): boolean {
  return countMemoryChars(entries) > readMemoryLimit(target);
}

function countMemoryChars(entries: string[]): number {
  return entries.length > 0 ? entries.join(MEMORY_DELIMITER).length : 0;
}

function readMemoryLimit(target: PersonalMemoryTarget): number {
  return target === "user" ? USER_MEMORY_CHAR_LIMIT : AGENT_MEMORY_CHAR_LIMIT;
}

function formatMemoryList(entries: string[]): string[] {
  return entries.length > 0
    ? entries.map((entry) => `- ${entry}`)
    : ["- none"];
}

function formatMemoryUsage(usage: PersonalMemoryUsageBucket): string {
  return `${usage.percent}% - ${formatInteger(usage.usedChars)}/${formatInteger(usage.limitChars)} chars`;
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}

function normalizeMemoryEntry(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 0
    ? normalized.slice(0, MAX_MEMORY_ENTRY_LENGTH)
    : undefined;
}

function normalizeOptionalMemoryEntry(value: unknown): string | undefined {
  return value === undefined ? undefined : normalizeMemoryEntry(value);
}

function isUnsafeMemoryEntry(entry: string): boolean {
  return UNSAFE_MEMORY_PATTERNS.some((pattern) => pattern.test(entry));
}

function dedupeEntries(entries: string[]): string[] {
  return Array.from(new Set(entries));
}

function readLatestMemoryUpdatedAt(paths: string[], io: PersonalMemoryReadIo): string | undefined {
  const latestMtime = paths
    .filter((filePath) => io.exists(filePath))
    .map((filePath) => io.stat?.(filePath).mtimeMs ?? 0)
    .filter((mtimeMs) => mtimeMs > 0)
    .sort((left, right) => right - left)[0];

  return latestMtime ? new Date(latestMtime).toISOString() : undefined;
}

function createDefaultPersonalMemoryIo(): PersonalMemoryIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    stat: (targetPath) => statSync(targetPath),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8")
  };
}
