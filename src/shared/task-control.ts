export const TASK_CONTROL_SCHEMA_VERSION = 1 as const;

export const COMPUTER_USE_PLAN_ROUTES = [
  "ghostty",
  "chrome",
  "finder",
  "desktop",
  "tmux_supervision"
] as const;

export const TASK_CONTROL_RISK_LEVELS = [
  "low",
  "medium",
  "high",
  "blocked"
] as const;

export const TASK_CONTROL_PHASES = [
  "waiting",
  "approval",
  "executing",
  "verifying",
  "terminal"
] as const;

export const TASK_CONTROL_OUTCOMES = [
  "app_policy_denied",
  "user_denied",
  "blocked",
  "confirmation_required",
  "failed",
  "cancelled",
  "completed"
] as const;

export const TASK_CONTROL_RECOVERY_ACTIONS = [
  "retry_observation",
  "retry_verification",
  "revise_plan",
  "open_readiness"
] as const;

export const TASK_CONTROL_FAILURE_STAGES = [
  "preflight",
  "approval",
  "observation",
  "execution",
  "verification"
] as const;

export const TASK_CONTROL_RECOVERY_MODES = [
  "prepare_only",
  "draft_only",
  "navigation"
] as const;

export const TASK_CONTROL_RECOVERY_RESULT_CODES = [
  "recovery-prepared",
  "recovery-invalid-request",
  "recovery-invalid-response",
  "recovery-stale-execution",
  "recovery-unknown",
  "recovery-mismatched"
] as const;

export const TASK_CONTROL_RECOVERY_DISPATCH_RESULT_CODES = [
  "recovery-dispatched",
  "recovery-dispatch-invalid-request",
  "recovery-dispatch-invalid-response",
  "recovery-dispatch-stale-execution",
  "recovery-dispatch-unknown",
  "recovery-dispatch-mismatched",
  "recovery-not-prepared",
  "recovery-already-dispatched",
  "recovery-dispatch-unavailable"
] as const;

export const TASK_CONTROL_SIDE_EFFECT_STATES = [
  "none",
  "possible",
  "occurred"
] as const;

export type ComputerUsePlanRoute = typeof COMPUTER_USE_PLAN_ROUTES[number];
export type TaskControlRiskLevel = typeof TASK_CONTROL_RISK_LEVELS[number];
export type TaskControlPhase = typeof TASK_CONTROL_PHASES[number];
export type TaskControlOutcome = typeof TASK_CONTROL_OUTCOMES[number];
export type TaskControlRecoveryAction = typeof TASK_CONTROL_RECOVERY_ACTIONS[number];
export type TaskControlFailureStage = typeof TASK_CONTROL_FAILURE_STAGES[number];
export type TaskControlRecoveryMode = typeof TASK_CONTROL_RECOVERY_MODES[number];
export type TaskControlRecoveryResultCode = typeof TASK_CONTROL_RECOVERY_RESULT_CODES[number];
export type TaskControlRecoveryDispatchResultCode =
  typeof TASK_CONTROL_RECOVERY_DISPATCH_RESULT_CODES[number];
export type TaskControlSideEffectState = typeof TASK_CONTROL_SIDE_EFFECT_STATES[number];
export type TaskControlApprovalGate = "action-plan" | "finder-plan" | "chrome-submit";

export type TaskControlStatus =
  | "waiting"
  | "approval_required"
  | "executing"
  | "verifying"
  | TaskControlOutcome;

export interface ComputerUsePlanPreview {
  planId: string;
  route: ComputerUsePlanRoute;
  appName: string;
  target: string;
  risk: {
    level: TaskControlRiskLevel;
    reason: string;
    requiresApproval: boolean;
  };
  approvalRequired: boolean;
  expectedVerification: string;
  mutating: boolean;
}

