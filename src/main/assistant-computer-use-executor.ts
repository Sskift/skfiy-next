import type { CommandRoute } from "./task-routing.js";
import type { TurnReplayTaskStatus } from "./computer-use/turn-replay-store.js";
import type { createTurnReplayStore } from "./computer-use/turn-replay-store.js";

export type AssistantComputerUseToolStatus =
  | "planned"
  | "approval_required"
  | "running"
  | "completed"
  | "denied"
  | "blocked"
  | "failed"
  | "cancelled";

export type AssistantComputerUseTerminalStatus = Exclude<
  AssistantComputerUseToolStatus,
  "planned" | "approval_required" | "running"
>;

export type AssistantComputerUseApprovalState =
  | "not-required"
  | "required"
  | "approved"
  | "denied"
  | "bypassed";

export interface AssistantComputerUseEvidenceSummary {
  summary: string;
  artifacts?: string[];
}

export interface AssistantComputerUseToolResult {
  status: AssistantComputerUseTerminalStatus;
  summary: string;
  evidence?: AssistantComputerUseEvidenceSummary;
}

export interface AssistantComputerUseApproval {
  state: AssistantComputerUseApprovalState;
  reason?: string;
}

export interface AssistantComputerUseToolCall {
  turnId: string;
  toolCallId: string;
  command: string;
  route: CommandRoute;
  status: AssistantComputerUseToolStatus;
  createdAt: string;
  updatedAt: string;
  approval: AssistantComputerUseApproval;
  result?: AssistantComputerUseToolResult;
}

export interface AssistantComputerUseToolIdentity {
  turnId: string;
  toolCallId: string;
}

export interface AssistantComputerUsePlanInput extends AssistantComputerUseToolIdentity {
  command: string;
  route: CommandRoute;
  createdAt?: string;
}

export interface AssistantComputerUseApprovalInput extends AssistantComputerUseToolIdentity {
  reason: string;
}

export type AssistantComputerUseApprovalResumeInput =
  | (AssistantComputerUseToolIdentity & {
    decision: "approved";
    reason?: string;
    result?: AssistantComputerUseToolResult;
  })
  | (AssistantComputerUseToolIdentity & {
    decision: "denied";
    reason: string;
  });

export interface AssistantComputerUseCancelInput extends AssistantComputerUseToolIdentity {
  reason: string;
}

export interface AssistantComputerUseCompletionInput extends AssistantComputerUseToolIdentity {
  result: AssistantComputerUseToolResult;
}

export type AssistantComputerUseReplayStore = Pick<
  ReturnType<typeof createTurnReplayStore>,
  "startTurn" | "recordComputerUseEvent" | "recordTaskEvent"
>;

export interface AssistantComputerUseExecutorOptions {
  replayStore?: AssistantComputerUseReplayStore;
  now?: () => Date;
}

export function createAssistantComputerUseExecutor({
  replayStore,
  now = () => new Date()
}: AssistantComputerUseExecutorOptions = {}) {
  const toolCalls = new Map<string, AssistantComputerUseToolCall>();
  const pendingApprovals = new Map<string, AssistantComputerUseToolCall>();

  const readTimestamp = () => now().toISOString();

  const save = (toolCall: AssistantComputerUseToolCall): AssistantComputerUseToolCall => {
    const next = cloneToolCall(toolCall);
    toolCalls.set(createToolKey(next), next);
    return cloneToolCall(next);
  };

  const readExisting = (identity: AssistantComputerUseToolIdentity): AssistantComputerUseToolCall => {
    const toolCall = toolCalls.get(createToolKey(identity));
    if (!toolCall) {
      throw new Error(`Unknown Computer Use tool continuation: ${identity.turnId}/${identity.toolCallId}`);
    }

    return toolCall;
  };

  return {
    planToolCall(input: AssistantComputerUsePlanInput): AssistantComputerUseToolCall {
      const createdAt = input.createdAt ?? readTimestamp();
      const toolCall: AssistantComputerUseToolCall = {
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        command: input.command,
        route: input.route,
        status: "planned",
        createdAt,
        updatedAt: createdAt,
        approval: { state: "not-required" }
      };

      replayStore?.startTurn();
      recordToolLifecycle(replayStore, toolCall);
      return save(toolCall);
    },

    requireApproval(input: AssistantComputerUseApprovalInput): AssistantComputerUseToolCall {
      const previous = readExisting(input);
      const next = save({
        ...previous,
        status: "approval_required",
        updatedAt: readTimestamp(),
        approval: {
          state: "required",
          reason: input.reason
        }
      });

      pendingApprovals.set(createToolKey(next), cloneToolCall(next));
      recordToolLifecycle(replayStore, next);
      return next;
    },

    resumeApproval(input: AssistantComputerUseApprovalResumeInput): AssistantComputerUseToolCall {
      const previous = readExisting(input);
      if (!pendingApprovals.has(createToolKey(input))) {
        throw new Error(`Computer Use tool is not waiting for approval: ${input.turnId}/${input.toolCallId}`);
      }
      pendingApprovals.delete(createToolKey(input));

      if (input.decision === "denied") {
        const summary = input.reason;
        const next = save({
          ...previous,
          status: "denied",
          updatedAt: readTimestamp(),
          approval: {
            state: "denied",
            reason: input.reason
          },
          result: {
            status: "denied",
            summary
          }
        });
        recordApprovalDecision(replayStore, next, "denied", input.reason);
        recordToolResult(replayStore, next);
        return next;
      }

      const approved = save({
        ...previous,
        status: "running",
        updatedAt: readTimestamp(),
        approval: {
          state: "approved",
          reason: input.reason
        }
      });
      recordApprovalDecision(replayStore, approved, "approved", input.reason);
      recordToolLifecycle(replayStore, approved);

      if (!input.result) {
        return approved;
      }

      const completed = save({
        ...approved,
        status: input.result.status,
        updatedAt: readTimestamp(),
        result: input.result
      });
      recordToolResult(replayStore, completed);
      return completed;
    },

    bypassApproval(input: AssistantComputerUseApprovalInput): AssistantComputerUseToolCall {
      const previous = readExisting(input);
      pendingApprovals.delete(createToolKey(input));
      const next = save({
        ...previous,
        status: "running",
        updatedAt: readTimestamp(),
        approval: {
          state: "bypassed",
          reason: input.reason
        }
      });

      recordApprovalDecision(replayStore, next, "bypassed", input.reason);
      recordToolLifecycle(replayStore, next);
      return next;
    },

    completeToolCall(input: AssistantComputerUseCompletionInput): AssistantComputerUseToolCall {
      const previous = readExisting(input);
      pendingApprovals.delete(createToolKey(input));
      const next = save({
        ...previous,
        status: input.result.status,
        updatedAt: readTimestamp(),
        result: input.result
      });

      recordToolResult(replayStore, next);
      return next;
    },

    cancelToolCall(input: AssistantComputerUseCancelInput): AssistantComputerUseToolCall {
      const previous = readExisting(input);
      pendingApprovals.delete(createToolKey(input));
      const next = save({
        ...previous,
        status: "cancelled",
        updatedAt: readTimestamp(),
        result: {
          status: "cancelled",
          summary: input.reason
        }
      });

      recordToolResult(replayStore, next);
      return next;
    },

    getToolCall(identity: AssistantComputerUseToolIdentity): AssistantComputerUseToolCall | undefined {
      const toolCall = toolCalls.get(createToolKey(identity));
      return toolCall ? cloneToolCall(toolCall) : undefined;
    },

    getPendingApproval(identity: AssistantComputerUseToolIdentity): AssistantComputerUseToolCall | undefined {
      const toolCall = pendingApprovals.get(createToolKey(identity));
      return toolCall ? cloneToolCall(toolCall) : undefined;
    }
  };
}

