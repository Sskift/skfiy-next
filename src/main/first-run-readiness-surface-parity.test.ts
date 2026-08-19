import { describe, expect, it } from "vitest";

import { createFirstRunReadinessController } from "./first-run-readiness";
import { createFirstRunReadinessFromStatus } from "./first-run-readiness-status";

describe("first-run readiness surface parity", () => {
  it("exposes the same canonical snapshot through the live controller and status adapter surfaces", async () => {
    const status = {
      backgroundAgent: {
        readiness: "binary-configured"
      },
      permissions: {
        screenRecording: "granted",
        accessibility: "granted",
        finderAutomation: "unknown"
      },
      desktopSession: {
        state: "controllable"
      },
      nativeHost: {
        state: "installed"
      },
      extension: {
        state: "connected",
        liveConnection: "connected",
        browserContext: {
          state: "ready"
        }
      },
      finder: {
        automation: {
          state: "proven-by-test"
        }
      }
    };
    const fromStatusAdapter = createFirstRunReadinessFromStatus(status);

    const controller = createFirstRunReadinessController({
      readProviderReadiness: async () => "binary-configured",
      testBackgroundAgentReadiness: async () => "chat-ready",
      readPermissions: async () => ({
        screenRecording: { state: "granted" },
        accessibility: { state: "granted" }
      }),
      readDesktopSession: async () => ({ state: "controllable" }),
      readBrowserReadiness: async () => ({
        nativeHostState: "installed",
        liveConnectionState: "connected",
        browserContextState: "ready",
        reason: "Browser Context is ready for the current Chrome page.",
        nextAction: "No setup action is required."
      }),
      testFinderAutomation: async () => ({
        state: "proven-by-test",
        code: "finder-automation-ready",
        reason: "skfiy read Finder selection without changing files.",
        nextAction: "Finder workflows are ready for planning and approval.",
        evidenceSource: "finder-selection-test",
        testedAt: "2026-08-19T00:00:00.000Z"
      })
    });
    const fromLiveController = await controller.testFinderAutomation();

    expect(fromLiveController).toEqual(fromStatusAdapter);
    expect(fromStatusAdapter).toMatchObject({
      chatReady: false,
      computerUseReady: true,
      readyWorkflows: ["computer-use", "finder", "browser-context"],
      resumeStepId: "background-agent"
    });
  });
});
