import {
  createTaskControlRecoveryRequest,
  type TaskControlRecoveryDescriptor,
  type TaskControlRecoveryPreparationResult,
  type TaskControlRecoveryRequest,
  type TaskControlSnapshot
} from "../shared/task-control";

export interface PreparedTaskRecovery {
  descriptor: TaskControlRecoveryDescriptor;
  generatedDraft: string;
  message: string;
  request: TaskControlRecoveryRequest;
}

export interface PreparedTaskRecoveryStage {
  descriptor: TaskControlRecoveryDescriptor;
  message: string;
  request: TaskControlRecoveryRequest;
}

export type PreparedTaskRecoveryReleaseIntent =
  | "clear_prepared_recovery"
  | "use_as_new_request";

export interface PreparedTaskRecoveryRelease {
  draft: string;
  editedDraftPreserved: boolean;
  prepared: null;
}

export interface PreparedTaskRecoveryReconciliation extends PreparedTaskRecoveryRelease {
  stale: true;
}

export function readAuthoritativeTaskControlRecoveryDescriptors(
  snapshot: TaskControlSnapshot
): TaskControlRecoveryDescriptor[] {
  if (snapshot.phase !== "terminal" || !snapshot.recoveryDescriptors) {
    return [];
  }

  return snapshot.recoveryDescriptors.map((descriptor) => ({ ...descriptor }));
}

export function isTaskControlRecoveryDescriptorCurrent(
  snapshot: TaskControlSnapshot | null | undefined,
  descriptor: TaskControlRecoveryDescriptor
): boolean {
  if (
    !snapshot
    || snapshot.phase !== "terminal"
    || snapshot.executionId !== descriptor.executionId
    || snapshot.executionPlanId !== descriptor.planId
    || snapshot.plan.route !== descriptor.route
    || snapshot.outcome !== descriptor.outcome
    || snapshot.failureStage !== descriptor.failureStage
  ) {
    return false;
  }

  return snapshot.recoveryDescriptors?.some((candidate) =>
    areTaskControlRecoveryDescriptorsEqual(candidate, descriptor)
  ) === true;
}

export function createPreparedTaskRecovery(
  result: TaskControlRecoveryPreparationResult
): PreparedTaskRecovery | null {
  if (
    result.state !== "prepared"
    || result.descriptor.mode !== "draft_only"
    || !result.draft
  ) {
    return null;
  }

  return {
    descriptor: { ...result.descriptor },
    generatedDraft: result.draft,
    message: result.message,
    request: createTaskControlRecoveryRequest(result.descriptor)
  };
}

export function createPreparedTaskRecoveryStage(
  result: TaskControlRecoveryPreparationResult
): PreparedTaskRecoveryStage | null {
  if (result.state !== "prepared" || result.descriptor.mode !== "prepare_only") {
    return null;
  }

  return {
    descriptor: { ...result.descriptor },
    message: result.message,
    request: createTaskControlRecoveryRequest(result.descriptor)
  };
}

export function releasePreparedTaskRecovery(
  prepared: PreparedTaskRecovery,
  currentDraft: string,
  intent: PreparedTaskRecoveryReleaseIntent
): PreparedTaskRecoveryRelease {
  const editedDraftPreserved = currentDraft !== prepared.generatedDraft;
  return {
    draft: intent === "clear_prepared_recovery" && !editedDraftPreserved
      ? ""
      : currentDraft,
    editedDraftPreserved,
    prepared: null
  };
}

export function reconcilePreparedTaskRecovery(
  prepared: PreparedTaskRecovery,
  currentDraft: string,
  snapshot: TaskControlSnapshot | null | undefined
): PreparedTaskRecovery | PreparedTaskRecoveryReconciliation {
  if (isTaskControlRecoveryDescriptorCurrent(snapshot, prepared.descriptor)) {
    return prepared;
  }

  return {
    ...releasePreparedTaskRecovery(
      prepared,
      currentDraft,
      "clear_prepared_recovery"
    ),
    stale: true
  };
}

export function reconcilePreparedTaskRecoveryStage(
  prepared: PreparedTaskRecoveryStage,
  snapshot: TaskControlSnapshot | null | undefined
): PreparedTaskRecoveryStage | null {
  return isTaskControlRecoveryDescriptorCurrent(snapshot, prepared.descriptor)
    ? prepared
    : null;
}

export function areTaskControlRecoveryDescriptorsEqual(
  left: TaskControlRecoveryDescriptor,
  right: TaskControlRecoveryDescriptor
): boolean {
  return left.recoveryId === right.recoveryId
    && left.action === right.action
    && left.mode === right.mode
    && left.executionId === right.executionId
    && left.planId === right.planId
    && left.route === right.route
    && left.outcome === right.outcome
    && left.failureStage === right.failureStage;
}
