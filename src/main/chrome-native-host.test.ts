import { describe, expect, it } from "vitest";
import {
  CHROME_NATIVE_HOST_NAME,
  createChromeNativeBridgeDispatch,
  createChromeNativeHostInstallPlan,
  createChromeNativeHostManifest,
  installChromeNativeHost,
  readChromeExtensionConnectionStatus,
  readChromeNativeHostStatus,
  writeChromeExtensionConnectionHeartbeat,
  type ChromeNativeHostIo
} from "./chrome-native-host";

function createMemoryChromeNativeHostIo(
  files: Record<string, string> = {}
): ChromeNativeHostIo & { files: Record<string, string> } {
  const store: Record<string, string> = { ...files };

  return {
    files: store,
    exists: (targetPath: string) => Object.hasOwn(store, targetPath),
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

const homeDir = "/Users/tester";
const cliShimPath = "/repo/dist/skfiy";
const extensionIds = ["abcdefghijklmnopabcdefghijklmnop"];
const manifestPath = `/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts/${CHROME_NATIVE_HOST_NAME}.json`;
const connectionPath = `/Users/tester/Library/Application Support/skfiy/chrome-extension-connection.json`;

describe("native host manifest skfiyVersion stamping", () => {
  it("includes skfiyVersion in the manifest when provided", () => {
    const manifest = createChromeNativeHostManifest({
      cliShimPath,
      extensionIds,
      skfiyVersion: "0.1.0"
    });

    expect(manifest.skfiyVersion).toBe("0.1.0");
  });

  it("omits skfiyVersion when not provided", () => {
    const manifest = createChromeNativeHostManifest({
      cliShimPath,
      extensionIds
    });

    expect(manifest).not.toHaveProperty("skfiyVersion");
  });

  it("writes skfiyVersion into the installed manifest", async () => {
    const io = createMemoryChromeNativeHostIo({
      [cliShimPath]: "#!/usr/bin/env node\n"
    });

    await installChromeNativeHost({
      homeDir,
      cliShimPath,
      extensionIds,
      skfiyVersion: "0.1.0",
      io
    });

    const installed = JSON.parse(io.files[manifestPath]) as { skfiyVersion?: string };
    expect(installed.skfiyVersion).toBe("0.1.0");
  });
});

describe("readChromeNativeHostStatus skfiyVersion comparison", () => {
  it("reports mismatched with skfiyVersion field when the installed manifest predates the app", async () => {
    const installed = createChromeNativeHostManifest({
      cliShimPath,
      extensionIds,
      skfiyVersion: "0.0.9"
    });
    const io = createMemoryChromeNativeHostIo({
      [cliShimPath]: "#!/usr/bin/env node\n",
      [manifestPath]: JSON.stringify(installed)
    });

    const status = await readChromeNativeHostStatus({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion: "0.1.0",
      io
    });

    expect(status.state).toBe("mismatched");
    expect(status.manifestDiagnostics.mismatchedFields).toContain("skfiyVersion");
    expect(status.installedSkfiyVersion).toBe("0.0.9");
    expect(status.reason).toContain("0.0.9");
    expect(status.reason).toContain("0.1.0");
  });

  it("reports mismatched when the installed manifest has no skfiyVersion", async () => {
    const installed = createChromeNativeHostManifest({
      cliShimPath,
      extensionIds
    });
    const io = createMemoryChromeNativeHostIo({
      [cliShimPath]: "#!/usr/bin/env node\n",
      [manifestPath]: JSON.stringify(installed)
    });

    const status = await readChromeNativeHostStatus({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion: "0.1.0",
      io
    });

    expect(status.state).toBe("mismatched");
    expect(status.manifestDiagnostics.mismatchedFields).toContain("skfiyVersion");
    expect(status.installedSkfiyVersion).toBeUndefined();
  });

  it("reports installed when the versions match", async () => {
    const installed = createChromeNativeHostManifest({
      cliShimPath,
      extensionIds,
      skfiyVersion: "0.1.0"
    });
    const io = createMemoryChromeNativeHostIo({
      [cliShimPath]: "#!/usr/bin/env node\n",
      [manifestPath]: JSON.stringify(installed)
    });

    const status = await readChromeNativeHostStatus({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion: "0.1.0",
      io
    });

    expect(status.state).toBe("installed");
    expect(status.manifestDiagnostics.mismatchedFields).not.toContain("skfiyVersion");
    expect(status.installedSkfiyVersion).toBe("0.1.0");
  });

  it("skips the skfiyVersion check when no app version is supplied", async () => {
    const installed = createChromeNativeHostManifest({
      cliShimPath,
      extensionIds
    });
    const io = createMemoryChromeNativeHostIo({
      [cliShimPath]: "#!/usr/bin/env node\n",
      [manifestPath]: JSON.stringify(installed)
    });

    const status = await readChromeNativeHostStatus({
      homeDir,
      cliShimPath,
      extensionIds,
      io
    });

    expect(status.state).toBe("installed");
    expect(status.manifestDiagnostics.mismatchedFields).toEqual([]);
  });
});

describe("chrome extension connection heartbeat extensionVersion", () => {
  it("round-trips extensionVersion through write and read", async () => {
    const io = createMemoryChromeNativeHostIo();

    await writeChromeExtensionConnectionHeartbeat({
      homeDir,
      observedAt: "2026-08-20T00:00:00.000Z",
      messageType: "skfiy.page.observe",
      requestId: "request-1",
      extensionVersion: "0.0.17",
      io
    });

    const status = await readChromeExtensionConnectionStatus({
      homeDir,
      generatedAt: "2026-08-20T00:01:00.000Z",
      io
    });

    expect(status.state).toBe("connected");
    expect(status.extensionVersion).toBe("0.0.17");
  });

  it("keeps the heartbeat schema-valid without extensionVersion", async () => {
    const io = createMemoryChromeNativeHostIo();

    const heartbeat = await writeChromeExtensionConnectionHeartbeat({
      homeDir,
      observedAt: "2026-08-20T00:00:00.000Z",
      messageType: "skfiy.page.observe",
      requestId: "request-2",
      io
    });

    expect(heartbeat.schemaVersion).toBe(1);
    expect(heartbeat).not.toHaveProperty("extensionVersion");

    const status = await readChromeExtensionConnectionStatus({
      homeDir,
      generatedAt: "2026-08-20T00:01:00.000Z",
      io
    });

    expect(status.state).toBe("connected");
    expect(status.extensionVersion).toBeUndefined();
  });

  it("bounds an overlong extensionVersion", async () => {
    const io = createMemoryChromeNativeHostIo();

    await writeChromeExtensionConnectionHeartbeat({
      homeDir,
      observedAt: "2026-08-20T00:00:00.000Z",
      messageType: "skfiy.page.observe",
      requestId: "request-3",
      extensionVersion: "x".repeat(200),
      io
    });

    const status = await readChromeExtensionConnectionStatus({
      homeDir,
      generatedAt: "2026-08-20T00:01:00.000Z",
      io
    });

    expect(status.extensionVersion).toHaveLength(64);
  });
});

describe("createChromeNativeBridgeDispatch compatibility fields", () => {
  it("includes appVersion and extensionCompatibility in every response", async () => {
    const dispatch = createChromeNativeBridgeDispatch({
      homeDir,
      appVersion: "0.1.0"
    });

    const response = await dispatch({
      schemaVersion: 1,
      type: "skfiy.page.observe",
      requestId: "request-1",
      payload: { extensionVersion: "0.0.17" }
    });

    expect(response.appVersion).toBe("0.1.0");
    expect(response.extensionCompatibility).toMatchObject({
      state: "compatible",
      extensionVersion: "0.0.17",
      appVersion: "0.1.0"
    });
  });

  it("reports extension_outdated for old extension payloads", async () => {
    const dispatch = createChromeNativeBridgeDispatch({
      homeDir,
      appVersion: "0.1.0"
    });

    const response = await dispatch({
      schemaVersion: 1,
      type: "skfiy.page.observe",
      requestId: "request-2",
      payload: { extensionVersion: "0.0.1" }
    });

    expect(response.extensionCompatibility).toMatchObject({
      state: "extension_outdated"
    });
  });

  it("reports unknown compatibility when the payload carries no extension version", async () => {
    const dispatch = createChromeNativeBridgeDispatch({
      homeDir,
      appVersion: "0.1.0"
    });

    const response = await dispatch({
      schemaVersion: 1,
      type: "skfiy.page.observe",
      requestId: "request-3"
    });

    expect(response.extensionCompatibility).toMatchObject({
      state: "unknown"
    });
    expect(response.appVersion).toBe("0.1.0");
  });

  it("still serves host policy alongside the compatibility fields", async () => {
    const io = createMemoryChromeNativeHostIo();
    const dispatch = createChromeNativeBridgeDispatch({
      homeDir,
      appVersion: "0.1.0",
      io
    });

    const response = await dispatch({
      schemaVersion: 1,
      type: "skfiy.host_policy.request",
      requestId: "request-4",
      payload: { extensionVersion: "0.0.17" }
    });

    expect(response.result).toBe("accepted");
    expect(response.hostPolicy).toBeTruthy();
    expect(response.extensionCompatibility).toMatchObject({ state: "compatible" });
  });
});

describe("install plan keeps skfiyVersion", () => {
  it("threads skfiyVersion through the install plan", () => {
    const plan = createChromeNativeHostInstallPlan({
      homeDir,
      cliShimPath,
      extensionIds,
      skfiyVersion: "0.1.0"
    });

    expect(plan.manifest.skfiyVersion).toBe("0.1.0");
  });
});