export interface TaskControlFinderPlanPreview {
  rootPath: string;
  operationCount: number;
  destructiveOperationCount: number;
  createFolders: string[];
  moveFiles: Array<{ from: string; to: string }>;
  copyFiles?: Array<{ from: string; to: string }>;
}

export interface TaskControlApproval {
  gate: TaskControlApprovalGate;
  planId: string;
  finderPlanPreview?: TaskControlFinderPlanPreview;
  chromeSubmitBinding?: TaskControlChromeSubmitBinding;
}

export interface TaskControlChromeSubmitBinding {
  schemaVersion: 1;
  url: string;
  fieldSelectors: string[];
  submitSelector: string;
}

export interface TaskControlRecoveryDescriptor {
  recoveryId: string;
  action: TaskControlRecoveryAction;
  mode: TaskControlRecoveryMode;
  executionId: string;
  planId: string;
  route: ComputerUsePlanRoute;
  outcome: TaskControlOutcome;
  failureStage: TaskControlFailureStage;
}

export interface TaskControlRecoveryRequest {
  recoveryId: string;
  action: TaskControlRecoveryAction;
  executionId: string;
  planId: string;
  route: ComputerUsePlanRoute;
  outcome: TaskControlOutcome;
  failureStage: TaskControlFailureStage;
}

export type TaskControlRecoveryPreparationResult =
  | {
      state: "prepared";
      code: "recovery-prepared";
      message: string;
      descriptor: TaskControlRecoveryDescriptor;
      draft?: string;
    }
  | {
      state: "rejected";
      code: Exclude<TaskControlRecoveryResultCode, "recovery-prepared">;
      message: string;
    };

export type TaskControlRecoveryDispatchResult =
  | {
      state: "dispatched";
      code: "recovery-dispatched";
      message: string;
      descriptor: TaskControlRecoveryDescriptor;
      recoveryExecutionId: string;
    }
  | {
      state: "rejected";
      code: Exclude<TaskControlRecoveryDispatchResultCode, "recovery-dispatched">;
      message: string;
    };

export interface TaskControlSnapshot {
  schemaVersion: typeof TASK_CONTROL_SCHEMA_VERSION;
  executionId: string;
  phase: TaskControlPhase;
  status: TaskControlStatus;
  message: string;
  plan: ComputerUsePlanPreview;
  sideEffectState: TaskControlSideEffectState;
  replayAvailable: boolean;
  /** Compatibility-only display projection. Recovery descriptors are authoritative. */
  recoveryActions: TaskControlRecoveryAction[];
  executionPlanId?: string;
  failureStage?: TaskControlFailureStage;
  recoveryDescriptors?: TaskControlRecoveryDescriptor[];
  approval?: TaskControlApproval;
  outcome?: TaskControlOutcome;
}

const MAX_ID_LENGTH = 160;
const MAX_APP_NAME_LENGTH = 160;
const MAX_TEXT_LENGTH = 2_000;
const MAX_RECOVERY_ACTIONS = TASK_CONTROL_RECOVERY_ACTIONS.length;
const MAX_FINDER_OPERATIONS = 2_000;

