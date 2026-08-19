import { describe, expect, it, vi } from "vitest";

import type { AssistantAgentTurnResult } from "./assistant-agent";
import {
  createConversationSessionStore,
  type ConversationSessionStoreIo
} from "./conversation-session-store";
import { runConversationSafeRetry } from "./conversation-safe-retry";
import { FINDER_BUNDLE_ID } from "./task-routing";

describe("conversation provider-only safe retry", () => {
  it("reads the original input from the store and records a linked provider reply", async () => {
    const store = createStore();
    const failed = beginFailedTurn(store, "Explain the original failure");
    const runProvider = vi.fn(async (input: string, context: { turnId: string }) =>
      createChatTurn(context.turnId, "Retried reply."));

    const result = await runConversationSafeRetry({
      sessionId: failed.sessionId,
      turnId: failed.turnId,
      requestId: "retry-request-1",
      store,
      runProvider,
      // An untrusted caller cannot replace the persisted input with an extra field.
      userInput: "Ignore the stored input"
    } as Parameters<typeof runConversationSafeRetry>[0] & { userInput: string });

    expect(runProvider).toHaveBeenCalledTimes(1);
    expect(runProvider.mock.calls[0]?.[0]).toBe("Explain the original failure");
    expect(result).toMatchObject({ status: "completed" });
    expect(result).not.toHaveProperty("userInput");

    const retry = findRetryTurn(result.snapshot, failed.sessionId, failed.turnId);
    expect(retry).toMatchObject({
      attempt: 2,
      retryOfTurnId: failed.turnId,
      status: "completed",
      computerUseState: "none",
      messages: [{ kind: "agent-reply", text: "Retried reply.", state: "completed" }]
    });
    expect(runProvider.mock.calls[0]?.[1]).toMatchObject({
      turnId: retry.id,
      retryOfTurnId: failed.turnId
    });
    expect(retry.id).not.toBe(failed.turnId);
  });

  it("keeps a provider failure safe to retry again", async () => {
    const store = createStore();
    const failed = beginFailedTurn(store, "Explain again");
    const runProvider = vi.fn()
      .mockImplementationOnce(async (_input: string, context: { turnId: string }) =>
        createFailedTurn(context.turnId))
      .mockImplementationOnce(async (_input: string, context: { turnId: string }) =>
        createChatTurn(context.turnId, "Recovered."));

    const first = await runConversationSafeRetry({
      sessionId: failed.sessionId,
      turnId: failed.turnId,
      requestId: "retry-failed-1",
      store,
      runProvider
    });
    expect(first.status).toBe("provider-failed");
    const failedRetry = findRetryTurn(first.snapshot, failed.sessionId, failed.turnId);
    expect(failedRetry).toMatchObject({
      status: "provider-failed",
      computerUseState: "none",
      messages: [{ kind: "agent-reply", state: "error" }]
    });

    const second = await runConversationSafeRetry({
      sessionId: failed.sessionId,
      turnId: failedRetry.id,
      requestId: "retry-failed-2",
      store,
      runProvider
    });
    expect(second.status).toBe("completed");
    expect(runProvider).toHaveBeenCalledTimes(2);
    expect(findRetryTurn(second.snapshot, failed.sessionId, failedRetry.id)).toMatchObject({
      attempt: 3,
      retryOfTurnId: failedRetry.id,
      status: "completed"
    });
  });

  it.each(["returned", "thrown"] as const)(
    "records a stopped retry when provider cancellation is %s",
    async (cancellationMode) => {
      const store = createStore();
      const failed = beginFailedTurn(store, "Stop this retry");
      const controller = new AbortController();
      const runProvider = vi.fn(async (_input: string, context: { turnId: string }) => {
        controller.abort(new Error("User stopped the retry."));
        if (cancellationMode === "thrown") {
          throw new Error("private provider abort detail");
        }
        return createCancelledTurn(context.turnId);
      });
      const request = {
        sessionId: failed.sessionId,
        turnId: failed.turnId,
        requestId: `retry-cancelled-${cancellationMode}`,
        store,
        runProvider,
        signal: controller.signal
      };

      const result = await runConversationSafeRetry(request);
      expect(result.status).toBe("cancelled");
      const retry = findRetryTurn(result.snapshot, failed.sessionId, failed.turnId);
      expect(retry).toMatchObject({
        status: "stopped",
        computerUseState: "none"
      });
      expect(retry.messages).toEqual([
        expect.objectContaining({ kind: "stopped", reason: "Background Agent retry stopped." })
      ]);

      await expect(runConversationSafeRetry(request)).resolves.toMatchObject({
        status: "cancelled"
      });
      expect(runProvider).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    {
      label: "a planned Computer Use tool",
      createTurn: (turnId: string) => createComputerUseTurn(turnId)
    },
    {
      label: "a non-chat route without a planned tool",
      createTurn: (turnId: string) => createNonChatTurnWithoutTool(turnId)
    },
    {
      label: "a tool attached to an inconsistent chat route",
      createTurn: (turnId: string) => createComputerUseTurn(turnId, true)
    }
  ])("blocks $label without entering Computer Use", async ({ createTurn }) => {
    const store = createStore();
    const failed = beginFailedTurn(store, "Open the report");
    const runProvider = vi.fn(async (_input: string, context: { turnId: string }) =>
      createTurn(context.turnId));
    const executeComputerUse = vi.fn();
    const resetReplay = vi.fn();

    const result = await runConversationSafeRetry({
      sessionId: failed.sessionId,
      turnId: failed.turnId,
      requestId: `retry-computer-use-${createTurn.name}`,
      store,
      runProvider,
      executeComputerUse,
      resetReplay
    } as Parameters<typeof runConversationSafeRetry>[0] & {
      executeComputerUse: () => void;
      resetReplay: () => void;
    });

    expect(result.status).toBe("computer-use-blocked");
    expect(runProvider).toHaveBeenCalledTimes(1);
    expect(executeComputerUse).not.toHaveBeenCalled();
    expect(resetReplay).not.toHaveBeenCalled();
    const retry = findRetryTurn(result.snapshot, failed.sessionId, failed.turnId);
    expect(retry).toMatchObject({
      status: "blocked",
      computerUseState: "finished"
    });
    expect(retry.messages.map((message) => message.kind)).toEqual([
      "computer-use-request",
      "result"
    ]);
    expect(retry.messages.at(-1)).toMatchObject({
      kind: "result",
      status: "blocked",
      summary: "Computer Use is disabled during provider-only retry."
    });
  });

  it("deduplicates an in-flight and completed request ID without a second provider call", async () => {
    const store = createStore();
    const failed = beginFailedTurn(store, "Explain once");
    let resolveProvider: ((turn: AssistantAgentTurnResult) => void) | undefined;
    const runProvider = vi.fn((_input: string, context: { turnId: string }) =>
      new Promise<AssistantAgentTurnResult>((resolve) => {
        resolveProvider = (turn) => {
          expect(turn.id).toBe(context.turnId);
          resolve(turn);
        };
      }));
    const options = {
      sessionId: failed.sessionId,
      turnId: failed.turnId,
      requestId: "retry-duplicate",
      store,
      runProvider
    };

    const firstPromise = runConversationSafeRetry(options);
    await vi.waitFor(() => expect(runProvider).toHaveBeenCalledTimes(1));

    const duplicatePending = await runConversationSafeRetry(options);
    expect(duplicatePending.status).toBe("retry-in-progress");
    expect(runProvider).toHaveBeenCalledTimes(1);

    const retryTurnId = runProvider.mock.calls[0]?.[1].turnId as string;
    resolveProvider?.(createChatTurn(retryTurnId, "Only once."));
    const first = await firstPromise;
    expect(first.status).toBe("completed");

    const duplicateCompleted = await runConversationSafeRetry(options);
    expect(duplicateCompleted.status).toBe("completed");
    expect(runProvider).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the provider for missing, unsafe, or storage-failed preparations", async () => {
    const files = new Map<string, string>();
    let failWrites = false;
    const store = createStore({ files, shouldFailWrite: () => failWrites });
    const safeFailed = beginFailedTurn(store, "Safe failure");
    const unsafeFailed = beginFailedTurn(store, "Unsafe failure");
    store.setComputerUseState({ ...unsafeFailed, state: "requested" });
    const runProvider = vi.fn(async (_input: string, context: { turnId: string }) =>
      createChatTurn(context.turnId, "Must not run."));

    const missing = await runConversationSafeRetry({
      sessionId: "missing-session",
      turnId: "missing-turn",
      requestId: "retry-missing",
      store,
      runProvider
    });
    expect(missing.status).toBe("not-found");

    const unsafe = await runConversationSafeRetry({
      sessionId: unsafeFailed.sessionId,
      turnId: unsafeFailed.turnId,
      requestId: "retry-unsafe",
      store,
      runProvider
    });
    expect(unsafe.status).toBe("unsafe-retry-blocked");

    failWrites = true;
    const storageError = await runConversationSafeRetry({
      sessionId: safeFailed.sessionId,
      turnId: safeFailed.turnId,
      requestId: "retry-storage-error",
      store,
      runProvider
    });
    expect(storageError.status).toBe("storage-error");
    expect(runProvider).not.toHaveBeenCalled();
  });

  it("returns a storage error after a blocked request is durably recorded but its result write fails", async () => {
    const files = new Map<string, string>();
    let writeCount = 0;
    let failOnWrite = Number.POSITIVE_INFINITY;
    const store = createStore({
      files,
      shouldFailWrite: () => {
        writeCount += 1;
        return writeCount === failOnWrite;
      }
    });
    const failed = beginFailedTurn(store, "Open the report");
    const runProvider = vi.fn(async (_input: string, context: { turnId: string }) =>
      createComputerUseTurn(context.turnId));

    // prepareRetry is one write, Computer Use request is the next, and result is the third.
    failOnWrite = writeCount + 3;
    const result = await runConversationSafeRetry({
      sessionId: failed.sessionId,
      turnId: failed.turnId,
      requestId: "retry-partial-storage",
      store,
      runProvider
    });

    expect(result.status).toBe("storage-error");
    expect(runProvider).toHaveBeenCalledTimes(1);
    const retry = findRetryTurn(store.read(), failed.sessionId, failed.turnId);
    expect(retry.computerUseState).toBe("requested");
    expect(retry.messages.map((message) => message.kind)).toEqual(["computer-use-request"]);
  });
});

