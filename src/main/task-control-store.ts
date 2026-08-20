import {
  TASK_CONTROL_SCHEMA_VERSION,
  cloneTaskControlApproval,
  cloneTaskControlRecoveryDescriptor,
  cloneTaskControlSnapshot,
  isComputerUsePlanPreview,
  isTaskControlSnapshot,
  readTaskControlStatusForPhase,
  type ComputerUsePlanPreview,
  type TaskControlApproval,
  type TaskControlFailureStage,
  type TaskControlOutcome,
  type TaskControlPhase,
  type TaskControlRecoveryAction,
  type TaskControlRecoveryDescriptor,
  type TaskControlSideEffectState,
  type TaskControlSnapshot
} from "../shared/task-control.js";

export type TaskControlStoreErrorCode =
  | "active-clear"
  | "active-execution"
  | "execution-id-reused"
  | "execution-mismatch"
  | "invalid-snapshot"
  | "invalid-transition"
  | "no-active-execution"
  | "replay-regression"
  | "side-effect-regression"
  | "terminal-execution";

export class TaskControlStoreError extends Error {
  readonly code: TaskControlStoreErrorCode;

  constructor(code: TaskControlStoreErrorCode, message: string) {
    super(message);
    this.name = "TaskControlStoreError";
    this.code = code;
  }
}

export interface TaskControlStoreOptions {
  onChanged?: (snapshot: TaskControlSnapshot | null) => void;
}

export interface StartTaskControlInput {
  executionId: string;
  message: string;
  plan: ComputerUsePlanPreview;
}

export interface TransitionTaskControlInput {
  executionId: string;
  phase: Exclude<TaskControlPhase, "terminal">;
  message: string;
  sideEffectState?: TaskControlSideEffectState;
  replayAvailable?: boolean;
  approval?: TaskControlApproval;
}

export interface BindTaskControlPlanInput {
  executionId: string;
  message: string;
  plan: ComputerUsePlanPreview;
}

export interface FinishTaskControlInput {
  executionId: string;
  outcome: TaskControlOutcome;
  message: string;
  sideEffectState?: TaskControlSideEffectState;
  replayAvailable?: boolean;
  failureStage?: TaskControlFailureStage;
  recoveryDescriptors?: TaskControlRecoveryDescriptor[];
  recoveryActions?: TaskControlRecoveryAction[];
}

const SIDE_EFFECT_ORDER: Record<TaskControlSideEffectState, number> = {
  none: 0,
  possible: 1,
  occurred: 2
};

