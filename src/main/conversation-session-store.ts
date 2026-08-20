import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CONVERSATION_HISTORY_SCHEMA_VERSION,
  canRetryConversationTurn,
  type ConversationApprovalDecision,
  type ConversationComputerUseState,
  type ConversationHistorySnapshot,
  type ConversationMessage,
  type ConversationProviderIdentity,
  type ConversationResultStatus,
  type ConversationRetryPreparation,
  type ConversationSession,
  type ConversationTurn
} from "../shared/conversation-history.js";
import type { SessionMemoryRecord } from "./session-memory.js";

const MAX_TITLE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_COMMAND_LENGTH = 5_000;
const DEFAULT_SESSION_TITLE = "New conversation";

export interface ConversationSessionStoreIo {
  exists: (targetPath: string) => boolean;
  mkdir: (targetPath: string) => void;
  readFile: (targetPath: string) => string;
  rename?: (fromPath: string, toPath: string) => void;
  writeFile: (targetPath: string, content: string) => void;
}

export interface ConversationTurnReference {
  sessionId: string;
  turnId: string;
}

export interface ConversationTurnStart extends ConversationTurnReference {
  submissionId: string;
  snapshot: ConversationHistorySnapshot;
}

export type ConversationRetryBlockReason =
  | "not-found"
  | "session-unavailable"
  | "not-provider-failure"
  | "unsafe-computer-use-state"
  | "stale-attempt"
  | "missing-user-input";

export type ConversationRetryPrepareResult =
  | { status: "prepared"; preparation: ConversationRetryPreparation }
  | {
    status: "duplicate";
    sessionId: string;
    turnId: string;
    snapshot: ConversationHistorySnapshot;
  }
  | {
    status: "blocked";
    reason: ConversationRetryBlockReason;
    snapshot: ConversationHistorySnapshot;
  };

export class ConversationSessionStorageError extends Error {
  readonly code: "corrupt" | "future-schema" | "write-failed";

  constructor(code: ConversationSessionStorageError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConversationSessionStorageError";
    this.code = code;
  }
}

export type ConversationSessionStore = ReturnType<typeof createConversationSessionStore>;

export function createConversationSessionStorePath(baseDir: string): string {
  return path.join(baseDir, "memory", "conversation-sessions.json");
}

export function readConversationSessionRecallRecords({
  baseDir,
  io,
  sessionId
}: {
  baseDir: string;
  io: Pick<ConversationSessionStoreIo, "exists" | "readFile">;
  sessionId?: string;
}): SessionMemoryRecord[] | undefined {
  const filePath = createConversationSessionStorePath(baseDir);
  if (!io.exists(filePath)) {
    return undefined;
  }

  return createRecallRecords(parseConversationHistorySnapshot(io.readFile(filePath)), { sessionId });
}

