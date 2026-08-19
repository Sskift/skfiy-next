import { describe, expect, it } from "vitest";

import { createRunCommandRouteDecision } from "./main-command-routing";
import {
  CHROME_BUNDLE_ID,
  FINDER_BUNDLE_ID,
  GHOSTTY_BUNDLE_ID,
  type CommandRoute
} from "./task-routing";

describe("createRunCommandRouteDecision", () => {
  it("keeps chat routed through assistant chat handling even when the assistant turn failed", () => {
    expect(createRunCommandRouteDecision({
      approved: false,
      assistantTurnStatus: "failed",
      route: {
        kind: "chat",
        reason: "Conversational prompt should be answered by the assistant instead of typed into Ghostty."
      }
    })).toEqual({
      kind: "chat",
      route: {
        kind: "chat",
        reason: "Conversational prompt should be answered by the assistant instead of typed into Ghostty."
      }
    });
  });

  it("preserves route-level clarification, denial, and block states even when the assistant turn failed", () => {
    expect(createRunCommandRouteDecision({
      approved: false,
      assistantTurnStatus: "failed",
      route: {
        kind: "needs_clarification",
        reason: "Generic visible-app control is not a supported product route yet."
      }
    })).toMatchObject({
      kind: "needs_clarification",
      route: {
        kind: "needs_clarification"
      }
    });

    expect(createRunCommandRouteDecision({
      approved: false,
      assistantTurnStatus: "cancelled",
      route: {
        kind: "denied",
        reason: "User denied this desktop control request.",
        targetRoute: {
          kind: "chrome",
          bundleId: CHROME_BUNDLE_ID
        }
      }
    })).toMatchObject({
      kind: "terminal_route_state",
      route: {
        kind: "denied",
        targetRoute: {
          kind: "chrome"
        }
      }
    });

    expect(createRunCommandRouteDecision({
      approved: false,
      assistantTurnStatus: "failed",
      route: {
        kind: "blocked",
        reason: "Route policy blocks destructive or sensitive terminal commands before Computer Use.",
        targetRoute: {
          kind: "ghostty",
          bundleId: GHOSTTY_BUNDLE_ID
        }
      }
    })).toMatchObject({
      kind: "terminal_route_state",
      route: {
        kind: "blocked",
        targetRoute: {
          kind: "ghostty"
        }
      }
    });
  });

  it("stops executable non-chat routes when the assistant turn did not complete", () => {
    const route: CommandRoute = {
      kind: "finder",
      bundleId: FINDER_BUNDLE_ID
    };

    expect(createRunCommandRouteDecision({
      approved: false,
      assistantTurnStatus: "cancelled",
      route
    })).toEqual({
      kind: "assistant_failed",
      route
    });
  });

  it("keeps clarification and terminal route states before Computer Use execution", () => {
    expect(createRunCommandRouteDecision({
      approved: false,
      assistantTurnStatus: "completed",
      route: {
        kind: "needs_clarification",
        reason: "No supported desktop control route matched this request."
      }
    })).toMatchObject({
      kind: "needs_clarification",
      route: {
        kind: "needs_clarification"
      }
    });

    expect(createRunCommandRouteDecision({
      approved: false,
      assistantTurnStatus: "completed",
      route: {
        kind: "blocked",
        reason: "Route policy blocks destructive or sensitive terminal commands before Computer Use.",
        targetRoute: {
          kind: "ghostty",
          bundleId: GHOSTTY_BUNDLE_ID
        }
      }
    })).toMatchObject({
      kind: "terminal_route_state",
      route: {
        kind: "blocked",
        targetRoute: {
          kind: "ghostty"
        }
      }
    });
  });

  it("keeps confirmation routes gated until approval", () => {
    const route: CommandRoute = {
      kind: "needs_confirmation",
      reason: "Route policy requires confirmation before continuing with Chrome.",
      targetRoute: {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      }
    };

    expect(createRunCommandRouteDecision({
      approved: false,
      assistantTurnStatus: "completed",
      route
    })).toEqual({
      kind: "needs_confirmation",
      route,
      executionRoute: {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      }
    });

    expect(createRunCommandRouteDecision({
      approved: true,
      assistantTurnStatus: "completed",
      route
    })).toEqual({
      kind: "continue",
      route: {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      },
      executionRoute: {
        kind: "chrome",
        bundleId: CHROME_BUNDLE_ID
      }
    });
  });

  it("continues executable routes directly after a completed assistant turn", () => {
    expect(createRunCommandRouteDecision({
      approved: false,
      assistantTurnStatus: "completed",
      route: {
        kind: "finder",
        bundleId: FINDER_BUNDLE_ID
      }
    })).toEqual({
      kind: "continue",
      route: {
        kind: "finder",
        bundleId: FINDER_BUNDLE_ID
      },
      executionRoute: {
        kind: "finder",
        bundleId: FINDER_BUNDLE_ID
      }
    });
  });
});
