/**
 * Chrome Compatibility Health — aggregated staleness diagnostics.
 *
 * Aggregates the five version sources (app, CLI, helper, native host,
 * extension) into one schema-versioned record so the renderer, the
 * diagnostic report, and the first-run readiness snapshot can surface
 * stale builds separately. Every sub-read is fail-closed: expected
 * failures degrade to typed "unknown" states with reason strings instead
 * of throwing, matching main-browser-readiness.ts.
 */

import {
  compareChromeExtensionVersions,
  evaluateChromeExtensionCompatibility,
  type ChromeCompatibilityHealth,
  type ChromeExtensionCompatibilityVerdict
} from "../shared/chrome-extension-compatibility.js";
import {
  createChromeNativeHostInstallPlan,
  readChromeExtensionConnectionStatus,
  readChromeNativeHostStatus,
  type ChromeExtensionConnectionStatus,
  type ChromeNativeHostIo,
  type ChromeNativeHostStatus
} from "./chrome-native-host.js";
import {
  readComponentVersions,
  type ComponentVersionIo
} from "./diagnostic-report.js";

export type { ChromeCompatibilityHealth } from "../shared/chrome-extension-compatibility.js";

export const CHROME_COMPATIBILITY_HEALTH_SCHEMA_VERSION = 1;

export interface ChromeCompatibilityHealthInput {
  homeDir: string;
  cliShimPath: string;
  extensionIds: string[];
  appVersion: string;
  extensionManifestPath?: string;
  helperInfoPlistPath?: string;
  generatedAt?: string;
  io?: ChromeNativeHostIo;
  /**
   * Overrides for the component-version readers (CLI --version probe,
   * Info.plist read). Production callers omit this and get filesystem
   * defaults; tests inject in-memory fakes.
   */
  componentVersionIo?: Partial<ComponentVersionIo>;
}

type NativeHostHealthEvidence = {
  state: ChromeNativeHostStatus["state"] | "unknown";
  installedSkfiyVersion: string | null;
  mismatchedFields: string[];
  reason: string;
};

export async function readChromeCompatibilityHealth({
  homeDir,
  cliShimPath,
  extensionIds,
  appVersion,
  extensionManifestPath,
  helperInfoPlistPath,
  generatedAt = new Date().toISOString(),
  io,
  componentVersionIo
}: ChromeCompatibilityHealthInput): Promise<ChromeCompatibilityHealth> {
  const connection = await readConnectionSafely(homeDir, generatedAt, io);
  const resolvedExtensionIds = extensionIds.length > 0
    ? extensionIds
    : readExtensionIdsFromConnection(connection);
  const nativeHost = await readNativeHostSafely({
    homeDir,
    cliShimPath,
    extensionIds: resolvedExtensionIds,
    appVersion,
    io
  });
  const componentVersions = await readComponentVersionsSafely({
    appVersion,
    cliShimPath,
    helperInfoPlistPath,
    extensionManifestPath,
    homeDir,
    resolvedExtensionIds,
    componentVersionIo
  });

  const extension = readExtensionEvidence(connection, componentVersions);
  const compatibility = evaluateChromeExtensionCompatibility({
    appVersion,
    extensionVersion: extension.version
  });
  const cliVersion = componentVersions.find((entry) => entry.component === "cli")?.version ?? null;
  const helperVersion = componentVersions.find((entry) => entry.component === "helper")?.version ?? null;

  return {
    schemaVersion: CHROME_COMPATIBILITY_HEALTH_SCHEMA_VERSION,
    generatedAt,
    appVersion,
    nativeHost: {
      state: nativeHost.state,
      installedSkfiyVersion: nativeHost.installedSkfiyVersion,
      reason: nativeHost.reason
    },
    extension,
    compatibility,
    staleness: {
      nativeHostStale: nativeHost.state === "mismatched"
        && nativeHost.mismatchedFields.includes("skfiyVersion"),
      extensionStale: compatibility.state === "extension_outdated",
      cliStale: isComponentStale(cliVersion, appVersion),
      helperStale: isComponentStale(helperVersion, appVersion)
    }
  };
}