export function createConversationSessionStore({
  baseDir,
  io = createDefaultIo(),
  now = () => new Date(),
  createId = (kind) => `${kind}-${randomUUID()}`
}: {
  baseDir: string;
  io?: ConversationSessionStoreIo;
  now?: () => Date;
  createId?: (kind: string) => string;
}) {
  const filePath = createConversationSessionStorePath(baseDir);
  let state: ConversationHistorySnapshot;

  if (io.exists(filePath)) {
    state = parseConversationHistorySnapshot(io.readFile(filePath));
  } else {
    state = migrateLegacySnapshot({ baseDir, io, now, createId });
    ensureAvailableSession(state, { now, createId });
    writeSnapshot(filePath, state, io);
  }

  if (recoverInterruptedTurns(state, { now, createId })) {
    ensureAvailableSession(state, { now, createId });
    writeSnapshot(filePath, state, io);
  } else {
    ensureAvailableSession(state, { now, createId });
  }

  const commit = <T>(mutate: (draft: ConversationHistorySnapshot) => T): T => {
    const draft = clone(state);
    const result = mutate(draft);
    writeSnapshot(filePath, draft, io);
    state = draft;
    return result;
  };

  const read = (): ConversationHistorySnapshot => clone(state);

  return {
    read,

    startSession(): ConversationHistorySnapshot {
      return commit((draft) => {
        const session = createEmptySession({ now, createId });
        draft.sessions.push(session);
        draft.lastActiveSessionId = session.id;
        return clone(draft);
      });
    },

    switchSession(sessionId: string): ConversationHistorySnapshot {
      return commit((draft) => {
        const session = requireAvailableSession(draft, sessionId);
        session.updatedAt = readTimestamp(now);
        draft.lastActiveSessionId = session.id;
        return clone(draft);
      });
    },

    renameSession(sessionId: string, title: string): ConversationHistorySnapshot {
      const normalizedTitle = normalizeTitle(title);
      if (!normalizedTitle) {
        throw new Error("Conversation title must be non-empty text.");
      }

      return commit((draft) => {
        const session = requireSession(draft, sessionId);
        session.title = normalizedTitle;
        session.titleSource = "user";
        session.updatedAt = readTimestamp(now);
        return clone(draft);
      });
    },

    archiveSession(sessionId: string): ConversationHistorySnapshot {
      return commit((draft) => {
        const session = requireSession(draft, sessionId);
        if (session.deletedAt) throw new Error("Deleted conversations must be restored before archiving.");
        assertSessionHasNoActiveTurn(session);
        const timestamp = readTimestamp(now);
        session.archivedAt = timestamp;
        session.updatedAt = timestamp;
        selectAvailableFallback(draft, sessionId, { now, createId });
        return clone(draft);
      });
    },

    deleteSession(sessionId: string): ConversationHistorySnapshot {
      return commit((draft) => {
        const session = requireSession(draft, sessionId);
        assertSessionHasNoActiveTurn(session);
        const timestamp = readTimestamp(now);
        session.deletedAt = timestamp;
        session.updatedAt = timestamp;
        selectAvailableFallback(draft, sessionId, { now, createId });
        return clone(draft);
      });
    },

    restoreSession(sessionId: string): ConversationHistorySnapshot {
      return commit((draft) => {
        const session = requireSession(draft, sessionId);
        session.archivedAt = undefined;
        session.deletedAt = undefined;
        session.updatedAt = readTimestamp(now);
        draft.lastActiveSessionId = session.id;
        return clone(draft);
      });
    },

    beginTurn({
      sessionId,
      userInput,
      provider
    }: {
      sessionId?: string;
      userInput: string;
      provider: ConversationProviderIdentity;
    }): ConversationTurnStart {
      const input = normalizeMessageText(userInput);
      if (!input) throw new Error("Conversation input must be non-empty text.");
      const normalizedProvider = normalizeProvider(provider);

      return commit((draft) => {
        const session = sessionId
          ? requireAvailableSession(draft, sessionId)
          : readActiveSession(draft) ?? createAndSelectSession(draft, { now, createId });
        const timestamp = readTimestamp(now);
        const turnId = createId("assistant-turn");
        const submissionId = createId("submission");
        const turn: ConversationTurn = {
          id: turnId,
          submissionId,
          attempt: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          status: "pending",
          provider: normalizedProvider,
          computerUseState: "none",
          messages: [{
            id: createId("message"),
            turnId,
            kind: "user-text",
            text: input,
            createdAt: timestamp
          }]
        };
        session.turns.push(turn);
        if (session.titleSource === "generated" && session.turns.length === 1) {
          session.title = createGeneratedTitle(input);
        }
        session.updatedAt = timestamp;
        draft.lastActiveSessionId = session.id;
        return {
          sessionId: session.id,
          turnId,
          submissionId,
          snapshot: clone(draft)
        };
      });
    },

    recordProviderSuccess({
      sessionId,
      turnId,
      text,
      provider
    }: ConversationTurnReference & {
      text: string;
      provider: ConversationProviderIdentity;
    }): ConversationHistorySnapshot {
      return commit((draft) => {
        const { session, turn } = requireTurn(draft, sessionId, turnId);
        const timestamp = readTimestamp(now);
        turn.provider = normalizeProvider(provider);
        turn.messages.push({
          id: createId("message"),
          turnId,
          kind: "agent-reply",
          text: normalizeMessageText(text) || "Background Agent completed without reply text.",
          provider: turn.provider,
          state: "completed",
          createdAt: timestamp
        });
        turn.status = "completed";
        touch(session, turn, timestamp);
        return clone(draft);
      });
    },

    failProviderTurn({
      sessionId,
      turnId,
      text
    }: ConversationTurnReference & { text: string }): ConversationHistorySnapshot {
      return commit((draft) => {
        const { session, turn } = requireTurn(draft, sessionId, turnId);
        const timestamp = readTimestamp(now);
        turn.messages.push({
          id: createId("message"),
          turnId,
          kind: "agent-reply",
          text: normalizeMessageText(text) || "Background Agent failed.",
          provider: turn.provider,
          state: "error",
          createdAt: timestamp
        });
        turn.status = "provider-failed";
        touch(session, turn, timestamp);
        return clone(draft);
      });
    },

    recordComputerUseRequest({
      sessionId,
      turnId,
      toolCallId,
      command,
      route,
      text
    }: ConversationTurnReference & {
      toolCallId: string;
      command: string;
      route: string;
      text: string;
    }): ConversationHistorySnapshot {
      return commit((draft) => {
        const { session, turn } = requireTurn(draft, sessionId, turnId);
        const timestamp = readTimestamp(now);
        turn.messages.push({
          id: createId("message"),
          turnId,
          kind: "computer-use-request",
          text: normalizeMessageText(text) || "Computer Use requested.",
          toolCallId: requireOpaqueId(toolCallId, "tool call"),
          command: truncate(normalizeMessageText(command), MAX_COMMAND_LENGTH),
          route: requireOpaqueId(route, "route"),
          createdAt: timestamp
        });
        turn.computerUseState = "requested";
        turn.status = "pending";
        touch(session, turn, timestamp);
        return clone(draft);
      });
    },

    recordApproval({
      sessionId,
      turnId,
      toolCallId,
      decision,
      text,
      reason
    }: ConversationTurnReference & {
      toolCallId: string;
      decision: ConversationApprovalDecision;
      text: string;
      reason?: string;
    }): ConversationHistorySnapshot {
      return commit((draft) => {
        const { session, turn } = requireTurn(draft, sessionId, turnId);
        const timestamp = readTimestamp(now);
        turn.messages.push({
          id: createId("message"),
          turnId,
          kind: "approval",
          text: normalizeMessageText(text) || `Computer Use approval ${decision}.`,
          toolCallId: requireOpaqueId(toolCallId, "tool call"),
          decision,
          ...(normalizeMessageText(reason) ? { reason: normalizeMessageText(reason) } : {}),
          createdAt: timestamp
        });
        touch(session, turn, timestamp);
        return clone(draft);
      });
    },

    setComputerUseState({
      sessionId,
      turnId,
      state: nextState
    }: ConversationTurnReference & { state: ConversationComputerUseState }): ConversationHistorySnapshot {
      return commit((draft) => {
        const { session, turn } = requireTurn(draft, sessionId, turnId);
        assertComputerUseStateTransition(turn.computerUseState, nextState);
        const timestamp = readTimestamp(now);
        turn.computerUseState = nextState;
        touch(session, turn, timestamp);
        return clone(draft);
      });
    },

    markComputerUseDispatching(reference: ConversationTurnReference): ConversationHistorySnapshot {
      return this.setComputerUseState({ ...reference, state: "dispatching" });
    },

    recordComputerUseResult({
      sessionId,
      turnId,
      toolCallId,
      status,
      summary,
      text
    }: ConversationTurnReference & {
      toolCallId: string;
      status: ConversationResultStatus;
      summary: string;
      text: string;
    }): ConversationHistorySnapshot {
      return commit((draft) => {
        const { session, turn } = requireTurn(draft, sessionId, turnId);
        const timestamp = readTimestamp(now);
        turn.messages.push({
          id: createId("message"),
          turnId,
          kind: "result",
          text: normalizeMessageText(text) || normalizeMessageText(summary) || `Computer Use ${status}.`,
          toolCallId: requireOpaqueId(toolCallId, "tool call"),
          status,
          summary: normalizeMessageText(summary) || `Computer Use ${status}.`,
          createdAt: timestamp
        });
        turn.computerUseState = "finished";
        turn.status = status;
        touch(session, turn, timestamp);
        return clone(draft);
      });
    },

    stopTurn({
      sessionId,
      turnId,
      reason
    }: ConversationTurnReference & { reason: string }): ConversationHistorySnapshot {
      return commit((draft) => {
        const { session, turn } = requireTurn(draft, sessionId, turnId);
        const timestamp = readTimestamp(now);
        if (turn.computerUseState === "dispatching") {
          turn.computerUseState = "unknown";
        }
        appendStoppedMessage(turn, normalizeMessageText(reason) || "Turn stopped.", timestamp, createId);
        turn.status = "stopped";
        touch(session, turn, timestamp);
        return clone(draft);
      });
    },

    prepareRetry({
      sessionId,
      turnId,
      requestId
    }: ConversationTurnReference & { requestId: string }): ConversationRetryPrepareResult {
      const normalizedRequestId = requireOpaqueId(requestId, "retry request");
      const duplicate = findTurnByRetryRequestId(state, normalizedRequestId);
      if (duplicate) {
        return {
          status: "duplicate",
          sessionId: duplicate.session.id,
          turnId: duplicate.turn.id,
          snapshot: read()
        };
      }

      const session = state.sessions.find((candidate) => candidate.id === sessionId);
      const turn = session?.turns.find((candidate) => candidate.id === turnId);
      if (!session || !turn) {
        return { status: "blocked", reason: "not-found", snapshot: read() };
      }
      if (!isAvailableSession(session)) {
        return { status: "blocked", reason: "session-unavailable", snapshot: read() };
      }
      if (turn.status !== "provider-failed") {
        return { status: "blocked", reason: "not-provider-failure", snapshot: read() };
      }
      if (turn.computerUseState !== "none") {
        return { status: "blocked", reason: "unsafe-computer-use-state", snapshot: read() };
      }
      const attempts = session.turns.filter((candidate) => candidate.submissionId === turn.submissionId);
      const latest = attempts.reduce((left, right) => right.attempt > left.attempt ? right : left, attempts[0]);
      if (!latest || latest.id !== turn.id || !canRetryConversationTurn(turn)) {
        return { status: "blocked", reason: "stale-attempt", snapshot: read() };
      }
      const userInput = readSubmissionUserInput(attempts);
      if (!userInput) {
        return { status: "blocked", reason: "missing-user-input", snapshot: read() };
      }

      return commit((draft) => {
        const draftSession = requireAvailableSession(draft, sessionId);
        const timestamp = readTimestamp(now);
        const retryTurnId = createId("assistant-turn");
        const retryTurn: ConversationTurn = {
          id: retryTurnId,
          submissionId: turn.submissionId,
          attempt: turn.attempt + 1,
          retryOfTurnId: turn.id,
          retryRequestId: normalizedRequestId,
          createdAt: timestamp,
          updatedAt: timestamp,
          status: "pending",
          provider: clone(turn.provider),
          computerUseState: "none",
          messages: []
        };
        draftSession.turns.push(retryTurn);
        draftSession.updatedAt = timestamp;
        draft.lastActiveSessionId = draftSession.id;
        const snapshot = clone(draft);
        return {
          status: "prepared" as const,
          preparation: {
            snapshot,
            sessionId: draftSession.id,
            turnId: retryTurn.id,
            retryOfTurnId: turn.id,
            submissionId: turn.submissionId,
            userInput
          }
        };
      });
    },

    readRecallableRecords(options: { sessionId?: string } = {}): SessionMemoryRecord[] {
      return createRecallRecords(state, options);
    },

    replaceSnapshot(snapshot: ConversationHistorySnapshot): ConversationHistorySnapshot {
      // Re-parse through the strict reader so a restore can never persist a
      // structurally invalid snapshot underneath the live store.
      const normalized = parseConversationHistorySnapshot(JSON.stringify(snapshot));
      writeSnapshot(filePath, normalized, io);
      state = normalized;
      return clone(normalized);
    }
  };
}

