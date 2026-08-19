import { describe, expect, it } from "vitest";
import { createComputerUseTaskEventDispatch } from "./main-task-event-dispatch";
import type { FinderPlanPreview } from "./orchestrator/finder-task";
import type { ExecutableCommandRoute } from "./task-routing";

const ghosttyRoute: ExecutableCommandRoute = {
  kind: "ghostty",
  bundleId: "com.mitchellh.ghostty"
};

const finderRoute: ExecutableCommandRoute = {
  kind: "finder",
  bundleId: "com.apple.finder"
};

const planPreview: FinderPlanPreview = {
  rootPath: "/tmp/skfiy-fixture",
  operationCount: 1,
  destructiveOperationCount: 0,
  createFolders: ["Images"],
  moveFiles: [{ from: "/tmp/skfiy-fixture/photo.png", to: "/tmp/skfiy-fixture/Images/photo.png" }]
};

describe("createComputerUseTaskEventDispatch", () => {
  it("turns unapproved risk events into approval requests and route-aware task status", () => {
    const dispatch = createComputerUseTaskEventDispatch({
      approved: false,
      command: "run pwd in Ghostty",
      event: {
        type: "approval_required",
        command: "pwd",
        risk: {
          level: "medium",
          reason: "Terminal command needs approval.",
          requiresApproval: true
        }
      },
      mode: "active",
      planApproved: false,
      route: ghosttyRoute
    });

    expect(dispatch).toMatchObject({
      approvalRequest: {
        command: "pwd",
        planApproved: false,
        reason: "Terminal command needs approval."
      },
      taskStatus: {
        status: "approval_required",
        message: "Approval required (medium): Terminal command needs approval.",
        command: "pwd",
        route: "ghostty",
        routeOutcome: {
          kind: "approval_required",
          value: "approval_required",
          routeLabel: "ghostty",
          source: "task-event"
        }
      },
      toolResult: undefined
    });
  });

  it("keeps Finder plan confirmation distinct from initial Computer Use approval", () => {
    const dispatch = createComputerUseTaskEventDispatch({
      approved: true,
      command: "整理 Finder 测试文件夹 /tmp/skfiy-fixture",
      event: {
        type: "plan_confirmation_required",
        command: "Finder organization plan",
        preview: planPreview,
        reason: "Confirm moving 1 file."
      },
      mode: "active",
      planApproved: false,
      route: finderRoute
    });

    expect(dispatch.approvalRequest).toEqual({
      command: "整理 Finder 测试文件夹 /tmp/skfiy-fixture",
      planApproved: true,
      approvedPlanPreview: planPreview,
      reason: "Confirm moving 1 file."
    });
    expect(dispatch.taskStatus).toMatchObject({
      status: "approval_required",
      message: "Finder plan confirmation required: Confirm moving 1 file.",
      command: "Finder organization plan",
      route: "finder"
    });
    expect(dispatch.taskStatus.finderPlanPreview).toEqual(planPreview);
    expect(dispatch.toolResult).toBeUndefined();
  });

  it("returns terminal tool results for completed orchestration events", () => {
    const dispatch = createComputerUseTaskEventDispatch({
      approved: true,
      command: "run pwd in Ghostty",
      event: {
        type: "completed",
        command: "pwd",
        summary: "pwd completed."
      },
      mode: "quiet",
      planApproved: true,
      route: ghosttyRoute
    });

    expect(dispatch.approvalRequest).toBeUndefined();
    expect(dispatch.taskStatus).toMatchObject({
      status: "completed",
      message: "pwd completed.",
      route: "ghostty",
      routeOutcome: {
        kind: "completed",
        value: "completed",
        routeLabel: "ghostty",
        source: "task-event"
      }
    });
    expect(dispatch.toolResult).toEqual({
      status: "completed",
      summary: "pwd completed.",
      evidence: {
        summary: "Computer Use route completed with replayed orchestration events."
      }
    });
  });

  it("returns failed tool results for verification failures without requesting approval", () => {
    const dispatch = createComputerUseTaskEventDispatch({
      approved: true,
      command: "run pwd in Ghostty",
      event: {
        type: "verification_failed",
        stage: "permissions",
        reason: "Accessibility is denied."
      },
      mode: "active",
      planApproved: true,
      route: ghosttyRoute
    });

    expect(dispatch.approvalRequest).toBeUndefined();
    expect(dispatch.taskStatus).toMatchObject({
      status: "failed",
      message: "Accessibility is denied.",
      route: "ghostty",
      routeOutcome: {
        kind: "failed",
        value: "failed",
        routeLabel: "ghostty",
        source: "task-event"
      }
    });
    expect(dispatch.toolResult).toEqual({
      status: "failed",
      summary: "Accessibility is denied.",
      evidence: {
        summary: "Computer Use route stopped during permissions verification."
      }
    });
  });
});
