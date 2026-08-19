import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_READINESS_STEP_ORDER,
  createFirstRunReadinessSnapshot,
  type FirstRunReadinessInput
} from "./first-run-readiness";

function createInput(
  overrides: Partial<FirstRunReadinessInput> = {}
): FirstRunReadinessInput {
  return {
    providerReadiness: "chat-ready",
    permissions: {
      screenRecording: "granted",
      accessibility: "granted"
    },
    desktopSession: {
      state: "controllable"
    },
    finderAutomation: {
      state: "proven-by-test"
    },
    chrome: {
      nativeHostState: "installed",
      liveConnectionState: "connected",
      browserContext: {
        state: "ready"
      }
    },
    ...overrides
  };
}

describe("createFirstRunReadinessSnapshot", () => {
  it("keeps normal chat ready when all optional and Computer Use evidence is unknown", () => {
    const snapshot = createFirstRunReadinessSnapshot({
      providerReadiness: "chat-ready"
    });

    expect(snapshot.chatReady).toBe(true);
    expect(snapshot.computerUseReady).toBe(false);
    expect(snapshot.readyWorkflows).toEqual(["chat"]);
    expect(snapshot.resumeStepId).toBe("screen-recording");
    expect(snapshot.steps).toEqual([
      {
        id: "background-agent",
        requirement: "required-for-chat",
        state: "ready"
      },
      {
        id: "screen-recording",
        requirement: "computer-use",
        state: "unknown",
        reason: "Screen Recording permission has not been checked.",
        nextAction: "Refresh macOS permission status."
      },
      {
        id: "accessibility",
        requirement: "computer-use",
        state: "unknown",
        reason: "Accessibility permission has not been checked.",
        nextAction: "Refresh macOS permission status."
      },
      {
        id: "finder-automation",
        requirement: "optional",
        state: "unknown",
        reason: "Finder Automation readiness has not been proven by a test.",
        nextAction: "Run the Finder Automation readiness test."
      },
      {
        id: "browser-context",
        requirement: "optional",
        state: "unknown",
        reason: "Chrome Native Messaging host status is unknown.",
        nextAction: "Refresh Chrome setup status."
      }
    ]);
  });

  it("never treats unknown permission or desktop-session evidence as ready", () => {
    const unknownPermissions = createFirstRunReadinessSnapshot(createInput({
      permissions: {
        screenRecording: "unknown",
        accessibility: "unknown"
      }
    }));
    const unknownSession = createFirstRunReadinessSnapshot(createInput({
      desktopSession: {
        state: "unknown",
        reason: "Desktop session probe has not returned."
      }
    }));

    expect(unknownPermissions.steps.slice(1, 3).map((step) => step.state)).toEqual([
      "unknown",
      "unknown"
    ]);
    expect(unknownPermissions.computerUseReady).toBe(false);
    expect(unknownSession.steps.find((step) => step.id === "accessibility")).toEqual({
      id: "accessibility",
      requirement: "computer-use",
      state: "unknown",
      reason: "Desktop session probe has not returned.",
      nextAction: "Refresh desktop session status before using Computer Use."
    });
    expect(unknownSession.computerUseReady).toBe(false);
  });

  it("keeps an authentication failure as an exact Background Agent blocker", () => {
    const snapshot = createFirstRunReadinessSnapshot(createInput({
      providerReadiness: "auth-or-permission-blocked"
    }));

    expect(snapshot.chatReady).toBe(false);
    expect(snapshot.steps[0]).toEqual({
      id: "background-agent",
      requirement: "required-for-chat",
      state: "blocked",
      reason: "Background Agent authentication or permission is blocked.",
      nextAction: "Sign in to the selected Background Agent, then retry the safe test turn."
    });
    expect(snapshot.readyWorkflows).not.toContain("chat");
    expect(snapshot.resumeStepId).toBe("background-agent");
  });

  it("accepts a successful Finder test as stronger readiness evidence", () => {
    const snapshot = createFirstRunReadinessSnapshot(createInput({
      chrome: undefined
    }));

    expect(snapshot.steps.find((step) => step.id === "finder-automation")).toEqual({
      id: "finder-automation",
      requirement: "optional",
      state: "ready"
    });
    expect(snapshot.computerUseReady).toBe(true);
    expect(snapshot.readyWorkflows).toEqual(["chat", "computer-use", "finder"]);
  });

  it.each([
    {
      liveConnectionState: "stale" as const,
      reason: "Chrome extension connection is stale.",
      nextAction: "Refresh the skfiy Chrome extension connection."
    },
    {
      liveConnectionState: "disconnected" as const,
      reason: "Chrome extension is not connected.",
      nextAction: "Open Chrome and connect the skfiy extension."
    }
  ])("does not claim Browser Context is ready for a $liveConnectionState connection", ({
    liveConnectionState,
    reason,
    nextAction
  }) => {
    const snapshot = createFirstRunReadinessSnapshot(createInput({
      chrome: {
        nativeHostState: "installed",
        liveConnectionState,
        browserContext: {
          state: "ready"
        }
      }
    }));

    expect(snapshot.steps[4]).toEqual({
      id: "browser-context",
      requirement: "optional",
      state: "blocked",
      reason,
      nextAction
    });
    expect(snapshot.readyWorkflows).not.toContain("browser-context");
    expect(snapshot.chatReady).toBe(true);
  });

  it.each([
    {
      state: "blocked_by_host_policy" as const,
      reason: "The active host is blocked by skfiy host policy.",
      nextAction: "Approve the active host for the current turn."
    },
    {
      state: "blocked_by_chrome_host_permission" as const,
      reason: "Chrome has not granted site access for the active page.",
      nextAction: "Grant site access from the skfiy extension popup."
    }
  ])("preserves the exact $state Browser Context recovery pair", ({
    state,
    reason,
    nextAction
  }) => {
    const snapshot = createFirstRunReadinessSnapshot(createInput({
      chrome: {
        nativeHostState: "installed",
        liveConnectionState: "connected",
        browserContext: {
          state,
          reason,
          nextAction
        }
      }
    }));

    expect(snapshot.steps[4]).toEqual({
      id: "browser-context",
      requirement: "optional",
      state: "blocked",
      reason,
      nextAction
    });
  });

  it("uses a deterministic resume order while retaining a still-incomplete previous step", () => {
    expect(FIRST_RUN_READINESS_STEP_ORDER).toEqual([
      "background-agent",
      "screen-recording",
      "accessibility",
      "finder-automation",
      "browser-context"
    ]);

    const firstIncomplete = createFirstRunReadinessSnapshot({
      providerReadiness: "binary-found"
    });
    const retained = createFirstRunReadinessSnapshot({
      providerReadiness: "chat-ready",
      previousResumeStepId: "browser-context"
    });
    const advanced = createFirstRunReadinessSnapshot(createInput({
      previousResumeStepId: "background-agent",
      finderAutomation: {
        state: "unknown"
      }
    }));

    expect(firstIncomplete.resumeStepId).toBe("background-agent");
    expect(retained.resumeStepId).toBe("browser-context");
    expect(advanced.resumeStepId).toBe("finder-automation");
  });

  it("returns exactly one reason and next action for every non-ready step", () => {
    const snapshot = createFirstRunReadinessSnapshot({});

    for (const step of snapshot.steps) {
      if (step.state === "ready") {
        expect(step).not.toHaveProperty("reason");
        expect(step).not.toHaveProperty("nextAction");
        continue;
      }

      expect(typeof step.reason).toBe("string");
      expect(step.reason.length).toBeGreaterThan(0);
      expect(typeof step.nextAction).toBe("string");
      expect(step.nextAction.length).toBeGreaterThan(0);
    }
  });

  it("omits page text, local paths, and secrets from the canonical output", () => {
    const browserContext = {
      state: "blocked_by_host_policy" as const,
      reason: "Policy file /Users/alice/.skfiy/policy.json contains token=super-secret.",
      nextAction: "Open file:///Users/alice/.skfiy/policy.json with Bearer abc.def.ghi.",
      visibleText: "private raw page body",
      url: "https://example.test/private?api_key=secret",
      manifestPath: "/Users/alice/Library/NativeMessagingHosts/skfiy.json"
    };
    const snapshot = createFirstRunReadinessSnapshot(createInput({
      chrome: {
        nativeHostState: "installed",
        liveConnectionState: "connected",
        browserContext
      }
    }));
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("private raw page body");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("api_key=secret");
    expect(serialized).not.toContain("manifestPath");
    expect(serialized).toContain("[local path]");
    expect(serialized).toContain("[redacted]");
  });
});
