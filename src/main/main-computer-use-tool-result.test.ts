import { describe, expect, it } from "vitest";

import {
  createToolResult,
  createToolResultFromTaskEvent,
  isSameComputerUseToolIdentity
} from "./main-computer-use-tool-result";
import type { ComputerUseTaskEvent } from "./task-event-view";

describe("main Computer Use tool result helpers", () => {
  it("matches active tool calls by turn and tool id", () => {
    const identity = { turnId: "turn-1", toolCallId: "tool-1" };

    expect(isSameComputerUseToolIdentity(identity, identity)).toBe(true);
    expect(isSameComputerUseToolIdentity({ ...identity }, identity)).toBe(true);
    expect(isSameComputerUseToolIdentity({ turnId: "turn-2", toolCallId: "tool-1" }, identity)).toBe(false);
    expect(isSameComputerUseToolIdentity(null, identity)).toBe(false);
  });

  it("maps terminal Computer Use events to assistant tool results", () => {
    expect(createToolResultFromTaskEvent({
      type: "completed",
      summary: "Done"
    } as ComputerUseTaskEvent)).toEqual({
      status: "completed",
      summary: "Done",
      evidence: {
        summary: "Computer Use route completed with replayed orchestration events."
      }
    });

    expect(createToolResultFromTaskEvent({
      type: "verification_failed",
      stage: "after",
      reason: "Window did not update"
    } as ComputerUseTaskEvent)).toEqual({
      status: "failed",
      summary: "Window did not update",
      evidence: {
        summary: "Computer Use route stopped during after verification."
      }
    });

    expect(createToolResultFromTaskEvent({ type: "observing", message: "Watching" } as ComputerUseTaskEvent))
      .toBeUndefined();
  });

  it("includes the Finder result summary in the tool result evidence", () => {
    const result = {
      schemaVersion: 1 as const,
      rootPath: "/tmp/work",
      destinationPath: "/tmp/work",
      collisionPolicy: "cancel" as const,
      totalOperationCount: 6,
      completedCount: 5,
      failedCount: 1,
      skippedCount: 0,
      completedItems: [],
      failedItems: [
        {
          operationId: "op-4",
          operationType: "move_file" as const,
          from: "/tmp/work/photo.png",
          to: "/tmp/work/Images/photo.png",
          reason: "Destination already exists.",
          errorCode: "destination-exists" as const
        }
      ],
      destinationVerified: true,
      resultingNamesVerified: true
    };

    expect(createToolResultFromTaskEvent({
      type: "completed",
      command: "/tmp/work",
      summary: "5 of 6 operations completed, 1 failed.",
      result
    } as ComputerUseTaskEvent)).toEqual({
      status: "completed",
      summary: "5 of 6 operations completed, 1 failed.",
      evidence: {
        summary: "Computer Use route completed with replayed orchestration events. 5 of 6 operations completed, 1 failed."
      }
    });
  });

  it("creates direct assistant tool results with matching evidence summaries", () => {
    expect(createToolResult("blocked", "Permission missing")).toEqual({
      status: "blocked",
      summary: "Permission missing",
      evidence: {
        summary: "Permission missing"
      }
    });
  });
});
