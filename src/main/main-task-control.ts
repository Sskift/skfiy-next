import {
  cloneTaskControlSnapshot,
  type ComputerUsePlanPreview,
  type TaskControlApproval,
  type TaskControlOutcome,
  type TaskControlRecoveryAction,
  type TaskControlSideEffectState,
  type TaskControlSnapshot
} from "../shared/task-control.js";
import {
  createTaskControlStore,
  TaskControlStoreError
} from "./task-control-store.js";
import type { AssistantComputerUseToolIdentity } from "./assistant-computer-use-executor.js";
import type { ComputerUseTaskEvent, TaskEvent } from "./task-event-view.js";

export type MainTaskControlStore = ReturnType<typeof createTaskControlStore>;

export interface StartComputerUseTaskControlInput {
  store: MainTaskControlStore;
  identity: AssistantComputerUseToolIdentity;
  message: string;
  plan: ComputerUsePlanPreview;
}

export interface AdvanceComputerUseTaskControlInput {
  store: MainTaskControlStore;
  executionId: string;
  event: TaskEvent;
  sideEffectState?: TaskControlSideEffectState;
  approval?: TaskControlApproval;
}

export function createTaskControlExecutionId(
  identity: AssistantComputerUseToolIdentity
): string {
  return `${identity.turnId}:${identity.toolCallId}`;
}

export function startComputerUseTaskControl({
  store,
  identity,
  message,
  plan
}: StartComputerUseTaskControlInput): TaskControlSnapshot {
  return store.start({
    executionId: createTaskControlExecutionId(identity),
    message,
    plan
  });
}

export function advanceComputerUseTaskControl({
  approval,
  store,
  executionId,
  event,
  sideEffectState
}: AdvanceComputerUseTaskControlInput): TaskControlSnapshot {
  const current = requireTaskControlSnapshot(store, executionId);
  const outcome = readTaskControlOutcome(event);
  if (outcome) {
    return store.finish({
      executionId,
      outcome,
      message: readTaskControlEventMessage(event, current),
      sideEffectState: sideEffectState ?? current.sideEffectState,
      replayAvailable: true,
      recoveryActions: readRecoveryActions(outcome)
    });
  }

  const requestedPhase = readActiveTaskControlPhase(event);
  const phase = preserveForwardPhase(current, requestedPhase);
  try {
    return store.transition({
      executionId,
      phase,
      message: readTaskControlEventMessage(event, current),
      sideEffectState: sideEffectState ?? current.sideEffectState,
      ...(phase === "approval" && approval ? { approval } : {}),
      replayAvailable: current.replayAvailable
        || phase === "executing"
        || phase === "verifying"
    });
  } catch (error) {
    // A second approval gate (e.g. Chrome action-plan after app-policy
    // approval) can arrive while the store is already executing with
    // possible side effects. The phase machine rejects executing→approval
    // in that state — keep the current snapshot and let the event flow.
    if (
      error instanceof TaskControlStoreError
      && error.code === "invalid-transition"
    ) {
      return current;
    }
    throw error;
  }
}

export function decorateTaskEventWithTaskControl(
  event: TaskEvent,
  snapshot: TaskControlSnapshot
): TaskEvent & { taskControl: TaskControlSnapshot } {
  return {
    ...event,
    taskControl: cloneTaskControlSnapshot(snapshot)
  };
}

export function createTaskControlStopMessage(snapshot: TaskControlSnapshot): string {
  return snapshot.sideEffectState === "none"
    ? "Task stopped. No external mutation was recorded before cancellation."
    : "Task stopped. Dispatched or completed actions, if any, were not undone.";
}

export function readComputerUseTaskSideEffectState(
  event: ComputerUseTaskEvent,
  plan: ComputerUsePlanPreview,
  options: {
    actionApproved?: boolean;
    finderPlanApproved?: boolean;
    finderPlanConfirmationRequired?: boolean;
    chromeSubmitApproved?: boolean;
    chromeSubmitConfirmationRequired?: boolean;
  } = {}
): TaskControlSideEffectState | undefined {
  if (!plan.mutating) {
    return "none";
  }

  switch (event.type) {
    case "started":
      return options.actionApproved
        && (
          plan.route !== "finder"
          || options.finderPlanApproved
          || options.finderPlanConfirmationRequired === false
        )
        ? "possible"
        : undefined;
    case "typing":
    case "submitted":
      return "possible";
    case "action_verified":
    case "completed":
      return "occurred";
    default:
      return undefined;
  }
}

function requireTaskControlSnapshot(
  store: MainTaskControlStore,
  executionId: string
): TaskControlSnapshot {
  const snapshot = store.read();
  if (!snapshot || snapshot.executionId !== executionId) {
    throw new Error(`Task Control execution ${executionId} is not active.`);
  }
  return snapshot;
}

function readTaskControlOutcome(event: TaskEvent): TaskControlOutcome | undefined {
  switch (event.routeOutcome?.kind) {
    case "app_policy_denied":
      return "app_policy_denied";
    case "user_denied":
      return "user_denied";
    case "blocked":
    case "chrome_host_policy_denied":
      return "blocked";
    case "needs_confirmation":
      return "confirmation_required";
    case "failed":
      return "failed";
    case "cancelled":
    case "stopped":
      return "cancelled";
    case "completed":
      return "completed";
  }

  switch (event.status) {
    case "denied":
      return event.denialKind === "app_policy" ? "app_policy_denied" : "user_denied";
    case "blocked":
      return event.denialKind === "app_policy" ? "app_policy_denied" : "blocked";
    case "needs_confirmation":
      return "confirmation_required";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

function readActiveTaskControlPhase(
  event: TaskEvent
): "waiting" | "approval" | "executing" | "verifying" {
  switch (event.status) {
    case "approval_required":
      return "approval";
    case "executing":
    case "running":
      return "executing";
    case "verifying":
      return "verifying";
    default:
      return "waiting";
  }
}

function preserveForwardPhase(
  current: TaskControlSnapshot,
  requested: "waiting" | "approval" | "executing" | "verifying"
): "waiting" | "approval" | "executing" | "verifying" {
  if (requested !== "waiting" || current.phase === "waiting") {
    return requested;
  }
  if (current.phase === "terminal") {
    throw new Error(`Task Control execution ${current.executionId} is already terminal.`);
  }
  return current.phase;
}

function readRecoveryActions(
  outcome: TaskControlOutcome
): TaskControlRecoveryAction[] {
  switch (outcome) {
    case "app_policy_denied":
    case "blocked":
      return ["revise_plan", "open_readiness"];
    case "user_denied":
    case "cancelled":
      return ["revise_plan"];
    case "confirmation_required":
    case "failed":
      return [
        "retry_observation",
        "retry_verification",
        "revise_plan",
        "open_readiness"
      ];
    case "completed":
      return [];
  }
}

function readTaskControlEventMessage(
  event: TaskEvent,
  current: TaskControlSnapshot
): string {
  if (event.replayRecord) {
    return `Captured ${event.replayRecord.stage} observation evidence.`;
  }

  const sanitized = (event.message ?? current.message)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim();
  return (sanitized || current.message).slice(0, 2_000);
}