export function createTaskControlStore(options: TaskControlStoreOptions = {}) {
  let state: TaskControlSnapshot | null = null;

  const read = (): TaskControlSnapshot | null => state
    ? cloneTaskControlSnapshot(state)
    : null;

  const commit = (next: TaskControlSnapshot | null): TaskControlSnapshot | null => {
    if (next && !isTaskControlSnapshot(next)) {
      throw new TaskControlStoreError(
        "invalid-snapshot",
        "Task Control state does not match schema v1."
      );
    }

    state = next ? cloneTaskControlSnapshot(next) : null;
    const result = read();
    options.onChanged?.(result ? cloneTaskControlSnapshot(result) : null);
    return result;
  };

  return {
    read,

    start(input: StartTaskControlInput): TaskControlSnapshot {
      if (state?.phase !== "terminal" && state) {
        throw new TaskControlStoreError(
          "active-execution",
          `Task Control execution ${state.executionId} is still active.`
        );
      }
      if (state?.executionId === input.executionId) {
        throw new TaskControlStoreError(
          "execution-id-reused",
          `Task Control execution ID ${input.executionId} was already used.`
        );
      }
      if (!isComputerUsePlanPreview(input.plan)) {
        throw new TaskControlStoreError(
          "invalid-snapshot",
          "Computer Use plan preview does not match schema v1."
        );
      }

      return requireCommittedSnapshot(commit({
        schemaVersion: TASK_CONTROL_SCHEMA_VERSION,
        executionId: input.executionId,
        phase: "waiting",
        status: "waiting",
        message: input.message,
        plan: input.plan,
        sideEffectState: "none",
        replayAvailable: false,
        recoveryActions: []
      }));
    },

    bindPlan(input: BindTaskControlPlanInput): TaskControlSnapshot {
      const current = requireMutableExecution(state, input.executionId);
      if (
        current.phase !== "waiting"
        || current.sideEffectState !== "none"
        || current.replayAvailable
      ) {
        throw new TaskControlStoreError(
          "invalid-transition",
          `Task Control execution ${input.executionId} can bind a plan only while waiting before dispatch.`
        );
      }
      if (!isComputerUsePlanPreview(input.plan)) {
        throw new TaskControlStoreError(
          "invalid-snapshot",
          "Bound Computer Use plan preview does not match schema v1."
        );
      }

      return requireCommittedSnapshot(commit({
        ...current,
        message: input.message,
        plan: input.plan
      }));
    },

    transition(input: TransitionTaskControlInput): TaskControlSnapshot {
      const current = requireMutableExecution(state, input.executionId);
      if (current.phase === "terminal") {
        throw new TaskControlStoreError(
          "terminal-execution",
          `Task Control execution ${input.executionId} is already terminal.`
        );
      }
      if (input.phase === "approval" && !current.plan.approvalRequired) {
        throw new TaskControlStoreError(
          "invalid-transition",
          `Task Control plan ${current.plan.planId} does not require approval.`
        );
      }
      if (input.phase === "approval" && !input.approval) {
        throw new TaskControlStoreError(
          "invalid-transition",
          `Task Control plan ${current.plan.planId} requires bound approval context.`
        );
      }
      if (input.phase !== "approval" && input.approval) {
        throw new TaskControlStoreError(
          "invalid-transition",
          "Task Control approval context is valid only in the approval phase."
        );
      }

      if (!isValidActivePhaseTransition(current, input.phase)) {
        throw new TaskControlStoreError(
          "invalid-transition",
          `Task Control cannot move from ${current.phase} to ${input.phase} in its current side-effect state.`
        );
      }

      const sideEffectState = input.sideEffectState ?? current.sideEffectState;
      assertSideEffectMonotonic(current.sideEffectState, sideEffectState);
      const replayAvailable = input.replayAvailable ?? current.replayAvailable;
      assertReplayMonotonic(current.replayAvailable, replayAvailable);

      return requireCommittedSnapshot(commit({
        ...current,
        phase: input.phase,
        status: readTaskControlStatusForPhase(input.phase),
        message: input.message,
        sideEffectState,
        replayAvailable,
        recoveryActions: [],
        approval: input.approval ? cloneTaskControlApproval(input.approval) : undefined
      }));
    },

    finish(input: FinishTaskControlInput): TaskControlSnapshot {
      const current = requireMutableExecution(state, input.executionId);
      if (current.phase === "terminal") {
        throw new TaskControlStoreError(
          "terminal-execution",
          `Task Control execution ${input.executionId} is already terminal.`
        );
      }

      const sideEffectState = input.sideEffectState ?? current.sideEffectState;
      assertSideEffectMonotonic(current.sideEffectState, sideEffectState);
      const replayAvailable = input.replayAvailable ?? current.replayAvailable;
      assertReplayMonotonic(current.replayAvailable, replayAvailable);
      const recoveryDescriptors = input.recoveryDescriptors?.map(
        cloneTaskControlRecoveryDescriptor
      );
      const recoveryActions = recoveryDescriptors
        ? recoveryDescriptors.map((descriptor) => descriptor.action)
        : [...(input.recoveryActions ?? [])];

      return requireCommittedSnapshot(commit({
        ...current,
        executionPlanId: current.executionPlanId ?? current.plan.planId,
        phase: "terminal",
        status: input.outcome,
        message: input.message,
        sideEffectState,
        replayAvailable,
        recoveryActions,
        recoveryDescriptors,
        failureStage: input.failureStage,
        approval: undefined,
        outcome: input.outcome
      }));
    },

    clear(): null {
      if (state && state.phase !== "terminal") {
        throw new TaskControlStoreError(
          "active-clear",
          `Task Control execution ${state.executionId} must finish before it can be cleared.`
        );
      }
      if (!state) {
        return null;
      }

      commit(null);
      return null;
    }
  };
}

function isValidActivePhaseTransition(
  current: TaskControlSnapshot,
  next: Exclude<TaskControlPhase, "terminal">
): boolean {
  if (current.phase === "terminal") {
    return false;
  }
  if (current.phase === next) {
    return true;
  }
  if (current.phase === "waiting") {
    return next === "approval" || next === "executing";
  }
  if (current.phase === "approval") {
    return next === "executing";
  }
  if (current.phase === "executing") {
    return next === "verifying"
      || (next === "approval" && current.sideEffectState !== "occurred");
  }
  if (current.phase === "verifying") {
    return next === "executing"
      || (next === "approval" && current.sideEffectState !== "occurred");
  }

  return false;
}

function requireMutableExecution(
  state: TaskControlSnapshot | null,
  executionId: string
): TaskControlSnapshot {
  if (!state) {
    throw new TaskControlStoreError(
      "no-active-execution",
      "Task Control has no execution to update."
    );
  }
  if (state.executionId !== executionId) {
    throw new TaskControlStoreError(
      "execution-mismatch",
      `Task Control execution ${executionId} does not match ${state.executionId}.`
    );
  }

  return cloneTaskControlSnapshot(state);
}

function assertSideEffectMonotonic(
  before: TaskControlSideEffectState,
  after: TaskControlSideEffectState
): void {
  if (SIDE_EFFECT_ORDER[after] < SIDE_EFFECT_ORDER[before]) {
    throw new TaskControlStoreError(
      "side-effect-regression",
      `Side-effect certainty cannot move from ${before} back to ${after}.`
    );
  }
}

function assertReplayMonotonic(before: boolean, after: boolean): void {
  if (before && !after) {
    throw new TaskControlStoreError(
      "replay-regression",
      "Replay availability cannot be removed from an active execution."
    );
  }
}

function requireCommittedSnapshot(
  snapshot: TaskControlSnapshot | null
): TaskControlSnapshot {
  if (!snapshot) {
    throw new TaskControlStoreError(
      "invalid-snapshot",
      "Task Control unexpectedly committed an empty snapshot."
    );
  }

  return snapshot;
}
