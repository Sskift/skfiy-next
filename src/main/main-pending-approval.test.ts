import { describe, expect, it } from "vitest";

import {
  cancelComputerUseToolCallState,
  createClearedActiveComputerUseTaskState,
  createClearedPendingComputerUseTaskState,
  createStartedComputerUseTaskState,
  completeComputerUseToolCallState,
  createPendingApproval as createBoundPendingApproval,
  createPendingApprovalDeniedTaskEvent,
  readApprovedPendingApprovalContinuation,
  readComputerUseRouteForToolCallState,
  readComputerUseToolCallIdentityToCancel,
  USER_DENIED_COMPUTER_USE_REASON
} from "./main-pending-approval";
import type {
  ComputerUseCommandRoute,
  CreatePendingApprovalInput,
  PendingApproval
} from "./main-pending-approval";
import type { AssistantComputerUseToolIdentity } from "./assistant-computer-use-executor";
import type { FinderPlanPreview } from "./orchestrator/finder-task";
import type { ManualMode } from "./task-event-view";
import { CHROME_BUNDLE_ID, FINDER_BUNDLE_ID } from "./task-routing";

describe("main pending approval helpers", () => {
  it("binds action and Finder approvals to an explicit gate and plan id", () => {
    const actionApproval = createPendingApproval({
      command: "open Chrome",
      mode: "active",
      identity: {
        turnId: "turn-plan-bound",
        toolCallId: "tool-plan-bound"
      },
      route: {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      },
      gate: "action-plan",
      planId: "plan-action-123",
      actionApproved: false,
      finderPlanApproved: false
    });

    expect(actionApproval).toMatchObject({
      gate: "action-plan",
      planId: "plan-action-123",
      actionApproved: false,
      finderPlanApproved: false
    });
    expect(readApprovedPendingApprovalContinuation(actionApproval)).toEqual({
      actionApproved: true,
      finderPlanApproved: false,
      chromeSubmitApproved: false
    });

    const finderApproval = createPendingApproval({
      command: actionApproval.command,
      mode: actionApproval.mode,
      identity: {
        turnId: actionApproval.turnId,
        toolCallId: actionApproval.toolCallId
      },
      route: actionApproval.route,
      gate: "finder-plan",
      planId: "plan-finder-456",
      actionApproved: true,
      finderPlanApproved: false
    });
    expect(readApprovedPendingApprovalContinuation(finderApproval)).toEqual({
      actionApproved: true,
      finderPlanApproved: true,
      chromeSubmitApproved: false
    });
  });

  it("resumes a Chrome submit gate with both approvals and a value-free binding", () => {
    const binding = {
      schemaVersion: 1 as const,
      url: "https://example.test/form",
      fieldSelectors: ["#name"],
      submitSelector: "#submit"
    };
    const approval = createBoundPendingApproval({
      command: "fill Chrome form",
      mode: "active",
      identity: { turnId: "turn-chrome", toolCallId: "tool-chrome" },
      route: { kind: "chrome", bundleId: CHROME_BUNDLE_ID },
      gate: "chrome-submit",
      planId: "plan-chrome:submit-derived",
      actionApproved: true,
      finderPlanApproved: false,
      chromeSubmitApproved: false,
      approvedChromeSubmitBinding: binding
    });

    expect(readApprovedPendingApprovalContinuation(approval)).toEqual({
      actionApproved: true,
      finderPlanApproved: false,
      chromeSubmitApproved: true
    });
    expect(approval.approvedChromeSubmitBinding).toEqual(binding);
    binding.fieldSelectors[0] = "#mutated";
    expect(approval.approvedChromeSubmitBinding?.fieldSelectors).toEqual(["#name"]);
  });

  it("preserves assistant tool identity and route state for approval resumption", () => {
    const approvedPlanPreview = {
      rootPath: "/tmp/Downloads",
      operationCount: 1,
      destructiveOperationCount: 0,
      createFolders: ["Images"],
      moveFiles: [{
        from: "/tmp/Downloads/photo.png",
        to: "/tmp/Downloads/Images/photo.png"
      }]
    };

    expect(createPendingApproval(
      "organize Downloads",
      "active",
      {
        turnId: "turn-agent-1",
        toolCallId: "tool-call-1"
      },
      {
        kind: "finder",
        bundleId: FINDER_BUNDLE_ID
      },
      true,
      approvedPlanPreview
    )).toEqual({
      turnId: "turn-agent-1",
      toolCallId: "tool-call-1",
      command: "organize Downloads",
      mode: "active",
      route: {
        kind: "finder",
        bundleId: FINDER_BUNDLE_ID
      },
      gate: "finder-plan",
      planId: "test-plan-tool-call-1",
      actionApproved: true,
      finderPlanApproved: false,
      chromeSubmitApproved: false,
      approvedPlanPreview
    });
  });

  it("keeps initial action approval explicit when a Finder plan is not involved", () => {
    expect(createPendingApproval(
      "open Chrome",
      "quiet",
      {
        turnId: "turn-agent-2",
        toolCallId: "tool-call-2"
      },
      {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      }
    )).toEqual({
      turnId: "turn-agent-2",
      toolCallId: "tool-call-2",
      command: "open Chrome",
      mode: "quiet",
      route: {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      },
      gate: "action-plan",
      planId: "test-plan-tool-call-2",
      actionApproved: false,
      finderPlanApproved: false,
      chromeSubmitApproved: false
    });
  });

  it("creates a routed user-denied task event for a pending approval", () => {
    const approval = createPendingApproval(
      "open https://example.test",
      "active",
      {
        turnId: "turn-agent-3",
        toolCallId: "tool-call-3"
      },
      {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      }
    );

    expect(createPendingApprovalDeniedTaskEvent(approval)).toMatchObject({
      status: "denied",
      message: "Task denied.",
      command: "open https://example.test",
      route: "chrome",
      routeReason: USER_DENIED_COMPUTER_USE_REASON,
      denialKind: "user",
      routeOutcome: {
        kind: "user_denied",
        value: "user_denied",
        routeLabel: "chrome",
        source: "task-event",
        denialKind: "user"
      }
    });
  });

  it("returns the existing idle response when no approval is pending", () => {
    expect(createPendingApprovalDeniedTaskEvent(null)).toEqual({
      status: "idle",
      message: "No task is waiting for approval."
    });
  });

  it("clears completed Computer Use tool identities from pending and active state", () => {
    const identity = { turnId: "turn-agent-4", toolCallId: "tool-call-4" };
    const otherIdentity = { turnId: "turn-agent-5", toolCallId: "tool-call-5" };
    const approval = createPendingApproval(
      "organize Downloads",
      "active",
      identity,
      {
        kind: "finder",
        bundleId: FINDER_BUNDLE_ID
      }
    );

    expect(completeComputerUseToolCallState({
      pendingApproval: approval,
      activeToolIdentity: identity
    }, identity)).toEqual({
      pendingApproval: null,
      activeToolIdentity: null
    });

    expect(completeComputerUseToolCallState({
      pendingApproval: approval,
      activeToolIdentity: otherIdentity
    }, otherIdentity)).toEqual({
      pendingApproval: approval,
      activeToolIdentity: null
    });
  });

  it("prefers pending approval when choosing the Computer Use tool call to cancel", () => {
    const activeToolIdentity = { turnId: "turn-agent-6", toolCallId: "tool-call-6" };
    const pendingToolIdentity = { turnId: "turn-agent-7", toolCallId: "tool-call-7" };
    const pendingApproval = createPendingApproval(
      "open Chrome",
      "active",
      pendingToolIdentity,
      {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      }
    );

    expect(readComputerUseToolCallIdentityToCancel({
      pendingApproval,
      activeToolIdentity
    })).toEqual(pendingApproval);
    expect(readComputerUseToolCallIdentityToCancel({
      pendingApproval: null,
      activeToolIdentity
    })).toEqual(activeToolIdentity);
    expect(readComputerUseToolCallIdentityToCancel({
      pendingApproval: null,
      activeToolIdentity: null
    })).toBeNull();
  });

  it("clears pending approval and matching active identity after cancellation", () => {
    const activeToolIdentity = { turnId: "turn-agent-8", toolCallId: "tool-call-8" };
    const unrelatedActiveToolIdentity = { turnId: "turn-agent-9", toolCallId: "tool-call-9" };
    const pendingApproval = createPendingApproval(
      "open Chrome",
      "quiet",
      activeToolIdentity,
      {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      }
    );

    expect(cancelComputerUseToolCallState({
      pendingApproval,
      activeToolIdentity
    }, pendingApproval)).toEqual({
      pendingApproval: null,
      activeToolIdentity: null
    });

    expect(cancelComputerUseToolCallState({
      pendingApproval,
      activeToolIdentity: unrelatedActiveToolIdentity
    }, pendingApproval)).toEqual({
      pendingApproval: null,
      activeToolIdentity: unrelatedActiveToolIdentity
    });
  });

  it("derives active Computer Use route from pending approval or active identity", () => {
    const activeToolIdentity = { turnId: "turn-agent-10", toolCallId: "tool-call-10" };
    const chromeRoute = {
      kind: "chrome",
      bundleId: CHROME_BUNDLE_ID
    } as const;
    const finderRoute = {
      kind: "finder",
      bundleId: FINDER_BUNDLE_ID
    } as const;
    const pendingApproval = createPendingApproval(
      "organize Downloads",
      "active",
      activeToolIdentity,
      finderRoute
    );

    expect(readComputerUseRouteForToolCallState({
      pendingApproval,
      activeToolIdentity,
      activeRoute: chromeRoute
    })).toEqual(finderRoute);
    expect(readComputerUseRouteForToolCallState({
      pendingApproval: null,
      activeToolIdentity,
      activeRoute: chromeRoute
    })).toEqual(chromeRoute);
    expect(readComputerUseRouteForToolCallState({
      pendingApproval: null,
      activeToolIdentity: null,
      activeRoute: chromeRoute
    })).toBeNull();
  });

  it("clears pending task epoch state without mutating tool identity state", () => {
    const activeToolIdentity = { turnId: "turn-agent-11", toolCallId: "tool-call-11" };
    const chromeRoute = {
      kind: "chrome",
      bundleId: CHROME_BUNDLE_ID
    } as const;
    const pendingApproval = createPendingApproval(
      "open Chrome",
      "active",
      activeToolIdentity,
      chromeRoute
    );
    const state = {
      currentTaskId: 41,
      pendingApproval,
      activeToolIdentity,
      activeRoute: chromeRoute
    };

    expect(createClearedPendingComputerUseTaskState(state)).toEqual({
      currentTaskId: 42,
      pendingApproval: null
    });
    expect(state.pendingApproval).toBe(pendingApproval);
    expect(state.activeToolIdentity).toBe(activeToolIdentity);
  });

  it("clears active task state for explicit denial and stop outcomes", () => {
    const activeToolIdentity = { turnId: "turn-agent-12", toolCallId: "tool-call-12" };
    const finderRoute = {
      kind: "finder",
      bundleId: FINDER_BUNDLE_ID
    } as const;
    const pendingApproval = createPendingApproval(
      "organize Downloads",
      "active",
      activeToolIdentity,
      finderRoute
    );

    expect(createClearedActiveComputerUseTaskState({
      currentTaskId: 8,
      pendingApproval,
      activeToolIdentity,
      activeRoute: finderRoute
    })).toEqual({
      currentTaskId: 9,
      pendingApproval: null,
      activeToolIdentity: null,
      activeRoute: null
    });
  });

  it("starts a task epoch while preserving the active Computer Use identity and route", () => {
    const activeToolIdentity = { turnId: "turn-agent-13", toolCallId: "tool-call-13" };
    const chromeRoute = {
      kind: "chrome",
      bundleId: CHROME_BUNDLE_ID
    } as const;
    const pendingApproval = createPendingApproval(
      "open Chrome",
      "active",
      activeToolIdentity,
      chromeRoute
    );

    expect(createStartedComputerUseTaskState({
      currentTaskId: 13,
      pendingApproval,
      activeToolIdentity,
      activeRoute: chromeRoute
    })).toEqual({
      taskId: 14,
      currentTaskId: 14,
      pendingApproval: null,
      activeToolIdentity,
      activeRoute: chromeRoute
    });
  });
});

function createPendingApproval(input: CreatePendingApprovalInput): PendingApproval;
function createPendingApproval(
  command: string,
  mode: ManualMode,
  identity: AssistantComputerUseToolIdentity,
  route: ComputerUseCommandRoute,
  planApproved?: boolean,
  approvedPlanPreview?: FinderPlanPreview
): PendingApproval;
function createPendingApproval(
  inputOrCommand: CreatePendingApprovalInput | string,
  mode?: ManualMode,
  identity?: AssistantComputerUseToolIdentity,
  route?: ComputerUseCommandRoute,
  planApproved = false,
  approvedPlanPreview?: FinderPlanPreview
): PendingApproval {
  if (typeof inputOrCommand !== "string") {
    return createBoundPendingApproval(inputOrCommand);
  }

  return createBoundPendingApproval({
    command: inputOrCommand,
    mode: mode!,
    identity: identity!,
    route: route!,
    gate: planApproved ? "finder-plan" : "action-plan",
    planId: `test-plan-${identity!.toolCallId}`,
    actionApproved: planApproved,
    finderPlanApproved: false,
    ...(approvedPlanPreview ? { approvedPlanPreview } : {})
  });
}