const PLAN_KEYS = new Set([
  "planId",
  "route",
  "appName",
  "target",
  "risk",
  "approvalRequired",
  "expectedVerification",
  "mutating"
]);
const PLAN_REQUIRED_KEYS = [...PLAN_KEYS];
const RISK_KEYS = new Set(["level", "reason", "requiresApproval"]);
const RISK_REQUIRED_KEYS = [...RISK_KEYS];
const SNAPSHOT_KEYS = new Set([
  "schemaVersion",
  "executionId",
  "phase",
  "status",
  "message",
  "plan",
  "sideEffectState",
  "replayAvailable",
  "recoveryActions",
  "executionPlanId",
  "failureStage",
  "recoveryDescriptors",
  "approval",
  "outcome"
]);
const SNAPSHOT_REQUIRED_KEYS = [
  "schemaVersion",
  "executionId",
  "phase",
  "status",
  "message",
  "plan",
  "sideEffectState",
  "replayAvailable",
  "recoveryActions"
];
const APPROVAL_KEYS = new Set([
  "gate",
  "planId",
  "finderPlanPreview",
  "chromeSubmitBinding"
]);
const APPROVAL_REQUIRED_KEYS = ["gate", "planId"];
const CHROME_SUBMIT_BINDING_KEYS = new Set([
  "schemaVersion",
  "url",
  "fieldSelectors",
  "submitSelector"
]);
const FINDER_PREVIEW_KEYS = new Set([
  "rootPath",
  "operationCount",
  "destructiveOperationCount",
  "createFolders",
  "moveFiles",
  "copyFiles"
]);
const FINDER_PREVIEW_REQUIRED_KEYS = [
  "rootPath",
  "operationCount",
  "destructiveOperationCount",
  "createFolders",
  "moveFiles"
];
const FINDER_MOVE_KEYS = new Set(["from", "to"]);
const FINDER_MOVE_REQUIRED_KEYS = [...FINDER_MOVE_KEYS];
const RECOVERY_DESCRIPTOR_KEYS = new Set([
  "recoveryId",
  "action",
  "mode",
  "executionId",
  "planId",
  "route",
  "outcome",
  "failureStage"
]);
const RECOVERY_DESCRIPTOR_REQUIRED_KEYS = [...RECOVERY_DESCRIPTOR_KEYS];
const RECOVERY_REQUEST_KEYS = new Set([
  "recoveryId",
  "action",
  "executionId",
  "planId",
  "route",
  "outcome",
  "failureStage"
]);
const RECOVERY_REQUEST_REQUIRED_KEYS = [...RECOVERY_REQUEST_KEYS];
const RECOVERY_RESULT_KEYS = new Set([
  "state",
  "code",
  "message",
  "descriptor",
  "draft"
]);
const RECOVERY_DISPATCH_RESULT_KEYS = new Set([
  "state",
  "code",
  "message",
  "descriptor",
  "recoveryExecutionId"
]);

const ACTIVE_STATUS_BY_PHASE = {
  waiting: "waiting",
  approval: "approval_required",
  executing: "executing",
  verifying: "verifying"
} as const satisfies Record<Exclude<TaskControlPhase, "terminal">, TaskControlStatus>;

export function isComputerUsePlanPreview(value: unknown): value is ComputerUsePlanPreview {
  const plan = readRecord(value);
  if (!plan || !hasStrictKeys(plan, PLAN_KEYS, PLAN_REQUIRED_KEYS)) {
    return false;
  }

  const risk = readRecord(plan.risk);
  if (!risk || !hasStrictKeys(risk, RISK_KEYS, RISK_REQUIRED_KEYS)) {
    return false;
  }

  return isBoundedIdentifier(plan.planId)
    && isComputerUsePlanRoute(plan.route)
    && isBoundedText(plan.appName, MAX_APP_NAME_LENGTH)
    && isBoundedText(plan.target, MAX_TEXT_LENGTH)
    && isTaskControlRiskLevel(risk.level)
    && isBoundedText(risk.reason, MAX_TEXT_LENGTH)
    && typeof risk.requiresApproval === "boolean"
    && typeof plan.approvalRequired === "boolean"
    && isBoundedText(plan.expectedVerification, MAX_TEXT_LENGTH)
    && typeof plan.mutating === "boolean"
    && (
      risk.level !== "blocked"
      || (plan.approvalRequired === false && plan.mutating === false)
    );
}

