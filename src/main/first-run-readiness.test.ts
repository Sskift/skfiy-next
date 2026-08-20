import { describe, expect, it, vi } from "vitest";

import { createFirstRunReadinessController } from "./first-run-readiness";

function createDependencies() {
  return {
    readProviderReadiness: vi.fn().mockResolvedValue("version-ok" as const),
    testBackgroundAgentReadiness: vi.fn().mockResolvedValue("chat-ready" as const),
    readPermissions: vi.fn().mockResolvedValue({
      screenRecording: { state: "unknown" as const },
      accessibility: { state: "unknown" as const }
    }),
    readDesktopSession: vi.fn().mockResolvedValue({
      state: "unknown" as const,
      reason: "Desktop session status is unknown."
    }),
    readBrowserReadiness: vi.fn().mockResolvedValue({
      nativeHostState: "missing" as const,
      liveConnectionState: "unknown" as const,
      browserContextState: "missing" as const,
      reason: "Chrome Native Messaging host is not installed.",
      nextAction: "Open Browser setup and install the Chrome native host."
    }),
    testFinderAutomation: vi.fn().mockResolvedValue({
      state: "proven-by-test" as const,
      code: "finder-automation-ready" as const,
      reason: "skfiy read Finder selection without changing files.",
      nextAction: "Finder workflows are ready for planning and approval.",
      evidenceSource: "finder-selection-test" as const
    }),
    readChromeCompatibility: vi.fn().mockResolvedValue({
      schemaVersion: 1 as const,
      generatedAt: "2026-01-01T00:00:00.000Z",
      appVersion: "0.1.0",
      nativeHost: { state: "unknown" as const, installedSkfiyVersion: null, reason: "" },
      extension: { state: "unknown" as const, version: null, source: "unknown" },
      compatibility: {
        state: "unknown" as const,
        appVersion: "0.1.0",
        extensionVersion: null,
        minVersion: "0.0.16",
        maxTestedVersion: "0.0.17",
        reason: ""
      },
      staleness: { nativeHostStale: false, extensionStale: false, cliStale: false, helperStale: false }
    })
  };
}