function recordToolLifecycle(
  replayStore: AssistantComputerUseReplayStore | undefined,
  toolCall: AssistantComputerUseToolCall
): void {
  replayStore?.recordComputerUseEvent({
    type: "tool_call",
    turnId: toolCall.turnId,
    toolCallId: toolCall.toolCallId,
    command: toolCall.command,
    route: toolCall.route.kind,
    status: toolCall.status
  });
  replayStore?.recordTaskEvent(createTaskEvent(toolCall, toolCall.status));
}

function recordApprovalDecision(
  replayStore: AssistantComputerUseReplayStore | undefined,
  toolCall: AssistantComputerUseToolCall,
  decision: "approved" | "denied" | "bypassed",
  reason?: string
): void {
  replayStore?.recordComputerUseEvent({
    type: "approval_decision",
    turnId: toolCall.turnId,
    toolCallId: toolCall.toolCallId,
    command: toolCall.command,
    route: toolCall.route.kind,
    decision,
    reason
  });
}

function recordToolResult(
  replayStore: AssistantComputerUseReplayStore | undefined,
  toolCall: AssistantComputerUseToolCall
): void {
  replayStore?.recordComputerUseEvent({
    type: "tool_result",
    turnId: toolCall.turnId,
    toolCallId: toolCall.toolCallId,
    command: toolCall.command,
    route: toolCall.route.kind,
    status: readTerminalStatus(toolCall),
    summary: toolCall.result?.summary,
    evidence: toolCall.result?.evidence
  });
  replayStore?.recordTaskEvent(createTaskEvent(toolCall, toolCall.status));
}

function readTerminalStatus(toolCall: AssistantComputerUseToolCall): AssistantComputerUseTerminalStatus {
  if (toolCall.result) {
    return toolCall.result.status;
  }

  if (
    toolCall.status === "completed"
    || toolCall.status === "denied"
    || toolCall.status === "blocked"
    || toolCall.status === "failed"
    || toolCall.status === "cancelled"
  ) {
    return toolCall.status;
  }

  throw new Error(`Computer Use tool result requires a terminal status, got ${toolCall.status}.`);
}

function createTaskEvent(
  toolCall: AssistantComputerUseToolCall,
  status: AssistantComputerUseToolStatus
) {
  return {
    status: status as TurnReplayTaskStatus,
    command: toolCall.command,
    turnId: toolCall.turnId,
    toolCallId: toolCall.toolCallId,
    route: toolCall.route.kind,
    ...(toolCall.result?.summary ? { message: toolCall.result.summary } : {})
  };
}

function createToolKey(identity: AssistantComputerUseToolIdentity): string {
  return `${identity.turnId}:${identity.toolCallId}`;
}

function cloneToolCall(toolCall: AssistantComputerUseToolCall): AssistantComputerUseToolCall {
  return {
    ...toolCall,
    route: { ...toolCall.route } as CommandRoute,
    approval: { ...toolCall.approval },
    ...(toolCall.result
      ? {
        result: {
          ...toolCall.result,
          ...(toolCall.result.evidence
            ? {
              evidence: {
                ...toolCall.result.evidence,
                artifacts: toolCall.result.evidence.artifacts
                  ? [...toolCall.result.evidence.artifacts]
                  : undefined
              }
            }
            : {})
        }
      }
      : {})
  };
}