export function isTaskControlSnapshot(value: unknown): value is TaskControlSnapshot {
  const snapshot = readRecord(value);
  if (!snapshot || !hasStrictKeys(snapshot, SNAPSHOT_KEYS, SNAPSHOT_REQUIRED_KEYS)) {
    return false;
  }

  if (
    snapshot.schemaVersion !== TASK_CONTROL_SCHEMA_VERSION
    || !isBoundedIdentifier(snapshot.executionId)
    || !isTaskControlPhase(snapshot.phase)
    || !isTaskControlStatus(snapshot.status)
    || !isBoundedText(snapshot.message, MAX_TEXT_LENGTH)
    || !isComputerUsePlanPreview(snapshot.plan)
    || !isTaskControlSideEffectState(snapshot.sideEffectState)
    || typeof snapshot.replayAvailable !== "boolean"
    || !isRecoveryActionList(snapshot.recoveryActions)
  ) {
    return false;
  }

  const executionPlanId = snapshot.executionPlanId;
  if (
    executionPlanId !== undefined
    && (
      !isBoundedIdentifier(executionPlanId)
      || !isExecutionPlanIdForPlan(executionPlanId, snapshot.plan)
    )
  ) {
    return false;
  }
  if (snapshot.failureStage !== undefined && !isTaskControlFailureStage(snapshot.failureStage)) {
    return false;
  }
  if (
    snapshot.recoveryDescriptors !== undefined
    && !isRecoveryDescriptorList(snapshot.recoveryDescriptors)
  ) {
    return false;
  }

  if (snapshot.phase === "terminal") {
    if (
      !isTaskControlOutcome(snapshot.outcome)
      || snapshot.status !== snapshot.outcome
      || snapshot.approval !== undefined
    ) {
      return false;
    }

    const descriptors = snapshot.recoveryDescriptors;
    const recoveryActions = snapshot.recoveryActions as TaskControlRecoveryAction[];
    if (descriptors === undefined) {
      return true;
    }
    if (!executionPlanId) {
      return false;
    }
    if (snapshot.outcome === "completed") {
      return descriptors.length === 0
        && recoveryActions.length === 0
        && snapshot.failureStage === undefined;
    }
    if (!isTaskControlFailureStage(snapshot.failureStage) || descriptors.length === 0) {
      return false;
    }
    if (
      descriptors.length !== recoveryActions.length
      || descriptors.some((descriptor, index) => descriptor.action !== recoveryActions[index])
    ) {
      return false;
    }

    return descriptors.every((descriptor) =>
      descriptor.executionId === snapshot.executionId
      && descriptor.planId === executionPlanId
      && descriptor.route === (snapshot.plan as ComputerUsePlanPreview).route
      && descriptor.outcome === snapshot.outcome
      && descriptor.failureStage === snapshot.failureStage
      && isTaskControlRecoveryActionAllowed({
        action: descriptor.action,
        failureStage: descriptor.failureStage,
        outcome: descriptor.outcome,
        sideEffectState: snapshot.sideEffectState as TaskControlSideEffectState
      })
    );
  }

  const approvalIsValid = snapshot.phase === "approval"
    ? isTaskControlApproval(snapshot.approval, snapshot.plan)
    : snapshot.approval === undefined;

  return approvalIsValid
    && snapshot.outcome === undefined
    && snapshot.failureStage === undefined
    && snapshot.status === ACTIVE_STATUS_BY_PHASE[snapshot.phase]
    && snapshot.recoveryActions.length === 0
    && (
      snapshot.recoveryDescriptors === undefined
      || snapshot.recoveryDescriptors.length === 0
    )
    && (
      executionPlanId === undefined
      || snapshot.phase !== "approval"
      || executionPlanId === (snapshot.approval as TaskControlApproval).planId
    );
}