function createRecallRecords(
  snapshot: ConversationHistorySnapshot,
  options: { sessionId?: string }
): SessionMemoryRecord[] {
  return snapshot.sessions
    .filter((session) => isAvailableSession(session) && (!options.sessionId || session.id === options.sessionId))
    .flatMap((session) => session.turns.flatMap((turn) => {
      const assistant = [...turn.messages].reverse().find(
        (message) => message.kind === "agent-reply" && message.state === "completed"
      );
      const userInput = readSubmissionUserInput(
        session.turns.filter((candidate) => candidate.submissionId === turn.submissionId)
      );
      return assistant?.kind === "agent-reply" && userInput
        ? [{
          turnId: turn.id,
          createdAt: turn.createdAt,
          userInput,
          assistantReply: assistant.text,
          providerLabel: assistant.provider.label
        }]
        : [];
    }));
}

function createEmptySession({
  now,
  createId
}: {
  now: () => Date;
  createId: (kind: string) => string;
}): ConversationSession {
  const timestamp = readTimestamp(now);
  return {
    id: createId("session"),
    title: DEFAULT_SESSION_TITLE,
    titleSource: "generated",
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: []
  };
}

function createAndSelectSession(
  snapshot: ConversationHistorySnapshot,
  dependencies: { now: () => Date; createId: (kind: string) => string }
): ConversationSession {
  const session = createEmptySession(dependencies);
  snapshot.sessions.push(session);
  snapshot.lastActiveSessionId = session.id;
  return session;
}

