import { describe, expect, it } from "vitest";

import {
  assertNoHostPolicyBroadening,
  diffAppPolicyBroadening,
  diffHostPolicyBroadening,
  isAppPolicyBroadening
} from "./profile-policy-guard";

describe("profile policy guard", () => {
  it("flags ask/deny to allow movements as app-policy broadening", () => {
    const broadenings = diffAppPolicyBroadening(
      {
        apps: [
          { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" },
          { name: "Finder", bundleId: "com.apple.finder", policy: "deny" }
        ]
      },
      {
        apps: [
          { name: "Chrome", bundleId: "com.google.Chrome", policy: "allow" },
          { name: "Finder", bundleId: "com.apple.finder", policy: "ask" }
        ]
      }
    );

    expect(broadenings).toEqual([
      {
        kind: "app-policy",
        target: "com.google.Chrome",
        targetName: "Chrome",
        from: "ask",
        to: "allow"
      },
      {
        kind: "app-policy",
        target: "com.apple.finder",
        targetName: "Finder",
        from: "deny",
        to: "ask"
      }
    ]);
  });

  it("treats a brand-new app introduced as allow as broadening because unknown apps default to ask", () => {
    const broadenings = diffAppPolicyBroadening(
      { apps: [] },
      {
        apps: [
          { name: "Slack", bundleId: "com.tinyspeck.slackmacgap", policy: "allow" }
        ]
      }
    );

    expect(broadenings).toEqual([
      {
        kind: "app-policy",
        target: "com.tinyspeck.slackmacgap",
        targetName: "Slack",
        from: "ask",
        to: "allow"
      }
    ]);
  });

  it("does not flag narrowing or unchanged app policy", () => {
    const broadenings = diffAppPolicyBroadening(
      {
        apps: [
          { name: "Chrome", bundleId: "com.google.Chrome", policy: "allow" },
          { name: "Finder", bundleId: "com.apple.finder", policy: "ask" }
        ]
      },
      {
        apps: [
          { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" },
          { name: "Finder", bundleId: "com.apple.finder", policy: "ask" },
          { name: "Slack", bundleId: "com.tinyspeck.slackmacgap", policy: "deny" }
        ]
      }
    );

    expect(broadenings).toEqual([]);
  });

  it("ranks policy movements correctly", () => {
    expect(isAppPolicyBroadening("ask", "allow")).toBe(true);
    expect(isAppPolicyBroadening("deny", "ask")).toBe(true);
    expect(isAppPolicyBroadening("deny", "allow")).toBe(true);
    expect(isAppPolicyBroadening("allow", "ask")).toBe(false);
    expect(isAppPolicyBroadening("ask", "deny")).toBe(false);
    expect(isAppPolicyBroadening("allow", "allow")).toBe(false);
  });

  it("flags newly allowed hosts as host-policy broadening", () => {
    const broadenings = diffHostPolicyBroadening(
      { allowedHosts: ["example.com"], blockedHosts: ["evil.example"] },
      {
        allowedHosts: ["example.com", "docs.example", "evil.example"],
        blockedHosts: []
      }
    );

    expect(broadenings).toEqual([
      { kind: "host-policy", host: "docs.example", from: "ask", to: "allow" },
      { kind: "host-policy", host: "evil.example", from: "blocked", to: "allow" }
    ]);
  });

  it("assertNoHostPolicyBroadening throws only when a host was newly allowed", () => {
    expect(() =>
      assertNoHostPolicyBroadening(
        { allowedHosts: ["example.com"], blockedHosts: [] },
        { allowedHosts: ["example.com"], blockedHosts: ["evil.example"] }
      )
    ).not.toThrow();

    expect(() =>
      assertNoHostPolicyBroadening(
        { allowedHosts: [], blockedHosts: [] },
        { allowedHosts: ["example.com"], blockedHosts: [] }
      )
    ).toThrow(/example\.com/);
  });
});