export function isTaskControlApproval(
  value: unknown,
  plan?: ComputerUsePlanPreview
): value is TaskControlApproval {
  const approval = readRecord(value);
  if (!approval || !hasStrictKeys(approval, APPROVAL_KEYS, APPROVAL_REQUIRED_KEYS)) {
    return false;
  }
  if (
    (
      approval.gate !== "action-plan"
      && approval.gate !== "finder-plan"
      && approval.gate !== "chrome-submit"
    )
    || !isBoundedIdentifier(approval.planId)
  ) {
    return false;
  }

  if (approval.gate === "action-plan") {
    return approval.finderPlanPreview === undefined
      && approval.chromeSubmitBinding === undefined
      && (!plan || approval.planId === plan.planId);
  }

  if (approval.gate === "chrome-submit") {
    return approval.finderPlanPreview === undefined
      && isTaskControlChromeSubmitBinding(approval.chromeSubmitBinding)
      && (!plan || (
        plan.route === "chrome"
        && approval.planId.startsWith(`${plan.planId}:`)
      ));
  }

  return isTaskControlFinderPlanPreview(approval.finderPlanPreview)
    && approval.chromeSubmitBinding === undefined
    && (!plan || approval.planId.startsWith(`${plan.planId}:`));
}

export function isTaskControlChromeSubmitBinding(
  value: unknown
): value is TaskControlChromeSubmitBinding {
  const binding = readRecord(value);
  return Boolean(binding)
    && hasStrictKeys(
      binding!,
      CHROME_SUBMIT_BINDING_KEYS,
      ["schemaVersion", "url", "fieldSelectors", "submitSelector"]
    )
    && binding!.schemaVersion === 1
    && isBoundedText(binding!.url, MAX_TEXT_LENGTH)
    && isBoundedTextList(binding!.fieldSelectors)
    && (binding!.fieldSelectors as string[]).length > 0
    && isBoundedText(binding!.submitSelector, MAX_TEXT_LENGTH);
}

export function isTaskControlFinderPlanPreview(
  value: unknown
): value is TaskControlFinderPlanPreview {
  const preview = readRecord(value);
  if (!preview || !hasStrictKeys(preview, FINDER_PREVIEW_KEYS, FINDER_PREVIEW_REQUIRED_KEYS)) {
    return false;
  }

  return isBoundedText(preview.rootPath, MAX_TEXT_LENGTH)
    && isBoundedCount(preview.operationCount)
    && isBoundedCount(preview.destructiveOperationCount)
    && preview.destructiveOperationCount <= preview.operationCount
    && isBoundedTextList(preview.createFolders)
    && Array.isArray(preview.moveFiles)
    && preview.moveFiles.length <= MAX_FINDER_OPERATIONS
    && preview.moveFiles.every(isTaskControlFinderMove)
    && (preview.copyFiles === undefined || (
      Array.isArray(preview.copyFiles)
      && preview.copyFiles.length <= MAX_FINDER_OPERATIONS
      && preview.copyFiles.every(isTaskControlFinderMove)
    ));
}

export function isComputerUsePlanRoute(value: unknown): value is ComputerUsePlanRoute {
  return typeof value === "string"
    && COMPUTER_USE_PLAN_ROUTES.includes(value as ComputerUsePlanRoute);
}

export function isTaskControlRiskLevel(value: unknown): value is TaskControlRiskLevel {
  return typeof value === "string"
    && TASK_CONTROL_RISK_LEVELS.includes(value as TaskControlRiskLevel);
}

export function isTaskControlPhase(value: unknown): value is TaskControlPhase {
  return typeof value === "string"
    && TASK_CONTROL_PHASES.includes(value as TaskControlPhase);
}

export function isTaskControlOutcome(value: unknown): value is TaskControlOutcome {
  return typeof value === "string"
    && TASK_CONTROL_OUTCOMES.includes(value as TaskControlOutcome);
}

export function isTaskControlRecoveryAction(
  value: unknown
): value is TaskControlRecoveryAction {
  return typeof value === "string"
    && TASK_CONTROL_RECOVERY_ACTIONS.includes(value as TaskControlRecoveryAction);
}

export function isTaskControlFailureStage(value: unknown): value is TaskControlFailureStage {
  return typeof value === "string"
    && TASK_CONTROL_FAILURE_STAGES.includes(value as TaskControlFailureStage);
}

