import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("conversation history main-process wiring", () => {
  it("persists the user turn before provider generation and Computer Use before dispatch", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const runCommand = sliceSource(source, "async function runCommandTask(", "async function createWindow()");
    const beginIndex = runCommand.indexOf("conversationStore.beginTurn({");
    const providerIndex = runCommand.indexOf("await createAssistantAgentTaskTurn(command, {");
    const requestIndex = runCommand.indexOf("conversationStore.recordComputerUseRequest({");
    const planIndex = runCommand.indexOf("assistantComputerUseExecutor.planToolCall(");
    const continueIndex = runCommand.indexOf("await continueComputerUseTask({");

    expect(source).toContain("createConversationSessionStore({");
    expect(beginIndex).toBeGreaterThan(-1);
    expect(beginIndex).toBeLessThan(providerIndex);
    expect(providerIndex).toBeGreaterThan(-1);
    expect(runCommand).toContain("createTurnId: () => conversationTurn.turnId");
    expect(runCommand).toContain("const conversationProvider = readSelectedConversationProvider();");
    expect(runCommand).toContain("provider: conversationProvider");
    expect(runCommand).toContain("signal: providerController.signal");
    expect(requestIndex).toBeGreaterThan(providerIndex);
    expect(requestIndex).toBeLessThan(planIndex);
    expect(continueIndex).toBeGreaterThan(planIndex);
    expect(source).toContain("conversationStore.markComputerUseDispatching(");
    expect(runCommand).toContain("const plannedCommand = computerUsePlan.planInput.command;");
    expect(runCommand).toContain("emitAssistantToolPlanTaskEvent(window, assistantTurn, plannedCommand, route)");
    expect(runCommand).toContain("command: plannedCommand,");
  });

  it("owns session operations and retry in narrow IPC handlers", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");

    for (const channel of [
      "skfiy:get-conversation-history",
      "skfiy:start-conversation-session",
      "skfiy:switch-conversation-session",
      "skfiy:rename-conversation-session",
      "skfiy:archive-conversation-session",
      "skfiy:delete-conversation-session",
      "skfiy:restore-conversation-session",
      "skfiy:retry-conversation-turn"
    ]) {
      expect(source).toContain(`ipcMain.handle("${channel}"`);
    }

    const retryHandler = sliceSource(
      source,
      "ipcMain.handle(\"skfiy:retry-conversation-turn\"",
      "ipcMain.handle(\"skfiy:get-turn-replay\""
    );
    expect(retryHandler).toContain("retryConversationProviderTurn({");
    expect(retryHandler).toContain("isRetry: true");
    expect(retryHandler).not.toContain("runCommandTask(");
    expect(retryHandler).not.toContain("assistantComputerUseExecutor");
    const providerHelper = sliceSource(
      source,
      "async function createAssistantAgentTaskTurn(",
      "function emitAssistantToolPlanTaskEvent("
    );
    expect(providerHelper).toContain("const browserPageContext = isRetry\n    ? undefined");
    expect(source).toContain('ipcMain.handle("skfiy:get-conversation-history", () => {\n  return requireConversationSessionStore().read();');
  });

  it("aborts provider generation and records typed stopped history", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const stopHandler = sliceSource(
      source,
      "ipcMain.handle(\"skfiy:stop-task\"",
      "ipcMain.handle(\"skfiy:get-permissions\""
    );

    expect(stopHandler).toContain("activeAssistantTurnController?.abort(");
    expect(stopHandler).toContain("stopActiveConversationTurn(");
    expect(source).toContain("window.webContents.send(\"skfiy:conversation-history-changed\"");
  });

  it("marks Computer Use dispatching after policy checks but before external execution", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const continuation = sliceSource(
      source,
      "async function continueComputerUseTask(",
      "async function runTmuxSupervisionCommandTask("
    );
    const preflightIndex = continuation.indexOf("const appPolicyPreflight");
    const dispatchingIndex = continuation.lastIndexOf("markConversationDispatching();");
    const executionIndex = continuation.indexOf("const { controller, taskId } = startComputerUseTaskEpoch()");

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(dispatchingIndex).toBeGreaterThan(preflightIndex);
    expect(executionIndex).toBeGreaterThan(dispatchingIndex);
  });
});

function sliceSource(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
