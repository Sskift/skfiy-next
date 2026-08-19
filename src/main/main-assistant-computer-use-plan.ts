import type {
  AssistantAgentPlannedToolCall,
  AssistantAgentTurnResult
} from "./assistant-agent.js";
import type {
  AssistantComputerUsePlanInput,
  AssistantComputerUseToolIdentity
} from "./assistant-computer-use-executor.js";

export interface AssistantComputerUseToolPlan {
  identity: AssistantComputerUseToolIdentity;
  planInput: AssistantComputerUsePlanInput;
  toolCall: AssistantAgentPlannedToolCall;
}

export function readAssistantComputerUseToolCall(
  turn: AssistantAgentTurnResult
): AssistantAgentPlannedToolCall {
  const toolCall = turn.toolCalls.find((candidate) =>
    candidate.type === "computer-use" && candidate.name === "desktop-control"
  );
  if (!toolCall) {
    throw new Error(`Assistant turn ${turn.id} did not plan a Computer Use tool call.`);
  }

  return toolCall;
}

export function createAssistantComputerUseToolPlan(
  turn: AssistantAgentTurnResult
): AssistantComputerUseToolPlan {
  const toolCall = readAssistantComputerUseToolCall(turn);
  const identity = {
    turnId: turn.id,
    toolCallId: toolCall.id
  };

  return {
    identity,
    planInput: {
      ...identity,
      command: toolCall.input.command,
      route: toolCall.input.route,
      createdAt: toolCall.createdAt
    },
    toolCall
  };
}