export function isTaskControlRecoveryMode(value: unknown): value is TaskControlRecoveryMode {
  return typeof value === "string"
    && TASK_CONTROL_RECOVERY_MODES.includes(value as TaskControlRecoveryMode);
}

export function isTaskControlRecoveryDescriptor(
  value: unknown
): value is TaskControlRecoveryDescriptor {
  const descriptor = readRecord(value);
  if (!descriptor || !hasStrictKeys(
    descriptor,
    RECOVERY_DESCRIPTOR_KEYS,
    RECOVERY_DESCRIPTOR_REQUIRED_KEYS
  )) {
    return false;
  }

  return isBoundedIdentifier(descriptor.recoveryId)
    && isTaskControlRecoveryAction(descriptor.action)
    && isTaskControlRecoveryMode(descriptor.mode)
    && isRecoveryModeForAction(descriptor.mode, descriptor.action)
    && isBoundedIdentifier(descriptor.executionId)
    && isBoundedIdentifier(descriptor.planId)
    && isComputerUsePlanRoute(descriptor.route)
    && isTaskControlOutcome(descriptor.outcome)
    && descriptor.outcome !== "completed"
    && isTaskControlFailureStage(descriptor.failureStage);
}

export function isTaskControlRecoveryRequest(value: unknown): value is TaskControlRecoveryRequest {
  const request = readRecord(value);
  if (!request || !hasStrictKeys(
    request,
    RECOVERY_REQUEST_KEYS,
    RECOVERY_REQUEST_REQUIRED_KEYS
  )) {
    return false;
  }

  return isBoundedIdentifier(request.recoveryId)
    && isTaskControlRecoveryAction(request.action)
    && isBoundedIdentifier(request.executionId)
    && isBoundedIdentifier(request.planId)
    && isComputerUsePlanRoute(request.route)
    && isTaskControlOutcome(request.outcome)
    && request.outcome !== "completed"
    && isTaskControlFailureStage(request.failureStage);
}

export function isTaskControlRecoveryPreparationResult(
  value: unknown
): value is TaskControlRecoveryPreparationResult {
  const result = readRecord(value);
  if (!result || !hasStrictKeys(result, RECOVERY_RESULT_KEYS, ["state", "code", "message"])) {
    return false;
  }
  if (!isBoundedText(result.message, MAX_TEXT_LENGTH)) {
    return false;
  }

  if (result.state === "prepared") {
    if (
      result.code !== "recovery-prepared"
      || !isTaskControlRecoveryDescriptor(result.descriptor)
    ) {
      return false;
    }
    return result.descriptor.mode === "draft_only"
      ? isBoundedText(result.draft, MAX_TEXT_LENGTH)
      : result.draft === undefined;
  }

  return result.state === "rejected"
    && isRejectedTaskControlRecoveryResultCode(result.code)
    && result.descriptor === undefined
    && result.draft === undefined;
}

export function createTaskControlRecoveryRequest(
  descriptor: TaskControlRecoveryDescriptor
): TaskControlRecoveryRequest {
  return {
    recoveryId: descriptor.recoveryId,
    action: descriptor.action,
    executionId: descriptor.executionId,
    planId: descriptor.planId,
    route: descriptor.route,
    outcome: descriptor.outcome,
    failureStage: descriptor.failureStage
  };
}

export function isTaskControlRecoveryDispatchResult(
  value: unknown
): value is TaskControlRecoveryDispatchResult {
  const result = readRecord(value);
  if (!result || !hasStrictKeys(
    result,
    RECOVERY_DISPATCH_RESULT_KEYS,
    ["state", "code", "message"]
  )) {
    return false;
  }
  if (!isBoundedText(result.message, MAX_TEXT_LENGTH)) {
    return false;
  }

  if (result.state === "dispatched") {
    return result.code === "recovery-dispatched"
      && isTaskControlRecoveryDescriptor(result.descriptor)
      && result.descriptor.mode === "prepare_only"
      && isBoundedIdentifier(result.recoveryExecutionId);
  }

  return result.state === "rejected"
    && isRejectedTaskControlRecoveryDispatchResultCode(result.code)
    && result.descriptor === undefined
    && result.recoveryExecutionId === undefined;
}