function ensureAvailableSession(
  snapshot: ConversationHistorySnapshot,
  dependencies: { now: () => Date; createId: (kind: string) => string }
): void {
  const active = readActiveSession(snapshot);
  if (active) {
    snapshot.lastActiveSessionId = active.id;
    return;
  }
  createAndSelectSession(snapshot, dependencies);
}

function selectAvailableFallback(
  snapshot: ConversationHistorySnapshot,
  excludedId: string,
  dependencies: { now: () => Date; createId: (kind: string) => string }
): void {
  if (snapshot.lastActiveSessionId !== excludedId) return;
  const fallback = snapshot.sessions
    .filter((session) => session.id !== excludedId && isAvailableSession(session))
    .sort(compareUpdatedDescending)[0];
  snapshot.lastActiveSessionId = fallback?.id ?? createAndSelectSession(snapshot, dependencies).id;
}

function readActiveSession(snapshot: ConversationHistorySnapshot): ConversationSession | undefined {
  const selected = snapshot.sessions.find(
    (session) => session.id === snapshot.lastActiveSessionId && isAvailableSession(session)
  );
  return selected ?? snapshot.sessions.filter(isAvailableSession).sort(compareUpdatedDescending)[0];
}

function requireSession(snapshot: ConversationHistorySnapshot, sessionId: string): ConversationSession {
  const normalizedId = requireOpaqueId(sessionId, "session");
  const session = snapshot.sessions.find((candidate) => candidate.id === normalizedId);
  if (!session) throw new Error(`Unknown conversation session: ${normalizedId}`);
  return session;
}

