import {
  createFirstRunReadinessSnapshot,
  type FirstRunDesktopSessionState,
  type FirstRunPermissionState,
  type FirstRunProviderReadiness,
  type FirstRunReadinessSnapshot,
  type FirstRunReadinessStepId
} from "../shared/first-run-readiness.js";
import {
  createUnknownFinderAutomationReadiness,
  type FinderAutomationReadiness
} from "./main-finder-automation-readiness.js";
import type { BrowserReadinessEvidence } from "./main-browser-readiness.js";

export interface FirstRunReadinessControllerDependencies {
  readProviderReadiness: () => Promise<FirstRunProviderReadiness>;
  testBackgroundAgentReadiness: () => Promise<FirstRunProviderReadiness>;
  readPermissions: () => Promise<{
    screenRecording: { state: FirstRunPermissionState };
    accessibility: { state: FirstRunPermissionState };
  }>;
  readDesktopSession: () => Promise<{
    state: FirstRunDesktopSessionState;
    reason?: string;
  }>;
  readBrowserReadiness: () => Promise<BrowserReadinessEvidence>;
  testFinderAutomation: () => Promise<FinderAutomationReadiness>;
}

export interface FirstRunReadinessController {
  read: () => Promise<FirstRunReadinessSnapshot>;
  testBackgroundAgent: () => Promise<FirstRunReadinessSnapshot>;
  testFinderAutomation: () => Promise<FirstRunReadinessSnapshot>;
  resetBackgroundAgentTest: () => void;
}

export function createFirstRunReadinessController(
  dependencies: FirstRunReadinessControllerDependencies
): FirstRunReadinessController {
  let finderAutomation = createUnknownFinderAutomationReadiness();
  let previousResumeStepId: FirstRunReadinessStepId | undefined;
  let testedProviderReadiness: FirstRunProviderReadiness | undefined;
  let providerTestGeneration = 0;

  const refreshTestedFinderAutomation = async (): Promise<void> => {
    if (finderAutomation.evidenceSource !== "finder-selection-test") {
      return;
    }

    finderAutomation = await dependencies.testFinderAutomation();
  };

  const createSnapshot = async (
    providerReadiness: FirstRunProviderReadiness
  ): Promise<FirstRunReadinessSnapshot> => {
    const [permissions, desktopSession, browser] = await Promise.all([
      dependencies.readPermissions(),
      dependencies.readDesktopSession(),
      dependencies.readBrowserReadiness()
    ]);
    const snapshot = createFirstRunReadinessSnapshot({
      providerReadiness,
      permissions: {
        screenRecording: permissions.screenRecording.state,
        accessibility: permissions.accessibility.state
      },
      desktopSession,
      finderAutomation: {
        state: finderAutomation.state,
        reason: finderAutomation.reason,
        nextAction: finderAutomation.nextAction
      },
      chrome: {
        nativeHostState: browser.nativeHostState,
        liveConnectionState: normalizeChromeLiveConnectionState(browser.liveConnectionState),
        browserContext: {
          state: browser.browserContextState,
          reason: browser.reason,
          nextAction: browser.nextAction
        }
      },
      previousResumeStepId
    });

    previousResumeStepId = snapshot.resumeStepId ?? undefined;
    return snapshot;
  };

  return {
    async read() {
      await refreshTestedFinderAutomation();
      return createSnapshot(
        testedProviderReadiness ?? await dependencies.readProviderReadiness()
      );
    },
    async testBackgroundAgent() {
      const generation = ++providerTestGeneration;
      const readiness = await dependencies.testBackgroundAgentReadiness();
      await refreshTestedFinderAutomation();

      if (generation !== providerTestGeneration) {
        return createSnapshot(
          testedProviderReadiness ?? await dependencies.readProviderReadiness()
        );
      }

      testedProviderReadiness = readiness;
      return createSnapshot(readiness);
    },
    async testFinderAutomation() {
      finderAutomation = await dependencies.testFinderAutomation();
      return createSnapshot(
        testedProviderReadiness ?? await dependencies.readProviderReadiness()
      );
    },
    resetBackgroundAgentTest() {
      providerTestGeneration += 1;
      testedProviderReadiness = undefined;
    }
  };
}

function normalizeChromeLiveConnectionState(
  state: BrowserReadinessEvidence["liveConnectionState"]
): "connected" | "stale" | "disconnected" | "invalid" | "unknown" {
  return state === "connected" || state === "stale" || state === "invalid"
    ? state
    : state === "unknown"
      ? "unknown"
      : "disconnected";
}