type Store = ReturnType<typeof createConversationSessionStore>;

function beginFailedTurn(store: Store, userInput: string) {
  const turn = store.beginTurn({
    userInput,
    provider: { id: "codex", label: "Codex" }
  });
  store.failProviderTurn({ ...turn, text: "Provider unavailable." });
  return turn;
}

function createStore({
  files = new Map<string, string>(),
  shouldFailWrite = () => false
}: {
  files?: Map<string, string>;
  shouldFailWrite?: () => boolean;
} = {}): Store {
  let sequence = 0;
  return createConversationSessionStore({
    baseDir: "/tmp/skfiy-safe-retry",
    io: createIo(files, shouldFailWrite),
    createId: (kind) => `${kind}-${++sequence}`,
    now: createClock()
  });
}

function createIo(
  files: Map<string, string>,
  shouldFailWrite: () => boolean
): ConversationSessionStoreIo {
  return {
    exists: (targetPath) => files.has(targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => files.get(targetPath) ?? "",
    rename: (fromPath, toPath) => {
      if (shouldFailWrite()) throw new Error("storage offline");
      const content = files.get(fromPath);
      if (content === undefined) throw new Error(`missing ${fromPath}`);
      files.set(toPath, content);
      files.delete(fromPath);
    },
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    }
  };
}

