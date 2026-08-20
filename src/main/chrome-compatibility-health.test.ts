import { describe, expect, it } from "vitest";
import {
  CHROME_COMPATIBILITY_HEALTH_SCHEMA_VERSION,
  readChromeCompatibilityHealth
} from "./chrome-compatibility-health";
import {
  CHROME_NATIVE_HOST_NAME,
  createChromeNativeHostManifest,
  writeChromeExtensionConnectionHeartbeat,
  type ChromeNativeHostIo
} from "./chrome-native-host";
import type { ComponentVersionIo } from "./diagnostic-report";

const homeDir = "/Users/tester";
const cliShimPath = "/repo/dist/skfiy";
const extensionIds = ["abcdefghijklmnopabcdefghijklmnop"];
const manifestPath = `/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts/${CHROME_NATIVE_HOST_NAME}.json`;
const connectionPath = `/Users/tester/Library/Application Support/skfiy/chrome-extension-connection.json`;
const extensionManifestPath = "/repo/chrome-extension/manifest.json";
const helperInfoPlistPath = "/repo/macos-helper/Info.plist";

function createMemoryIo(
  files: Record<string, string> = {}
): ChromeNativeHostIo & { files: Record<string, string> } {
  const store: Record<string, string> = { ...files };

  return {
    files: store,
    exists: (targetPath: string) => Object.hasOwn(store, targetPath),
    mkdir: async (targetPath: string) => {
      store[targetPath] = store[targetPath] ?? "__dir__";
    },
    readFile: async (targetPath: string) => {
      if (!Object.hasOwn(store, targetPath)) {
        throw new Error(`ENOENT: ${targetPath}`);
      }
      return store[targetPath];
    },
    writeFile: async (targetPath: string, content: string) => {
      store[targetPath] = content;
    },
    rm: async (targetPath: string) => {
      delete store[targetPath];
    }
  };
}

function createComponentVersionIo(
  memory: ChromeNativeHostIo & { files: Record<string, string> },
  cliVersion = "0.1.0"
): Partial<ComponentVersionIo> {
  return {
    exists: async (targetPath: string) => memory.exists(targetPath),
    readFile: async (targetPath: string) => memory.readFile(targetPath),
    execFile: async (command: string) => {
      if (command === cliShimPath) {
        return { stdout: `skfiy ${cliVersion}\n`, stderr: "" };
      }
      throw new Error(`unexpected exec: ${command}`);
    }
  };
}

function createInstalledHostFiles(skfiyVersion: string): Record<string, string> {
  return {
    [cliShimPath]: "#!/usr/bin/env node\n",
    [manifestPath]: JSON.stringify(
      createChromeNativeHostManifest({ cliShimPath, extensionIds, skfiyVersion })
    )
  };
}

