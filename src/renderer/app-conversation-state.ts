import {
  CONVERSATION_HISTORY_SCHEMA_VERSION,
  canRetryConversationTurn,
  type ConversationHistorySnapshot,
  type ConversationMessage,
  type ConversationSession,
  type ConversationTurn
} from "../shared/conversation-history";

export type ConversationSessionState = "active" | "archived" | "deleted";

export interface ConversationSessionGroups {
  active: ConversationSession[];
  archived: ConversationSession[];
  deleted: ConversationSession[];
}

export interface ConversationMessageRow {
  message: ConversationMessage;
  turn: ConversationTurn;
  retryEligible: boolean;
}

export function createEmptyConversationHistorySnapshot(): ConversationHistorySnapshot {
  return {
    schemaVersion: CONVERSATION_HISTORY_SCHEMA_VERSION,
    lastActiveSessionId: null,
    sessions: []
  };
}

export function readConversationSessionState(
  session: ConversationSession
): ConversationSessionState {
  if (session.deletedAt) {
    return "deleted";
  }

  return session.archivedAt ? "archived" : "active";
}

export function readConversationSessionGroups(
  snapshot: ConversationHistorySnapshot
): ConversationSessionGroups {
  const groups: ConversationSessionGroups = {
    active: [],
    archived: [],
    deleted: []
  };

  for (const session of snapshot.sessions) {
    groups[readConversationSessionState(session)].push(session);
  }

  for (const sessions of Object.values(groups)) {
    sessions.sort(compareConversationSessionsByRecency);
  }

  return groups;
}

export function readActiveConversationSession(
  snapshot: ConversationHistorySnapshot
): ConversationSession | undefined {
  const activeSessions = snapshot.sessions.filter(
    (session) => readConversationSessionState(session) === "active"
  );
  const restored = activeSessions.find(
    (session) => session.id === snapshot.lastActiveSessionId
  );

  return restored ?? activeSessions.sort(compareConversationSessionsByRecency)[0];
}

export function readConversationMessageRows(
  session: ConversationSession | undefined
): ConversationMessageRow[] {
  if (!session) {
    return [];
  }

  return session.turns.flatMap((turn) => turn.messages.map((message) => ({
    message,
    turn,
    retryEligible: message.kind === "agent-reply"
      && message.state === "error"
      && isLatestRetryableTurn(session, turn)
  })));
}

export function createConversationRetryRequest(
  session: ConversationSession,
  turn: ConversationTurn,
  createRequestId: () => string
): { sessionId: string; turnId: string; requestId: string } | null {
  if (!isLatestRetryableTurn(session, turn)) {
    return null;
  }

  const requestId = createRequestId().trim();
  return requestId
    ? { sessionId: session.id, turnId: turn.id, requestId }
    : null;
}

function isLatestRetryableTurn(
  session: ConversationSession,
  turn: ConversationTurn
): boolean {
  if (!canRetryConversationTurn(turn)) {
    return false;
  }

  const latestAttempt = session.turns
    .filter((candidate) => candidate.submissionId === turn.submissionId)
    .reduce<ConversationTurn | undefined>((latest, candidate) =>
      !latest || candidate.attempt > latest.attempt ? candidate : latest, undefined);
  return latestAttempt?.id === turn.id;
}

export function formatConversationTimestamp(
  value: string,
  locale?: string
): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    return "未知时间";
  }

  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function compareConversationSessionsByRecency(
  left: ConversationSession,
  right: ConversationSession
): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || right.id.localeCompare(left.id);
}
