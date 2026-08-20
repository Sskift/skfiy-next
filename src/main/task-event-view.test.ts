import { describe, expect, it } from "vitest";

import {
  createTaskEvent,
  readTurnReplayTaskEvent,
  withRouteTaskEventMetadata
} from "./task-event-view";
import type { FinderTaskEvent } from "./orchestrator/finder-task";

describe("task event route metadata", () => {
  it("adds route-policy metadata for confirmation-gated routes", () => {
    expect(withRouteTaskEventMetadata({
      status: "needs_confirmation",
      message: "Route policy requires confirmation before continuing with Ghostty.",
      command: "run pwd"
    }, {
      kind: "needs_confirmation",
      reason: "Route policy requires confirmation before continuing with Ghostty.",
      targetRoute: {
        kind: "ghostty",
        bundleId: "com.mitchellh.ghostty"
      }
    })).toMatchObject({
      route: "ghostty",
      routeReason: "Route policy requires confirmation before continuing with Ghostty.",
      policyKind: "route-policy",
      routeOutcome: {
        kind: "needs_confirmation",
        value: "needs_confirmation",
        routeLabel: "ghostty",
        source: "task-event",
        policyKind: "route-policy"
      }
    });
  });

  it("preserves clarification status and route reason in replay task events", () => {
    const event = withRouteTaskEventMetadata({
      status: "needs_clarification",
      message: "No supported desktop control route matched this request. 请明确目标应用和动作。"
    }, {
      kind: "needs_clarification",
      reason: "No supported desktop control route matched this request."
    });

    expect(event).toMatchObject({
      status: "needs_clarification",
      routeReason: "No supported desktop control route matched this request."
    });
    expect(readTurnReplayTaskEvent(event)).toMatchObject({
      status: "needs_clarification",
      routeReason: "No supported desktop control route matched this request.",
      routeOutcome: {
        kind: "needs_clarification",
        value: "needs_clarification",
        source: "task-event"
      }
    });
  });

  it("preserves explicit app-policy denial metadata in replay task events without leaking tokens", () => {
    const event = withRouteTaskEventMetadata({
      status: "blocked",
      message: "Ghostty is blocked by policy with token=event-secret.",
      command: "run pwd"
    }, {
      kind: "ghostty",
      bundleId: "com.mitchellh.ghostty"
    }, {
      routeReason: "Ghostty is denied by configured app policy with token=event-secret.",
      denialKind: "app_policy",
      policyKind: "app-policy"
    });

    expect(event).toMatchObject({
      route: "ghostty",
      routeReason: "Ghostty is denied by configured app policy with token=event-secret.",
      denialKind: "app_policy",
      policyKind: "app-policy"
    });
    expect(readTurnReplayTaskEvent(event)).toMatchObject({
      status: "blocked",
      route: "ghostty",
      routeReason: "Ghostty is denied by configured app policy with token=event-secret.",
      denialKind: "app_policy",
      policyKind: "app-policy",
      routeOutcome: {
        kind: "app_policy_denied",
        detail: "Ghostty is denied by configured app policy with token=[redacted]",
        routeLabel: "ghostty",
        source: "task-event",
        denialKind: "app_policy",
        policyKind: "app-policy"
      }
    });
  });

  it("preserves stop-turn behavior in replay task events", () => {
    expect(readTurnReplayTaskEvent({
      status: "cancelled",
      message: "Task stopped.",
      stopTurnBehavior: {
        afterStatus: "cancelled",
        afterMessage: "Task stopped."
      }
    })).toMatchObject({
      status: "cancelled",
      message: "Task stopped.",
      stopTurnBehavior: {
        afterStatus: "cancelled",
        afterMessage: "Task stopped."
      }
    });
  });

  it("maps the Finder task result from a completed Finder event", () => {
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

    const event: FinderTaskEvent = {
      type: "completed",
      command: "/tmp/work",
      summary: "5 of 6 operations completed, 1 failed.",
      result
    };

    expect(createTaskEvent(event, "active")).toMatchObject({
      status: "completed",
      message: "5 of 6 operations completed, 1 failed.",
      finderTaskResult: result
    });
  });

  it("does not attach a Finder result to non-Finder completed events", () => {
    const event = {
      type: "completed" as const,
      command: "pwd",
      summary: "Command completed in Ghostty."
    };

    const taskEvent = createTaskEvent(event, "active");
    expect(taskEvent.status).toBe("completed");
    expect(taskEvent).not.toHaveProperty("finderTaskResult");
  });
});

