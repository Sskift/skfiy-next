export const TASK_CONTROL_SCHEMA_VERSION = 1 as const;

export const COMPUTER_USE_PLAN_ROUTES = [
  "ghostty",
  "chrome",
  "finder",
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
export type TaskControlSideEffectState = typeof TASK_CONTROL_SIDE_EFFECT_STATES[number];
export type TaskControlApprovalGate = "action-plan" | "finder-plan";

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
}

export interface TaskControlApproval {
  gate: TaskControlApprovalGate;
  planId: string;
  finderPlanPreview?: TaskControlFinderPlanPreview;
}

export interface TaskControlSnapshot {
  schemaVersion: typeof TASK_CONTROL_SCHEMA_VERSION;
  executionId: string;
  phase: TaskControlPhase;
  status: TaskControlStatus;
  message: string;
  plan: ComputerUsePlanPreview;
  sideEffectState: TaskControlSideEffectState;
  replayAvailable: boolean;
  recoveryActions: TaskControlRecoveryAction[];
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
const APPROVAL_KEYS = new Set(["gate", "planId", "finderPlanPreview"]);
const APPROVAL_REQUIRED_KEYS = ["gate", "planId"];
const FINDER_PREVIEW_KEYS = new Set([
  "rootPath",
  "operationCount",
  "destructiveOperationCount",
  "createFolders",
  "moveFiles"
]);
const FINDER_PREVIEW_REQUIRED_KEYS = [...FINDER_PREVIEW_KEYS];
const FINDER_MOVE_KEYS = new Set(["from", "to"]);
const FINDER_MOVE_REQUIRED_KEYS = [...FINDER_MOVE_KEYS];

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

  if (snapshot.phase === "terminal") {
    return isTaskControlOutcome(snapshot.outcome)
      && snapshot.status === snapshot.outcome
      && snapshot.approval === undefined;
  }

  const approvalIsValid = snapshot.phase === "approval"
    ? isTaskControlApproval(snapshot.approval, snapshot.plan)
    : snapshot.approval === undefined;

  return approvalIsValid
    && snapshot.outcome === undefined
    && snapshot.status === ACTIVE_STATUS_BY_PHASE[snapshot.phase]
    && snapshot.recoveryActions.length === 0;
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
    (approval.gate !== "action-plan" && approval.gate !== "finder-plan")
    || !isBoundedIdentifier(approval.planId)
  ) {
    return false;
  }

  if (approval.gate === "action-plan") {
    return approval.finderPlanPreview === undefined
      && (!plan || approval.planId === plan.planId);
  }

  return isTaskControlFinderPlanPreview(approval.finderPlanPreview)
    && (!plan || approval.planId.startsWith(`${plan.planId}:`));
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
    && preview.moveFiles.every(isTaskControlFinderMove);
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
    ...(snapshot.approval ? { approval: cloneTaskControlApproval(snapshot.approval) } : {})
  };
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
        moveFiles: approval.finderPlanPreview.moveFiles.map((move) => ({ ...move }))
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
