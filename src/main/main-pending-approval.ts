import type { AssistantComputerUseToolIdentity } from "./assistant-computer-use-executor.js";
import { isSameComputerUseToolIdentity } from "./main-computer-use-tool-result.js";
import type { ExecutableCommandRoute } from "./task-routing.js";
import type { FinderPlanPreview } from "./orchestrator/finder-task.js";
import {
  withRouteTaskEventMetadata,
  type ManualMode,
  type TaskEvent
} from "./task-event-view.js";

export type ComputerUseCommandRoute = ExecutableCommandRoute;
export type ComputerUseApprovalGate = "action-plan" | "finder-plan";

export interface PendingApproval extends AssistantComputerUseToolIdentity {
  command: string;
  mode: ManualMode;
  route: ComputerUseCommandRoute;
  gate: ComputerUseApprovalGate;
  planId: string;
  actionApproved: boolean;
  finderPlanApproved: boolean;
  approvedPlanPreview?: FinderPlanPreview;
}

export interface CreatePendingApprovalInput {
  command: string;
  mode: ManualMode;
  identity: AssistantComputerUseToolIdentity;
  route: ComputerUseCommandRoute;
  gate: ComputerUseApprovalGate;
  planId: string;
  actionApproved: boolean;
  finderPlanApproved: boolean;
  approvedPlanPreview?: FinderPlanPreview;
}

export interface ApprovedPendingApprovalContinuation {
  actionApproved: boolean;
  finderPlanApproved: boolean;
}

export interface ComputerUseToolCallState {
  pendingApproval: PendingApproval | null;
  activeToolIdentity: AssistantComputerUseToolIdentity | null;
}

export interface ComputerUseToolCallRouteState extends ComputerUseToolCallState {
  activeRoute: ComputerUseCommandRoute | null;
}

export interface ComputerUseTaskEpochState {
  currentTaskId: number;
  pendingApproval: PendingApproval | null;
}

export interface ActiveComputerUseTaskState extends ComputerUseTaskEpochState {
  activeToolIdentity: AssistantComputerUseToolIdentity | null;
  activeRoute: ComputerUseCommandRoute | null;
}

export interface StartedComputerUseTaskState extends ActiveComputerUseTaskState {
  taskId: number;
}

export const USER_DENIED_COMPUTER_USE_REASON = "User denied this Computer Use turn.";

export function createPendingApproval(
  input: CreatePendingApprovalInput
): PendingApproval {
  const planId = input.planId.trim();
  if (!planId) {
    throw new Error("Pending Computer Use approval requires a plan id.");
  }

  return {
    ...input.identity,
    command: input.command,
    mode: input.mode,
    route: input.route,
    gate: input.gate,
    planId,
    actionApproved: input.actionApproved,
    finderPlanApproved: input.finderPlanApproved,
    ...(input.approvedPlanPreview ? { approvedPlanPreview: cloneFinderPlanPreview(input.approvedPlanPreview) } : {})
  };
}

export function readApprovedPendingApprovalContinuation(
  approval: PendingApproval
): ApprovedPendingApprovalContinuation {
  return {
    actionApproved: approval.actionApproved === true || approval.gate === "action-plan",
    finderPlanApproved: approval.finderPlanApproved === true || approval.gate === "finder-plan"
  };
}

function cloneFinderPlanPreview(preview: FinderPlanPreview): FinderPlanPreview {
  return {
    ...preview,
    createFolders: [...preview.createFolders],
    moveFiles: preview.moveFiles.map((move) => ({ ...move })),
    ...(preview.copyFiles ? {
      copyFiles: preview.copyFiles.map((copy) => ({ ...copy }))
    } : {})
  };
}

export function createPendingApprovalDeniedTaskEvent(
  approval: PendingApproval | null
): TaskEvent {
  const taskEvent: TaskEvent = {
    status: approval ? "denied" : "idle",
    message: approval ? "Task denied." : "No task is waiting for approval.",
    ...(approval ? { command: approval.command } : {})
  };

  return approval
    ? withRouteTaskEventMetadata(taskEvent, approval.route, {
      routeReason: USER_DENIED_COMPUTER_USE_REASON,
      denialKind: "user"
    })
    : taskEvent;
}

export function completeComputerUseToolCallState(
  state: ComputerUseToolCallState,
  identity: AssistantComputerUseToolIdentity
): ComputerUseToolCallState {
  return {
    pendingApproval: isSameComputerUseToolIdentity(state.pendingApproval, identity) ? null : state.pendingApproval,
    activeToolIdentity: isSameComputerUseToolIdentity(state.activeToolIdentity, identity)
      ? null
      : state.activeToolIdentity
  };
}

export function readComputerUseToolCallIdentityToCancel(
  state: ComputerUseToolCallState
): AssistantComputerUseToolIdentity | null {
  return state.pendingApproval ?? state.activeToolIdentity;
}

export function cancelComputerUseToolCallState(
  state: ComputerUseToolCallState,
  identity: AssistantComputerUseToolIdentity
): ComputerUseToolCallState {
  return {
    pendingApproval: null,
    activeToolIdentity: isSameComputerUseToolIdentity(state.activeToolIdentity, identity)
      ? null
      : state.activeToolIdentity
  };
}

export function readComputerUseRouteForToolCallState(
  state: ComputerUseToolCallRouteState
): ComputerUseCommandRoute | null {
  if (state.pendingApproval) {
    return state.pendingApproval.route;
  }

  return state.activeToolIdentity ? state.activeRoute : null;
}

export function createClearedPendingComputerUseTaskState(
  state: ComputerUseTaskEpochState
): ComputerUseTaskEpochState {
  return {
    currentTaskId: state.currentTaskId + 1,
    pendingApproval: null
  };
}

export function createClearedActiveComputerUseTaskState(
  state: ActiveComputerUseTaskState
): ActiveComputerUseTaskState {
  return {
    currentTaskId: state.currentTaskId + 1,
    pendingApproval: null,
    activeToolIdentity: null,
    activeRoute: null
  };
}

export function createStartedComputerUseTaskState(
  state: ActiveComputerUseTaskState
): StartedComputerUseTaskState {
  const taskId = state.currentTaskId + 1;

  return {
    taskId,
    currentTaskId: taskId,
    pendingApproval: null,
    activeToolIdentity: state.activeToolIdentity,
    activeRoute: state.activeRoute
  };
}
