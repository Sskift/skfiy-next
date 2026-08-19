import { describe, expect, it } from "vitest";

import type {
  ConversationHistorySnapshot,
  ConversationSession,
  ConversationTurn
} from "../shared/conversation-history";
import {
  createEmptyConversationHistorySnapshot,
  createConversationRetryRequest,
  formatConversationTimestamp,
  readActiveConversationSession,
  readConversationMessageRows,
  readConversationSessionGroups,
  readConversationSessionState
} from "./app-conversation-state";

const ACTIVE_SESSION = createSession({
  id: "session-active",
  title: "Active notes",
  updatedAt: "2026-07-11T02:00:00.000Z",
  turns: [
    createTurn({
      id: "turn-completed",
      status: "completed",
      messages: [
        {
          id: "message-user",
          turnId: "turn-completed",
          kind: "user-text",
          text: "Remember this",
          createdAt: "2026-07-11T01:59:00.000Z"
        },
        {
          id: "message-agent",
          turnId: "turn-completed",
          kind: "agent-reply",
          text: "I will.",
          provider: { id: "codex", label: "Codex" },
          state: "completed",
          createdAt: "2026-07-11T02:00:00.000Z"
        }
      ]
    }),
    createTurn({
      id: "turn-safe-retry",
      status: "provider-failed",
      computerUseState: "none",
      createdAt: "2026-07-11T02:01:00.000Z",
      messages: [
        {
          id: "message-failed-agent",
          turnId: "turn-safe-retry",
          kind: "agent-reply",
          text: "Provider unavailable.",
          provider: { id: "codex", label: "Codex" },
          state: "error",
          createdAt: "2026-07-11T02:01:00.000Z"
        }
      ]
    })
  ]
});

const ARCHIVED_SESSION = createSession({
  id: "session-archived",
  title: "Archived",
  updatedAt: "2026-07-10T02:00:00.000Z",
  archivedAt: "2026-07-11T02:05:00.000Z"
});

const DELETED_SESSION = createSession({
  id: "session-deleted",
  title: "Deleted",
  updatedAt: "2026-07-09T02:00:00.000Z",
  archivedAt: "2026-07-10T02:05:00.000Z",
  deletedAt: "2026-07-11T02:06:00.000Z"
});

const SNAPSHOT: ConversationHistorySnapshot = {
  schemaVersion: 1,
  lastActiveSessionId: ACTIVE_SESSION.id,
  sessions: [DELETED_SESSION, ARCHIVED_SESSION, ACTIVE_SESSION]
};

