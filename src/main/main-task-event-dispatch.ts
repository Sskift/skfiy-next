import type { AssistantComputerUseToolResult } from "./assistant-computer-use-executor.js";
import { createToolResultFromTaskEvent } from "./main-computer-use-tool-result.js";
import type { ExecutableCommandRoute } from "./task-routing.js";
import type { FinderPlanPreview } from "./orchestrator/finder-task.js";
import {
  createTaskEvent,
  withRouteTaskEventMetadata,
  type ComputerUseTaskEvent,
  type ManualMode,
  type TaskEvent
} from "./task-event-view.js";

export interface ComputerUseTaskEventApprovalRequest {
  command: string;
  planApproved: boolean;
  approvedPlanPreview?: FinderPlanPreview;
  reason: string;
}

export interface ComputerUseTaskEventDispatch {
  approvalRequest?: ComputerUseTaskEventApprovalRequest;
  taskStatus: TaskEvent;
  toolResult?: AssistantComputerUseToolResult;
}

export function createComputerUseTaskEventDispatch({
  approved,
  command,
  event,
  mode,
  planApproved,
  route
}: {
  approved: boolean;
  command: string;
  event: ComputerUseTaskEvent;
  mode: ManualMode;
  planApproved: boolean;
  route: ExecutableCommandRoute;
}): ComputerUseTaskEventDispatch {
  return {
    ...readComputerUseTaskEventApprovalRequest({ approved, command, event, planApproved }),
    taskStatus: withRouteTaskEventMetadata(createTaskEvent(event, mode), route),
    toolResult: createToolResultFromTaskEvent(event)
  };
}

function readComputerUseTaskEventApprovalRequest({
  approved,
  command,
  event,
  planApproved
}: {
  approved: boolean;
  command: string;
  event: ComputerUseTaskEvent;
  planApproved: boolean;
}): Pick<ComputerUseTaskEventDispatch, "approvalRequest"> {
  if (event.type === "approval_required" && !approved) {
    return {
      approvalRequest: {
        command: "command" in event ? event.command : command,
        planApproved: false,
        reason: event.risk.reason
      }
    };
  }

  if (event.type === "plan_confirmation_required" && !planApproved) {
    return {
      approvalRequest: {
        command,
        planApproved: true,
        approvedPlanPreview: event.preview,
        reason: event.reason
      }
    };
  }

  return {};
}
