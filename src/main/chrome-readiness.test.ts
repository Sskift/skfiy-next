import { describe, expect, it } from "vitest";
import { createChromeHostPolicyStatePath } from "./chrome-host-policy";
import {
  createChromeNativeHostManifest,
  createChromeExtensionConnectionStatePath
} from "./chrome-native-host";
import {
  createChromeReadinessConnectionPath,
  createChromeReadinessDiagnostics
} from "./chrome-readiness";

function createMemoryChromeReadinessIo(files: Record<string, string> = {}) {
  const store = { ...files };

  return {
    files: store,
    exists: async (targetPath: string) => Object.hasOwn(store, targetPath),
    mkdir: async (targetPath: string) => {
      store[targetPath] = store[targetPath] ?? "__dir__";
    },
    readFile: async (targetPath: string) => store[targetPath],
    writeFile: async (targetPath: string, content: string) => {
      store[targetPath] = content;
    },
    rm: async (targetPath: string) => {
      delete store[targetPath];
    }
  };
}

describe("Chrome extension readiness diagnostics", () => {
  const homeDir = "/Users/tester";
  const cliShimPath = "/repo/dist/skfiy";
  const extensionIds = ["abcdefghijklmnopabcdefghijklmnop"];
  const extensionPath = "/repo/chrome-extension";
  const manifestPath = "/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sskift.skfiy.json";
  const hostPolicyPath = createChromeHostPolicyStatePath(homeDir);
  const connectionPath = createChromeExtensionConnectionStatePath(homeDir);
  const installHostCommand = [
    "skfiy",
    "chrome",
    "install-host",
    "--cli",
    cliShimPath,
    "--extension-id",
    extensionIds[0]
  ];
  const verifyStatusCommand = [
    "skfiy",
    "chrome",
    "status",
    "--cli",
    cliShimPath,
    "--extension-id",
    extensionIds[0]
  ];

  it("summarizes installed native host, host policy, approval policy, and live connection evidence", async () => {
    const manifest = createChromeNativeHostManifest({
      cliShimPath,
      extensionIds
    });
    const io = createMemoryChromeReadinessIo({
      [cliShimPath]: "#!/usr/bin/env node\n",
      [manifestPath]: JSON.stringify(manifest),
      [hostPolicyPath]: JSON.stringify({
        schemaVersion: 1,
        policy: {
          defaultMode: "ask",
          allowedHosts: ["always.example"],
          currentTurnAllowedHosts: ["turn.example"],
          blockedHosts: []
        }
      }),
      [connectionPath]: JSON.stringify({
        schemaVersion: 1,
        hostName: "com.sskift.skfiy",
        observedAt: "2026-06-20T00:00:00.000Z",
        launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        messageType: "skfiy.page.observe",
        requestId: "request-1"
      })
    });

    await expect(createChromeReadinessDiagnostics({
      homeDir,
      cliShimPath,
      extensionIds,
      extensionPath,
      approvalProbeCommand: "打开 Chrome 测试页面 https://Example.com/path 并提取正文",
      generatedAt: "2026-06-20T00:02:00.000Z",
      io
    })).resolves.toEqual({
      schemaVersion: 1,
      state: "ready",
      generatedAt: "2026-06-20T00:02:00.000Z",
      nativeHost: {
        hostName: "com.sskift.skfiy",
        state: "installed",
        manifestPath,
        cliShimPath,
        allowedOrigins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
        reason: "Chrome Native Messaging host is installed."
      },
      extensionManifest: {
        state: "planned",
        manifestVersion: 3,
        hostName: "com.sskift.skfiy",
        allowedOrigins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
        nativeMessaging: true,
        optionalHostPermissions: ["http://*/*", "https://*/*"]
      },
      hostPolicy: {
        schemaVersion: 1,
        state: "configured",
        path: hostPolicyPath,
        defaultMode: "ask",
        entryCount: 2
      },
      approvalPolicy: {
        state: "ready",
        host: "example.com",
        defaultAction: "allow_current_turn_after_user_approval",
        failClosed: true
      },
      liveConnection: {
        state: "connected",
        liveConnection: "connected",
        path: connectionPath,
        ageSeconds: 120,
        launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        messageType: "skfiy.page.observe",
        requestId: "request-1"
      },
      setupGuide: {
        schemaVersion: 1,
        productPath: "dist/skfiy -> Chrome MV3 extension -> Native Messaging",
        state: "ready",
        extensionIds,
        expectedAllowedOrigins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
        nativeHostManifestPath: manifestPath,
        cliShimPath,
        connectionHeartbeatPath: connectionPath,
        hostPolicyPath,
        extensionPath,
        recommendedBrowsers: [
          "Google Chrome for Testing",
          "Chromium",
          "Google Chrome with manually installed skfiy extension"
        ],
        installHostCommand,
        verifyStatusCommand,
        smokeCommand: [
          "skfiy",
          "smoke",
          "chrome",
          "--output",
          ".skfiy-smoke/chrome.json"
        ],
        nextActions: [
          {
            id: "build-cli",
            state: "done",
            owner: "skfiy",
            title: "Packaged skfiy CLI is available for Native Messaging."
          },
          {
            id: "install-native-host",
            state: "done",
            owner: "skfiy",
            title: "Chrome Native Messaging host manifest is installed.",
            command: verifyStatusCommand
          },
          {
            id: "repair-host-policy",
            state: "done",
            owner: "skfiy",
            title: "Chrome host policy is readable and fail-closed."
          },
          {
            id: "verify-live-connection",
            state: "done",
            owner: "browser",
            title: "Chrome extension has recently connected to the native host.",
            command: verifyStatusCommand
          }
        ]
      }
    });
  });

  it("reports needs_setup when the packaged native host manifest is missing", async () => {
    const io = createMemoryChromeReadinessIo({
      [cliShimPath]: "#!/usr/bin/env node\n"
    });

    await expect(createChromeReadinessDiagnostics({
      homeDir,
      cliShimPath,
      extensionIds,
      generatedAt: "2026-06-20T00:00:00.000Z",
      io
    })).resolves.toMatchObject({
      state: "needs_setup",
      nativeHost: {
        state: "missing"
      },
      hostPolicy: {
        state: "default",
        defaultMode: "ask",
        entryCount: 0
      },
      approvalPolicy: {
        state: "no_probe"
      },
      liveConnection: {
        state: "unknown",
        liveConnection: "unknown",
        path: connectionPath
      },
      setupGuide: {
        state: "needs_setup",
        nativeHostManifestPath: manifestPath,
        connectionHeartbeatPath: connectionPath,
        installHostCommand,
        nextActions: [
          {
            id: "build-cli",
            state: "done"
          },
          {
            id: "install-native-host",
            state: "needed",
            command: installHostCommand
          },
          {
            id: "repair-host-policy",
            state: "done"
          },
          {
            id: "load-extension",
            state: "waiting",
            command: verifyStatusCommand
          }
        ]
      }
    });
  });

  it("fails closed when stored host policy JSON is invalid", async () => {
    const manifest = createChromeNativeHostManifest({
      cliShimPath,
      extensionIds
    });
    const io = createMemoryChromeReadinessIo({
      [cliShimPath]: "#!/usr/bin/env node\n",
      [manifestPath]: JSON.stringify(manifest),
      [hostPolicyPath]: "{"
    });

    await expect(createChromeReadinessDiagnostics({
      homeDir,
      cliShimPath,
      extensionIds,
      generatedAt: "2026-06-20T00:00:00.000Z",
      io
    })).resolves.toMatchObject({
      state: "blocked",
      nativeHost: {
        state: "installed"
      },
      hostPolicy: {
        state: "invalid",
        reason: "Chrome host policy file is not valid JSON."
      },
      setupGuide: {
        state: "blocked",
        nextActions: expect.arrayContaining([
          expect.objectContaining({
            id: "repair-host-policy",
            state: "blocked",
            command: ["skfiy", "chrome", "policy", "reset"]
          })
        ])
      }
    });
  });

  it("exposes the same heartbeat path used by native-host connection evidence", () => {
    expect(createChromeReadinessConnectionPath(homeDir)).toBe(connectionPath);
  });
});