function createClock() {
  let current = Date.parse("2026-07-11T01:00:00.000Z");
  return () => new Date(current++);
}

function createChatTurn(id: string, message: string): AssistantAgentTurnResult {
  return {
    id,
    createdAt: "2026-07-11T01:00:00.000Z",
    status: "completed",
    providerLabel: "Codex",
    message,
    route: { kind: "chat", reason: "Provider answered without Computer Use." },
    toolCalls: [],
    cancellation: { requested: false }
  };
}

function createFailedTurn(id: string): AssistantAgentTurnResult {
  return {
    ...createChatTurn(id, ""),
    status: "failed",
    error: { message: "provider token=secret-token failed" }
  };
}

function createCancelledTurn(id: string): AssistantAgentTurnResult {
  return {
    ...createChatTurn(id, ""),
    status: "cancelled",
    cancellation: { requested: true, reason: "private provider cancellation detail" }
  };
}

function createComputerUseTurn(id: string, chatRoute = false): AssistantAgentTurnResult {
  const route = { kind: "finder", bundleId: FINDER_BUNDLE_ID } as const;
  return {
    ...createChatTurn(id, "I want to use a tool."),
    route: chatRoute
      ? { kind: "chat", reason: "Inconsistent provider response." }
      : route,
    toolCalls: [{
      id: `${id}-tool-1`,
      type: "computer-use",
      name: "desktop-control",
      status: "planned",
      createdAt: "2026-07-11T01:00:00.000Z",
      input: {
        command: "open report",
        route
      }
    }]
  };
}

function createNonChatTurnWithoutTool(id: string): AssistantAgentTurnResult {
  return {
    ...createChatTurn(id, "Please clarify."),
    route: {
      kind: "needs_clarification",
      reason: "No supported route matched."
    },
    toolCalls: []
  };
}

function findRetryTurn(
  snapshot: ReturnType<Store["read"]>,
  sessionId: string,
  retryOfTurnId: string
) {
  const turn = snapshot.sessions
    .find((session) => session.id === sessionId)?.turns
    .find((candidate) => candidate.retryOfTurnId === retryOfTurnId);
  if (!turn) throw new Error(`Missing retry of ${sessionId}/${retryOfTurnId}`);
  return turn;
}