export function isTaskControlSideEffectState(
  value: unknown
): value is TaskControlSideEffectState {
  return typeof value === "string"
    && TASK_CONTROL_SIDE_EFFECT_STATES.includes(value as TaskControlSideEffectState);
}

export function isTaskControlStatus(value: unknown): value is TaskControlStatus {
  return value === "waiting"
    || value === "approval_required"
    || value === "executing"
    || value === "verifying"
    || isTaskControlOutcome(value);
}

export function readTaskControlStatusForPhase(
  phase: Exclude<TaskControlPhase, "terminal">
): Exclude<TaskControlStatus, TaskControlOutcome> {
  return ACTIVE_STATUS_BY_PHASE[phase];
}

export function cloneComputerUsePlanPreview(
  plan: ComputerUsePlanPreview
): ComputerUsePlanPreview {
  return {
    ...plan,
    risk: { ...plan.risk }
  };
}

export function cloneTaskControlSnapshot(
  snapshot: TaskControlSnapshot
): TaskControlSnapshot {
  return {
    ...snapshot,
    plan: cloneComputerUsePlanPreview(snapshot.plan),
    recoveryActions: [...snapshot.recoveryActions],
    ...(snapshot.recoveryDescriptors ? {
      recoveryDescriptors: snapshot.recoveryDescriptors.map(cloneTaskControlRecoveryDescriptor)
    } : {}),
    ...(snapshot.approval ? { approval: cloneTaskControlApproval(snapshot.approval) } : {})
  };
}

export function cloneTaskControlRecoveryDescriptor(
  descriptor: TaskControlRecoveryDescriptor
): TaskControlRecoveryDescriptor {
  return { ...descriptor };
}

export function cloneTaskControlRecoveryPreparationResult(
  result: TaskControlRecoveryPreparationResult
): TaskControlRecoveryPreparationResult {
  return result.state === "prepared"
    ? {
        ...result,
        descriptor: cloneTaskControlRecoveryDescriptor(result.descriptor)
      }
    : { ...result };
}

export function cloneTaskControlRecoveryDispatchResult(
  result: TaskControlRecoveryDispatchResult
): TaskControlRecoveryDispatchResult {
  return result.state === "dispatched"
    ? {
        ...result,
        descriptor: cloneTaskControlRecoveryDescriptor(result.descriptor)
      }
    : { ...result };
}

export function cloneTaskControlApproval(
  approval: TaskControlApproval
): TaskControlApproval {
  return {
    ...approval,
    ...(approval.finderPlanPreview ? {
      finderPlanPreview: {
        ...approval.finderPlanPreview,
        createFolders: [...approval.finderPlanPreview.createFolders],
        moveFiles: approval.finderPlanPreview.moveFiles.map((move) => ({ ...move })),
        ...(approval.finderPlanPreview.copyFiles ? {
          copyFiles: approval.finderPlanPreview.copyFiles.map((copy) => ({ ...copy }))
        } : {})
      }
    } : {}),
    ...(approval.chromeSubmitBinding ? {
      chromeSubmitBinding: {
        ...approval.chromeSubmitBinding,
        fieldSelectors: [...approval.chromeSubmitBinding.fieldSelectors]
      }
    } : {})
  };
}

function isRecoveryActionList(value: unknown): value is TaskControlRecoveryAction[] {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_ACTIONS) {
    return false;
  }

  const unique = new Set(value);
  return unique.size === value.length && value.every(isTaskControlRecoveryAction);
}