function requireAvailableSession(snapshot: ConversationHistorySnapshot, sessionId: string): ConversationSession {
  const session = requireSession(snapshot, sessionId);
  if (!isAvailableSession(session)) throw new Error(`Conversation session is unavailable: ${sessionId}`);
  return session;
}

function requireTurn(
  snapshot: ConversationHistorySnapshot,
  sessionId: string,
  turnId: string
): { session: ConversationSession; turn: ConversationTurn } {
  const session = requireSession(snapshot, sessionId);
  const normalizedTurnId = requireOpaqueId(turnId, "turn");
  const turn = session.turns.find((candidate) => candidate.id === normalizedTurnId);
  if (!turn) throw new Error(`Unknown conversation turn: ${sessionId}/${normalizedTurnId}`);
  return { session, turn };
}

function isAvailableSession(session: ConversationSession): boolean {
  return !session.archivedAt && !session.deletedAt;
}

function assertSessionHasNoActiveTurn(session: ConversationSession): void {
  if (session.turns.some((turn) => turn.status === "pending")) {
    throw new Error("Conversation session has an active turn; stop it before archiving or deleting.");
  }
}

function touch(session: ConversationSession, turn: ConversationTurn, timestamp: string): void {
  turn.updatedAt = timestamp;
  session.updatedAt = timestamp;
}

function appendStoppedMessage(
  turn: ConversationTurn,
  reason: string,
  timestamp: string,
  createId: (kind: string) => string
): void {
  if (turn.messages.at(-1)?.kind === "stopped") return;
  turn.messages.push({
    id: createId("message"),
    turnId: turn.id,
    kind: "stopped",
    text: reason,
    reason,
    createdAt: timestamp
  });
}