describe("first-run readiness controller", () => {
  it("reads current evidence without turning unknown permissions into ready", async () => {
    const dependencies = createDependencies();
    const controller = createFirstRunReadinessController(dependencies);

    const snapshot = await controller.read();

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      chatReady: false,
      computerUseReady: false,
      resumeStepId: "background-agent"
    });
    expect(snapshot.steps.find((step) => step.id === "screen-recording")?.state).toBe("unknown");
    expect(dependencies.testBackgroundAgentReadiness).not.toHaveBeenCalled();
    expect(dependencies.testFinderAutomation).not.toHaveBeenCalled();
  });

  it("runs the explicit safe Background Agent test and refreshes the same snapshot", async () => {
    const dependencies = createDependencies();
    const controller = createFirstRunReadinessController(dependencies);

    const snapshot = await controller.testBackgroundAgent();

    expect(dependencies.testBackgroundAgentReadiness).toHaveBeenCalledTimes(1);
    expect(dependencies.readProviderReadiness).not.toHaveBeenCalled();
    expect(snapshot.chatReady).toBe(true);
    expect(snapshot.steps[0]).toEqual({
      id: "background-agent",
      requirement: "required-for-chat",
      state: "ready"
    });
    await expect(controller.read()).resolves.toMatchObject({ chatReady: true });

    controller.resetBackgroundAgentTest();
    await expect(controller.read()).resolves.toMatchObject({ chatReady: false });
  });

  it("discards an in-flight Background Agent result after the provider selection resets", async () => {
    const dependencies = createDependencies();
    let resolveTest!: (readiness: "chat-ready") => void;
    dependencies.testBackgroundAgentReadiness.mockImplementation(() => new Promise((resolve) => {
      resolveTest = resolve;
    }));
    const controller = createFirstRunReadinessController(dependencies);

    const pending = controller.testBackgroundAgent();
    controller.resetBackgroundAgentTest();
    resolveTest("chat-ready");

    await expect(pending).resolves.toMatchObject({ chatReady: false });
    await expect(controller.read()).resolves.toMatchObject({ chatReady: false });
  });

  it("keeps Finder unproven until the explicit read-only test succeeds", async () => {
    const dependencies = createDependencies();
    dependencies.readProviderReadiness.mockResolvedValue("chat-ready");
    const controller = createFirstRunReadinessController(dependencies);

    const before = await controller.read();
    const after = await controller.testFinderAutomation();

    expect(before.steps.find((step) => step.id === "finder-automation")?.state).toBe("unknown");
    expect(dependencies.testFinderAutomation).toHaveBeenCalledTimes(1);
    expect(after.steps.find((step) => step.id === "finder-automation")?.state).toBe("ready");
  });

  it("revalidates Finder after an explicit test instead of keeping stale permission evidence", async () => {
    const dependencies = createDependencies();
    dependencies.readProviderReadiness.mockResolvedValue("chat-ready");
    dependencies.testFinderAutomation
      .mockResolvedValueOnce({
        state: "proven-by-test",
        code: "finder-automation-ready",
        reason: "skfiy read Finder selection without changing files.",
        nextAction: "Finder workflows are ready for planning and approval.",
        evidenceSource: "finder-selection-test"
      })
      .mockResolvedValueOnce({
        state: "blocked",
        code: "finder-automation-denied",
        reason: "macOS denied skfiy permission to control Finder.",
        nextAction: "Open Privacy & Security > Automation and allow skfiy to control Finder.",
        evidenceSource: "finder-selection-test"
      });
    const controller = createFirstRunReadinessController(dependencies);

    const tested = await controller.testFinderAutomation();
    const refreshed = await controller.read();

    expect(tested.steps.find((step) => step.id === "finder-automation")?.state).toBe("ready");
    expect(refreshed.steps.find((step) => step.id === "finder-automation")?.state).toBe("blocked");
    expect(dependencies.testFinderAutomation).toHaveBeenCalledTimes(2);
  });

  it("retains the current incomplete resume step when evidence refreshes", async () => {
    const dependencies = createDependencies();
    dependencies.readProviderReadiness.mockResolvedValue("chat-ready");
    dependencies.readPermissions.mockResolvedValue({
      screenRecording: { state: "granted" },
      accessibility: { state: "granted" }
    });
    dependencies.readDesktopSession.mockResolvedValue({ state: "controllable", reason: "" });
    const controller = createFirstRunReadinessController(dependencies);

    const first = await controller.read();
    const second = await controller.read();

    expect(first.resumeStepId).toBe("finder-automation");
    expect(second.resumeStepId).toBe("finder-automation");
  });

  it("carries the extension compatibility warning into the browser-context step", async () => {
    const dependencies = createDependencies();
    dependencies.readProviderReadiness.mockResolvedValue("chat-ready");
    dependencies.readBrowserReadiness.mockResolvedValue({
      nativeHostState: "installed",
      liveConnectionState: "connected",
      browserContextState: "ready",
      reason: "Browser Context is ready for the current Chrome page.",
      nextAction: "No setup action is required."
    });
    dependencies.readChromeCompatibility = vi.fn().mockResolvedValue({
      schemaVersion: 1 as const,
      generatedAt: "2026-08-20T00:00:00.000Z",
      appVersion: "0.1.0",
      nativeHost: {
        state: "installed" as const,
        installedSkfiyVersion: "0.1.0",
        reason: "Chrome Native Messaging host is installed."
      },
      extension: {
        state: "connected" as const,
        version: "0.0.1",
        source: "running-extension-heartbeat"
      },
      compatibility: {
        state: "extension_outdated" as const,
        appVersion: "0.1.0",
        extensionVersion: "0.0.1",
        minVersion: "0.0.16",
        maxTestedVersion: "0.0.17",
        reason: "Chrome extension v0.0.1 is older than the minimum supported v0.0.16.",
        nextAction: "Reload the unpacked extension from chrome-extension/ to update."
      },
      staleness: {
        nativeHostStale: false,
        extensionStale: true,
        cliStale: false,
        helperStale: false
      }
    });
    const controller = createFirstRunReadinessController(dependencies);

    const snapshot = await controller.read();

    expect(dependencies.readChromeCompatibility).toHaveBeenCalledTimes(1);
    const browserContext = snapshot.steps.find((step) => step.id === "browser-context");
    expect(browserContext?.state).toBe("ready");
    expect(browserContext?.warning).toContain("older than the minimum supported");
  });

  it("tolerates a failing compatibility reader without breaking the snapshot", async () => {
    const dependencies = createDependencies();
    dependencies.readChromeCompatibility = vi.fn().mockRejectedValue(new Error("boom"));
    const controller = createFirstRunReadinessController(dependencies);

    const snapshot = await controller.read();

    const browserContext = snapshot.steps.find((step) => step.id === "browser-context");
    expect(browserContext?.warning).toBeUndefined();
  });
});
