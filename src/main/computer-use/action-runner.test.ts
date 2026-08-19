import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopActionResultEvidence,
  DesktopActionVerificationError,
  runDesktopActionPlan,
  type DesktopActionExecutor
} from "./action-runner";
import type { DesktopAction, DesktopActionResult, DesktopExecutableAction } from "./types";

function createExecutor(
  responses: DesktopActionResult[] = []
): DesktopActionExecutor & { calls: DesktopExecutableAction[] } {
  const calls: DesktopExecutableAction[] = [];

  return {
    calls,
    executeAction: async (action) => {
      calls.push(action);
      return responses.shift() ?? { ok: true };
    }
  };
}

describe("runDesktopActionPlan", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes desktop actions in order and returns each step result", async () => {
    const executor = createExecutor([
      { ok: true, message: "activated" },
      { outputPath: "/tmp/shot.png" },
      { ok: true, message: "clicked" }
    ]);
    const actions: DesktopAction[] = [
      { type: "activate_app", bundleId: "com.mitchellh.ghostty" },
      { type: "screenshot", outputPath: "/tmp/shot.png" },
      { type: "click", x: 12, y: 34 }
    ];

    await expect(runDesktopActionPlan(executor, actions)).resolves.toEqual([
      {
        action: { type: "activate_app", bundleId: "com.mitchellh.ghostty" },
        result: { ok: true, message: "activated" }
      },
      {
        action: { type: "screenshot", outputPath: "/tmp/shot.png" },
        result: { outputPath: "/tmp/shot.png" }
      },
      {
        action: { type: "click", x: 12, y: 34 },
        result: { ok: true, message: "clicked" }
      }
    ]);
    expect(executor.calls).toEqual(actions);
  });

  it("runs step verification after executable actions and records passed decisions", async () => {
    const executor = createExecutor([
      { ok: true, message: "activated" },
      { ok: true, message: "clicked" }
    ]);
    const actions: DesktopAction[] = [
      { type: "activate_app", bundleId: "com.mitchellh.ghostty" },
      { type: "click", x: 12, y: 34 }
    ];
    const verified: string[] = [];

    await expect(runDesktopActionPlan(executor, actions, {
      verifyStep: ({ action, result, stepIndex, previousResults }) => {
        verified.push(`${stepIndex}:${action.type}:${"ok" in result ? result.ok : "result"}`);
        expect(previousResults).toHaveLength(stepIndex);
        return {
          status: "passed",
          message: `${action.type} verified`
        };
      }
    })).resolves.toEqual([
      {
        action: { type: "activate_app", bundleId: "com.mitchellh.ghostty" },
        result: { ok: true, message: "activated" },
        verification: { status: "passed", message: "activate_app verified" }
      },
      {
        action: { type: "click", x: 12, y: 34 },
        result: { ok: true, message: "clicked" },
        verification: { status: "passed", message: "click verified" }
      }
    ]);
    expect(verified).toEqual(["0:activate_app:true", "1:click:true"]);
  });

  it("collects app-agnostic result evidence when requested", async () => {
    const executor = createExecutor([
      {
        bundleId: "com.apple.finder",
        pid: 120,
        isRunning: true,
        isActive: true,
        screenshotPath: "/tmp/finder.png",
        frontmostBundleId: "com.apple.finder",
        windows: [
          { title: "Desktop", layer: 0, bounds: { x: 0, y: 0, width: 800, height: 600 } }
        ],
        ocrLabels: [
          { text: "Desktop", confidence: 0.91, bounds: { x: 12, y: 20, width: 80, height: 24 } }
        ]
      }
    ]);

    await expect(runDesktopActionPlan(executor, [
      {
        type: "observe_app",
        bundleId: "com.apple.finder",
        pid: 120,
        screenshotOutputPath: "/tmp/finder.png"
      }
    ], {
      collectEvidence: true
    })).resolves.toEqual([
      {
        action: {
          type: "observe_app",
          bundleId: "com.apple.finder",
          pid: 120,
          screenshotOutputPath: "/tmp/finder.png"
        },
        result: {
          bundleId: "com.apple.finder",
          pid: 120,
          isRunning: true,
          isActive: true,
          screenshotPath: "/tmp/finder.png",
          frontmostBundleId: "com.apple.finder",
          windows: [
            { title: "Desktop", layer: 0, bounds: { x: 0, y: 0, width: 800, height: 600 } }
          ],
          ocrLabels: [
            { text: "Desktop", confidence: 0.91, bounds: { x: 12, y: 20, width: 80, height: 24 } }
          ]
        },
        evidence: {
          actionType: "observe_app",
          target: {
            bundleId: "com.apple.finder",
            pid: 120
          },
          screenshotPath: "/tmp/finder.png",
          observed: {
            isRunning: true,
            isActive: true,
            frontmostBundleId: "com.apple.finder",
            windowCount: 1,
            ocrLabelCount: 1
          }
        }
      }
    ]);
  });

  it("stops before later actions when step verification asks for user confirmation", async () => {
    const executor = createExecutor([
      { ok: true, message: "clicked" },
      { ok: true, message: "typed" }
    ]);
    const actions: DesktopAction[] = [
      { type: "click", x: 12, y: 34 },
      { type: "type_text", text: "should not type" }
    ];

    await expect(runDesktopActionPlan(executor, actions, {
      verifyStep: ({ action }) => action.type === "click"
        ? {
            status: "needs_user_confirmation",
            reason: "Observed target moved after click."
          }
        : { status: "passed" }
    })).rejects.toMatchObject({
      name: "DesktopActionVerificationError",
      message: "Desktop action verification needs user confirmation after click: Observed target moved after click.",
      stepIndex: 0,
      action: { type: "click", x: 12, y: 34 },
      verification: {
        status: "needs_user_confirmation",
        reason: "Observed target moved after click."
      },
      partialResults: [
        {
          action: { type: "click", x: 12, y: 34 },
          result: { ok: true, message: "clicked" },
          verification: {
            status: "needs_user_confirmation",
            reason: "Observed target moved after click."
          }
        }
      ]
    } satisfies Partial<DesktopActionVerificationError>);
    expect(executor.calls).toEqual([{ type: "click", x: 12, y: 34 }]);
  });

  it("handles wait actions without invoking the executor", async () => {
    vi.useFakeTimers();
    const executor = createExecutor([{ ok: true, message: "typed" }]);
    const actions: DesktopAction[] = [
      { type: "type_text", text: "hello" },
      { type: "wait", ms: 25 },
      { type: "press_key", key: "enter" }
    ];

    const resultPromise = runDesktopActionPlan(executor, actions);
    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual([
      {
        action: { type: "type_text", text: "hello" },
        result: { ok: true, message: "typed" }
      },
      {
        action: { type: "wait", ms: 25 },
        result: { ok: true, waitedMs: 25 }
      },
      {
        action: { type: "press_key", key: "enter" },
        result: { ok: true }
      }
    ]);
    expect(executor.calls).toEqual([
      { type: "type_text", text: "hello" },
      { type: "press_key", key: "enter" }
    ]);
  });

  it("rejects invalid wait durations before invoking later actions", async () => {
    const executor = createExecutor();

    await expect(
      runDesktopActionPlan(executor, [
        { type: "wait", ms: Number.NaN },
        { type: "press_key", key: "enter" }
      ])
    ).rejects.toThrow("wait.ms must be a finite number.");
    await expect(runDesktopActionPlan(executor, [{ type: "wait", ms: -1 }])).rejects.toThrow(
      "wait.ms must be greater than or equal to 0."
    );
    await expect(runDesktopActionPlan(executor, [{ type: "wait", ms: 30001 }])).rejects.toThrow(
      "wait.ms must be less than or equal to 30000."
    );
    expect(executor.calls).toEqual([]);
  });

  it("throws a clear error when aborted before the next step starts", async () => {
    const executor = createExecutor([{ ok: true }]);
    const controller = new AbortController();

    await expect(
      runDesktopActionPlan(
        {
          executeAction: async (action) => {
            const result = await executor.executeAction(action);
            controller.abort("user stopped the plan");
            return result;
          }
        },
        [
          { type: "click", x: 1, y: 2 },
          { type: "press_key", key: "enter" }
        ],
        { signal: controller.signal }
      )
    ).rejects.toThrow("Desktop action plan aborted: user stopped the plan");
    expect(executor.calls).toEqual([{ type: "click", x: 1, y: 2 }]);
  });

  it("interrupts a wait when the signal is aborted", async () => {
    vi.useFakeTimers();
    const executor = createExecutor();
    const controller = new AbortController();

    const resultPromise = runDesktopActionPlan(
      executor,
      [
        { type: "wait", ms: 1000 },
        { type: "press_key", key: "enter" }
      ],
      { signal: controller.signal }
    );

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    await expect(resultPromise).rejects.toThrow("Desktop action plan aborted.");
    expect(executor.calls).toEqual([]);
  });
});

describe("createDesktopActionResultEvidence", () => {
  it("summarizes desktop session and helper action evidence without app-specific assumptions", () => {
    expect(createDesktopActionResultEvidence(
      { type: "activate_app", bundleId: "com.apple.TextEdit", pid: 330 },
      { ok: true, message: "activated" }
    )).toEqual({
      actionType: "activate_app",
      target: {
        bundleId: "com.apple.TextEdit",
        pid: 330
      },
      ok: true,
      message: "activated"
    });

    expect(createDesktopActionResultEvidence(
      { type: "screenshot", outputPath: "/tmp/shot.png" },
      {
        controllable: false,
        frontmostBundleId: "com.apple.loginwindow",
        frontmostProcessIdentifier: 591,
        mainDisplayAsleep: true
      }
    )).toEqual({
      actionType: "screenshot",
      desktopSession: {
        controllable: false,
        frontmostBundleId: "com.apple.loginwindow",
        frontmostProcessIdentifier: 591,
        mainDisplayAsleep: true
      }
    });
  });
});
