import { describe, expect, it, vi } from "vitest";

import {
  createTaskControlRecoveryRequest,
  type ComputerUsePlanPreview,
  type TaskControlRecoveryDescriptor,
  type TaskControlSnapshot
} from "../shared/task-control.js";
import { createTaskControlStore } from "./task-control-store.js";
import { startTaskRecoveryDispatch } from "./task-recovery-dispatch.js";
import { createTaskRecoveryRegistry } from "./task-recovery-registry.js";
import type { TaskRecoveryStageInput } from "./task-recovery-stage.js";

describe("Task Control recovery dispatch", () => {
  it("starts one read-only recovery execution and completes only the bound stage", async () => {
    const fixture = createRecoveryFixture();
    const lifecycle: Array<{ status: string; snapshot: TaskControlSnapshot }> = [];
    let receivedStageInput: TaskRecoveryStageInput | undefined;
    const runStage = vi.fn(async (input: TaskRecoveryStageInput) => {
      receivedStageInput = input;
      return {
      state: "passed" as const,
      message: "Read-only Finder verification passed for 0 bound operations."
      };
    });

    const dispatch = startTaskRecoveryDispatch({
      registry: fixture.registry,
      request: fixture.request,
      store: fixture.store,
      runStage,
      onLifecycle: (event) => lifecycle.push(event)
    });

    expect(dispatch.result).toMatchObject({
      state: "dispatched",
      code: "recovery-dispatched",
      descriptor: fixture.descriptor,
      recoveryExecutionId: `${fixture.descriptor.recoveryId}:stage`
    });
    expect(dispatch.result.message).not.toContain("private-command");
    expect(fixture.store.read()).toMatchObject({
      executionId: `${fixture.descriptor.recoveryId}:stage`,
      phase: "verifying",
      sideEffectState: "none",
      plan: {
        route: "finder",
        approvalRequired: false,
        mutating: false
      }
    });

    await dispatch.completion;

    expect(runStage).toHaveBeenCalledTimes(1);
    expect(receivedStageInput).toMatchObject({
      descriptor: fixture.descriptor,
      context: {
        command: "private-command token=hidden",
        finderExecutionPlan: { rootPath: "/tmp/fixture" }
      }
    });
    expect(lifecycle.map((event) => event.status)).toEqual([
      "waiting",
      "executing",
      "verifying",
      "completed"
    ]);
    expect(fixture.store.read()).toMatchObject({
      phase: "terminal",
      status: "completed",
      outcome: "completed",
      sideEffectState: "none",
      recoveryActions: [],
      recoveryDescriptors: []
    });
  });

  it("rejects dispatch until the exact descriptor has been prepared", () => {
    const fixture = createRecoveryFixture({ prepare: false });
    const runStage = vi.fn();

    const dispatch = startTaskRecoveryDispatch({
      registry: fixture.registry,
      request: fixture.request,
      store: fixture.store,
      runStage
    });

    expect(dispatch.result).toMatchObject({
      state: "rejected",
      code: "recovery-not-prepared"
    });
    expect(dispatch.completion).toBeUndefined();
    expect(runStage).not.toHaveBeenCalled();
    expect(fixture.store.read()?.executionId).toBe(fixture.descriptor.executionId);
  });

  it("keeps confirmation required distinct and offers no mutation replay", async () => {
    const fixture = createRecoveryFixture();
    const dispatch = startTaskRecoveryDispatch({
      registry: fixture.registry,
      request: fixture.request,
      store: fixture.store,
      runStage: async () => ({
        state: "confirmation_required",
        message: "Read-only evidence cannot prove the previous result."
      })
    });

    await dispatch.completion;

    expect(fixture.store.read()).toMatchObject({
      phase: "terminal",
      status: "confirmation_required",
      outcome: "confirmation_required",
      failureStage: "verification",
      sideEffectState: "none",
      recoveryActions: []
    });
    expect(fixture.store.read()?.recoveryDescriptors).toBeUndefined();
  });

  it("does not overwrite an authoritative Stop while a read-only stage is in flight", async () => {
    const fixture = createRecoveryFixture();
    let resolveStage!: (value: {
      state: "passed";
      message: string;
    }) => void;
    const stage = new Promise<{
      state: "passed";
      message: string;
    }>((resolve) => {
      resolveStage = resolve;
    });
    const dispatch = startTaskRecoveryDispatch({
      registry: fixture.registry,
      request: fixture.request,
      store: fixture.store,
      runStage: () => stage,
      isCurrent: () => true
    });
    const recoveryExecutionId = dispatch.result.state === "dispatched"
      ? dispatch.result.recoveryExecutionId
      : "missing";
    fixture.store.finish({
      executionId: recoveryExecutionId,
      outcome: "cancelled",
      message: "Task stopped. No external mutation was recorded before cancellation.",
      sideEffectState: "none",
      replayAvailable: true,
      failureStage: "verification"
    });
    resolveStage({ state: "passed", message: "Late result." });

    await dispatch.completion;

    expect(fixture.store.read()).toMatchObject({
      executionId: recoveryExecutionId,
      status: "cancelled",
      outcome: "cancelled"
    });
  });
});

function createRecoveryFixture({ prepare = true }: { prepare?: boolean } = {}) {
  const registry = createTaskRecoveryRegistry();
  const store = createTaskControlStore({
    onChanged: (snapshot) => registry.sync(snapshot)
  });
  const descriptor: TaskControlRecoveryDescriptor = {
    recoveryId: "task-recovery-dispatch-test",
    action: "retry_verification",
    mode: "prepare_only",
    executionId: "execution-source",
    planId: "plan-source",
    route: "finder",
    outcome: "failed",
    failureStage: "verification"
  };
  store.start({
    executionId: descriptor.executionId,
    message: "Source task ready.",
    plan: createPlan()
  });
  registry.bindExecutionContext({
    executionId: descriptor.executionId,
    command: "private-command token=hidden",
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
  store.finish({
    executionId: descriptor.executionId,
    outcome: descriptor.outcome,
    message: "Source task verification failed.",
    sideEffectState: "possible",
    replayAvailable: true,
    failureStage: descriptor.failureStage,
    recoveryDescriptors: [descriptor]
  });
  const request = createTaskControlRecoveryRequest(descriptor);
  if (prepare) registry.prepare(request, store.read());

  return { descriptor, registry, request, store };
}

function createPlan(): ComputerUsePlanPreview {
  return {
    planId: "plan-source",
    route: "finder",
    appName: "Finder",
    target: "Bound Finder fixture",
    risk: {
      level: "medium",
      reason: "Finder changes files.",
      requiresApproval: true
    },
    approvalRequired: true,
    expectedVerification: "Verify exact file operations.",
    mutating: true
  };
}
