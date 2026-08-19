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
  approvedChromeSubmitBinding?: import("./orchestrator/chrome-task.js").ChromeSubmitConfirmationBinding;
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
  route,
  chromeSubmitApproved,
  approvedChromeSubmitBinding
}: {
  approved: boolean;
  command: string;
  event: ComputerUseTaskEvent;
  mode: ManualMode;
  planApproved: boolean;
  route: ExecutableCommandRoute;
  chromeSubmitApproved?: boolean;
  approvedChromeSubmitBinding?: import("./orchestrator/chrome-task.js").ChromeSubmitConfirmationBinding;
}): ComputerUseTaskEventDispatch {
  return {
    ...readComputerUseTaskEventApprovalRequest({ approved, command, event, planApproved, chromeSubmitApproved, approvedChromeSubmitBinding }),
    taskStatus: withRouteTaskEventMetadata(createTaskEvent(event, mode), route),
    toolResult: createToolResultFromTaskEvent(event)
  };
}

function readComputerUseTaskEventApprovalRequest({
  approved,
  command,
  event,
  planApproved,
  chromeSubmitApproved,
  approvedChromeSubmitBinding
}: {
  approved: boolean;
  command: string;
  event: ComputerUseTaskEvent;
  planApproved: boolean;
  chromeSubmitApproved?: boolean;
  approvedChromeSubmitBinding?: import("./orchestrator/chrome-task.js").ChromeSubmitConfirmationBinding;
}): Pick<ComputerUseTaskEventDispatch, "approvalRequest"> {
  if (event.type === "approval_required" && !approved) {
    return {
      approvalRequest: {
        command: "command" in event ? event.command : command,
        planApproved: false,
        approvedChromeSubmitBinding,
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

  if (event.type === "submit_confirmation_required" && !chromeSubmitApproved) {
    return {
      approvalRequest: {
        command: "command" in event ? event.command : command,
        planApproved: true,
        approvedChromeSubmitBinding,
        reason: "reason" in event ? event.reason : "Chrome submit confirmation required."
      }
    };
  }

  return {};
}