function isRecoveryDescriptorList(value: unknown): value is TaskControlRecoveryDescriptor[] {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_ACTIONS) {
    return false;
  }

  const recoveryIds = new Set<string>();
  const actions = new Set<TaskControlRecoveryAction>();
  for (const descriptor of value) {
    if (
      !isTaskControlRecoveryDescriptor(descriptor)
      || recoveryIds.has(descriptor.recoveryId)
      || actions.has(descriptor.action)
    ) {
      return false;
    }
    recoveryIds.add(descriptor.recoveryId);
    actions.add(descriptor.action);
  }
  return true;
}

function isRecoveryModeForAction(
  mode: TaskControlRecoveryMode,
  action: TaskControlRecoveryAction
): boolean {
  if (action === "open_readiness") return mode === "navigation";
  if (action === "revise_plan") return mode === "draft_only";
  return mode === "prepare_only";
}

function isRejectedTaskControlRecoveryResultCode(
  value: unknown
): value is Exclude<TaskControlRecoveryResultCode, "recovery-prepared"> {
  return typeof value === "string"
    && value !== "recovery-prepared"
    && TASK_CONTROL_RECOVERY_RESULT_CODES.includes(value as TaskControlRecoveryResultCode);
}

function isRejectedTaskControlRecoveryDispatchResultCode(
  value: unknown
): value is Exclude<TaskControlRecoveryDispatchResultCode, "recovery-dispatched"> {
  return typeof value === "string"
    && value !== "recovery-dispatched"
    && TASK_CONTROL_RECOVERY_DISPATCH_RESULT_CODES.includes(
      value as TaskControlRecoveryDispatchResultCode
    );
}

function isExecutionPlanIdForPlan(
  executionPlanId: string,
  plan: ComputerUsePlanPreview
): boolean {
  return executionPlanId === plan.planId
    || (plan.route === "finder" && executionPlanId.startsWith(`${plan.planId}:`));
}

export function isTaskControlRecoveryActionAllowed({
  action,
  failureStage,
  outcome,
  sideEffectState
}: {
  action: TaskControlRecoveryAction;
  failureStage: TaskControlFailureStage;
  outcome: TaskControlOutcome;
  sideEffectState: TaskControlSideEffectState;
}): boolean {
  if (outcome === "completed") return false;
  if (outcome === "user_denied") {
    return failureStage === "approval" && action === "revise_plan";
  }
  if (outcome === "cancelled") {
    return action === "revise_plan";
  }
  if (outcome === "app_policy_denied" || outcome === "blocked") {
    return failureStage === "preflight"
      && (action === "revise_plan" || action === "open_readiness");
  }
  if (outcome === "confirmation_required") {
    return failureStage === "verification"
      && (
        action === "retry_observation"
        || action === "retry_verification"
        || action === "revise_plan"
      );
  }

  switch (failureStage) {
    case "preflight":
      return action === "revise_plan" || action === "open_readiness";
    case "approval":
      return action === "revise_plan";
    case "observation":
      return action === "retry_observation"
        || action === "revise_plan"
        || action === "open_readiness";
    case "execution":
      return action === "revise_plan"
        || (sideEffectState !== "none" && action === "retry_verification");
    case "verification":
      return action === "retry_observation"
        || action === "retry_verification"
        || action === "revise_plan";
  }
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= MAX_FINDER_OPERATIONS;
}

function isBoundedTextList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_FINDER_OPERATIONS
    && value.every((entry) => isBoundedText(entry, MAX_TEXT_LENGTH));
}

function isTaskControlFinderMove(value: unknown): boolean {
  const move = readRecord(value);
  return Boolean(move)
    && hasStrictKeys(move!, FINDER_MOVE_KEYS, FINDER_MOVE_REQUIRED_KEYS)
    && isBoundedText(move!.from, MAX_TEXT_LENGTH)
    && isBoundedText(move!.to, MAX_TEXT_LENGTH);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasStrictKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key))
    && required.every((key) => Object.hasOwn(value, key));
}