describe("app conversation state", () => {
  it("creates an inert empty snapshot without inventing an active session", () => {
    expect(createEmptyConversationHistorySnapshot()).toEqual({
      schemaVersion: 1,
      lastActiveSessionId: null,
      sessions: []
    });
  });

  it("reads the last active non-archived session and falls back deterministically", () => {
    expect(readActiveConversationSession(SNAPSHOT)?.id).toBe("session-active");
    expect(readActiveConversationSession({
      ...SNAPSHOT,
      lastActiveSessionId: "session-archived"
    })?.id).toBe("session-active");
    expect(readActiveConversationSession({
      ...SNAPSHOT,
      lastActiveSessionId: null,
      sessions: [
        createSession({ id: "older", title: "Older", updatedAt: "2026-07-01T00:00:00.000Z" }),
        createSession({ id: "newer", title: "Newer", updatedAt: "2026-07-02T00:00:00.000Z" })
      ]
    })?.id).toBe("newer");
  });

  it("groups active, archived, and soft-deleted sessions without overlap", () => {
    expect(readConversationSessionState(ACTIVE_SESSION)).toBe("active");
    expect(readConversationSessionState(ARCHIVED_SESSION)).toBe("archived");
    expect(readConversationSessionState(DELETED_SESSION)).toBe("deleted");

    const groups = readConversationSessionGroups(SNAPSHOT);
    expect(groups.active.map((session) => session.id)).toEqual(["session-active"]);
    expect(groups.archived.map((session) => session.id)).toEqual(["session-archived"]);
    expect(groups.deleted.map((session) => session.id)).toEqual(["session-deleted"]);
  });

  it("flattens typed messages with their canonical turn outcome and retry eligibility", () => {
    const rows = readConversationMessageRows(ACTIVE_SESSION);

    expect(rows.map((row) => ({
      kind: row.message.kind,
      turnId: row.turn.id,
      outcome: row.turn.status,
      retryEligible: row.retryEligible
    }))).toEqual([
      {
        kind: "user-text",
        turnId: "turn-completed",
        outcome: "completed",
        retryEligible: false
      },
      {
        kind: "agent-reply",
        turnId: "turn-completed",
        outcome: "completed",
        retryEligible: false
      },
      {
        kind: "agent-reply",
        turnId: "turn-safe-retry",
        outcome: "provider-failed",
        retryEligible: true
      }
    ]);
  });

  it("creates retry requests only from shared-domain eligible turns", () => {
    const safeTurn = ACTIVE_SESSION.turns[1];
    expect(createConversationRetryRequest(
      ACTIVE_SESSION,
      safeTurn,
      () => "retry-request-123"
    )).toEqual({
      sessionId: "session-active",
      turnId: "turn-safe-retry",
      requestId: "retry-request-123"
    });

    expect(createConversationRetryRequest(
      ACTIVE_SESSION,
      createTurn({
        id: "unsafe-turn",
        status: "provider-failed",
        computerUseState: "finished"
      }),
      () => "must-not-be-used"
    )).toBeNull();
  });

  it("only offers retry for the latest attempt in a submission lineage", () => {
    const staleFailure = createTurn({
      id: "turn-stale-failure",
      status: "provider-failed",
      submissionId: "submission-retry-lineage",
      attempt: 1,
      messages: [{
        id: "message-stale-failure",
        turnId: "turn-stale-failure",
        kind: "agent-reply",
        text: "Provider unavailable.",
        provider: { id: "codex", label: "Codex" },
        state: "error",
        createdAt: "2026-07-11T02:10:00.000Z"
      }]
    });
    const completedRetry = createTurn({
      id: "turn-completed-retry",
      status: "completed",
      submissionId: "submission-retry-lineage",
      attempt: 2,
      retryOfTurnId: staleFailure.id
    });
    const session = createSession({
      id: "session-retry-lineage",
      title: "Retry lineage",
      updatedAt: "2026-07-11T02:11:00.000Z",
      turns: [staleFailure, completedRetry]
    });

    expect(readConversationMessageRows(session).find(
      (row) => row.turn.id === staleFailure.id
    )?.retryEligible).toBe(false);
    expect(createConversationRetryRequest(
      session,
      staleFailure,
      () => "must-not-be-used"
    )).toBeNull();
  });

  it("formats valid timestamps compactly and keeps invalid values explicit", () => {
    expect(formatConversationTimestamp("2026-07-11T02:00:00.000Z", "zh-CN")).not.toBe("未知时间");
    expect(formatConversationTimestamp("not-a-date", "zh-CN")).toBe("未知时间");
  });
});

function createSession({
  id,
  title,
  updatedAt,
  turns = [],
  archivedAt,
  deletedAt
}: {
  id: string;
  title: string;
  updatedAt: string;
  turns?: ConversationTurn[];
  archivedAt?: string;
  deletedAt?: string;
}): ConversationSession {
  return {
    id,
    title,
    titleSource: "user",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt,
    ...(archivedAt ? { archivedAt } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    turns
  };
}

function createTurn({
  id,
  status,
  computerUseState = "none",
  createdAt = "2026-07-11T01:59:00.000Z",
  messages = [],
  submissionId = `submission-${id}`,
  attempt = 1,
  retryOfTurnId
}: {
  id: string;
  status: ConversationTurn["status"];
  computerUseState?: ConversationTurn["computerUseState"];
  createdAt?: string;
  messages?: ConversationTurn["messages"];
  submissionId?: string;
  attempt?: number;
  retryOfTurnId?: string;
}): ConversationTurn {
  return {
    id,
    submissionId,
    attempt,
    ...(retryOfTurnId ? { retryOfTurnId } : {}),
    createdAt,
    updatedAt: createdAt,
    status,
    provider: { id: "codex", label: "Codex" },
    computerUseState,
    messages
  };
}
