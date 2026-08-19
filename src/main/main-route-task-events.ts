import type { AssistantAgentTurnResult } from "./assistant-agent.js";
import { summarizeAssistantToolPlan } from "./assistant-tools.js";
import type { ResolvedPlannerCommand } from "./planner-command.js";
import type { CommandRoute, ExecutableCommandRoute } from "./task-routing.js";
import {
  withRouteTaskEventMetadata,
  type TaskEvent,
  type TaskStatus
} from "./task-event-view.js";

export function createAssistantChatRouteTaskEvent({
  status,
  message
}: {
  status: AssistantAgentTurnResult["status"];
  message: string;
}): TaskEvent {
  return {
    status: status === "completed" ? "completed" : "failed",
    message
  };
}

export function createAssistantTurnFailedRouteTaskEvent({
  command,
  message,
  route
}: {
  command: string;
  message: string;
  route: CommandRoute;
}): TaskEvent {
  return withRouteTaskEventMetadata({
    status: "failed",
    message,
    command
  }, route, {
    routeReason: message
  });
}

export function createAssistantToolPlanRouteTaskEvent({
  command,
  route,
  turn
}: {
  command: string;
  route: CommandRoute;
  turn: AssistantAgentTurnResult;
}): TaskEvent | undefined {
  const summary = summarizeAssistantToolPlan(turn);
  if (!summary) {
    return undefined;
  }

  return withRouteTaskEventMetadata({
    status: "observing",
    message: summary.message,
    command
  }, route);
}

export function createNeedsClarificationRouteTaskEvent(
  route: Extract<CommandRoute, { kind: "needs_clarification" }>
): TaskEvent {
  return withRouteTaskEventMetadata({
    status: "needs_clarification",
    message: `${route.reason} 请明确目标应用和动作。`
  }, route);
}

export function createTerminalRouteTaskEvent({
  command,
  route
}: {
  command: string;
  route: Extract<CommandRoute, { kind: "denied" | "blocked" }>;
}): TaskEvent {
  return withRouteTaskEventMetadata({
    status: route.kind,
    message: route.reason,
    command
  }, route);
}

export function createNeedsConfirmationRouteTaskEvent({
  command,
  route
}: {
  command: string;
  route: Extract<CommandRoute, { kind: "needs_confirmation" }>;
}): TaskEvent {
  return withRouteTaskEventMetadata({
    status: "needs_confirmation",
    message: route.reason,
    command
  }, route);
}

export function createAppPolicyBlockedTaskEvent({
  command,
  reason,
  route
}: {
  command: string;
  reason: string;
  route: ExecutableCommandRoute;
}): TaskEvent {
  return withRouteTaskEventMetadata({
    status: "blocked",
    message: reason,
    command
  }, route, {
    routeReason: reason,
    denialKind: "app_policy",
    policyKind: "app-policy"
  });
}

export function createAppPolicyApprovalRequiredTaskEvent({
  command,
  reason,
  route
}: {
  command: string;
  reason: string;
  route: ExecutableCommandRoute;
}): TaskEvent {
  return withRouteTaskEventMetadata({
    status: "approval_required",
    message: `Approval required (app policy): ${reason}`,
    command
  }, route, {
    routeReason: reason,
    policyKind: "app-policy"
  });
}

export function createChromeHostPolicyBlockedTaskEvent({
  command,
  host,
  route
}: {
  command: string;
  host: string;
  route: Extract<ExecutableCommandRoute, { kind: "chrome" }>;
}): TaskEvent {
  const message = `Chrome host policy blocked this approved task: ${host}`;
  return withRouteTaskEventMetadata({
    status: "blocked",
    message,
    command
  }, route, {
    routeReason: message,
    policyKind: "chrome-host-policy"
  });
}

export function createChromeHostPolicyApprovalFailedTaskEvent({
  command,
  message,
  route
}: {
  command: string;
  message: string;
  route: Extract<ExecutableCommandRoute, { kind: "chrome" }>;
}): TaskEvent {
  const failureMessage = `Chrome host policy approval failed: ${message}`;
  return withRouteTaskEventMetadata({
    status: "failed",
    message: failureMessage,
    command
  }, route, {
    routeReason: failureMessage,
    policyKind: "chrome-host-policy"
  });
}

export function createChromeHostPolicyAllowedTaskEvent({
  command,
  host,
  route
}: {
  command: string;
  host: string;
  route: Extract<ExecutableCommandRoute, { kind: "chrome" }>;
}): TaskEvent {
  const message = `Chrome host policy allowed for current turn: ${host}`;
  return withRouteTaskEventMetadata({
    status: "executing",
    message,
    command
  }, route, {
    routeReason: message,
    policyKind: "chrome-host-policy"
  });
}

export function createPlannerUnavailableTaskEvent({
  command,
  message,
  route,
  status
}: {
  command: string;
  message: string;
  route: ExecutableCommandRoute;
  status: TaskStatus;
}): TaskEvent {
  return withRouteTaskEventMetadata({
    status,
    message,
    command
  }, route, {
    routeReason: message
  });
}

export function createPlannerResolvedTaskEvent({
  command,
  plannedCommand,
  providerLabel,
  route
}: {
  command: string;
  plannedCommand: ResolvedPlannerCommand;
  providerLabel: string;
  route: ExecutableCommandRoute;
}): TaskEvent {
  const message = plannedCommand.rationale
    ? `${providerLabel} planned: ${plannedCommand.command} (${plannedCommand.rationale})`
    : `${providerLabel} planned: ${plannedCommand.command}`;

  return withRouteTaskEventMetadata({
    status: "executing",
    message,
    command
  }, route);
}

export function createComputerUseFailureTaskEvent({
  command,
  message,
  route
}: {
  command: string;
  message: string;
  route: ExecutableCommandRoute;
}): TaskEvent {
  return withRouteTaskEventMetadata({
    status: "failed",
    message,
    command
  }, route, {
    routeReason: message
  });
}

export function createStopTurnTaskEvent(
  route?: ExecutableCommandRoute | null,
  message = "Task stopped."
): TaskEvent {
  const event: TaskEvent = {
    status: "cancelled",
    message,
    stopTurnBehavior: {
      afterStatus: "cancelled",
      afterMessage: message
    }
  };

  return route
    ? withRouteTaskEventMetadata(event, route, { routeReason: message })
    : event;
}
