import type { AppPolicyDecision } from "./app-policy-settings.js";
import type { AssistantComputerUseToolResult } from "./assistant-computer-use-executor.js";
import type { ApprovedChromeHostPolicyResult } from "./chrome-approval-policy.js";
import { createToolResult } from "./main-computer-use-tool-result.js";
import {
  createAppPolicyApprovalRequiredTaskEvent,
  createAppPolicyBlockedTaskEvent,
  createChromeHostPolicyAllowedTaskEvent,
  createChromeHostPolicyApprovalFailedTaskEvent,
  createChromeHostPolicyBlockedTaskEvent
} from "./main-route-task-events.js";
import type { ExecutableCommandRoute } from "./task-routing.js";
import type { ManualMode, TaskEvent } from "./task-event-view.js";

export type AppPolicyCommandRoute = Exclude<ExecutableCommandRoute, { kind: "tmux_supervision" }>;

export type AppPolicyPreflightDecision =
  | { kind: "continue" }
  | {
      kind: "blocked";
      taskEvent: TaskEvent;
      toolResult: AssistantComputerUseToolResult;
    }
  | {
      kind: "approval_required";
      approvalRequest: {
        command: string;
        mode: ManualMode;
        route: AppPolicyCommandRoute;
        reason: string;
      };
      taskEvent: TaskEvent;
    };

export function createAppPolicyPreflightDecision({
  appPolicy,
  approved,
  command,
  mode,
  route
}: {
  appPolicy: AppPolicyDecision;
  approved: boolean;
  command: string;
  mode: ManualMode;
  route: AppPolicyCommandRoute;
}): AppPolicyPreflightDecision {
  if (appPolicy.decision === "deny") {
    return {
      kind: "blocked",
      taskEvent: createAppPolicyBlockedTaskEvent({
        command,
        reason: appPolicy.reason,
        route
      }),
      toolResult: createToolResult("blocked", appPolicy.reason)
    };
  }

  if (appPolicy.decision === "ask" && !approved) {
    return {
      kind: "approval_required",
      approvalRequest: {
        command,
        mode,
        route,
        reason: appPolicy.reason
      },
      taskEvent: createAppPolicyApprovalRequiredTaskEvent({
        command,
        reason: appPolicy.reason,
        route
      })
    };
  }

  return { kind: "continue" };
}

export type ChromeHostPolicyPreflightDecision =
  | { kind: "continue" }
  | {
      kind: "allowed_current_turn";
      taskEvent: TaskEvent;
    }
  | {
      kind: "blocked";
      taskEvent: TaskEvent;
      toolResult: AssistantComputerUseToolResult;
    }
  | {
      kind: "failed";
      taskEvent: TaskEvent;
      toolResult: AssistantComputerUseToolResult;
    };

export function createChromeHostPolicyPreflightDecision({
  command,
  result,
  route
}: {
  command: string;
  result: ApprovedChromeHostPolicyResult;
  route: Extract<ExecutableCommandRoute, { kind: "chrome" }>;
}): ChromeHostPolicyPreflightDecision {
  if (result.status === "blocked") {
    const taskEvent = createChromeHostPolicyBlockedTaskEvent({
      command,
      host: result.host,
      route
    });

    return {
      kind: "blocked",
      taskEvent,
      toolResult: createToolResult(
        "blocked",
        taskEvent.message ?? `Chrome host policy blocked this approved task: ${result.host}`
      )
    };
  }

  if (result.status === "failed") {
    const taskEvent = createChromeHostPolicyApprovalFailedTaskEvent({
      command,
      message: result.message,
      route
    });

    return {
      kind: "failed",
      taskEvent,
      toolResult: createToolResult(
        "failed",
        taskEvent.message ?? `Chrome host policy approval failed: ${result.message}`
      )
    };
  }

  if (result.status === "updated") {
    return {
      kind: "allowed_current_turn",
      taskEvent: createChromeHostPolicyAllowedTaskEvent({
        command,
        host: result.host,
        route
      })
    };
  }

  return { kind: "continue" };
}