describe("readChromeCompatibilityHealth", () => {
  it("aggregates a fully compatible installation", async () => {
    const memory = createMemoryIo(createInstalledHostFiles("0.1.0"));
    memory.files[extensionManifestPath] = JSON.stringify({ version: "0.0.17" });
    memory.files[helperInfoPlistPath] = `
      <plist><dict>
        <key>CFBundleShortVersionString</key><string>0.1.0</string>
      </dict></plist>`;

    await writeChromeExtensionConnectionHeartbeat({
      homeDir,
      observedAt: "2026-08-20T00:00:00.000Z",
      messageType: "skfiy.page.observe",
      requestId: "request-1",
      extensionVersion: "0.0.17",
      io: memory
    });

    const health = await readChromeCompatibilityHealth({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion: "0.1.0",
      extensionManifestPath,
      helperInfoPlistPath,
      generatedAt: "2026-08-20T00:01:00.000Z",
      io: memory,
      componentVersionIo: createComponentVersionIo(memory)
    });

    expect(health.schemaVersion).toBe(CHROME_COMPATIBILITY_HEALTH_SCHEMA_VERSION);
    expect(health.appVersion).toBe("0.1.0");
    expect(health.nativeHost.state).toBe("installed");
    expect(health.nativeHost.installedSkfiyVersion).toBe("0.1.0");
    expect(health.extension).toEqual({
      state: "connected",
      version: "0.0.17",
      source: "running-extension-heartbeat"
    });
    expect(health.compatibility.state).toBe("compatible");
    expect(health.staleness).toEqual({
      nativeHostStale: false,
      extensionStale: false,
      cliStale: false,
      helperStale: false
    });
  });

  it("flags a native host installed by an older app build", async () => {
    const memory = createMemoryIo(createInstalledHostFiles("0.0.9"));

    const health = await readChromeCompatibilityHealth({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion: "0.1.0",
      generatedAt: "2026-08-20T00:01:00.000Z",
      io: memory,
      componentVersionIo: createComponentVersionIo(memory)
    });

    expect(health.nativeHost.state).toBe("mismatched");
    expect(health.nativeHost.installedSkfiyVersion).toBe("0.0.9");
    expect(health.staleness.nativeHostStale).toBe(true);
  });

  it("flags an outdated running extension", async () => {
    const memory = createMemoryIo(createInstalledHostFiles("0.1.0"));

    await writeChromeExtensionConnectionHeartbeat({
      homeDir,
      observedAt: "2026-08-20T00:00:00.000Z",
      messageType: "skfiy.page.observe",
      requestId: "request-1",
      extensionVersion: "0.0.1",
      io: memory
    });

    const health = await readChromeCompatibilityHealth({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion: "0.1.0",
      generatedAt: "2026-08-20T00:01:00.000Z",
      io: memory,
      componentVersionIo: createComponentVersionIo(memory)
    });

    expect(health.extension.state).toBe("connected");
    expect(health.compatibility.state).toBe("extension_outdated");
    expect(health.staleness.extensionStale).toBe(true);
  });

  it("falls back to the on-disk packaged manifest when no heartbeat exists", async () => {
    const memory = createMemoryIo(createInstalledHostFiles("0.1.0"));
    memory.files[extensionManifestPath] = JSON.stringify({ version: "0.0.17" });

    const health = await readChromeCompatibilityHealth({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion: "0.1.0",
      extensionManifestPath,
      generatedAt: "2026-08-20T00:01:00.000Z",
      io: memory,
      componentVersionIo: createComponentVersionIo(memory)
    });

    expect(health.extension.state).toBe("on-disk");
    expect(health.extension.version).toBe("0.0.17");
    expect(health.extension.source).toBe("packaged-extension-manifest");
    expect(health.compatibility.state).toBe("compatible");
  });

  it("returns unknown states when every underlying reader throws", async () => {
    const brokenIo: ChromeNativeHostIo = {
      exists: () => {
        throw new Error("boom");
      },
      mkdir: async () => {
        throw new Error("boom");
      },
      readFile: async () => {
        throw new Error("boom");
      },
      writeFile: async () => {
        throw new Error("boom");
      },
      rm: async () => {
        throw new Error("boom");
      }
    };

    const health = await readChromeCompatibilityHealth({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion: "0.1.0",
      generatedAt: "2026-08-20T00:01:00.000Z",
      io: brokenIo,
      componentVersionIo: {
        exists: async () => {
          throw new Error("boom");
        },
        readFile: async () => {
          throw new Error("boom");
        }
      }
    });

    expect(health.nativeHost.state).toBe("unknown");
    expect(health.nativeHost.installedSkfiyVersion).toBeNull();
    expect(health.extension.state).toBe("unknown");
    expect(health.extension.version).toBeNull();
    expect(health.compatibility.state).toBe("unknown");
    expect(health.staleness).toEqual({
      nativeHostStale: false,
      extensionStale: false,
      cliStale: false,
      helperStale: false
    });
  });

  it("flags stale CLI and helper builds", async () => {
    const memory = createMemoryIo(createInstalledHostFiles("0.1.0"));
    memory.files[helperInfoPlistPath] = `
      <plist><dict>
        <key>CFBundleShortVersionString</key><string>0.0.8</string>
      </dict></plist>`;

    const health = await readChromeCompatibilityHealth({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion: "0.1.0",
      helperInfoPlistPath,
      generatedAt: "2026-08-20T00:01:00.000Z",
      io: memory,
      componentVersionIo: createComponentVersionIo(memory, "0.0.9")
    });

    expect(health.staleness.cliStale).toBe(true);
    expect(health.staleness.helperStale).toBe(true);
  });

  it("derives extension ids from the heartbeat launch origin when none are supplied", async () => {
    const memory = createMemoryIo({
      [cliShimPath]: "#!/usr/bin/env node\n",
      [manifestPath]: JSON.stringify(
        createChromeNativeHostManifest({
          cliShimPath,
          extensionIds,
          skfiyVersion: "0.1.0"
        })
      )
    });

    await writeChromeExtensionConnectionHeartbeat({
      homeDir,
      observedAt: "2026-08-20T00:00:00.000Z",
      launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
      messageType: "skfiy.page.observe",
      requestId: "request-1",
      extensionVersion: "0.0.17",
      io: memory
    });

    const health = await readChromeCompatibilityHealth({
      homeDir,
      cliShimPath,
      extensionIds: [],
      appVersion: "0.1.0",
      generatedAt: "2026-08-20T00:01:00.000Z",
      io: memory,
      componentVersionIo: createComponentVersionIo(memory)
    });

    expect(health.nativeHost.state).toBe("installed");
    expect(health.extension.state).toBe("connected");
  });
});
