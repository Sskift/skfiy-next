import type {
  AssistantComputerUseTerminalStatus,
  AssistantComputerUseToolIdentity,
  AssistantComputerUseToolResult
} from "./assistant-computer-use-executor.js";
import type { ComputerUseTaskEvent } from "./task-event-view.js";

export function isSameComputerUseToolIdentity(
  left: AssistantComputerUseToolIdentity | null,
  right: AssistantComputerUseToolIdentity
): boolean {
  return Boolean(left && left.turnId === right.turnId && left.toolCallId === right.toolCallId);
}

export function createToolResultFromTaskEvent(event: ComputerUseTaskEvent): AssistantComputerUseToolResult | undefined {
  if (event.type === "completed") {
    return {
      status: "completed",
      summary: event.summary,
      evidence: {
        summary: "Computer Use route completed with replayed orchestration events."
      }
    };
  }

  if (event.type === "verification_failed") {
    return {
      status: "failed",
      summary: event.reason,
      evidence: {
        summary: `Computer Use route stopped during ${event.stage} verification.`
      }
    };
  }

  return undefined;
}

export function createToolResult(
  status: AssistantComputerUseTerminalStatus,
  summary: string
): AssistantComputerUseToolResult {
  return {
    status,
    summary,
    evidence: {
      summary
    }
  };
}
