import type { AssistantAgentTurnResult } from "./assistant-agent.js";
import {
  CONVERSATION_HISTORY_SCHEMA_VERSION,
  type ConversationHistorySnapshot,
  type ConversationProviderIdentity,
  type ConversationRetryResult,
  type ConversationTurn
} from "../shared/conversation-history.js";
import {
  createConversationSessionStore,
  type ConversationRetryPrepareResult
} from "./conversation-session-store.js";

const PROVIDER_RETRY_COMPLETED_MESSAGE = "Background Agent retry completed.";
const PROVIDER_RETRY_FAILED_MESSAGE = "Background Agent retry failed. You can retry safely.";
const PROVIDER_RETRY_STOPPED_MESSAGE = "Background Agent retry stopped.";
const COMPUTER_USE_BLOCKED_MESSAGE = "Computer Use is disabled during provider-only retry.";
const UNSAFE_RETRY_MESSAGE = "This turn is not safe to retry.";
const RETRY_NOT_FOUND_MESSAGE = "Conversation turn not found.";
const RETRY_IN_PROGRESS_MESSAGE = "Retry is already in progress.";
const RETRY_STORAGE_ERROR_MESSAGE = "Conversation retry could not be saved.";

type ConversationSessionStore = ReturnType<typeof createConversationSessionStore>;

export interface ConversationSafeRetryProviderContext {
  turnId: string;
  retryOfTurnId: string;
  provider: ConversationProviderIdentity;
}

export type ConversationSafeRetryProviderRunner = (
  userInput: string,
  context: ConversationSafeRetryProviderContext
) => Promise<AssistantAgentTurnResult>;

export interface RunConversationSafeRetryInput {
  sessionId: string;
  turnId: string;
  requestId: string;
  store: ConversationSessionStore;
  runProvider: ConversationSafeRetryProviderRunner;
  signal?: AbortSignal;
}

/**
 * Retries only the Background Agent portion of a failed conversation turn.
 *
 * The retry attempt and request-id dedupe marker are committed by the canonical
 * session store before the provider is invoked. A retry never enters the
 * Computer Use planner, approval, replay, grant, or execution paths.
 */
export async function runConversationSafeRetry({
  sessionId,
  turnId,
  requestId,
  store,
  runProvider,
  signal
}: RunConversationSafeRetryInput): Promise<ConversationRetryResult> {
  let prepared: ConversationRetryPrepareResult;
  try {
    prepared = store.prepareRetry({ sessionId, turnId, requestId });
  } catch {
    return createStorageErrorResult(store);
  }

  if (prepared.status === "blocked") {
    return {
      status: prepared.reason === "not-found" ? "not-found" : "unsafe-retry-blocked",
      message: prepared.reason === "not-found" ? RETRY_NOT_FOUND_MESSAGE : UNSAFE_RETRY_MESSAGE,
      snapshot: prepared.snapshot
    };
  }

  if (prepared.status === "duplicate") {
    return readDuplicateResult(prepared);
  }

  const preparation = prepared.preparation;
  const retryTurn = findTurn(
    preparation.snapshot,
    preparation.sessionId,
    preparation.turnId
  );
  if (!retryTurn) {
    return createStorageErrorResult(store, preparation.snapshot);
  }

  let providerTurn: AssistantAgentTurnResult;
  try {
    providerTurn = await runProvider(preparation.userInput, {
      turnId: preparation.turnId,
      retryOfTurnId: preparation.retryOfTurnId,
      provider: retryTurn.provider
    });
  } catch {
    if (signal?.aborted) {
      return recordProviderCancellation(store, preparation.sessionId, preparation.turnId);
    }
    return recordProviderFailure(store, preparation.sessionId, preparation.turnId);
  }

  if (signal?.aborted || providerTurn.status === "cancelled") {
    return recordProviderCancellation(store, preparation.sessionId, preparation.turnId);
  }

  const computerUseTool = providerTurn.toolCalls.find(
    (toolCall) => toolCall.type === "computer-use"
  );
  if (computerUseTool || providerTurn.route.kind !== "chat") {
    const toolCallId = computerUseTool?.id ?? `${preparation.turnId}-blocked-tool-1`;
    const command = computerUseTool?.input.command ?? preparation.userInput;
    const route = computerUseTool?.input.route.kind ?? providerTurn.route.kind;

    try {
      store.recordComputerUseRequest({
        sessionId: preparation.sessionId,
        turnId: preparation.turnId,
        toolCallId,
        command,
        route,
        text: COMPUTER_USE_BLOCKED_MESSAGE
      });
      const snapshot = store.recordComputerUseResult({
        sessionId: preparation.sessionId,
        turnId: preparation.turnId,
        toolCallId,
        status: "blocked",
        summary: COMPUTER_USE_BLOCKED_MESSAGE,
        text: COMPUTER_USE_BLOCKED_MESSAGE
      });
      return {
        status: "computer-use-blocked",
        message: COMPUTER_USE_BLOCKED_MESSAGE,
        snapshot
      };
    } catch {
      return createStorageErrorResult(store, preparation.snapshot);
    }
  }

  if (providerTurn.id !== preparation.turnId || providerTurn.status !== "completed") {
    return recordProviderFailure(store, preparation.sessionId, preparation.turnId);
  }

  try {
    const snapshot = store.recordProviderSuccess({
      sessionId: preparation.sessionId,
      turnId: preparation.turnId,
      text: providerTurn.message,
      provider: retryTurn.provider
    });
    return {
      status: "completed",
      message: PROVIDER_RETRY_COMPLETED_MESSAGE,
      snapshot
    };
  } catch {
    return createStorageErrorResult(store, preparation.snapshot);
  }
}