async function readConnectionSafely(
  homeDir: string,
  generatedAt: string,
  io: ChromeNativeHostIo | undefined
): Promise<ChromeExtensionConnectionStatus> {
  try {
    return await readChromeExtensionConnectionStatus({ homeDir, generatedAt, io });
  } catch {
    return {
      state: "unknown",
      liveConnection: "unknown",
      path: "",
      reason: "Chrome extension connection status could not be read."
    };
  }
}

async function readNativeHostSafely({
  homeDir,
  cliShimPath,
  extensionIds,
  appVersion,
  io
}: {
  homeDir: string;
  cliShimPath: string;
  extensionIds: string[];
  appVersion: string;
  io: ChromeNativeHostIo | undefined;
}): Promise<NativeHostHealthEvidence> {
  try {
    const status = await readChromeNativeHostStatus({
      homeDir,
      cliShimPath,
      extensionIds,
      appVersion,
      io
    });

    return {
      state: status.state,
      installedSkfiyVersion: status.installedSkfiyVersion ?? null,
      mismatchedFields: status.manifestDiagnostics.mismatchedFields,
      reason: status.reason
    };
  } catch {
    return {
      state: "unknown",
      installedSkfiyVersion: null,
      mismatchedFields: [],
      reason: "Chrome Native Messaging host status could not be read."
    };
  }
}

async function readComponentVersionsSafely({
  appVersion,
  cliShimPath,
  helperInfoPlistPath,
  extensionManifestPath,
  homeDir,
  resolvedExtensionIds,
  componentVersionIo
}: {
  appVersion: string;
  cliShimPath: string;
  helperInfoPlistPath: string | undefined;
  extensionManifestPath: string | undefined;
  homeDir: string;
  resolvedExtensionIds: string[];
  componentVersionIo: Partial<ComponentVersionIo> | undefined;
}): Promise<Array<{ component: string; version: string | null }>> {
  try {
    const nativeHostManifestPath = createChromeNativeHostInstallPlan({
      homeDir,
      cliShimPath,
      extensionIds: resolvedExtensionIds
    }).manifestPath;

    return await readComponentVersions({
      appVersion,
      cliShimPath,
      helperInfoPlistPath: helperInfoPlistPath ?? "",
      extensionManifestPath: extensionManifestPath ?? "",
      nativeHostManifestPath,
      providerStates: [],
      io: componentVersionIo
    });
  } catch {
    return [];
  }
}

function readExtensionEvidence(
  connection: ChromeExtensionConnectionStatus,
  componentVersions: Array<{ component: string; version: string | null }>
): ChromeCompatibilityHealth["extension"] {
  if (connection.state === "connected" && connection.extensionVersion) {
    return {
      state: "connected",
      version: connection.extensionVersion,
      source: "running-extension-heartbeat"
    };
  }

  const packagedVersion = componentVersions.find(
    (entry) => entry.component === "chrome-extension"
  )?.version ?? null;

  if (packagedVersion) {
    return {
      state: "on-disk",
      version: packagedVersion,
      source: "packaged-extension-manifest"
    };
  }

  return {
    state: "unknown",
    version: null,
    source: connection.extensionVersion ? "stale-heartbeat" : "none"
  };
}

function isComponentStale(version: string | null, appVersion: string): boolean {
  if (!version) {
    return false;
  }

  return compareChromeExtensionVersions(version, appVersion) === -1;
}

function readExtensionIdsFromConnection(
  connection: ChromeExtensionConnectionStatus
): string[] {
  const candidates = [
    connection.launchOrigin,
    connection.latestCommand?.launchOrigin
  ];

  return [...new Set(candidates.map(readExtensionIdFromLaunchOrigin).filter(Boolean))];
}

function readExtensionIdFromLaunchOrigin(launchOrigin: string | undefined): string {
  const match = launchOrigin?.match(/^chrome-extension:\/\/([a-p]{32})\/$/);

  return match?.[1] ?? "";
}
