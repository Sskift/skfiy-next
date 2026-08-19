import { describe, expect, it } from "vitest";

import { createPendingApproval } from "./main-pending-approval";
import {
  createStopTaskEventDecision,
  STOP_TASK_MESSAGE
} from "./main-stop-task";
import { CHROME_BUNDLE_ID, FINDER_BUNDLE_ID } from "./task-routing";

describe("main stop task helper", () => {
  it("prefers pending approval routes for stopped task replay decisions", () => {
    const activeRoute = {
      kind: "chrome",
      bundleId: CHROME_BUNDLE_ID
    } as const;
    const pendingRoute = {
      kind: "finder",
      bundleId: FINDER_BUNDLE_ID
    } as const;
    const pendingApproval = createPendingApproval(
      "organize Downloads",
      "active",
      {
        turnId: "turn-stop-pending",
        toolCallId: "tool-stop-pending"
      },
      pendingRoute
    );

    expect(createStopTaskEventDecision({
      activeRoute,
      pendingApproval
    })).toMatchObject({
      cancellationReason: STOP_TASK_MESSAGE,
      delivery: "turn-replay",
      route: pendingRoute,
      event: {
        status: "cancelled",
        message: "Task stopped.",
        route: "finder",
        routeReason: "Task stopped.",
        routeOutcome: {
          kind: "stopped",
          value: "stopped",
          routeLabel: "finder",
          source: "task-event"
        },
        stopTurnBehavior: {
          afterStatus: "cancelled",
          afterMessage: "Task stopped."
        }
      }
    });
  });

  it("uses the active route for stopped task replay decisions when approval is not pending", () => {
    const activeRoute = {
      kind: "chrome",
      bundleId: CHROME_BUNDLE_ID
    } as const;

    expect(createStopTaskEventDecision({
      activeRoute,
      pendingApproval: null
    })).toMatchObject({
      cancellationReason: STOP_TASK_MESSAGE,
      delivery: "turn-replay",
      route: activeRoute,
      event: {
        status: "cancelled",
        message: "Task stopped.",
        route: "chrome",
        routeOutcome: {
          kind: "stopped",
          value: "stopped",
          routeLabel: "chrome",
          source: "task-event"
        }
      }
    });
  });

  it("keeps no-route stop events transient without inventing route metadata", () => {
    expect(createStopTaskEventDecision({
      activeRoute: null,
      pendingApproval: null
    })).toEqual({
      cancellationReason: STOP_TASK_MESSAGE,
      delivery: "transient",
      route: null,
      event: {
        status: "cancelled",
        message: "Task stopped.",
        stopTurnBehavior: {
          afterStatus: "cancelled",
          afterMessage: "Task stopped."
        }
      }
    });
  });
});