describe("chrome workflow task events", () => {
  it("maps workflow confirmation to needs_confirmation with a value-free preview", () => {
    const taskEvent = createTaskEvent({
      type: "workflow_confirmation_required",
      command: "search workflow",
      preview: {
        planId: "chrome-workflow-test",
        stepCount: 2,
        steps: [
          { stepKind: "fill", selector: "#query", risk: "medium" },
          { stepKind: "submit", selector: "#go", risk: "high" }
        ],
        maxSteps: 12
      },
      reason: "Confirm a 2-step Chrome workflow (2 mutating steps) with value-free selectors only."
    }, "active");

    expect(taskEvent).toMatchObject({
      status: "needs_confirmation",
      message: "Chrome workflow confirmation required: Confirm a 2-step Chrome workflow (2 mutating steps) with value-free selectors only.",
      command: "search workflow"
    });
    expect(taskEvent.chromeWorkflowPreview?.stepCount).toBe(2);
  });

  it("maps navigation and reload detections to executing recovery messages", () => {
    expect(createTaskEvent({
      type: "navigation_detected",
      fromUrl: "https://example.com/form",
      toUrl: "https://example.com/results",
      stepIndex: 1,
      reason: "The workflow re-bound to the new page and continues."
    }, "active")).toMatchObject({
      status: "executing",
      message: "Chrome page navigated from https://example.com/form to https://example.com/results at step 1; re-binding. The workflow re-bound to the new page and continues."
    });

    expect(createTaskEvent({
      type: "page_reload_detected",
      url: "https://example.com/form",
      stepIndex: 2,
      reason: "The workflow re-observed the reloaded page."
    }, "active")).toMatchObject({
      status: "executing",
      message: "Chrome page reloaded at https://example.com/form step 2; re-observing. The workflow re-observed the reloaded page."
    });
  });

  it("maps new tab and auth wall detections to blocked", () => {
    expect(createTaskEvent({
      type: "new_tab_detected",
      tabUrl: "https://example.com/new-tab",
      stepIndex: 1,
      reason: "Chrome opened 1 new tab after the last action; re-bind to the new tab or stay on the original."
    }, "active").status).toBe("blocked");

    const authWall = createTaskEvent({
      type: "auth_wall_detected",
      url: "https://example.com/login",
      reason: "Chrome page shows an auth wall: credential_or_otp_prompt.",
      safetyFindings: [{ kind: "credential_or_otp_prompt", severity: "high" }]
    }, "active");
    expect(authWall.status).toBe("blocked");
    expect(authWall.message).toContain("credential_or_otp_prompt");
  });

  it("maps DOM verification evidence to verifying and failed", () => {
    expect(createTaskEvent({
      type: "dom_verification_passed",
      stepIndex: 2,
      selector: "#results",
      expected: "element visible",
      actual: "visible"
    }, "active")).toMatchObject({
      status: "verifying",
      message: "DOM verification passed for #results: expected element visible, actual visible."
    });

    expect(createTaskEvent({
      type: "dom_verification_failed",
      stepIndex: 2,
      selector: "#results",
      expected: "element visible",
      actual: "hidden"
    }, "active")).toMatchObject({
      status: "failed",
      message: "DOM verification failed for #results: expected element visible, actual hidden."
    });
  });

  it("maps workflow step lifecycle and download events", () => {
    expect(createTaskEvent({
      type: "workflow_step_started",
      stepIndex: 0,
      stepKind: "observe"
    }, "active")).toMatchObject({
      status: "executing",
      message: "Chrome workflow step 0 (observe) started."
    });

    expect(createTaskEvent({
      type: "workflow_step_completed",
      stepIndex: 1,
      stepKind: "click",
      status: "passed"
    }, "active")).toMatchObject({
      status: "verifying",
      message: "Chrome workflow step 1 (click) passed."
    });

    expect(createTaskEvent({
      type: "download_detected",
      downloadUrl: "cdn.example.com",
      stepIndex: 1,
      reason: "Chrome triggered 1 download after the last action; the page content may be stale."
    }, "active")).toMatchObject({
      status: "executing",
      message: "Chrome download detected from cdn.example.com at step 1. Chrome triggered 1 download after the last action; the page content may be stale."
    });
  });
});
