import { describe, expect, it } from "vitest";

import {
  ConversationSessionStorageError,
  createConversationSessionStore,
  createConversationSessionStorePath,
  type ConversationSessionStoreIo
} from "./conversation-session-store";

describe("conversation session store", () => {
  it("persists stable sessions, titles, timestamps, and the last active session", () => {
    const files = new Map<string, string>();
    const clock = createClock("2026-07-11T01:00:00.000Z");
    const ids = createIds();
    const store = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(files),
      now: clock.now,
      createId: ids.create
    });

    const initial = store.read();
    expect(initial.sessions).toHaveLength(1);
    expect(initial.lastActiveSessionId).toBe(initial.sessions[0].id);

    const first = store.beginTurn({
      userInput: "  Plan   the launch checklist  ",
      provider: { id: "codex", label: "Codex" }
    });
    store.recordProviderSuccess({
      sessionId: first.sessionId,
      turnId: first.turnId,
      text: "Here is the checklist.",
      provider: { id: "codex", label: "Codex" }
    });
    expect(store.read().sessions[0]).toMatchObject({
      title: "Plan the launch checklist",
      titleSource: "generated",
      turns: [{ status: "completed" }]
    });

    store.renameSession(first.sessionId, "Launch room");
    const secondSession = store.startSession();
    store.switchSession(first.sessionId);
    const restored = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(files),
      now: clock.now,
      createId: ids.create
    }).read();

    expect(restored.lastActiveSessionId).toBe(first.sessionId);
    expect(restored.sessions.find((session) => session.id === first.sessionId)).toMatchObject({
      title: "Launch room",
      titleSource: "user"
    });
    expect(restored.sessions.some((session) => session.id === secondSession.lastActiveSessionId)).toBe(true);
  });

  it("archives, soft-deletes, and restores sessions without losing their identity or transcript", () => {
    const files = new Map<string, string>();
    const store = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(files),
      createId: createIds().create
    });
    const originalId = store.read().lastActiveSessionId as string;
    const turn = store.beginTurn({
      sessionId: originalId,
      userInput: "Keep this transcript",
      provider: { id: "codex", label: "Codex" }
    });
    store.recordProviderSuccess({
      sessionId: originalId,
      turnId: turn.turnId,
      text: "Kept.",
      provider: { id: "codex", label: "Codex" }
    });

    const archived = store.archiveSession(originalId);
    expect(archived.sessions.find((session) => session.id === originalId)?.archivedAt).toBeTruthy();
    expect(archived.lastActiveSessionId).not.toBe(originalId);
    expect(store.readRecallableRecords()).toEqual([]);

    const restored = store.restoreSession(originalId);
    expect(restored.lastActiveSessionId).toBe(originalId);
    const restoredSession = restored.sessions.find((session) => session.id === originalId);
    expect(restoredSession).toMatchObject({
      id: originalId,
      turns: [{ messages: expect.arrayContaining([expect.objectContaining({ text: "Kept." })]) }]
    });
    expect(restoredSession).not.toHaveProperty("archivedAt");
    expect(restoredSession).not.toHaveProperty("deletedAt");

    const deleted = store.deleteSession(originalId);
    expect(deleted.sessions.find((session) => session.id === originalId)?.deletedAt).toBeTruthy();
    expect(store.readRecallableRecords()).toEqual([]);
    expect(store.restoreSession(originalId).lastActiveSessionId).toBe(originalId);
  });

  it("refuses to archive or delete a session with an active turn", () => {
    const store = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(new Map()),
      createId: createIds().create
    });
    const active = store.beginTurn({
      userInput: "Still running",
      provider: { id: "codex", label: "Codex" }
    });

    expect(() => store.archiveSession(active.sessionId)).toThrow("active turn");
    expect(() => store.deleteSession(active.sessionId)).toThrow("active turn");
  });

  it("records typed Computer Use request, approval, write-ahead dispatch, result, and stop messages", () => {
    const store = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(new Map()),
      createId: createIds().create
    });
    const turn = store.beginTurn({
      userInput: "Open the report",
      provider: { id: "codex", label: "Codex" }
    });
    store.recordProviderSuccess({
      ...turn,
      text: "I need Computer Use.",
      provider: { id: "codex", label: "Codex" }
    });
    store.recordComputerUseRequest({
      ...turn,
      toolCallId: `${turn.turnId}-tool-1`,
      command: "open report",
      route: "finder",
      text: "Computer Use requested for Finder."
    });
    store.recordApproval({
      ...turn,
      toolCallId: `${turn.turnId}-tool-1`,
      decision: "required",
      text: "Approval required."
    });
    store.markComputerUseDispatching(turn);

    let storedTurn = readTurn(store, turn.sessionId, turn.turnId);
    expect(storedTurn.computerUseState).toBe("dispatching");
    expect(storedTurn.messages.map((message) => message.kind)).toEqual([
      "user-text",
      "agent-reply",
      "computer-use-request",
      "approval"
    ]);

    store.recordComputerUseResult({
      ...turn,
      toolCallId: `${turn.turnId}-tool-1`,
      status: "completed",
      summary: "Report opened.",
      text: "Computer Use completed: Report opened."
    });
    storedTurn = readTurn(store, turn.sessionId, turn.turnId);
    expect(storedTurn).toMatchObject({ status: "completed", computerUseState: "finished" });
    expect(storedTurn.messages.at(-1)).toMatchObject({ kind: "result", status: "completed" });

    const stopped = store.beginTurn({
      userInput: "Another action",
      provider: { id: "codex", label: "Codex" }
    });
    store.recordComputerUseRequest({
      ...stopped,
      toolCallId: `${stopped.turnId}-tool-1`,
      command: "do action",
      route: "chrome",
      text: "Computer Use requested."
    });
    store.markComputerUseDispatching(stopped);
    store.stopTurn({ ...stopped, reason: "Task stopped." });
    expect(readTurn(store, stopped.sessionId, stopped.turnId)).toMatchObject({
      status: "stopped",
      computerUseState: "unknown",
      messages: expect.arrayContaining([expect.objectContaining({ kind: "stopped" })])
    });
  });

  it.each(["denied", "blocked", "failed", "cancelled"] as const)(
    "preserves the distinct %s Computer Use outcome on the turn",
    (status) => {
      const store = createConversationSessionStore({
        baseDir: "/tmp/skfiy",
        io: createIo(new Map()),
        createId: createIds().create
      });
      const turn = store.beginTurn({
        userInput: `Exercise ${status}`,
        provider: { id: "codex", label: "Codex" }
      });
      store.recordComputerUseRequest({
        ...turn,
        toolCallId: `${turn.turnId}-tool-1`,
        command: `exercise ${status}`,
        route: "finder",
        text: "Computer Use requested."
      });
      store.recordComputerUseResult({
        ...turn,
        toolCallId: `${turn.turnId}-tool-1`,
        status,
        summary: `Computer Use ${status}.`,
        text: `Computer Use ${status}.`
      });

      expect(readTurn(store, turn.sessionId, turn.turnId)).toMatchObject({
        status,
        computerUseState: "finished",
        messages: expect.arrayContaining([
          expect.objectContaining({ kind: "result", status })
        ])
      });
    }
  );

  it("atomically prepares and deduplicates only the latest provider-only failed attempt", () => {
    const store = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(new Map()),
      createId: createIds().create
    });
    const failed = store.beginTurn({
      userInput: "Explain the build failure",
      provider: { id: "codex", label: "Codex" }
    });
    store.failProviderTurn({ ...failed, text: "Provider unavailable." });

    const prepared = store.prepareRetry({
      sessionId: failed.sessionId,
      turnId: failed.turnId,
      requestId: "retry-request-1"
    });
    expect(prepared).toMatchObject({
      status: "prepared",
      preparation: {
        sessionId: failed.sessionId,
        retryOfTurnId: failed.turnId,
        submissionId: expect.any(String),
        userInput: "Explain the build failure"
      }
    });
    if (prepared.status !== "prepared") throw new Error("expected prepared retry");
    expect(prepared.preparation.turnId).not.toBe(failed.turnId);
    expect(readTurn(store, failed.sessionId, prepared.preparation.turnId)).toMatchObject({
      status: "pending",
      retryOfTurnId: failed.turnId,
      attempt: 2,
      messages: []
    });

    expect(store.prepareRetry({
      sessionId: failed.sessionId,
      turnId: failed.turnId,
      requestId: "retry-request-1"
    })).toMatchObject({
      status: "duplicate",
      turnId: prepared.preparation.turnId
    });
    expect(store.prepareRetry({
      sessionId: failed.sessionId,
      turnId: failed.turnId,
      requestId: "retry-request-2"
    })).toMatchObject({ status: "blocked", reason: "stale-attempt" });
  });

  it.each(["requested", "dispatching", "finished", "unknown"] as const)(
    "refuses provider retry after Computer Use becomes %s",
    (computerUseState) => {
      const store = createConversationSessionStore({
        baseDir: `/tmp/skfiy-${computerUseState}`,
        io: createIo(new Map()),
        createId: createIds().create
      });
      const failed = store.beginTurn({
        userInput: "Run something",
        provider: { id: "codex", label: "Codex" }
      });
      store.failProviderTurn({ ...failed, text: "Provider failed." });
      store.setComputerUseState({ ...failed, state: computerUseState });

      expect(store.prepareRetry({
        sessionId: failed.sessionId,
        turnId: failed.turnId,
        requestId: `retry-${computerUseState}`
      })).toMatchObject({ status: "blocked", reason: "unsafe-computer-use-state" });
    }
  );

  it("migrates each legacy recall record into an independent canonical session", () => {
    const files = new Map<string, string>();
    files.set("/tmp/skfiy/memory/sessions.jsonl", [
      JSON.stringify({
        turnId: "legacy-turn-1",
        createdAt: "2026-07-10T01:00:00.000Z",
        userInput: "First legacy prompt",
        assistantReply: "First reply",
        providerLabel: "Codex"
      }),
      "malformed",
      JSON.stringify({
        turnId: "legacy-turn-2",
        createdAt: "2026-07-10T02:00:00.000Z",
        userInput: "Second legacy prompt",
        assistantReply: "Second reply",
        providerLabel: "Codex"
      })
    ].join("\n"));

    const store = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(files),
      createId: createIds().create
    });
    expect(store.read().sessions).toHaveLength(2);
    expect(store.read().sessions.map((session) => session.turns.length)).toEqual([1, 1]);
    expect(store.readRecallableRecords().map((record) => record.turnId)).toEqual([
      "legacy-turn-1",
      "legacy-turn-2"
    ]);
    expect(files.has(createConversationSessionStorePath("/tmp/skfiy"))).toBe(true);
    expect(files.has("/tmp/skfiy/memory/sessions.jsonl")).toBe(true);
  });

  it("refuses corrupt or future canonical schemas without overwriting user data", () => {
    const path = createConversationSessionStorePath("/tmp/skfiy");
    for (const content of ["{broken", JSON.stringify({ schemaVersion: 2, sessions: [] })]) {
      const files = new Map([[path, content]]);
      expect(() => createConversationSessionStore({
        baseDir: "/tmp/skfiy",
        io: createIo(files),
        createId: createIds().create
      })).toThrow(ConversationSessionStorageError);
      expect(files.get(path)).toBe(content);
    }
  });

  it("recovers ambiguous in-flight dispatch as stopped and unknown after restart", () => {
    const files = new Map<string, string>();
    const ids = createIds();
    const store = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(files),
      createId: ids.create
    });
    const turn = store.beginTurn({
      userInput: "Mutate something",
      provider: { id: "codex", label: "Codex" }
    });
    store.recordComputerUseRequest({
      ...turn,
      toolCallId: `${turn.turnId}-tool-1`,
      command: "mutate",
      route: "finder",
      text: "Computer Use requested."
    });
    store.markComputerUseDispatching(turn);

    const restarted = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(files),
      createId: ids.create
    });
    expect(readTurn(restarted, turn.sessionId, turn.turnId)).toMatchObject({
      status: "stopped",
      computerUseState: "unknown"
    });
    expect(restarted.prepareRetry({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      requestId: "retry-after-restart"
    })).toMatchObject({ status: "blocked" });
  });

  it("recovers a provider-only pending attempt as retryable without claiming it stopped a mutation", () => {
    const files = new Map<string, string>();
    const ids = createIds();
    const store = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(files),
      createId: ids.create
    });
    const turn = store.beginTurn({
      userInput: "Explain after restart",
      provider: { id: "codex", label: "Codex" }
    });

    const restarted = createConversationSessionStore({
      baseDir: "/tmp/skfiy",
      io: createIo(files),
      createId: ids.create
    });
    expect(readTurn(restarted, turn.sessionId, turn.turnId)).toMatchObject({
      status: "provider-failed",
      computerUseState: "none",
      messages: [
        expect.objectContaining({ kind: "user-text" }),
        expect.objectContaining({ kind: "agent-reply", state: "error" })
      ]
    });
    expect(restarted.prepareRetry({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      requestId: "retry-provider-after-restart"
    })).toMatchObject({ status: "prepared" });
  });
});

function readTurn(
  store: ReturnType<typeof createConversationSessionStore>,
  sessionId: string,
  turnId: string
) {
  const turn = store.read().sessions
    .find((session) => session.id === sessionId)?.turns
    .find((candidate) => candidate.id === turnId);
  if (!turn) throw new Error(`missing turn ${sessionId}/${turnId}`);
  return turn;
}

function createIds() {
  let sequence = 0;
  return {
    create(kind: string) {
      sequence += 1;
      return `${kind}-${sequence}`;
    }
  };
}

function createClock(initial: string) {
  let current = new Date(initial).getTime();
  return {
    now() {
      const value = new Date(current);
      current += 1_000;
      return value;
    }
  };
}

function createIo(files: Map<string, string>): ConversationSessionStoreIo {
  return {
    exists: (targetPath) => files.has(targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => files.get(targetPath) ?? "",
    rename: (fromPath, toPath) => {
      const content = files.get(fromPath);
      if (content === undefined) throw new Error(`missing temp file ${fromPath}`);
      files.set(toPath, content);
      files.delete(fromPath);
    },
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    }
  };
}