function recoverInterruptedTurns(
  snapshot: ConversationHistorySnapshot,
  {
    now,
    createId
  }: {
    now: () => Date;
    createId: (kind: string) => string;
  }
): boolean {
  let changed = false;
  for (const session of snapshot.sessions) {
    for (const turn of session.turns) {
      if (turn.status !== "pending") continue;
      const timestamp = readTimestamp(now);
      if (turn.computerUseState === "none") {
        turn.messages.push({
          id: createId("message"),
          turnId: turn.id,
          kind: "agent-reply",
          text: "Background Agent was interrupted before the reply was saved. You can retry safely.",
          provider: clone(turn.provider),
          state: "error",
          createdAt: timestamp
        });
        turn.status = "provider-failed";
      } else {
        if (turn.computerUseState === "dispatching") turn.computerUseState = "unknown";
        appendStoppedMessage(turn, "Turn stopped when skfiy exited.", timestamp, createId);
        turn.status = "stopped";
      }
      touch(session, turn, timestamp);
      changed = true;
    }
  }
  return changed;
}

function findTurnByRetryRequestId(
  snapshot: ConversationHistorySnapshot,
  requestId: string
): { session: ConversationSession; turn: ConversationTurn } | undefined {
  for (const session of snapshot.sessions) {
    const turn = session.turns.find((candidate) => candidate.retryRequestId === requestId);
    if (turn) return { session, turn };
  }
  return undefined;
}

function readSubmissionUserInput(turns: ConversationTurn[]): string | undefined {
  return turns
    .sort((left, right) => left.attempt - right.attempt)
    .flatMap((turn) => turn.messages)
    .find((message) => message.kind === "user-text")?.text;
}

function assertComputerUseStateTransition(
  current: ConversationComputerUseState,
  next: ConversationComputerUseState
): void {
  const rank: Record<ConversationComputerUseState, number> = {
    none: 0,
    requested: 1,
    dispatching: 2,
    finished: 3,
    unknown: 4
  };
  if (rank[next] < rank[current]) {
    throw new Error(`Computer Use state cannot move backward from ${current} to ${next}.`);
  }
}

function migrateLegacySnapshot({
  baseDir,
  io,
  now,
  createId
}: {
  baseDir: string;
  io: ConversationSessionStoreIo;
  now: () => Date;
  createId: (kind: string) => string;
}): ConversationHistorySnapshot {
  const legacyPath = path.join(baseDir, "memory", "sessions.jsonl");
  const records = io.exists(legacyPath) ? parseLegacyRecords(io.readFile(legacyPath)) : [];
  const usedTurnIds = new Set<string>();
  const sessions = records.map((record) => {
    const turnId = record.turnId && !usedTurnIds.has(record.turnId)
      ? record.turnId
      : createId("legacy-turn");
    usedTurnIds.add(turnId);
    const provider = {
      id: readProviderId(record.providerLabel),
      label: record.providerLabel
    };
    const turn: ConversationTurn = {
      id: turnId,
      submissionId: createId("submission"),
      attempt: 1,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      status: "completed",
      provider,
      computerUseState: "none",
      messages: [
        {
          id: createId("message"),
          turnId,
          kind: "user-text",
          text: record.userInput,
          createdAt: record.createdAt
        },
        {
          id: createId("message"),
          turnId,
          kind: "agent-reply",
          text: record.assistantReply,
          provider,
          state: "completed",
          createdAt: record.createdAt
        }
      ]
    };
    return {
      id: createId("session"),
      title: createGeneratedTitle(record.userInput),
      titleSource: "generated" as const,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      turns: [turn]
    };
  });

  return {
    schemaVersion: CONVERSATION_HISTORY_SCHEMA_VERSION,
    lastActiveSessionId: sessions.at(-1)?.id ?? null,
    sessions
  };
}

function parseLegacyRecords(content: string): SessionMemoryRecord[] {
  return content.split(/\r?\n/u).flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof value.turnId !== "string"
        || typeof value.createdAt !== "string"
        || typeof value.userInput !== "string"
        || typeof value.assistantReply !== "string"
        || typeof value.providerLabel !== "string"
      ) return [];
      return [{
        turnId: value.turnId,
        createdAt: value.createdAt,
        userInput: value.userInput,
        assistantReply: value.assistantReply,
        providerLabel: value.providerLabel
      }];
    } catch {
      return [];
    }
  });
}

