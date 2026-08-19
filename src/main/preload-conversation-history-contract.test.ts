import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("preload conversation history contract", () => {
  it("validates every canonical message, safety state, result, and IPC channel fail closed", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");
    const validator = source.slice(
      source.indexOf("function isConversationHistorySnapshot"),
      source.indexOf("const api: DesktopApi")
    );

    for (const kind of [
      "user-text",
      "agent-reply",
      "computer-use-request",
      "approval",
      "result",
      "stopped"
    ]) {
      expect(validator).toContain(`message.kind === "${kind}"`);
    }
    for (const state of ["none", "requested", "dispatching", "finished", "unknown"]) {
      expect(validator).toContain(`turn.computerUseState === "${state}"`);
    }
    for (const result of [
      "completed",
      "provider-failed",
      "cancelled",
      "computer-use-blocked",
      "unsafe-retry-blocked",
      "not-found",
      "retry-in-progress",
      "storage-error"
    ]) {
      expect(validator).toContain(`result.status === "${result}"`);
    }
    for (const channel of [
      "get-conversation-history",
      "start-conversation-session",
      "switch-conversation-session",
      "rename-conversation-session",
      "archive-conversation-session",
      "delete-conversation-session",
      "restore-conversation-session",
      "retry-conversation-turn",
      "conversation-history-changed"
    ]) {
      expect(source).toContain(`skfiy:${channel}`);
    }
    expect(source).toContain("function requireConversationHistorySnapshot");
    expect(source).toContain("Conversation history payload is invalid.");
    const historyApi = source.slice(
      source.indexOf("async getConversationHistory()"),
      source.indexOf("async retryConversationTurn(")
    );
    expect(historyApi).not.toContain("createEmptyConversationHistorySnapshot()");
  });
});
