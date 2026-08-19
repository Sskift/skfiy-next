import { describe, expect, it } from "vitest";

import { createTaskEventRouteMetadata } from "./task-event-route-metadata";

describe("task event route metadata", () => {
  it("labels executable routes without adding policy metadata", () => {
    expect(createTaskEventRouteMetadata({
      kind: "finder",
      bundleId: "com.apple.finder"
    })).toEqual({
      route: "finder"
    });
  });

  it("derives route-policy metadata for confirmation-gated routes", () => {
    expect(createTaskEventRouteMetadata({
      kind: "needs_confirmation",
      reason: "Route policy requires confirmation before continuing with Chrome.",
      targetRoute: {
        kind: "chrome",
        bundleId: "com.google.Chrome"
      }
    })).toEqual({
      route: "chrome",
      routeReason: "Route policy requires confirmation before continuing with Chrome.",
      policyKind: "route-policy"
    });
  });

  it("derives route-policy metadata for blocked target routes", () => {
    expect(createTaskEventRouteMetadata({
      kind: "blocked",
      reason: "Route policy blocks destructive or sensitive terminal commands before Computer Use.",
      targetRoute: {
        kind: "ghostty",
        bundleId: "com.mitchellh.ghostty"
      }
    })).toEqual({
      route: "ghostty",
      routeReason: "Route policy blocks destructive or sensitive terminal commands before Computer Use.",
      policyKind: "route-policy"
    });
  });

  it("marks user-denied route metadata distinctly", () => {
    expect(createTaskEventRouteMetadata({
      kind: "denied",
      reason: "User denied this desktop control request.",
      targetRoute: {
        kind: "ghostty",
        bundleId: "com.mitchellh.ghostty"
      }
    })).toEqual({
      route: "ghostty",
      routeReason: "User denied this desktop control request.",
      denialKind: "user"
    });
  });

  it("preserves explicit app-policy and host-policy overrides", () => {
    expect(createTaskEventRouteMetadata({
      kind: "chrome",
      bundleId: "com.google.Chrome"
    }, {
      routeReason: "Chrome host policy blocked this approved task: blocked.example",
      denialKind: "app_policy",
      policyKind: "chrome-host-policy"
    })).toEqual({
      route: "chrome",
      routeReason: "Chrome host policy blocked this approved task: blocked.example",
      denialKind: "app_policy",
      policyKind: "chrome-host-policy"
    });
  });
});
