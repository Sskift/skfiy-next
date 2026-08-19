import { describe, expect, it } from "vitest";

import {
  readTurnReplayTaskEvent,
  withRouteTaskEventMetadata
} from "./task-event-view";

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
});