function recordProviderFailure(
  store: ConversationSessionStore,
  sessionId: string,
  turnId: string
): ConversationRetryResult {
  try {
    const snapshot = store.failProviderTurn({
      sessionId,
      turnId,
      text: "Background Agent retry failed."
    });
    return {
      status: "provider-failed",
      message: PROVIDER_RETRY_FAILED_MESSAGE,
      snapshot
    };
  } catch {
    return createStorageErrorResult(store);
  }
}

function recordProviderCancellation(
  store: ConversationSessionStore,
  sessionId: string,
  turnId: string
): ConversationRetryResult {
  try {
    const snapshot = store.stopTurn({
      sessionId,
      turnId,
      reason: PROVIDER_RETRY_STOPPED_MESSAGE
    });
    return {
      status: "cancelled",
      message: PROVIDER_RETRY_STOPPED_MESSAGE,
      snapshot
    };
  } catch {
    return createStorageErrorResult(store);
  }
}

function readDuplicateResult(
  duplicate: Extract<ConversationRetryPrepareResult, { status: "duplicate" }>
): ConversationRetryResult {
  const turn = findTurn(duplicate.snapshot, duplicate.sessionId, duplicate.turnId);
  if (!turn) {
    return {
      status: "storage-error",
      message: RETRY_STORAGE_ERROR_MESSAGE,
      snapshot: duplicate.snapshot
    };
  }

  const blockedResult = turn.messages.some(
    (message) => message.kind === "result" && message.status === "blocked"
  );
  const hasComputerUse = turn.computerUseState !== "none"
    || turn.messages.some((message) => message.kind === "computer-use-request");
  if (blockedResult || hasComputerUse) {
    return {
      status: "computer-use-blocked",
      message: COMPUTER_USE_BLOCKED_MESSAGE,
      snapshot: duplicate.snapshot
    };
  }

  if (turn.status === "pending") {
    return {
      status: "retry-in-progress",
      message: RETRY_IN_PROGRESS_MESSAGE,
      snapshot: duplicate.snapshot
    };
  }
  if (turn.status === "provider-failed") {
    return {
      status: "provider-failed",
      message: PROVIDER_RETRY_FAILED_MESSAGE,
      snapshot: duplicate.snapshot
    };
  }
  if (turn.status === "stopped") {
    return {
      status: "cancelled",
      message: PROVIDER_RETRY_STOPPED_MESSAGE,
      snapshot: duplicate.snapshot
    };
  }
  if (
    turn.status === "completed"
    && turn.messages.some((message) => message.kind === "agent-reply" && message.state === "completed")
  ) {
    return {
      status: "completed",
      message: PROVIDER_RETRY_COMPLETED_MESSAGE,
      snapshot: duplicate.snapshot
    };
  }

  return {
    status: "unsafe-retry-blocked",
    message: UNSAFE_RETRY_MESSAGE,
    snapshot: duplicate.snapshot
  };
}

function createStorageErrorResult(
  store: ConversationSessionStore,
  fallback?: ConversationHistorySnapshot
): ConversationRetryResult {
  let snapshot = fallback;
  try {
    snapshot = store.read();
  } catch {
    // Use the last known canonical snapshot when the store itself is unavailable.
  }
  return {
    status: "storage-error",
    message: RETRY_STORAGE_ERROR_MESSAGE,
    snapshot: snapshot ?? createEmptySnapshot()
  };
}

function findTurn(
  snapshot: ConversationHistorySnapshot,
  sessionId: string,
  turnId: string
): ConversationTurn | undefined {
  return snapshot.sessions
    .find((session) => session.id === sessionId)?.turns
    .find((turn) => turn.id === turnId);
}

function createEmptySnapshot(): ConversationHistorySnapshot {
  return {
    schemaVersion: CONVERSATION_HISTORY_SCHEMA_VERSION,
    lastActiveSessionId: null,
    sessions: []
  };
}
