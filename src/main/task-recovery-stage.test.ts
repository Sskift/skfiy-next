import { describe, expect, it, vi } from "vitest";

import type { TaskControlRecoveryDescriptor } from "../shared/task-control.js";
import type { FinderExecutionPlanBinding } from "./orchestrator/finder-task.js";
import {
  readTaskRecoveryChromePageSnapshot,
  runTaskRecoveryStage,
  type TaskRecoveryPathStatus
} from "./task-recovery-stage.js";
import type { TaskRecoveryExecutionContext } from "./task-recovery-registry.js";

describe("Task Control recovery stage", () => {
  it("verifies a bound Finder plan with read-only identity checks", async () => {
    const finderExecutionPlan = createFinderPlan();
    const readPathStatus = vi.fn(async (candidate: string): Promise<TaskRecoveryPathStatus> => {
      if (candidate.endsWith("/Images")) return { state: "directory" };
      if (candidate.endsWith("/photo.png") && !candidate.includes("/Images/")) {
        return { state: "missing" };
      }
      if (candidate.endsWith("/Images/photo.png")) {
        return { state: "file", identity: sourceIdentity };
      }
      if (candidate.endsWith("/notes.txt")) {
        return { state: "file", identity: skippedIdentity };
      }
      return { state: "directory" };
    });

    const result = await runTaskRecoveryStage(
      createStageInput({ finderExecutionPlan }),
      { readPathStatus }
    );

    expect(result).toEqual({
      state: "passed",
      message: "Read-only Finder verification passed for 3 bound operations."
    });
    expect(readPathStatus).toHaveBeenCalledTimes(6);
  });

  it("requests confirmation when Finder final state no longer proves the bound result", async () => {
    const result = await runTaskRecoveryStage(
      createStageInput({ finderExecutionPlan: createFinderPlan() }),
      {
        readPathStatus: async (candidate) => candidate === "/tmp/fixture" || candidate.endsWith("/Images")
          ? { state: "directory" }
          : { state: "missing" }
      }
    );

    expect(result).toEqual({
      state: "confirmation_required",
      message: "Read-only Finder verification could not prove 2 of 3 bound operations. Review the current file state."
    });
  });

  it("observes Finder state without requiring the mutation to have completed", async () => {
    const readPathStatus = vi.fn(async (candidate: string): Promise<TaskRecoveryPathStatus> => (
      candidate === "/tmp/fixture" ? { state: "directory" } : { state: "missing" }
    ));
    const result = await runTaskRecoveryStage(
      createStageInput({
        action: "retry_observation",
        failureStage: "observation",
        finderExecutionPlan: createFinderPlan()
      }),
      { readPathStatus }
    );

    expect(result).toEqual({
      state: "passed",
      message: "Read-only Finder observation inspected 3 bound operations."
    });
    expect(readPathStatus).toHaveBeenCalledTimes(6);
  });

  it("fails closed when Finder recovery has no exact execution plan", async () => {
    await expect(runTaskRecoveryStage(createStageInput(), {})).resolves.toEqual({
      state: "blocked",
      message: "The exact Finder execution plan is unavailable for read-only recovery."
    });
  });

  it("passes an exact Chrome URL observation and stops on changed-page evidence", async () => {
    const observeChromePage = vi.fn(async () => ({
      url: "https://example.test/report",
      title: "Report"
    }));
    const input = createStageInput({
      action: "retry_observation",
      command: "Open Chrome https://example.test/report and extract content",
      failureStage: "observation",
      route: { kind: "chrome", bundleId: "com.google.Chrome" }
    });

    await expect(runTaskRecoveryStage(input, { observeChromePage })).resolves.toEqual({
      state: "passed",
      message: "Read-only Chrome observation matched the bound page target."
    });
    observeChromePage.mockResolvedValue({
      url: "https://example.test/changed",
      title: "Changed"
    });
    await expect(runTaskRecoveryStage(input, { observeChromePage })).resolves.toEqual({
      state: "confirmation_required",
      message: "Chrome changed pages after the bound task. Re-observe and review the current page before any action."
    });
  });

  it("drops Chrome page text from the recovery snapshot boundary", () => {
    expect(readTaskRecoveryChromePageSnapshot({
      result: {
        value: {
          url: "https://example.test/report",
          title: "Report",
          text: "token=private page body"
        }
      }
    })).toEqual({
      url: "https://example.test/report",
      title: "Report"
    });
    expect(() => readTaskRecoveryChromePageSnapshot({ result: { value: {} } }))
      .toThrow("Chrome recovery observation did not return bounded page identity.");
  });

  it("never treats a form page observation as proof of submission", async () => {
    const command = "填写 Chrome 测试表单 https://example.test/form 字段 #name=private-value 点击 button[type=submit] 并提取正文";
    const result = await runTaskRecoveryStage(createStageInput({
      command,
      route: { kind: "chrome", bundleId: "com.google.Chrome" }
    }), {
      observeChromePage: async () => ({
        url: "https://example.test/form",
        title: "Form"
      })
    });

    expect(result).toEqual({
      state: "confirmation_required",
      message: "A read-only page observation cannot prove a form submission or external side effect. Review the current page."
    });
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("observes Ghostty presence without activating it or claiming command completion", async () => {
    const listRunningAppBundleIds = vi.fn(async () => ["com.mitchellh.ghostty"]);
    const observation = await runTaskRecoveryStage(createStageInput({
      action: "retry_observation",
      failureStage: "observation",
      route: { kind: "ghostty", bundleId: "com.mitchellh.ghostty" }
    }), { listRunningAppBundleIds });
    const verification = await runTaskRecoveryStage(createStageInput({
      route: { kind: "ghostty", bundleId: "com.mitchellh.ghostty" }
    }), { listRunningAppBundleIds });

    expect(observation).toEqual({
      state: "passed",
      message: "Read-only Ghostty observation confirmed that the bound app is running."
    });
    expect(verification).toEqual({
      state: "confirmation_required",
      message: "App presence cannot prove terminal command completion without capturing terminal content. Review the terminal result."
    });
    expect(listRunningAppBundleIds).toHaveBeenCalledTimes(2);
  });

  it("uses only the read-only tmux probe and reports missing sessions as blocked", async () => {
    const probeTmuxSession = vi.fn(async (): Promise<{
      state: "observable" | "missing" | "unknown";
    }> => ({ state: "observable" }));
    const input = createStageInput({
      action: "retry_observation",
      failureStage: "observation",
      route: { kind: "tmux_supervision", sessionName: "money-run" }
    });

    await expect(runTaskRecoveryStage(input, { probeTmuxSession })).resolves.toEqual({
      state: "passed",
      message: "Read-only tmux observation confirmed that the bound session is observable."
    });
    probeTmuxSession.mockResolvedValue({ state: "missing" });
    await expect(runTaskRecoveryStage(input, { probeTmuxSession })).resolves.toEqual({
      state: "blocked",
      message: "The bound tmux session is not currently observable."
    });
    expect(probeTmuxSession).toHaveBeenNthCalledWith(1, "money-run");
  });

  it("sanitizes dependency failures instead of exposing private diagnostics", async () => {
    const result = await runTaskRecoveryStage(createStageInput({
      action: "retry_observation",
      failureStage: "observation",
      route: { kind: "ghostty", bundleId: "com.mitchellh.ghostty" }
    }), {
      listRunningAppBundleIds: async () => {
        throw new Error("token=private /Users/tester/secret");
      }
    });

    expect(result).toEqual({
      state: "failed",
      message: "The read-only Ghostty observation could not be completed."
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("/Users");
  });
});

const sourceIdentity = {
  device: 1,
  inode: 10,
  size: 20,
  modifiedAtMs: 30,
  changedAtMs: 40
};
const skippedIdentity = {
  device: 1,
  inode: 11,
  size: 21,
  modifiedAtMs: 31,
  changedAtMs: 41
};

function createFinderPlan(): FinderExecutionPlanBinding {
  return {
    schemaVersion: 1,
    targetKind: "absolute_path",
    rootPath: "/tmp/fixture",
    collisionPolicy: "skip",
    operations: [
      {
        operationId: "finder-op-folder",
        type: "create_folder",
        path: "/tmp/fixture/Images"
      },
      {
        operationId: "finder-op-move",
        type: "move_file",
        from: "/tmp/fixture/photo.png",
        requestedTo: "/tmp/fixture/Images/photo.png",
        to: "/tmp/fixture/Images/photo.png",
        resolution: "move",
        replaceEligible: false,
        expectedSourceIdentity: sourceIdentity
      },
      {
        operationId: "finder-op-skip",
        type: "move_file",
        from: "/tmp/fixture/notes.txt",
        requestedTo: "/tmp/fixture/Documents/notes.txt",
        to: "/tmp/fixture/Documents/notes.txt",
        resolution: "skip",
        replaceEligible: true,
        expectedSourceIdentity: skippedIdentity
      }
    ]
  };
}

function createStageInput({
  action = "retry_verification",
  command = "organize Finder fixture",
  failureStage = "verification",
  finderExecutionPlan,
  route = { kind: "finder", bundleId: "com.apple.finder" }
}: {
  action?: TaskControlRecoveryDescriptor["action"];
  command?: string;
  failureStage?: TaskControlRecoveryDescriptor["failureStage"];
  finderExecutionPlan?: FinderExecutionPlanBinding;
  route?: TaskRecoveryExecutionContext["route"];
} = {}) {
  const descriptor: TaskControlRecoveryDescriptor = {
    recoveryId: "task-recovery-stage-test",
    action,
    mode: "prepare_only",
    executionId: "execution-1",
    planId: "plan-1",
    route: route.kind,
    outcome: "failed",
    failureStage
  };
  const context: TaskRecoveryExecutionContext = {
    executionId: descriptor.executionId,
    command,
    mode: "active",
    route,
    ...(finderExecutionPlan ? { finderExecutionPlan } : {})
  };

  return { descriptor, context };
}
