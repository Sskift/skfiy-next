import { describe, expect, it } from "vitest";
import {
  summarizeAssistantComputerUseToolCall,
  summarizeAssistantToolPlan
} from "./assistant-tools";
import type { AssistantAgentTurnResult } from "./assistant-agent";

describe("assistant tool bridge", () => {
  it("summarizes planned Computer Use tool calls without executing them", () => {
    const turn: AssistantAgentTurnResult = {
      id: "turn-1",
      createdAt: "2026-06-22T10:00:00.000Z",
      status: "completed",
      providerLabel: "Codex",
      message: "Planning Chrome control.",
      route: {
        kind: "chrome",
        bundleId: "com.google.Chrome"
      },
      toolCalls: [
        {
          id: "turn-1-tool-1",
          type: "computer-use",
          name: "desktop-control",
          status: "planned",
          createdAt: "2026-06-22T10:00:00.000Z",
          input: {
            command: "打开 Chrome 测试页面",
            route: {
              kind: "chrome",
              bundleId: "com.google.Chrome"
            }
          }
        }
      ],
      cancellation: {
        requested: false
      }
    };

    expect(summarizeAssistantToolPlan(turn)).toEqual({
      providerLabel: "Codex",
      turnId: "turn-1",
      route: {
        kind: "chrome",
        bundleId: "com.google.Chrome"
      },
      plannedToolCount: 1,
      message: "Codex planned 1 Computer Use tool call for Chrome."
    });
  });

  it("does not create tool evidence for chat turns", () => {
    expect(summarizeAssistantToolPlan({
      id: "turn-chat",
      createdAt: "2026-06-22T10:00:00.000Z",
      status: "completed",
      providerLabel: "Codex",
      message: "你好",
      route: {
        kind: "chat",
        reason: "Conversational prompt should be answered by the assistant instead of typed into Ghostty."
      },
      toolCalls: [],
      cancellation: {
        requested: false
      }
    })).toBeUndefined();
  });

  it("summarizes executor-owned tool continuation status and evidence", () => {
    expect(summarizeAssistantComputerUseToolCall({
      turnId: "turn-1",
      toolCallId: "turn-1-tool-1",
      command: "打开 Chrome 测试页面",
      route: {
        kind: "chrome",
        bundleId: "com.google.Chrome"
      },
      status: "completed",
      createdAt: "2026-06-22T10:00:00.000Z",
      updatedAt: "2026-06-22T10:00:01.000Z",
      approval: {
        state: "approved"
      },
      result: {
        status: "completed",
        summary: "Chrome page opened.",
        evidence: {
          summary: "Screenshot captured.",
          artifacts: ["/tmp/chrome-after.png"]
        }
      }
    })).toEqual({
      turnId: "turn-1",
      toolCallId: "turn-1-tool-1",
      route: {
        kind: "chrome",
        bundleId: "com.google.Chrome"
      },
      status: "completed",
      approvalState: "approved",
      resultStatus: "completed",
      evidenceSummary: "Screenshot captured.",
      artifactCount: 1,
      message: "Computer Use tool turn-1-tool-1 completed for Chrome: Chrome page opened."
    });
  });
});
