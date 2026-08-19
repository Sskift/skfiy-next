import {
  cloneTaskControlRecoveryDescriptor,
  cloneTaskControlRecoveryDispatchResult,
  cloneTaskControlRecoveryPreparationResult,
  cloneTaskControlSnapshot,
  isTaskControlRecoveryRequest,
  isTaskControlSnapshot,
  type TaskControlRecoveryDescriptor,
  type TaskControlRecoveryDispatchResult,
  type TaskControlRecoveryPreparationResult,
  type TaskControlRecoveryRequest,
  type TaskControlSnapshot
} from "../shared/task-control.js";
import type { ComputerUseCommandRoute } from "./main-pending-approval.js";
import type { FinderExecutionPlanBinding } from "./orchestrator/finder-task.js";
import type { ManualMode } from "./task-event-view.js";

const MAX_RECOVERY_DRAFT_LENGTH = 2_000;

export interface TaskRecoveryExecutionContext {
  executionId: string;
  command: string;
  mode: ManualMode;
  route: ComputerUseCommandRoute;
  finderExecutionPlan?: FinderExecutionPlanBinding;
}

export type TaskRecoveryDispatchClaim =
  | {
      state: "claimed";
      descriptor: TaskControlRecoveryDescriptor;
      snapshot: TaskControlSnapshot;
      context: TaskRecoveryExecutionContext;
    }
  | Extract<TaskControlRecoveryDispatchResult, { state: "rejected" }>;

export function createTaskRecoveryRegistry() {
  let currentExecutionId: string | null = null;
  let descriptorFingerprint = "";
  let snapshot: TaskControlSnapshot | null = null;
  let descriptors = new Map<string, TaskControlRecoveryDescriptor>();
  const preparedResults = new Map<string, TaskControlRecoveryPreparationResult>();
  const dispatchedRecoveryIds = new Set<string>();
  let executionContext: TaskRecoveryExecutionContext | null = null;

  const clearRecoveryState = () => {
    currentExecutionId = null;
    descriptorFingerprint = "";
    snapshot = null;
    descriptors = new Map();
    preparedResults.clear();
    dispatchedRecoveryIds.clear();
  };

  const clear = () => {
    clearRecoveryState();
    executionContext = null;
  };

  return {
    bindExecutionContext(value: TaskRecoveryExecutionContext): void {
      executionContext = cloneExecutionContext(value);
    },

    sync(value: TaskControlSnapshot | null): void {
      if (
        !value
        || !isTaskControlSnapshot(value)
      ) {
        clear();
        return;
      }
      if (
        value.phase !== "terminal"
        || !value.recoveryDescriptors
        || value.recoveryDescriptors.length === 0
      ) {
        if (executionContext?.executionId !== value.executionId) {
          executionContext = null;
        }
        clearRecoveryState();
        return;
      }

      const nextFingerprint = JSON.stringify(value.recoveryDescriptors);
      if (
        currentExecutionId === value.executionId
        && descriptorFingerprint === nextFingerprint
      ) {
        snapshot = cloneTaskControlSnapshot(value);
        return;
      }

      currentExecutionId = value.executionId;
      descriptorFingerprint = nextFingerprint;
      snapshot = cloneTaskControlSnapshot(value);
      descriptors = new Map(value.recoveryDescriptors.map((descriptor) => [
        descriptor.recoveryId,
        cloneTaskControlRecoveryDescriptor(descriptor)
      ]));
      preparedResults.clear();
      dispatchedRecoveryIds.clear();
      if (executionContext?.executionId !== value.executionId) {
        executionContext = null;
      }
    },

    prepare(
      value: unknown,
      current: TaskControlSnapshot | null
    ): TaskControlRecoveryPreparationResult {
      if (!isTaskControlRecoveryRequest(value)) {
        return reject(
          "recovery-invalid-request",
          "The recovery request is invalid and was not prepared."
        );
      }
      if (
        !current
        || !isTaskControlSnapshot(current)
        || current.phase !== "terminal"
        || current.executionId !== value.executionId
        || currentExecutionId !== value.executionId
      ) {
        return reject(
          "recovery-stale-execution",
          "The recovery request is stale and was not prepared."
        );
      }

      const descriptor = descriptors.get(value.recoveryId);
      if (!descriptor) {
        return reject(
          "recovery-unknown",
          "The recovery request is no longer available and was not prepared."
        );
      }
      if (
        !recoveryRequestMatchesDescriptor(value, descriptor)
        || !current.recoveryDescriptors?.some((candidate) =>
          recoveryDescriptorsEqual(candidate, descriptor)
        )
        || !snapshot?.recoveryDescriptors?.some((candidate) =>
          recoveryDescriptorsEqual(candidate, descriptor)
        )
      ) {
        return reject(
          "recovery-mismatched",
          "The recovery request does not match the terminal task and was not prepared."
        );
      }

      const existing = preparedResults.get(descriptor.recoveryId);
      if (existing) {
        return cloneTaskControlRecoveryPreparationResult(existing);
      }

      const prepared = createPreparedResult(descriptor, current);
      preparedResults.set(descriptor.recoveryId, prepared);
      return cloneTaskControlRecoveryPreparationResult(prepared);
    },

    claimDispatch(
      value: unknown,
      current: TaskControlSnapshot | null
    ): TaskRecoveryDispatchClaim {
      if (!isTaskControlRecoveryRequest(value)) {
        return rejectDispatch(
          "recovery-dispatch-invalid-request",
          "The recovery dispatch request is invalid and was not started."
        );
      }
      if (
        !current
        || !isTaskControlSnapshot(current)
        || current.phase !== "terminal"
        || current.executionId !== value.executionId
        || currentExecutionId !== value.executionId
      ) {
        return rejectDispatch(
          "recovery-dispatch-stale-execution",
          "The recovery dispatch request is stale and was not started."
        );
      }

      const descriptor = descriptors.get(value.recoveryId);
      if (!descriptor) {
        return rejectDispatch(
          "recovery-dispatch-unknown",
          "The recovery dispatch request is no longer available and was not started."
        );
      }
      if (
        !recoveryRequestMatchesDescriptor(value, descriptor)
        || !current.recoveryDescriptors?.some((candidate) =>
          recoveryDescriptorsEqual(candidate, descriptor)
        )
        || !snapshot?.recoveryDescriptors?.some((candidate) =>
          recoveryDescriptorsEqual(candidate, descriptor)
        )
      ) {
        return rejectDispatch(
          "recovery-dispatch-mismatched",
          "The recovery dispatch request does not match the terminal task and was not started."
        );
      }
      if (dispatchedRecoveryIds.has(descriptor.recoveryId)) {
        return rejectDispatch(
          "recovery-already-dispatched",
          "The recovery stage was already dispatched and was not started again."
        );
      }
      if (!preparedResults.has(descriptor.recoveryId)) {
        return rejectDispatch(
          "recovery-not-prepared",
          "Prepare this recovery stage before dispatching it."
        );
      }
      if (
        descriptor.mode !== "prepare_only"
        || (descriptor.action !== "retry_observation" && descriptor.action !== "retry_verification")
        || !executionContext
        || executionContext.executionId !== descriptor.executionId
        || executionContext.route.kind !== descriptor.route
        || (executionContext.route.kind === "finder" && !executionContext.finderExecutionPlan)
      ) {
        return rejectDispatch(
          "recovery-dispatch-unavailable",
          "This recovery does not have a bound read-only stage and was not started."
        );
      }

      dispatchedRecoveryIds.add(descriptor.recoveryId);
      return {
        state: "claimed",
        descriptor: cloneTaskControlRecoveryDescriptor(descriptor),
        snapshot: cloneTaskControlSnapshot(current),
        context: cloneExecutionContext(executionContext)
      };
    }
  };
}

