import { describe, expect, it } from "vitest";

import {
  TASK_CONTROL_SCHEMA_VERSION,
  createTaskControlRecoveryRequest,
  type TaskControlRecoveryDescriptor,
  type TaskControlSnapshot
} from "../shared/task-control.js";
import { createTaskRecoveryRegistry } from "./task-recovery-registry.js";

describe("Task Control recovery registry", () => {
  it("prepares an exact retry idempotently without dispatching Computer Use", () => {
    const registry = createTaskRecoveryRegistry();
    const snapshot = createTerminalSnapshot();
    const descriptor = snapshot.recoveryDescriptors![0]!;
    const request = createTaskControlRecoveryRequest(descriptor);
    registry.sync(snapshot);

    const first = registry.prepare(request, snapshot);
    const second = registry.prepare(request, snapshot);

    expect(first).toEqual({
      state: "prepared",
      code: "recovery-prepared",
      message: "Prepared a read-only verification recovery. No Computer Use action has run.",
      descriptor
    });
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty("draft");
  });

  it("returns a bounded sanitized draft only for draft-only plan revision", () => {
    const registry = createTaskRecoveryRegistry();
    const snapshot = createTerminalSnapshot({
      plan: {
        ...createTerminalSnapshot().plan,
        appName: "Finder token=secret-value",
        target: "run --password hunter2 in /Users/tester/My Secret/file.txt"
      },
      recoveryActions: ["revise_plan"],
      recoveryDescriptors: [createDescriptor({
        recoveryId: "task-recovery-revise",
        action: "revise_plan",
        mode: "draft_only"
      })]
    });
    registry.sync(snapshot);

    const result = registry.prepare(
      createTaskControlRecoveryRequest(snapshot.recoveryDescriptors![0]!),
      snapshot
    );

    expect(result).toMatchObject({
      state: "prepared",
      code: "recovery-prepared",
      descriptor: { action: "revise_plan", mode: "draft_only" }
    });
    expect(result.state === "prepared" ? result.draft : undefined).toBe(
      "Revise the bound finder Computer Use plan before taking any action."
    );
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("/Users/tester");
    expect(JSON.stringify(result)).not.toContain("Secret/file.txt");
  });

  it.each([
    ["executionId", "other-execution"],
    ["planId", "other-plan"],
    ["route", "chrome"],
    ["outcome", "blocked"],
    ["failureStage", "observation"],
    ["action", "retry_observation"]
  ] as const)("rejects a request with mismatched %s", (key, value) => {
    const registry = createTaskRecoveryRegistry();
    const snapshot = createTerminalSnapshot();
    const descriptor = snapshot.recoveryDescriptors![0]!;
    registry.sync(snapshot);

    expect(registry.prepare({
      ...createTaskControlRecoveryRequest(descriptor),
      [key]: value
    }, snapshot)).toMatchObject({
      state: "rejected",
      code: key === "executionId" ? "recovery-stale-execution" : "recovery-mismatched"
    });
  });

  it("rejects invalid, unknown, and stale recovery requests fail closed", () => {
    const registry = createTaskRecoveryRegistry();
    const snapshot = createTerminalSnapshot();
    const request = createTaskControlRecoveryRequest(snapshot.recoveryDescriptors![0]!);
    registry.sync(snapshot);

    expect(registry.prepare({ ...request, extra: true }, snapshot)).toMatchObject({
      state: "rejected",
      code: "recovery-invalid-request"
    });
    expect(registry.prepare({ ...request, recoveryId: "task-recovery-unknown" }, snapshot))
      .toMatchObject({ state: "rejected", code: "recovery-unknown" });

    const nextActive = createActiveSnapshot("execution-next", "plan-next");
    registry.sync(nextActive);
    expect(registry.prepare(request, nextActive)).toMatchObject({
      state: "rejected",
      code: "recovery-stale-execution"
    });

    registry.sync(null);
    expect(registry.prepare(request, null)).toMatchObject({
      state: "rejected",
      code: "recovery-stale-execution"
    });
  });

  it("claims one exact prepared stage dispatch with its private execution context", () => {
    const registry = createTaskRecoveryRegistry();
    const snapshot = createTerminalSnapshot();
    const descriptor = snapshot.recoveryDescriptors![0]!;
    const request = createTaskControlRecoveryRequest(descriptor);
    registry.bindExecutionContext({
      executionId: snapshot.executionId,
      command: "organize Finder fixture token=private",
      mode: "active",
      route: { kind: "finder", bundleId: "com.apple.finder" },
      finderExecutionPlan: {
        schemaVersion: 1,
        targetKind: "absolute_path",
        rootPath: "/tmp/fixture",
        collisionPolicy: "cancel",
        operations: []
      }
    });
    registry.sync(snapshot);

    expect(registry.claimDispatch(request, snapshot)).toMatchObject({
      state: "rejected",
      code: "recovery-not-prepared"
    });

    registry.prepare(request, snapshot);
    const claim = registry.claimDispatch(request, snapshot);
    expect(claim).toMatchObject({
      state: "claimed",
      descriptor,
      snapshot: { executionId: snapshot.executionId },
      context: {
        executionId: snapshot.executionId,
        command: "organize Finder fixture token=private",
        route: { kind: "finder" },
        finderExecutionPlan: { rootPath: "/tmp/fixture" }
      }
    });
    if (claim.state !== "claimed") throw new Error("Expected an exact recovery dispatch claim.");
    claim.context.command = "mutated";
    claim.snapshot.plan.target = "mutated";

    const duplicate = registry.claimDispatch(request, snapshot);
    expect(duplicate).toMatchObject({
      state: "rejected",
      code: "recovery-already-dispatched"
    });
    expect(JSON.stringify(duplicate)).not.toContain("token=private");
  });

  it("rejects dispatch when the private execution context is absent or stale", () => {
    const registry = createTaskRecoveryRegistry();
    const snapshot = createTerminalSnapshot();
    const descriptor = snapshot.recoveryDescriptors![0]!;
    const request = createTaskControlRecoveryRequest(descriptor);
    registry.sync(snapshot);
    registry.prepare(request, snapshot);

    expect(registry.claimDispatch(request, snapshot)).toMatchObject({
      state: "rejected",
      code: "recovery-dispatch-unavailable"
    });

    registry.bindExecutionContext({
      executionId: snapshot.executionId,
      command: "observe only",
      mode: "quiet",
      route: { kind: "finder", bundleId: "com.apple.finder" }
    });
    expect(registry.claimDispatch(request, snapshot)).toMatchObject({
      state: "rejected",
      code: "recovery-dispatch-unavailable"
    });

    registry.bindExecutionContext({
      executionId: "other-execution",
      command: "observe only",
      mode: "quiet",
      route: { kind: "finder", bundleId: "com.apple.finder" }
    });
    expect(registry.claimDispatch(request, snapshot)).toMatchObject({
      state: "rejected",
      code: "recovery-dispatch-unavailable"
    });
  });

  it("never claims draft-only or navigation recovery as executable work", () => {
    for (const descriptor of [
      createDescriptor({
        recoveryId: "task-recovery-revise",
        action: "revise_plan",
        mode: "draft_only"
      }),
      createDescriptor({
        recoveryId: "task-recovery-readiness",
        action: "open_readiness",
        mode: "navigation",
        failureStage: "preflight"
      })
    ] as const) {
      const registry = createTaskRecoveryRegistry();
      const snapshot = createTerminalSnapshot({
        failureStage: descriptor.failureStage,
        sideEffectState: descriptor.failureStage === "preflight" ? "none" : "possible",
        recoveryActions: [descriptor.action],
        recoveryDescriptors: [descriptor]
      });
      const request = createTaskControlRecoveryRequest(descriptor);
      registry.bindExecutionContext({
        executionId: snapshot.executionId,
        command: "bounded source request",
        mode: "active",
        route: { kind: "finder", bundleId: "com.apple.finder" }
      });
      registry.sync(snapshot);
      registry.prepare(request, snapshot);

      expect(registry.claimDispatch(request, snapshot)).toMatchObject({
        state: "rejected",
        code: "recovery-dispatch-unavailable"
      });
    }
  });
});

