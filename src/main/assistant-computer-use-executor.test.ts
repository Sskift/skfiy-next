import { describe, expect, it } from "vitest";
import {
  createAssistantComputerUseExecutor,
  type AssistantComputerUseToolCall
} from "./assistant-computer-use-executor";
import { createRuntimeSnapshotFromReplay } from "./runtime-snapshot";
import { createTurnReplayStore } from "./computer-use/turn-replay-store";

describe("assistant-owned Computer Use executor", () => {
  const route = {
    kind: "chrome",
    bundleId: "com.google.Chrome"
  } as const;
  const baseToolCall = {
    turnId: "turn-agent-1",
    toolCallId: "turn-agent-1-tool-1",
    command: "打开 Chrome 测试页面 file:///tmp/skfiy.html 并提取正文",
    route,
    createdAt: "2026-06-22T10:00:00.000Z"
  };

  it("preserves the same turn/tool continuation through approval denial", () => {
    const replayStore = createTurnReplayStore();
    const executor = createAssistantComputerUseExecutor({ replayStore });

    expect(executor.planToolCall(baseToolCall)).toMatchObject({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: baseToolCall.command,
      route,
      status: "planned"
    });

    expect(executor.requireApproval({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      reason: "Chrome navigation changes browser state."
    })).toMatchObject({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      status: "approval_required",
      approval: {
        state: "required",
        reason: "Chrome navigation changes browser state."
      }
    });

    const denied = executor.resumeApproval({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      decision: "denied",
      reason: "User denied this browser mutation."
    });

    expect(denied).toMatchObject({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: baseToolCall.command,
      route,
      status: "denied",
      approval: {
        state: "denied",
        reason: "User denied this browser mutation."
      },
      result: {
        status: "denied",
        summary: "User denied this browser mutation."
      }
    });
    expect(executor.getPendingApproval({ turnId: "turn-agent-1", toolCallId: "turn-agent-1-tool-1" }))
      .toBeUndefined();
    expect(replayStore.getReplay()).toMatchObject({
      transcript: {
        command: baseToolCall.command,
        approvalRequired: true,
        outcome: "denied",
        actions: expect.arrayContaining([
          expect.objectContaining({
            type: "tool_call",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            status: "planned"
          }),
          expect.objectContaining({
            type: "approval_decision",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            decision: "denied"
          }),
          expect.objectContaining({
            type: "tool_result",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            status: "denied"
          })
        ])
      },
      timeline: [
        {
          status: "planned",
          command: baseToolCall.command,
          toolCallId: "turn-agent-1-tool-1"
        },
        {
          status: "approval_required",
          command: baseToolCall.command,
          toolCallId: "turn-agent-1-tool-1"
        },
        {
          status: "denied",
          command: baseToolCall.command,
          toolCallId: "turn-agent-1-tool-1"
        }
      ]
    });
  });

  it("resumes approval to completion without starting a new command route", () => {
    const replayStore = createTurnReplayStore();
    const executor = createAssistantComputerUseExecutor({ replayStore });

    executor.planToolCall(baseToolCall);
    executor.requireApproval({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      reason: "Browser mutation requires approval."
    });

    const completed = executor.resumeApproval({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      decision: "approved",
      result: {
        status: "completed",
        summary: "Chrome page opened and body text extracted.",
        evidence: {
          summary: "Screenshot and extracted text captured.",
          artifacts: ["/tmp/skfiy/chrome-after.png"]
        }
      }
    });

    expect(completed).toMatchObject({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: baseToolCall.command,
      route,
      status: "completed",
      approval: {
        state: "approved"
      },
      result: {
        status: "completed",
        summary: "Chrome page opened and body text extracted.",
        evidence: {
          summary: "Screenshot and extracted text captured.",
          artifacts: ["/tmp/skfiy/chrome-after.png"]
        }
      }
    } satisfies Partial<AssistantComputerUseToolCall>);
    expect(replayStore.getReplay()).toMatchObject({
      transcript: {
        outcome: "completed",
        actions: expect.arrayContaining([
          expect.objectContaining({
            type: "approval_decision",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            decision: "approved"
          }),
          expect.objectContaining({
            type: "tool_result",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            status: "completed",
            summary: "Chrome page opened and body text extracted.",
            evidenceSummary: "Screenshot and extracted text captured.",
            artifactCount: 1
          })
        ])
      },
      timeline: [
        expect.objectContaining({ status: "planned" }),
        expect.objectContaining({ status: "approval_required" }),
        expect.objectContaining({ status: "running" }),
        expect.objectContaining({ status: "completed" })
      ]
    });
  });

  it("records cancellation and approval bypass evidence for the same tool identity", () => {
    const replayStore = createTurnReplayStore();
    const executor = createAssistantComputerUseExecutor({ replayStore });

    executor.planToolCall(baseToolCall);
    executor.bypassApproval({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      reason: "Dogfood bypass enabled for this local smoke run."
    });
    const cancelled = executor.cancelToolCall({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      reason: "User pressed stop."
    });

    expect(cancelled).toMatchObject({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      status: "cancelled",
      approval: {
        state: "bypassed",
        reason: "Dogfood bypass enabled for this local smoke run."
      },
      result: {
        status: "cancelled",
        summary: "User pressed stop."
      }
    });
    expect(replayStore.getReplay()).toMatchObject({
      transcript: {
        outcome: "cancelled",
        actions: expect.arrayContaining([
          expect.objectContaining({
            type: "approval_decision",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            decision: "bypassed"
          }),
          expect.objectContaining({
            type: "tool_result",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            status: "cancelled"
          })
        ])
      }
    });
  });

  it("records bypass, running, and completion evidence without changing tool identity", () => {
    const replayStore = createTurnReplayStore();
    const executor = createAssistantComputerUseExecutor({ replayStore });

    executor.planToolCall(baseToolCall);
    expect(executor.bypassApproval({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      reason: "Default approval bypass enabled for local dogfood."
    })).toMatchObject({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      status: "running",
      approval: {
        state: "bypassed",
        reason: "Default approval bypass enabled for local dogfood."
      }
    });

    expect(executor.completeToolCall({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      result: {
        status: "completed",
        summary: "Chrome page opened.",
        evidence: {
          summary: "Chrome orchestration completed with replay events."
        }
      }
    })).toMatchObject({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      status: "completed",
      approval: {
        state: "bypassed"
      },
      result: {
        status: "completed",
        summary: "Chrome page opened."
      }
    });

    expect(replayStore.getReplay()).toMatchObject({
      transcript: {
        outcome: "completed",
        actions: expect.arrayContaining([
          expect.objectContaining({
            type: "approval_decision",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            decision: "bypassed"
          }),
          expect.objectContaining({
            type: "tool_call",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            status: "running"
          }),
          expect.objectContaining({
            type: "tool_result",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            status: "completed",
            summary: "Chrome page opened.",
            evidenceSummary: "Chrome orchestration completed with replay events."
          })
        ])
      },
      timeline: [
        expect.objectContaining({ status: "planned", toolCallId: "turn-agent-1-tool-1" }),
        expect.objectContaining({ status: "running", toolCallId: "turn-agent-1-tool-1" }),
        expect.objectContaining({ status: "completed", toolCallId: "turn-agent-1-tool-1" })
      ]
    });
  });

  it("exposes lifecycle identity and evidence in runtime snapshots", () => {
    const replayStore = createTurnReplayStore();
    const executor = createAssistantComputerUseExecutor({ replayStore });

    executor.planToolCall(baseToolCall);
    executor.requireApproval({
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      reason: "Chrome navigation changes browser state."
    });

    expect(createRuntimeSnapshotFromReplay({
      replay: replayStore.getReplay(),
      observedAt: "2026-06-22T10:00:01.000Z"
    })).toMatchObject({
      currentTurn: {
        state: "approval_required",
        command: baseToolCall.command,
        turnId: "turn-agent-1",
        toolCallId: "turn-agent-1-tool-1",
        route: "chrome",
        approvalRequired: true,
        approvalState: "required",
        latestToolStatus: "approval_required"
      },
      replay: {
        state: "available",
        outcome: "approval_required",
        latestToolCall: {
          turnId: "turn-agent-1",
          toolCallId: "turn-agent-1-tool-1",
          status: "approval_required",
          route: "chrome"
        },
        timelineTail: expect.arrayContaining([
          {
            status: "approval_required",
            command: baseToolCall.command,
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            route: "chrome"
          }
        ])
      }
    });
  });
});