function createPreparedResult(
  descriptor: TaskControlRecoveryDescriptor,
  snapshot: TaskControlSnapshot
): TaskControlRecoveryPreparationResult {
  const result = {
    state: "prepared" as const,
    code: "recovery-prepared" as const,
    message: readPreparedMessage(descriptor),
    descriptor: cloneTaskControlRecoveryDescriptor(descriptor)
  };

  return descriptor.mode === "draft_only"
    ? {
        ...result,
        draft: createPlanRevisionDraft(snapshot)
      }
    : result;
}

function readPreparedMessage(descriptor: TaskControlRecoveryDescriptor): string {
  switch (descriptor.action) {
    case "retry_observation":
      return "Prepared a read-only observation recovery. No Computer Use action has run.";
    case "retry_verification":
      return "Prepared a read-only verification recovery. No Computer Use action has run.";
    case "revise_plan":
      return "Prepared a bounded plan-revision draft. No Computer Use action has run.";
    case "open_readiness":
      return "Prepared readiness navigation. No Computer Use action has run.";
  }
}

function createPlanRevisionDraft(snapshot: TaskControlSnapshot): string {
  return `Revise the bound ${snapshot.plan.route} Computer Use plan before taking any action.`
    .slice(0, MAX_RECOVERY_DRAFT_LENGTH);
}

function recoveryRequestMatchesDescriptor(
  request: TaskControlRecoveryRequest,
  descriptor: TaskControlRecoveryDescriptor
): boolean {
  return request.recoveryId === descriptor.recoveryId
    && request.action === descriptor.action
    && request.executionId === descriptor.executionId
    && request.planId === descriptor.planId
    && request.route === descriptor.route
    && request.outcome === descriptor.outcome
    && request.failureStage === descriptor.failureStage;
}

function recoveryDescriptorsEqual(
  left: TaskControlRecoveryDescriptor,
  right: TaskControlRecoveryDescriptor
): boolean {
  return left.mode === right.mode && recoveryRequestMatchesDescriptor(left, right);
}

function reject(
  code: Exclude<TaskControlRecoveryPreparationResult["code"], "recovery-prepared">,
  message: string
): TaskControlRecoveryPreparationResult {
  return { state: "rejected", code, message };
}

function rejectDispatch(
  code: Exclude<TaskControlRecoveryDispatchResult["code"], "recovery-dispatched">,
  message: string
): Extract<TaskControlRecoveryDispatchResult, { state: "rejected" }> {
  return cloneTaskControlRecoveryDispatchResult({ state: "rejected", code, message }) as Extract<
    TaskControlRecoveryDispatchResult,
    { state: "rejected" }
  >;
}

function cloneExecutionContext(
  context: TaskRecoveryExecutionContext
): TaskRecoveryExecutionContext {
  return {
    ...context,
    route: { ...context.route },
    ...(context.finderExecutionPlan ? {
      finderExecutionPlan: {
        ...context.finderExecutionPlan,
        operations: context.finderExecutionPlan.operations.map((operation) => ({
          ...operation,
          ...(operation.type !== "create_folder" && operation.expectedSourceIdentity ? {
            expectedSourceIdentity: { ...operation.expectedSourceIdentity }
          } : {}),
          ...(operation.type !== "create_folder" && operation.expectedDestinationIdentity ? {
            expectedDestinationIdentity: { ...operation.expectedDestinationIdentity }
          } : {})
        }))
      }
    } : {})
  };
}
