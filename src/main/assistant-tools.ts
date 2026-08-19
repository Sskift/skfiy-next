import type { AssistantAgentTurnResult } from "./assistant-agent.js";
import type {
  AssistantComputerUseTerminalStatus,
  AssistantComputerUseToolCall
} from "./assistant-computer-use-executor.js";
import type { CommandRoute } from "./task-routing.js";

export interface AssistantToolPlanSummary {
  providerLabel: AssistantAgentTurnResult["providerLabel"];
  turnId: string;
  route: CommandRoute;
  plannedToolCount: number;
  message: string;
}

export interface AssistantComputerUseToolCallSummary {
  turnId: string;
  toolCallId: string;
  route: CommandRoute;
  status: AssistantComputerUseToolCall["status"];
  approvalState: AssistantComputerUseToolCall["approval"]["state"];
  resultStatus?: AssistantComputerUseTerminalStatus;
  evidenceSummary?: string;
  artifactCount: number;
  message: string;
}

export function summarizeAssistantToolPlan(
  turn: AssistantAgentTurnResult
): AssistantToolPlanSummary | undefined {
  const plannedToolCount = turn.toolCalls.filter((toolCall) => toolCall.status === "planned").length;
  if (plannedToolCount === 0) {
    return undefined;
  }

  return {
    providerLabel: turn.providerLabel,
    turnId: turn.id,
    route: turn.route,
    plannedToolCount,
    message: `${turn.providerLabel} planned ${formatToolCount(plannedToolCount)} for ${formatCommandRoute(turn.route)}.`
  };
}

export function summarizeAssistantComputerUseToolCall(
  toolCall: AssistantComputerUseToolCall
): AssistantComputerUseToolCallSummary {
  const routeLabel = formatCommandRoute(toolCall.route);
  const resultText = toolCall.result?.summary ? `: ${toolCall.result.summary}` : ".";

  return {
    turnId: toolCall.turnId,
    toolCallId: toolCall.toolCallId,
    route: toolCall.route,
    status: toolCall.status,
    approvalState: toolCall.approval.state,
    ...(toolCall.result ? { resultStatus: toolCall.result.status } : {}),
    ...(toolCall.result?.evidence?.summary
      ? { evidenceSummary: toolCall.result.evidence.summary }
      : {}),
    artifactCount: toolCall.result?.evidence?.artifacts?.length ?? 0,
    message: `Computer Use tool ${toolCall.toolCallId} ${toolCall.status} for ${routeLabel}${resultText}`
  };
}

function formatToolCount(count: number): string {
  return count === 1 ? "1 Computer Use tool call" : `${count} Computer Use tool calls`;
}

function formatCommandRoute(route: CommandRoute): string {
  switch (route.kind) {
    case "chrome":
      return "Chrome";
    case "finder":
      return "Finder";
    case "ghostty":
      return "Ghostty";
    case "tmux_supervision":
      return "money-run supervision";
    case "chat":
      return "chat";
    case "needs_clarification":
      return "clarification";
    case "needs_confirmation":
      return "confirmation";
    case "denied":
      return "denied";
    case "blocked":
      return "blocked";
  }
}
