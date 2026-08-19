import { describe, expect, it } from "vitest";

import {
  TASK_CONTROL_SCHEMA_VERSION,
  isComputerUsePlanPreview,
  isTaskControlSnapshot,
  type ComputerUsePlanPreview,
  type TaskControlSnapshot
} from "./task-control";

describe("task control contract", () => {
  it("accepts a bounded generic Computer Use plan preview", () => {
    for (const route of ["ghostty", "chrome", "finder", "tmux_supervision"] as const) {
      for (const level of ["low", "medium", "high", "blocked"] as const) {
        expect(isComputerUsePlanPreview({
          ...createPlan(),
          route,
          risk: {
            ...createPlan().risk,
            level
          },
          approvalRequired: level !== "blocked",
          mutating: level !== "blocked"
        })).toBe(true);
      }
    }
  });

  it("rejects malformed, unbounded, and extensible plan previews", () => {
    expect(isComputerUsePlanPreview({
      ...createPlan(),
      route: "generic"
    })).toBe(false);
    expect(isComputerUsePlanPreview({
      ...createPlan(),
      target: "x".repeat(2_001)
    })).toBe(false);
    expect(isComputerUsePlanPreview({
      ...createPlan(),
      risk: {
        ...createPlan().risk,
        extra: "not part of schema v1"
      }
    })).toBe(false);
    expect(isComputerUsePlanPreview({
      ...createPlan(),
      extra: "not part of schema v1"
    })).toBe(false);
    expect(isComputerUsePlanPreview({
      ...createPlan(),
      risk: {
        ...createPlan().risk,
        level: "blocked"
      },
      approvalRequired: true,
      mutating: false
    })).toBe(false);
    expect(isComputerUsePlanPreview({
      ...createPlan(),
      risk: {
        ...createPlan().risk,
        level: "blocked"
      },
      approvalRequired: false,
      mutating: true
    })).toBe(false);
  });

  it("accepts active waiting and verifying snapshots", () => {
    expect(isTaskControlSnapshot(createSnapshot())).toBe(true);
    expect(isTaskControlSnapshot(createSnapshot({
      phase: "verifying",
      status: "verifying",
      message: "Checking that the command result is visible.",
      sideEffectState: "occurred",
      replayAvailable: true
    }))).toBe(true);
  });

  it("requires plan-bound approval context and preserves safe Finder preview details", () => {
    expect(isTaskControlSnapshot(createSnapshot({
      phase: "approval",
      status: "approval_required",
      approval: {
        gate: "action-plan",
        planId: "plan-1"
      }
    }))).toBe(true);
    expect(isTaskControlSnapshot(createSnapshot({
      phase: "approval",
      status: "approval_required"
    }))).toBe(false);
    expect(isTaskControlSnapshot(createSnapshot({
      phase: "approval",
      status: "approval_required",
      approval: {
        gate: "finder-plan",
        planId: "plan-1:derived",
        finderPlanPreview: {
          rootPath: "/tmp/fixture",
          operationCount: 1,
          destructiveOperationCount: 0,
          createFolders: ["/tmp/fixture/Images"],
          moveFiles: [{
            from: "/tmp/fixture/photo.png",
            to: "/tmp/fixture/Images/photo.png"
          }]
        }
      }
    }))).toBe(true);
  });

  it("accepts each canonical terminal outcome", () => {
    for (const outcome of [
      "app_policy_denied",
      "user_denied",
      "blocked",
      "confirmation_required",
      "failed",
      "cancelled",
      "completed"
    ] as const) {
      expect(isTaskControlSnapshot(createSnapshot({
        phase: "terminal",
        status: outcome,
        message: `Terminal outcome: ${outcome}`,
        outcome,
        replayAvailable: true,
        recoveryActions: outcome === "completed" ? [] : ["revise_plan"]
      }))).toBe(true);
    }
  });

  it("rejects status/phase mismatches and non-terminal outcome or recovery", () => {
    expect(isTaskControlSnapshot(createSnapshot({
      phase: "verifying",
      status: "executing"
    }))).toBe(false);
    expect(isTaskControlSnapshot(createSnapshot({
      outcome: "failed"
    }))).toBe(false);
    expect(isTaskControlSnapshot(createSnapshot({
      recoveryActions: ["retry_observation"]
    }))).toBe(false);
    expect(isTaskControlSnapshot(createSnapshot({
      phase: "terminal",
      status: "completed",
      outcome: "failed"
    }))).toBe(false);
    expect(isTaskControlSnapshot(createSnapshot({
      phase: "terminal",
      status: "failed"
    }))).toBe(false);
    expect(isTaskControlSnapshot(createSnapshot({
      phase: "approval",
      status: "approval_required",
      approval: {
        gate: "action-plan",
        planId: "stale-plan"
      }
    }))).toBe(false);
  });

  it("rejects malformed, duplicate, unbounded, and unknown snapshot fields", () => {
    expect(isTaskControlSnapshot({
      ...createSnapshot(),
      schemaVersion: 2
    })).toBe(false);
    expect(isTaskControlSnapshot({
      ...createSnapshot(),
      executionId: ""
    })).toBe(false);
    expect(isTaskControlSnapshot({
      ...createSnapshot(),
      message: "x".repeat(2_001)
    })).toBe(false);
    expect(isTaskControlSnapshot(createSnapshot({
      phase: "terminal",
      status: "failed",
      outcome: "failed",
      recoveryActions: ["retry_verification", "retry_verification"]
    }))).toBe(false);
    expect(isTaskControlSnapshot({
      ...createSnapshot(),
      extra: true
    })).toBe(false);
  });
});

function createPlan(): ComputerUsePlanPreview {
  return {
    planId: "plan-1",
    route: "ghostty",
    appName: "Ghostty",
    target: "active terminal session",
    risk: {
      level: "medium",
      reason: "This command changes local files.",
      requiresApproval: true
    },
    approvalRequired: true,
    expectedVerification: "Confirm the command result appears in the active terminal.",
    mutating: true
  };
}

function createSnapshot(
  overrides: Partial<TaskControlSnapshot> = {}
): TaskControlSnapshot {
  return {
    schemaVersion: TASK_CONTROL_SCHEMA_VERSION,
    executionId: "execution-1",
    phase: "waiting",
    status: "waiting",
    message: "Preparing the Computer Use plan.",
    plan: createPlan(),
    sideEffectState: "none",
    replayAvailable: false,
    recoveryActions: [],
    ...overrides
  };
}
