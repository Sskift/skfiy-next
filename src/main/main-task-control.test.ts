import { describe, expect, it } from "vitest";

import type { ComputerUsePlanPreview } from "../shared/task-control";
import { createTaskControlStore } from "./task-control-store";
import {
  advanceComputerUseTaskControl,
  createTaskControlExecutionId,
  createTaskControlStopMessage,
  decorateTaskEventWithTaskControl,
  readComputerUseTaskSideEffectState,
  startComputerUseTaskControl
} from "./main-task-control";
import { withRouteTaskEventMetadata, type TaskEvent } from "./task-event-view";
import { GHOSTTY_BUNDLE_ID } from "./task-routing";

const identity = { turnId: "turn-control-1", toolCallId: "tool-control-1" };
const executionId = "turn-control-1:tool-control-1";
const route = { kind: "ghostty", bundleId: GHOSTTY_BUNDLE_ID } as const;

describe("main Task Control projection", () => {
  it("uses the stable tool identity as the execution id", () => {
    expect(createTaskControlExecutionId(identity)).toBe(executionId);
  });

  it("projects waiting, approval, execution, verification, and completion", () => {
    const store = createTaskControlStore();
    startComputerUseTaskControl({
      store,
      identity,
      plan: createPlan(),
      message: "Plan ready."
    });

    expect(advance(store, { status: "waiting", message: "Waiting." })).toMatchObject({
      phase: "waiting",
      status: "waiting",
      sideEffectState: "none"
    });
    expect(advance(
      store,
      { status: "approval_required", message: "Approval required." },
      undefined,
      { gate: "action-plan", planId: "plan-control-1" }
    )).toMatchObject({
      phase: "approval",
      status: "approval_required"
    });
    expect(advance(store, { status: "executing", message: "Typing." }, "possible")).toMatchObject({
      phase: "executing",
      status: "executing",
      sideEffectState: "possible",
      replayAvailable: true
    });
    expect(advance(store, { status: "verifying", message: "Checking." }, "occurred")).toMatchObject({
      phase: "verifying",
      status: "verifying",
      sideEffectState: "occurred"
    });
    expect(advance(store, routed({ status: "completed", message: "Command completed." }))).toMatchObject({
      phase: "terminal",
      status: "completed",
      outcome: "completed",
      replayAvailable: true,
      recoveryActions: []
    });
  });

  it("maps typed terminal outcomes without conflating confirmation and failure", () => {
    const cases: Array<{
      event: TaskEvent;
      outcome: string;
      recoveryActions: string[];
    }> = [
      {
        event: routed({ status: "blocked", message: "Denied by app policy.", denialKind: "app_policy" }),
        outcome: "app_policy_denied",
        recoveryActions: ["revise_plan", "open_readiness"]
      },
      {
        event: routed({ status: "denied", message: "Task denied.", denialKind: "user" }),
        outcome: "user_denied",
        recoveryActions: ["revise_plan"]
      },
      {
        event: routed({ status: "needs_confirmation", message: "Verification needs confirmation." }),
        outcome: "confirmation_required",
        recoveryActions: ["retry_observation", "retry_verification", "revise_plan", "open_readiness"]
      },
      {
        event: routed({ status: "failed", message: "Verification failed." }),
        outcome: "failed",
        recoveryActions: ["retry_observation", "retry_verification", "revise_plan", "open_readiness"]
      }
    ];

    for (const [index, item] of cases.entries()) {
      const store = createTaskControlStore();
      const caseIdentity = { turnId: `turn-${index}`, toolCallId: `tool-${index}` };
      startComputerUseTaskControl({
        store,
        identity: caseIdentity,
        plan: createPlan({ planId: `plan-${index}` }),
        message: "Plan ready."
      });
      expect(advanceComputerUseTaskControl({
        store,
        executionId: createTaskControlExecutionId(caseIdentity),
        event: item.event
      })).toMatchObject({
        phase: "terminal",
        outcome: item.outcome,
        recoveryActions: item.recoveryActions
      });
    }
  });

  it("keeps Stop honest about side effects and decorates renderer events", () => {
    const store = createTaskControlStore();
    const started = startComputerUseTaskControl({
      store,
      identity,
      plan: createPlan(),
      message: "Plan ready."
    });
    expect(createTaskControlStopMessage(started)).toBe(
      "Task stopped. No external mutation was recorded before cancellation."
    );

    const executing = advance(store, { status: "executing", message: "Typing." }, "possible");
    expect(createTaskControlStopMessage(executing)).toBe(
      "Task stopped. Dispatched or completed actions, if any, were not undone."
    );

    const stopped = advance(store, routed({
      status: "cancelled",
      message: createTaskControlStopMessage(executing),
      stopTurnBehavior: {
        afterStatus: "cancelled",
        afterMessage: createTaskControlStopMessage(executing)
      }
    }));
    const decorated = decorateTaskEventWithTaskControl({
      status: "cancelled",
      message: stopped.message
    }, stopped);

    expect(stopped).toMatchObject({
      outcome: "cancelled",
      sideEffectState: "possible",
      recoveryActions: ["revise_plan"]
    });
    expect(decorated.taskControl).toEqual(stopped);
    decorated.taskControl!.plan.target = "mutated";
    expect(store.read()?.plan.target).toBe("skfiy-shell");
  });

  it("tracks possible and observed mutations without inventing side effects for read-only work", () => {
    const mutatingPlan = createPlan();
    const readOnlyPlan = createPlan({ mutating: false });

    expect(readComputerUseTaskSideEffectState({
      type: "typing",
      command: "mkdir fixture"
    }, mutatingPlan)).toBe("possible");
    expect(readComputerUseTaskSideEffectState({
      type: "started",
      command: "mkdir fixture",
      risk: {
        level: "medium",
        reason: "Command can modify local state.",
        requiresApproval: true
      }
    }, mutatingPlan, { actionApproved: false })).toBeUndefined();
    expect(readComputerUseTaskSideEffectState({
      type: "started",
      command: "mkdir fixture",
      risk: {
        level: "medium",
        reason: "Command can modify local state.",
        requiresApproval: true
      }
    }, mutatingPlan, { actionApproved: true })).toBe("possible");
    expect(readComputerUseTaskSideEffectState({
      type: "started",
      command: "Finder organization plan",
      risk: {
        level: "medium",
        reason: "Finder organization moves files.",
        requiresApproval: true
      }
    }, createPlan({ route: "finder" }), {
      actionApproved: true,
      finderPlanApproved: false,
      finderPlanConfirmationRequired: true
    })).toBeUndefined();
    expect(readComputerUseTaskSideEffectState({
      type: "started",
      command: "Finder organization plan",
      risk: {
        level: "medium",
        reason: "Finder organization moves files.",
        requiresApproval: true
      }
    }, createPlan({ route: "finder" }), {
      actionApproved: true,
      finderPlanApproved: true,
      finderPlanConfirmationRequired: true
    })).toBe("possible");
    expect(readComputerUseTaskSideEffectState({
      type: "started",
      command: "Finder absolute folder plan",
      risk: {
        level: "medium",
        reason: "Finder organization moves files.",
        requiresApproval: true
      }
    }, createPlan({ route: "finder" }), {
      actionApproved: true,
      finderPlanApproved: false,
      finderPlanConfirmationRequired: false
    })).toBe("possible");
    expect(readComputerUseTaskSideEffectState({
      type: "submitted",
      key: "enter"
    }, mutatingPlan)).toBe("possible");
    expect(readComputerUseTaskSideEffectState({
      type: "action_verified",
      actionType: "press_key",
      status: "passed"
    }, mutatingPlan)).toBe("occurred");
    expect(readComputerUseTaskSideEffectState({
      type: "completed",
      command: "mkdir fixture",
      summary: "Command completed."
    }, mutatingPlan)).toBe("occurred");
    expect(readComputerUseTaskSideEffectState({
      type: "completed",
      command: "pwd",
      summary: "pwd completed."
    }, readOnlyPlan)).toBe("none");
    expect(readComputerUseTaskSideEffectState({
      type: "screenshot_after",
      path: "/tmp/private/after.png",
      observation: {
        bundleId: GHOSTTY_BUNDLE_ID,
        isRunning: true,
        isActive: true,
        screenshotPath: "/tmp/private/after.png"
      }
    }, mutatingPlan)).toBeUndefined();
  });

  it("keeps screenshot paths out of the default Task Control message", () => {
    const store = createTaskControlStore();
    startComputerUseTaskControl({
      store,
      identity,
      plan: createPlan(),
      message: "Plan ready."
    });
    advance(store, { status: "executing", message: "Dispatched." }, "possible");

    const snapshot = advance(store, {
      status: "verifying",
      message: "Captured after screenshot: /tmp/private/after.png",
      replayRecord: {
        stage: "after",
        bundleId: GHOSTTY_BUNDLE_ID,
        isRunning: true,
        isActive: true,
        screenshotPath: "/tmp/private/after.png"
      }
    });

    expect(snapshot.message).toBe("Captured after observation evidence.");
    expect(snapshot.message).not.toContain("/tmp/private");
  });

  it("bounds untrusted orchestration messages before committing Task Control", () => {
    const store = createTaskControlStore();
    startComputerUseTaskControl({
      store,
      identity,
      plan: createPlan(),
      message: "Plan ready."
    });

    const snapshot = advance(store, {
      status: "executing",
      message: `Planner output ${"x".repeat(4_000)}\u0000ignored`
    });

    expect(snapshot.message.length).toBeLessThanOrEqual(2_000);
    expect(snapshot.message).not.toContain("\u0000");
  });
});

function advance(
  store: ReturnType<typeof createTaskControlStore>,
  event: TaskEvent,
  sideEffectState?: "none" | "possible" | "occurred",
  approval?: import("../shared/task-control").TaskControlApproval
) {
  return advanceComputerUseTaskControl({ store, executionId, event, sideEffectState, approval });
}

function routed(event: TaskEvent): TaskEvent {
  return withRouteTaskEventMetadata(event, route);
}

function createPlan(overrides: Partial<ComputerUsePlanPreview> = {}): ComputerUsePlanPreview {
  return {
    planId: "plan-control-1",
    route: "ghostty",
    appName: "Ghostty",
    target: "skfiy-shell",
    risk: {
      level: "medium",
      reason: "Command can modify local state.",
      requiresApproval: true
    },
    approvalRequired: true,
    expectedVerification: "Observe the command completion marker.",
    mutating: true,
    ...overrides
  };
}
