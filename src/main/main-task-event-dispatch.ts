import type { AssistantComputerUseToolResult } from "./assistant-computer-use-executor.js";
import { createToolResultFromTaskEvent } from "./main-computer-use-tool-result.js";
import type { ExecutableCommandRoute } from "./task-routing.js";
import type { FinderPlanPreview } from "./orchestrator/finder-task.js";
import type {
  ChromeSubmitConfirmationBinding,
  ChromeWorkflowPlanPreview
} from "./orchestrator/chrome-task.js";
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
  approvedChromeSubmitBinding?: ChromeSubmitConfirmationBinding;
  approvedChromeWorkflowPreview?: ChromeWorkflowPlanPreview;
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
  chromeWorkflowApproved,
  approvedChromeSubmitBinding
}: {
  approved: boolean;
  command: string;
  event: ComputerUseTaskEvent;
  mode: ManualMode;
  planApproved: boolean;
  route: ExecutableCommandRoute;
  chromeSubmitApproved?: boolean;
  chromeWorkflowApproved?: boolean;
  approvedChromeSubmitBinding?: ChromeSubmitConfirmationBinding;
}): ComputerUseTaskEventDispatch {
  return {
    ...readComputerUseTaskEventApprovalRequest({
      approved,
      command,
      event,
      planApproved,
      chromeSubmitApproved,
      chromeWorkflowApproved,
      approvedChromeSubmitBinding
    }),
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
  chromeWorkflowApproved,
  approvedChromeSubmitBinding
}: {
  approved: boolean;
  command: string;
  event: ComputerUseTaskEvent;
  planApproved: boolean;
  chromeSubmitApproved?: boolean;
  chromeWorkflowApproved?: boolean;
  approvedChromeSubmitBinding?: ChromeSubmitConfirmationBinding;
}): Pick<ComputerUseTaskEventDispatch, "approvalRequest"> {
  if (event.type === "approval_required" && !approved) {
    return {
      approvalRequest: {
        // Use the full input command, not event.command — Chrome events
        // carry the parsed URL for display, but the resume flow needs the
        // original command to re-parse the intent.
        command,
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
        command,
        planApproved: true,
        approvedChromeSubmitBinding: approvedChromeSubmitBinding ?? event.binding,
        reason: "reason" in event ? event.reason : "Chrome submit confirmation required."
      }
    };
  }

  if (event.type === "workflow_confirmation_required" && !chromeWorkflowApproved) {
    return {
      approvalRequest: {
        command,
        planApproved: true,
        approvedChromeWorkflowPreview: event.preview,
        reason: event.reason
      }
    };
  }

  return {};
}
