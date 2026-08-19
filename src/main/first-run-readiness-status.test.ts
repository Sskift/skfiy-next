import { describe, expect, it } from "vitest";

import { createFirstRunReadinessFromStatus } from "./first-run-readiness-status";

describe("first-run readiness status adapter", () => {
  it("normalizes the same status evidence for every first-run surface", () => {
    const status = {
      backgroundAgent: { readiness: "binary-configured" },
      permissions: {
        screenRecording: "granted",
        accessibility: "unknown",
        finderAutomation: "unknown"
      },
      desktopSession: {
        state: "unknown",
        reason: "Desktop session has not been checked."
      },
      finder: {
        automation: {
          state: "blocked-by-permission",
          reason: "macOS denied Finder Automation.",
          nextAction: "Open Automation settings."
        }
      },
      nativeHost: { state: "installed" },
      extension: {
        state: "connected",
        liveConnection: "connected",
        pageControl: {
          state: "blocked_by_host_policy",
          reason: "Host policy blocked this page.",
          nextAction: "Approve the current host."
        }
      }
    };

    expect(createFirstRunReadinessFromStatus(status)).toEqual(
      createFirstRunReadinessFromStatus({ ...status })
    );
    expect(createFirstRunReadinessFromStatus(status)).toMatchObject({
      chatReady: false,
      computerUseReady: false,
      resumeStepId: "background-agent",
      steps: [
        { id: "background-agent", state: "action-required" },
        { id: "screen-recording", state: "ready" },
        { id: "accessibility", state: "unknown" },
        { id: "finder-automation", state: "blocked" },
        { id: "browser-context", state: "blocked" }
      ]
    });
  });

  it("does not promote unknown Finder permission or Chrome connection evidence", () => {
    const snapshot = createFirstRunReadinessFromStatus({
      backgroundAgent: { readiness: "chat-ready" },
      permissions: {
        screenRecording: "granted",
        accessibility: "granted",
        finderAutomation: "unknown"
      },
      desktopSession: { state: "controllable" },
      nativeHost: { state: "installed" },
      extension: { state: "unknown", liveConnection: "unknown" }
    });

    expect(snapshot.chatReady).toBe(true);
    expect(snapshot.steps.find((step) => step.id === "finder-automation")?.state).toBe("unknown");
    expect(snapshot.steps.find((step) => step.id === "browser-context")?.state).toBe("unknown");
  });

  it("accepts only concrete Finder smoke proof as ready evidence", () => {
    expect(createFirstRunReadinessFromStatus({
      finder: {
        automation: {
          state: "proven-by-smoke"
        },
        latestSmoke: { stale: false, automationEvidence: "proven" }
      }
    }).steps.find((step) => step.id === "finder-automation")?.state).toBe("ready");
  });

  it("does not promote stale smoke or legacy granted labels to Finder readiness", () => {
    const stale = createFirstRunReadinessFromStatus({
      finder: {
        automation: { state: "proven-by-smoke" },
        latestSmoke: { stale: true, automationEvidence: "proven" }
      }
    });
    const legacyGranted = createFirstRunReadinessFromStatus({
      finder: {
        automation: { state: "granted" }
      }
    });

    expect(stale.steps.find((step) => step.id === "finder-automation")?.state).toBe("unknown");
    expect(legacyGranted.steps.find((step) => step.id === "finder-automation")?.state)
      .toBe("unknown");
  });

  it("requires smoke freshness and matching Automation proof", () => {
    const contradictory = createFirstRunReadinessFromStatus({
      finder: {
        automation: { state: "proven-by-smoke" },
        latestSmoke: { stale: false, automationEvidence: "blocked" }
      }
    });

    expect(contradictory.steps.find((step) => step.id === "finder-automation")?.state)
      .toBe("unknown");
  });
});