export function parseConversationHistorySnapshot(content: string): ConversationHistorySnapshot {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new ConversationSessionStorageError("corrupt", "Conversation history JSON is corrupt.", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationSessionStorageError("corrupt", "Conversation history must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CONVERSATION_HISTORY_SCHEMA_VERSION) {
    throw new ConversationSessionStorageError(
      typeof record.schemaVersion === "number" && record.schemaVersion > CONVERSATION_HISTORY_SCHEMA_VERSION
        ? "future-schema"
        : "corrupt",
      `Unsupported conversation history schema: ${String(record.schemaVersion)}.`
    );
  }
  if (!Array.isArray(record.sessions)) {
    throw new ConversationSessionStorageError("corrupt", "Conversation history sessions must be an array.");
  }
  const sessions = record.sessions.map(parseSession);
  const lastActiveSessionId = record.lastActiveSessionId === null
    ? null
    : requireParsedString(record.lastActiveSessionId, "lastActiveSessionId");
  return {
    schemaVersion: CONVERSATION_HISTORY_SCHEMA_VERSION,
    lastActiveSessionId,
    sessions
  };
}

function parseSession(value: unknown): ConversationSession {
  const record = requireRecord(value, "session");
  const titleSource = record.titleSource;
  if (titleSource !== "generated" && titleSource !== "user") {
    throw new ConversationSessionStorageError("corrupt", "Conversation session titleSource is invalid.");
  }
  if (!Array.isArray(record.turns)) {
    throw new ConversationSessionStorageError("corrupt", "Conversation session turns must be an array.");
  }
  return {
    id: requireParsedString(record.id, "session.id"),
    title: requireParsedString(record.title, "session.title"),
    titleSource,
    createdAt: requireParsedString(record.createdAt, "session.createdAt"),
    updatedAt: requireParsedString(record.updatedAt, "session.updatedAt"),
    ...(typeof record.archivedAt === "string" ? { archivedAt: record.archivedAt } : {}),
    ...(typeof record.deletedAt === "string" ? { deletedAt: record.deletedAt } : {}),
    turns: record.turns.map(parseTurn)
  };
}

function parseTurn(value: unknown): ConversationTurn {
  const record = requireRecord(value, "turn");
  const status = record.status;
  if (!isTurnStatus(status)) throw new ConversationSessionStorageError("corrupt", "Conversation turn status is invalid.");
  const computerUseState = record.computerUseState;
  if (!isComputerUseState(computerUseState)) {
    throw new ConversationSessionStorageError("corrupt", "Conversation Computer Use state is invalid.");
  }
  if (!Array.isArray(record.messages)) {
    throw new ConversationSessionStorageError("corrupt", "Conversation turn messages must be an array.");
  }
  return {
    id: requireParsedString(record.id, "turn.id"),
    submissionId: requireParsedString(record.submissionId, "turn.submissionId"),
    attempt: requirePositiveInteger(record.attempt, "turn.attempt"),
    ...(typeof record.retryOfTurnId === "string" ? { retryOfTurnId: record.retryOfTurnId } : {}),
    ...(typeof record.retryRequestId === "string" ? { retryRequestId: record.retryRequestId } : {}),
    createdAt: requireParsedString(record.createdAt, "turn.createdAt"),
    updatedAt: requireParsedString(record.updatedAt, "turn.updatedAt"),
    status,
    provider: parseProvider(record.provider),
    computerUseState,
    messages: record.messages.map(parseMessage)
  };
}

function parseMessage(value: unknown): ConversationMessage {
  const record = requireRecord(value, "message");
  const base = {
    id: requireParsedString(record.id, "message.id"),
    turnId: requireParsedString(record.turnId, "message.turnId"),
    createdAt: requireParsedString(record.createdAt, "message.createdAt")
  };
  const text = requireParsedString(record.text, "message.text");
  switch (record.kind) {
    case "user-text": return { ...base, kind: "user-text", text };
    case "agent-reply": {
      if (record.state !== "completed" && record.state !== "error") {
        throw new ConversationSessionStorageError("corrupt", "Agent reply state is invalid.");
      }
      return { ...base, kind: "agent-reply", text, provider: parseProvider(record.provider), state: record.state };
    }
    case "computer-use-request": return {
      ...base,
      kind: "computer-use-request",
      text,
      toolCallId: requireParsedString(record.toolCallId, "message.toolCallId"),
      command: requireParsedString(record.command, "message.command"),
      route: requireParsedString(record.route, "message.route")
    };
    case "approval": {
      if (!isApprovalDecision(record.decision)) {
        throw new ConversationSessionStorageError("corrupt", "Approval decision is invalid.");
      }
      return {
        ...base,
        kind: "approval",
        text,
        toolCallId: requireParsedString(record.toolCallId, "message.toolCallId"),
        decision: record.decision,
        ...(typeof record.reason === "string" ? { reason: record.reason } : {})
      };
    }
    case "result": {
      if (!isResultStatus(record.status)) {
        throw new ConversationSessionStorageError("corrupt", "Computer Use result status is invalid.");
      }
      return {
        ...base,
        kind: "result",
        text,
        toolCallId: requireParsedString(record.toolCallId, "message.toolCallId"),
        status: record.status,
        summary: requireParsedString(record.summary, "message.summary")
      };
    }
    case "stopped": return {
      ...base,
      kind: "stopped",
      text,
      reason: requireParsedString(record.reason, "message.reason")
    };
    default: throw new ConversationSessionStorageError("corrupt", `Unknown conversation message kind: ${String(record.kind)}.`);
  }
}

function parseProvider(value: unknown): ConversationProviderIdentity {
  const record = requireRecord(value, "provider");
  return {
    id: requireParsedString(record.id, "provider.id"),
    label: requireParsedString(record.label, "provider.label")
  };
}

function writeSnapshot(
  filePath: string,
  snapshot: ConversationHistorySnapshot,
  io: ConversationSessionStoreIo
): void {
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const tempPath = `${filePath}.tmp-${Date.now()}-${randomUUID()}`;
  try {
    io.mkdir(path.dirname(filePath));
    if (io.rename) {
      io.writeFile(tempPath, content);
      io.rename(tempPath, filePath);
    } else {
      io.writeFile(filePath, content);
    }
  } catch (error) {
    throw new ConversationSessionStorageError("write-failed", "Unable to persist conversation history.", error);
  }
}

function createDefaultIo(): ConversationSessionStoreIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    rename: renameSync,
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8")
  };
}