function createDescriptor(
  overrides: Partial<TaskControlRecoveryDescriptor> = {}
): TaskControlRecoveryDescriptor {
  return {
    recoveryId: "task-recovery-verify",
    action: "retry_verification",
    mode: "prepare_only",
    executionId: "execution-1",
    planId: "plan-1:derived",
    route: "finder",
    outcome: "failed",
    failureStage: "verification",
    ...overrides
  };
}

function createTerminalSnapshot(
  overrides: Partial<TaskControlSnapshot> = {}
): TaskControlSnapshot {
  const descriptor = createDescriptor();
  return {
    schemaVersion: TASK_CONTROL_SCHEMA_VERSION,
    executionId: descriptor.executionId,
    executionPlanId: descriptor.planId,
    phase: "terminal",
    status: descriptor.outcome,
    outcome: descriptor.outcome,
    failureStage: descriptor.failureStage,
    message: "Finder verification failed.",
    plan: {
      planId: "plan-1",
      route: descriptor.route,
      appName: "Finder",
      target: "Selected Finder folder",
      risk: {
        level: "medium",
        reason: "Finder changes files.",
        requiresApproval: true
      },
      approvalRequired: true,
      expectedVerification: "Verify exact file operations.",
      mutating: true
    },
    sideEffectState: "possible",
    replayAvailable: true,
    recoveryActions: [descriptor.action],
    recoveryDescriptors: [descriptor],
    ...overrides
  };
}

function createActiveSnapshot(executionId: string, planId: string): TaskControlSnapshot {
  return {
    schemaVersion: TASK_CONTROL_SCHEMA_VERSION,
    executionId,
    executionPlanId: planId,
    phase: "waiting",
    status: "waiting",
    message: "Waiting.",
    plan: {
      planId,
      route: "ghostty",
      appName: "Ghostty",
      target: "skfiy-shell",
      risk: { level: "low", reason: "Read only.", requiresApproval: false },
      approvalRequired: false,
      expectedVerification: "Observe output.",
      mutating: false
    },
    sideEffectState: "none",
    replayAvailable: false,
    recoveryActions: [],
    recoveryDescriptors: []
  };
}
