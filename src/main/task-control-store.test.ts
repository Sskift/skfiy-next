import { describe, expect, it, vi } from "vitest";

import {
  TaskControlStoreError,
  createTaskControlStore
} from "./task-control-store";
import type { ComputerUsePlanPreview } from "../shared/task-control";

describe("task control store", () => {
  it("binds a resolved plan only while the execution is still waiting", () => {
    const store = createTaskControlStore();
    store.start({ executionId: "execution-bind", message: "Planning.", plan: createPlan() });
    const rebound = store.bindPlan({
      executionId: "execution-bind",
      message: "Resolved exact command.",
      plan: createPlan({ planId: "plan-resolved", target: "skfiy-shell · pwd" })
    });

    expect(rebound.plan).toMatchObject({ planId: "plan-resolved", target: "skfiy-shell · pwd" });
    store.transition({
      executionId: "execution-bind",
      phase: "approval",
      message: "Approve.",
      approval: { gate: "action-plan", planId: "plan-resolved" }
    });
    expect(() => store.bindPlan({
      executionId: "execution-bind",
      message: "Too late.",
      plan: createPlan({ planId: "plan-late" })
    })).toThrow(/only while waiting before dispatch/u);
  });

  it("starts a waiting snapshot and returns defensive clones", () => {
    const plan = createPlan();
    const onChanged = vi.fn();
    const store = createTaskControlStore({ onChanged });

    const started = store.start({
      executionId: "execution-1",
      message: "Waiting for the Computer Use plan.",
      plan
    });
    plan.risk.reason = "mutated caller input";
    started.plan.target = "mutated returned snapshot";
    const read = store.read();

    expect(read).toMatchObject({
      schemaVersion: 1,
      executionId: "execution-1",
      phase: "waiting",
      status: "waiting",
      sideEffectState: "none",
      replayAvailable: false,
      recoveryActions: [],
      plan: {
        target: "active terminal session",
        risk: { reason: "This command changes local files." }
      }
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0]?.[0]).not.toBe(read);
  });

  it("moves forward through approval, execution, verification, and completion", () => {
    const store = createTaskControlStore();
    store.start({
      executionId: "execution-1",
      message: "Plan ready for review.",
      plan: createPlan()
    });

    expect(store.transition({
      executionId: "execution-1",
      phase: "approval",
      message: "Approval required.",
      approval: { gate: "action-plan", planId: "plan-1" }
    })).toMatchObject({
      phase: "approval",
      status: "approval_required",
      sideEffectState: "none"
    });
    expect(store.transition({
      executionId: "execution-1",
      phase: "executing",
      message: "Executing the approved plan.",
      sideEffectState: "possible",
      replayAvailable: true
    })).toMatchObject({
      phase: "executing",
      status: "executing",
      sideEffectState: "possible",
      replayAvailable: true
    });
    expect(store.transition({
      executionId: "execution-1",
      phase: "verifying",
      message: "Verifying the result.",
      sideEffectState: "occurred"
    })).toMatchObject({
      phase: "verifying",
      status: "verifying",
      sideEffectState: "occurred",
      replayAvailable: true
    });
    expect(store.finish({
      executionId: "execution-1",
      outcome: "completed",
      message: "Command completed and verification passed.",
      sideEffectState: "occurred",
      replayAvailable: true
    })).toMatchObject({
      phase: "terminal",
      status: "completed",
      outcome: "completed",
      recoveryActions: []
    });
  });

  it("allows terminal recovery actions but never puts them on active snapshots", () => {
    const store = createTaskControlStore();
    store.start({
      executionId: "execution-1",
      message: "Preparing observation.",
      plan: createPlan()
    });

    expect(store.finish({
      executionId: "execution-1",
      outcome: "confirmation_required",
      message: "Verification needs confirmation.",
      sideEffectState: "possible",
      replayAvailable: true,
      recoveryActions: ["retry_observation", "retry_verification", "revise_plan", "open_readiness"]
    })).toMatchObject({
      phase: "terminal",
      status: "confirmation_required",
      outcome: "confirmation_required",
      recoveryActions: ["retry_observation", "retry_verification", "revise_plan", "open_readiness"]
    });
  });

  it("rejects stale execution updates and transitions after terminal", () => {
    const store = createTaskControlStore();
    store.start({
      executionId: "execution-1",
      message: "Waiting.",
      plan: createPlan()
    });

    expect(() => store.transition({
      executionId: "execution-stale",
      phase: "executing",
      message: "Stale update."
    })).toThrowError(expect.objectContaining({ code: "execution-mismatch" }));

    store.finish({
      executionId: "execution-1",
      outcome: "cancelled",
      message: "Task stopped. Completed actions were not rolled back.",
      sideEffectState: "possible",
      replayAvailable: true
    });

    expect(() => store.transition({
      executionId: "execution-1",
      phase: "verifying",
      message: "Late verification."
    })).toThrowError(expect.objectContaining({ code: "terminal-execution" }));
    expect(() => store.finish({
      executionId: "execution-1",
      outcome: "failed",
      message: "Late failure."
    })).toThrowError(expect.objectContaining({ code: "terminal-execution" }));
  });

  it("allows execution/verification cycles and a pre-mutation late approval", () => {
    const store = createTaskControlStore();
    store.start({
      executionId: "execution-1",
      message: "Waiting.",
      plan: createPlan()
    });
    store.transition({
      executionId: "execution-1",
      phase: "executing",
      message: "Preparing execution."
    });
    expect(store.transition({
      executionId: "execution-1",
      phase: "approval",
      message: "The resolved Finder plan needs approval.",
      approval: { gate: "action-plan", planId: "plan-1" }
    })).toMatchObject({ phase: "approval", sideEffectState: "none" });
    store.transition({
      executionId: "execution-1",
      phase: "executing",
      message: "Executing approved operations.",
      sideEffectState: "possible"
    });
    store.transition({
      executionId: "execution-1",
      phase: "verifying",
      message: "Verifying operation one."
    });
    expect(store.transition({
      executionId: "execution-1",
      phase: "executing",
      message: "Executing operation two."
    })).toMatchObject({ phase: "executing", sideEffectState: "possible" });

    // Side effects "possible" still allows a late confirmation gate (e.g.
    // Chrome submit confirmation before the actual mutation). Once side
    // effects have "occurred", returning to approval must be rejected.
    store.transition({
      executionId: "execution-1",
      phase: "verifying",
      message: "Verifying operation two.",
      sideEffectState: "occurred"
    });
    expect(() => store.transition({
      executionId: "execution-1",
      phase: "approval",
      message: "Unsafe approval after mutation.",
      approval: { gate: "action-plan", planId: "plan-1" }
    })).toThrowError(expect.objectContaining({ code: "invalid-transition" }));
  });

  it("never regresses an active execution to waiting", () => {
    const store = createTaskControlStore();
    store.start({
      executionId: "execution-1",
      message: "Waiting.",
      plan: createPlan()
    });
    store.transition({
      executionId: "execution-1",
      phase: "executing",
      message: "Executing.",
      sideEffectState: "possible"
    });

    expect(() => store.transition({
      executionId: "execution-1",
      phase: "waiting",
      message: "Regressed to waiting."
    })).toThrowError(expect.objectContaining({ code: "invalid-transition" }));
  });

  it("never enters approval for an approval-free plan", () => {
    const store = createTaskControlStore();
    store.start({
      executionId: "execution-1",
      message: "Read-only observation is ready.",
      plan: createPlan({
        risk: {
          level: "low",
          reason: "This plan only observes the current session.",
          requiresApproval: false
        },
        approvalRequired: false,
        mutating: false
      })
    });

    expect(() => store.transition({
      executionId: "execution-1",
      phase: "approval",
      message: "Approval should not be shown."
    })).toThrowError(expect.objectContaining({ code: "invalid-transition" }));
  });

  it("keeps side-effect certainty and replay availability monotonic", () => {
    const store = createTaskControlStore();
    store.start({
      executionId: "execution-1",
      message: "Waiting.",
      plan: createPlan()
    });
    store.transition({
      executionId: "execution-1",
      phase: "executing",
      message: "Executing.",
      sideEffectState: "occurred",
      replayAvailable: true
    });

    expect(() => store.transition({
      executionId: "execution-1",
      phase: "verifying",
      message: "Verifying.",
      sideEffectState: "possible"
    })).toThrowError(expect.objectContaining({ code: "side-effect-regression" }));
    expect(() => store.transition({
      executionId: "execution-1",
      phase: "verifying",
      message: "Verifying.",
      replayAvailable: false
    })).toThrowError(expect.objectContaining({ code: "replay-regression" }));
  });

  it("starts a new execution after terminal but never replaces active work", () => {
    const store = createTaskControlStore();
    store.start({
      executionId: "execution-1",
      message: "Waiting.",
      plan: createPlan()
    });
    expect(() => store.start({
      executionId: "execution-2",
      message: "Should not replace active work.",
      plan: createPlan({ planId: "plan-2" })
    })).toThrowError(expect.objectContaining({ code: "active-execution" }));

    store.finish({
      executionId: "execution-1",
      outcome: "failed",
      message: "First execution failed.",
      recoveryActions: ["revise_plan"]
    });
    const restarted = store.start({
      executionId: "execution-2",
      message: "A revised plan is waiting.",
      plan: createPlan({ planId: "plan-2" })
    });
    expect(restarted).toMatchObject({
      executionId: "execution-2",
      phase: "waiting"
    });
    expect(restarted).not.toHaveProperty("outcome");
  });

  it("clears terminal snapshots but refuses to hide active control state", () => {
    const store = createTaskControlStore();
    expect(store.clear()).toBeNull();
    store.start({
      executionId: "execution-1",
      message: "Waiting.",
      plan: createPlan()
    });
    expect(() => store.clear()).toThrowError(expect.objectContaining({ code: "active-clear" }));

    store.finish({
      executionId: "execution-1",
      outcome: "user_denied",
      message: "User denied the plan."
    });
    expect(store.clear()).toBeNull();
    expect(store.read()).toBeNull();
  });

  it("throws a typed validation error for malformed start data", () => {
    const store = createTaskControlStore();

    expect(() => store.start({
      executionId: "execution-1",
      message: "Waiting.",
      plan: createPlan({ target: "x".repeat(2_001) })
    })).toThrowError(TaskControlStoreError);
  });
});

function createPlan(
  overrides: Partial<ComputerUsePlanPreview> = {}
): ComputerUsePlanPreview {
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
    mutating: true,
    ...overrides
  };
}