function normalizeProvider(provider: ConversationProviderIdentity): ConversationProviderIdentity {
  return {
    id: requireOpaqueId(provider?.id, "provider"),
    label: truncate(normalizeMessageText(provider?.label), 100) || "Background Agent"
  };
}

function createGeneratedTitle(input: string): string {
  return truncate(input.replace(/\s+/gu, " ").trim(), 48) || DEFAULT_SESSION_TITLE;
}

function normalizeTitle(value: unknown): string {
  return typeof value === "string"
    ? truncate(value.trim().replace(/\s+/gu, " "), MAX_TITLE_LENGTH)
    : "";
}

function normalizeMessageText(value: unknown): string {
  return typeof value === "string" ? truncate(value.trim(), MAX_MESSAGE_LENGTH) : "";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function requireOpaqueId(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 200) throw new Error(`${label} id must be bounded text.`);
  return normalized;
}

function requireParsedString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConversationSessionStorageError("corrupt", `${label} must be non-empty text.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConversationSessionStorageError("corrupt", `${label} must be a positive integer.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationSessionStorageError("corrupt", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function isTurnStatus(value: unknown): value is ConversationTurn["status"] {
  return value === "pending" || value === "completed" || value === "provider-failed"
    || value === "denied" || value === "blocked" || value === "failed"
    || value === "cancelled" || value === "stopped";
}

function isComputerUseState(value: unknown): value is ConversationComputerUseState {
  return value === "none" || value === "requested" || value === "dispatching"
    || value === "finished" || value === "unknown";
}

function isApprovalDecision(value: unknown): value is ConversationApprovalDecision {
  return value === "required" || value === "approved" || value === "denied" || value === "bypassed";
}

function isResultStatus(value: unknown): value is ConversationResultStatus {
  return value === "completed" || value === "denied" || value === "blocked"
    || value === "failed" || value === "cancelled";
}

function readProviderId(label: string): string {
  // skfiy-next runs a single Codex backend provider. Legacy session records may
  // carry older provider labels, but every canonical turn is owned by Codex.
  void label;
  return "codex";
}

function readTimestamp(now: () => Date): string {
  return now().toISOString();
}

function compareUpdatedDescending(left: ConversationSession, right: ConversationSession): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
