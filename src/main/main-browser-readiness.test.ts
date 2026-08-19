import { describe, expect, it, vi } from "vitest";

import { readBrowserReadinessEvidence } from "./main-browser-readiness";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";

describe("main Browser Context readiness", () => {
  it("reports a missing native host before extension connection blockers", async () => {
    const readNativeHostStatus = vi.fn().mockResolvedValue({
      state: "missing",
      reason: "Chrome Native Messaging host manifest is not installed."
    });

    await expect(readBrowserReadinessEvidence({
      homeDir: "/Users/tester",
      cliShimPath: "/repo/dist/skfiy",
      readConnectionStatus: async () => ({
        state: "unknown",
        liveConnection: "unknown",
        path: "/connection.json"
      }),
      readNativeHostStatus
    })).resolves.toEqual({
      nativeHostState: "missing",
      liveConnectionState: "unknown",
      browserContextState: "missing",
      reason: "Chrome Native Messaging host is not installed.",
      nextAction: "Open Browser setup and install the Chrome native host."
    });
    expect(readNativeHostStatus).toHaveBeenCalledWith({
      homeDir: "/Users/tester",
      cliShimPath: "/repo/dist/skfiy",
      extensionIds: []
    });
  });

  it("keeps stale extension heartbeat out of ready state", async () => {
    await expect(readBrowserReadinessEvidence({
      homeDir: "/Users/tester",
      cliShimPath: "/repo/dist/skfiy",
      readConnectionStatus: async () => ({
        state: "stale",
        liveConnection: "stale",
        path: "/connection.json",
        launchOrigin: `chrome-extension://${extensionId}/`,
        reason: "Heartbeat is stale."
      }),
      readNativeHostStatus: async () => ({
        state: "installed",
        reason: "installed"
      })
    })).resolves.toEqual({
      nativeHostState: "installed",
      liveConnectionState: "stale",
      browserContextState: "stale",
      reason: "Heartbeat is stale.",
      nextAction: "Refresh the skfiy Chrome extension before using Browser Context."
    });
  });

  it("preserves the bounded current page blocker and next action", async () => {
    await expect(readBrowserReadinessEvidence({
      homeDir: "/Users/tester",
      cliShimPath: "/repo/dist/skfiy",
      readConnectionStatus: async () => ({
        state: "connected",
        liveConnection: "connected",
        path: "/connection.json",
        launchOrigin: `chrome-extension://${extensionId}/`,
        pageControl: {
          state: "blocked_by_chrome_host_permission",
          reason: "Chrome site access is missing.",
          nextAction: "Grant site access in the extension popup."
        }
      }),
      readNativeHostStatus: async () => ({
        state: "installed",
        reason: "installed"
      })
    })).resolves.toEqual({
      nativeHostState: "installed",
      liveConnectionState: "connected",
      browserContextState: "blocked_by_chrome_host_permission",
      reason: "Chrome site access is missing.",
      nextAction: "Grant site access in the extension popup."
    });
  });

  it("returns only bounded readiness metadata for a ready page", async () => {
    const evidence = await readBrowserReadinessEvidence({
      homeDir: "/Users/tester",
      cliShimPath: "/repo/dist/skfiy",
      readConnectionStatus: async () => ({
        state: "connected",
        liveConnection: "connected",
        path: "/connection.json",
        launchOrigin: `chrome-extension://${extensionId}/`,
        pageControl: { state: "ready" },
        pageObservation: {
          url: "https://private.example/secret",
          title: "Private page",
          visibleText: "token=do-not-serialize"
        }
      }),
      readNativeHostStatus: async () => ({
        state: "installed",
        reason: "installed"
      })
    });

    expect(evidence).toEqual({
      nativeHostState: "installed",
      liveConnectionState: "connected",
      browserContextState: "ready",
      reason: "Browser Context is ready for the current Chrome page.",
      nextAction: "No setup action is required."
    });
    expect(JSON.stringify(evidence)).not.toContain("private.example");
    expect(JSON.stringify(evidence)).not.toContain("do-not-serialize");
  });
});
