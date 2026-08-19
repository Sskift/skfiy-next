import {
  cloneTaskControlRecoveryDescriptor,
  cloneTaskControlRecoveryDispatchResult,
  type ComputerUsePlanPreview,
  type TaskControlFailureStage,
  type TaskControlRecoveryDispatchResult,
  type TaskControlRecoveryRequest,
  type TaskControlSnapshot
} from "../shared/task-control.js";
import type { TaskStatus } from "./task-event-view.js";
import type { createTaskControlStore } from "./task-control-store.js";
import type { createTaskRecoveryRegistry } from "./task-recovery-registry.js";
import type {
  TaskRecoveryStageInput,
  TaskRecoveryStageResult
} from "./task-recovery-stage.js";

type TaskControlStore = ReturnType<typeof createTaskControlStore>;
type TaskRecoveryRegistry = ReturnType<typeof createTaskRecoveryRegistry>;

export interface TaskRecoveryLifecycleEvent {
  status: TaskStatus;
  message: string;
  snapshot: TaskControlSnapshot;
}

export interface StartTaskRecoveryDispatchInput {
  registry: TaskRecoveryRegistry;
  request: unknown;
  store: TaskControlStore;
  runStage: (input: TaskRecoveryStageInput) => Promise<TaskRecoveryStageResult>;
  onLifecycle?: (event: TaskRecoveryLifecycleEvent) => void;
  isCurrent?: () => boolean;
}

export interface StartedTaskRecoveryDispatch {
  result: TaskControlRecoveryDispatchResult;
  completion?: Promise<void>;
}

export function startTaskRecoveryDispatch({
  registry,
  request,
  store,
  runStage,
  onLifecycle,
  isCurrent
}: StartTaskRecoveryDispatchInput): StartedTaskRecoveryDispatch {
  const claim = registry.claimDispatch(request, store.read());
  if (claim.state === "rejected") {
    return { result: cloneTaskControlRecoveryDispatchResult(claim) };
  }

  const recoveryExecutionId = `${claim.descriptor.recoveryId}:stage`;
  const plan = createTaskRecoveryPlan(claim.descriptor.recoveryId, claim.snapshot.plan);
  let started: TaskControlSnapshot;
  try {
    started = store.start({
      executionId: recoveryExecutionId,
      message: readWaitingMessage(claim.descriptor.action),
      plan
    });
  } catch {
    return {
      result: rejectDispatch(
        "recovery-dispatch-unavailable",
        "The bound read-only recovery could not be started."
      )
    };
  }

  emitLifecycle(onLifecycle, "waiting", started.message, started);
  const executing = store.transition({
    executionId: recoveryExecutionId,
    phase: "executing",
    message: readExecutingMessage(claim.descriptor.action),
    sideEffectState: "none",
    replayAvailable: true
  });
  emitLifecycle(onLifecycle, "executing", executing.message, executing);

  let verifying: TaskControlSnapshot | undefined;
  if (claim.descriptor.action === "retry_verification") {
    verifying = store.transition({
      executionId: recoveryExecutionId,
      phase: "verifying",
      message: "Running the bound read-only verification stage.",
      sideEffectState: "none",
      replayAvailable: true
    });
    emitLifecycle(onLifecycle, "verifying", verifying.message, verifying);
  }

  const stillCurrent = () => {
    const current = store.read();
    return current?.executionId === recoveryExecutionId
      && current.phase !== "terminal"
      && (isCurrent?.() ?? true);
  };
  const stageInput: TaskRecoveryStageInput = {
    descriptor: cloneTaskControlRecoveryDescriptor(claim.descriptor),
    context: claim.context
  };
  const completion = completeTaskRecoveryDispatch({
    executionId: recoveryExecutionId,
    input: stageInput,
    isCurrent: stillCurrent,
    onLifecycle,
    runStage,
    store
  });

  return {
    result: {
      state: "dispatched",
      code: "recovery-dispatched",
      message: claim.descriptor.action === "retry_observation"
        ? "Started the exact prepared read-only observation recovery."
        : "Started the exact prepared read-only verification recovery.",
      descriptor: cloneTaskControlRecoveryDescriptor(claim.descriptor),
      recoveryExecutionId
    },
    completion
  };
}

