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

export interface PendingApproval extends AssistantComputerUseToolIdentity {
  command: string;
  mode: ManualMode;
  route: ComputerUseCommandRoute;
  planApproved?: boolean;
  approvedPlanPreview?: FinderPlanPreview;
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
  command: string,
  mode: ManualMode,
  identity: AssistantComputerUseToolIdentity,
  route: ComputerUseCommandRoute,
  planApproved = false,
  approvedPlanPreview?: FinderPlanPreview
): PendingApproval {
  return {
    ...identity,
    command,
    mode,
    route,
    ...(planApproved ? { planApproved } : {}),
    ...(approvedPlanPreview ? { approvedPlanPreview } : {})
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
