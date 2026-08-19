import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Task Control main-process wiring", () => {
  it("owns one current plan, exposes hydration, and clears a terminal card for the next turn", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const runCommand = sliceSource(source, "async function runCommandTask(", "async function createWindow()");
    const clearIndex = runCommand.indexOf("taskControlStore.clear();");
    const beginTurnIndex = runCommand.indexOf("conversationStore.beginTurn({");

    expect(source).toContain("const taskControlStore = createTaskControlStore();");
    expect(source).toContain("startTaskControlForComputerUse({");
    expect(source).toContain("emitTaskControlEventForTool(window, event, toolIdentity)");
    expect(source).toContain('ipcMain.handle("skfiy:get-task-control", () => {');
    expect(source).toContain("return taskControlStore.read();");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(beginTurnIndex);
  });

  it("binds approval gates to plan ids and gives Stop an authoritative Task Control outcome", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const approval = sliceSource(
      source,
      "function requireComputerUseApproval({",
      "function completeComputerUseToolCall("
    );
    const stop = sliceSource(
      source,
      'ipcMain.handle("skfiy:stop-task"',
      'ipcMain.handle("skfiy:get-permissions"'
    );

    expect(approval).toContain('gate === "action-plan"');
    expect(approval).toContain("planId !== taskControl.plan.planId");
    expect(approval).toContain("planId !== createDerivedComputerUsePlanId(");
    expect(approval).toContain("createPendingApproval({");
    expect(stop).toContain("createTaskControlStopMessage(activeTaskControl)");
    expect(stop).toContain("emitTaskControlTurnReplayTaskEvent(window, stopTask.event");
    expect(stop.indexOf("if (activeTaskControl)"))
      .toBeLessThan(stop.indexOf('if (stopTask.delivery === "turn-replay"'));
  });

  it("binds an external Ghostty planner result before any plan approval or execution", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const binder = sliceSource(
      source,
      "async function bindGhosttyPlannerCommand({",
      "function dispatchComputerUseTaskEvent({"
    );
    const continuation = sliceSource(
      source,
      "async function continueComputerUseTask({",
      "async function runTmuxSupervisionCommandTask("
    );
    const runCommand = sliceSource(source, "async function runCommandTask(", "async function createWindow()");

    expect(binder.indexOf("await resolvePlannerCommand({"))
      .toBeLessThan(binder.indexOf("taskControlStore.bindPlan({"));
    expect(binder.indexOf("await resolvePlannerCommand({"))
      .toBeLessThan(binder.indexOf("const latestAppPolicy = decideAppPolicy("));
    expect(binder).toContain("createAppPolicyBoundComputerUsePlanPreview({");
    expect(continuation).not.toContain("resolvePlannerCommand({");
    expect(continuation).toContain("appPolicyPreflight.kind === \"approval_required\"");
    expect(continuation).toContain("taskControl = taskControlStore.bindPlan({");
    expect(continuation).toContain("taskControl.plan.approvalRequired\n      || appPolicyPreflight.kind === \"approval_required\"");
    expect(runCommand.indexOf("await bindGhosttyPlannerCommand({"))
      .toBeLessThan(runCommand.indexOf("await continueComputerUseTask({"));
    expect(runCommand).toContain("activeComputerUseRoute = routeDecision.executionRoute;");
  });

  it("rejects stale approval and denial IPC before mutating the active task", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const approve = sliceSource(
      source,
      'ipcMain.handle("skfiy:approve-task"',
      'ipcMain.handle("skfiy:deny-task"'
    );
    const deny = sliceSource(
      source,
      'ipcMain.handle("skfiy:deny-task"',
      'ipcMain.handle("skfiy:take-screenshot"'
    );

    for (const handler of [approve, deny]) {
      expect(handler).toContain("readTaskApprovalDecisionRequest(value)");
      expect(handler).toContain("taskControl.executionId !== request.executionId");
      expect(handler).toContain("approval.planId !== request.planId");
      expect(handler).toContain("taskControl.approval?.planId !== request.planId");
    }
    expect(deny.indexOf("throw new Error("))
      .toBeLessThan(deny.indexOf("clearActiveComputerUseTask();"));
  });
});

function sliceSource(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