async function completeTaskRecoveryDispatch({
  executionId,
  input,
  isCurrent,
  onLifecycle,
  runStage,
  store
}: {
  executionId: string;
  input: TaskRecoveryStageInput;
  isCurrent: () => boolean;
  onLifecycle?: (event: TaskRecoveryLifecycleEvent) => void;
  runStage: (input: TaskRecoveryStageInput) => Promise<TaskRecoveryStageResult>;
  store: TaskControlStore;
}): Promise<void> {
  let result: TaskRecoveryStageResult;
  try {
    result = await runStage(input);
  } catch {
    result = {
      state: "failed",
      message: "The bound read-only recovery stage could not be completed."
    };
  }
  if (!isCurrent()) return;

  const terminal = finishTaskRecoveryStage({
    descriptor: input.descriptor,
    executionId,
    result,
    store
  });
  emitLifecycle(onLifecycle, readTerminalTaskStatus(result), terminal.message, terminal);
}

function finishTaskRecoveryStage({
  descriptor,
  executionId,
  result,
  store
}: {
  descriptor: TaskRecoveryStageInput["descriptor"];
  executionId: string;
  result: TaskRecoveryStageResult;
  store: TaskControlStore;
}): TaskControlSnapshot {
  if (result.state === "passed") {
    return store.finish({
      executionId,
      outcome: "completed",
      message: result.message,
      sideEffectState: "none",
      replayAvailable: true,
      recoveryDescriptors: []
    });
  }

  const outcome = result.state === "confirmation_required"
    ? "confirmation_required"
    : result.state;
  return store.finish({
    executionId,
    outcome,
    message: result.message,
    sideEffectState: "none",
    replayAvailable: true,
    failureStage: readRecoveryFailureStage(result, descriptor.action)
  });
}

function readRecoveryFailureStage(
  result: Exclude<TaskRecoveryStageResult, { state: "passed" }>,
  action: TaskRecoveryStageInput["descriptor"]["action"]
): TaskControlFailureStage {
  if (result.state === "blocked") return "preflight";
  return action === "retry_observation" ? "observation" : "verification";
}

function readTerminalTaskStatus(result: TaskRecoveryStageResult): TaskStatus {
  if (result.state === "passed") return "completed";
  if (result.state === "confirmation_required") return "needs_confirmation";
  return result.state;
}

function createTaskRecoveryPlan(
  recoveryId: string,
  sourcePlan: ComputerUsePlanPreview
): ComputerUsePlanPreview {
  return {
    planId: `${recoveryId}:stage-plan`,
    route: sourcePlan.route,
    appName: sourcePlan.appName,
    target: "Bound read-only recovery stage",
    risk: {
      level: "low",
      reason: "This recovery only observes or verifies current state.",
      requiresApproval: false
    },
    approvalRequired: false,
    expectedVerification: "Report bounded read-only evidence without replaying the original mutation.",
    mutating: false
  };
}

function readWaitingMessage(action: TaskControlRecoveryRequest["action"]): string {
  return action === "retry_observation"
    ? "Prepared read-only observation is starting."
    : "Prepared read-only verification is starting.";
}

function readExecutingMessage(action: TaskControlRecoveryRequest["action"]): string {
  return action === "retry_observation"
    ? "Running the bound read-only observation stage."
    : "Starting the bound read-only verification stage.";
}

function emitLifecycle(
  onLifecycle: StartTaskRecoveryDispatchInput["onLifecycle"],
  status: TaskStatus,
  message: string,
  snapshot: TaskControlSnapshot
): void {
  onLifecycle?.({ status, message, snapshot });
}

function rejectDispatch(
  code: Extract<TaskControlRecoveryDispatchResult, { state: "rejected" }>["code"],
  message: string
): TaskControlRecoveryDispatchResult {
  return { state: "rejected", code, message };
}
