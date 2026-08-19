import {
  createBrowserPageContextFromConnection,
  type BrowserPageContextState
} from "./browser-page-context.js";
import {
  readChromeExtensionConnectionStatus,
  readChromeNativeHostStatus,
  type ChromeExtensionConnectionStatus,
  type ChromeNativeHostStatus
} from "./chrome-native-host.js";

export interface BrowserReadinessEvidence {
  nativeHostState: ChromeNativeHostStatus["state"] | "unknown";
  liveConnectionState: ChromeExtensionConnectionStatus["state"];
  browserContextState: BrowserPageContextState;
  reason: string;
  nextAction: string;
}

type ReadConnectionStatus = (input: {
  homeDir: string;
}) => Promise<ChromeExtensionConnectionStatus>;

type ReadNativeHostStatus = (input: {
  homeDir: string;
  cliShimPath: string;
  extensionIds: string[];
}) => Promise<Pick<ChromeNativeHostStatus, "state" | "reason"> & {
  manifestDiagnostics?: Pick<ChromeNativeHostStatus["manifestDiagnostics"], "installedAllowedOrigins">;
}>;

type NativeHostReadinessEvidence = Omit<
  Awaited<ReturnType<ReadNativeHostStatus>>,
  "state"
> & {
  state: BrowserReadinessEvidence["nativeHostState"];
};

export async function readBrowserReadinessEvidence({
  homeDir,
  cliShimPath,
  readConnectionStatus = readChromeExtensionConnectionStatus,
  readNativeHostStatus: readNativeHost = readChromeNativeHostStatus
}: {
  homeDir: string;
  cliShimPath: string;
  readConnectionStatus?: ReadConnectionStatus;
  readNativeHostStatus?: ReadNativeHostStatus;
}): Promise<BrowserReadinessEvidence> {
  let connection: ChromeExtensionConnectionStatus;
  try {
    connection = await readConnectionStatus({ homeDir });
  } catch {
    connection = {
      state: "unknown",
      liveConnection: "unknown",
      path: "",
      reason: "Chrome extension connection status could not be read."
    };
  }

  let extensionIds = readChromeExtensionIdsFromConnection(connection);
  let nativeHost = await readNativeHostSafely({
    homeDir,
    cliShimPath,
    extensionIds,
    readNativeHost
  });
  if (extensionIds.length === 0) {
    extensionIds = readExtensionIds(nativeHost.manifestDiagnostics?.installedAllowedOrigins);
    if (extensionIds.length > 0) {
      nativeHost = await readNativeHostSafely({
        homeDir,
        cliShimPath,
        extensionIds,
        readNativeHost
      });
    }
  }

  const context = createBrowserPageContextFromConnection(connection);
  const nativeBlocker = readNativeHostBlocker(nativeHost.state);
  if (nativeBlocker) {
    return {
      nativeHostState: nativeHost.state,
      liveConnectionState: connection.state,
      browserContextState: context.state,
      ...nativeBlocker
    };
  }

  if (connection.state !== "connected") {
    return {
      nativeHostState: nativeHost.state,
      liveConnectionState: connection.state,
      browserContextState: context.state,
      reason: context.reason ?? connection.reason ?? "Chrome extension is not connected.",
      nextAction: context.nextAction
        ?? "Load or refresh the skfiy Chrome extension and run one page observation."
    };
  }

  if (context.state !== "ready" && context.state !== "partial") {
    return {
      nativeHostState: nativeHost.state,
      liveConnectionState: connection.state,
      browserContextState: context.state,
      reason: context.reason ?? "Browser Context is not ready for the current page.",
      nextAction: context.nextAction ?? "Refresh Browser Context from the skfiy Chrome extension."
    };
  }

  return {
    nativeHostState: nativeHost.state,
    liveConnectionState: connection.state,
    browserContextState: context.state,
    reason: "Browser Context is ready for the current Chrome page.",
    nextAction: "No setup action is required."
  };
}

async function readNativeHostSafely({
  homeDir,
  cliShimPath,
  extensionIds,
  readNativeHost
}: {
  homeDir: string;
  cliShimPath: string;
  extensionIds: string[];
  readNativeHost: ReadNativeHostStatus;
}): Promise<NativeHostReadinessEvidence> {
  try {
    return await readNativeHost({ homeDir, cliShimPath, extensionIds });
  } catch {
    return {
      state: "unknown",
      reason: "Chrome Native Messaging host status could not be read."
    };
  }
}

function readNativeHostBlocker(
  state: BrowserReadinessEvidence["nativeHostState"]
): Pick<BrowserReadinessEvidence, "reason" | "nextAction"> | undefined {
  if (state === "installed") {
    return undefined;
  }
  if (state === "missing") {
    return {
      reason: "Chrome Native Messaging host is not installed.",
      nextAction: "Open Browser setup and install the Chrome native host."
    };
  }
  if (state === "cli-missing") {
    return {
      reason: "The packaged skfiy CLI required by Chrome is missing.",
      nextAction: "Reinstall or rebuild skfiy, then refresh Browser setup."
    };
  }
  if (state === "invalid" || state === "mismatched") {
    return {
      reason: "Chrome Native Messaging host needs repair.",
      nextAction: "Open Browser setup and repair the Chrome native host."
    };
  }

  return {
    reason: "Chrome Native Messaging host status is unknown.",
    nextAction: "Refresh Browser setup after the packaged skfiy CLI is available."
  };
}

function readChromeExtensionIdsFromConnection(
  extensionConnection: ChromeExtensionConnectionStatus | undefined
): string[] {
  const candidates = [
    extensionConnection?.launchOrigin,
    extensionConnection?.latestCommand?.launchOrigin
  ];

  return [...new Set(candidates.map(readChromeExtensionIdFromLaunchOrigin).filter(Boolean))];
}

function readChromeExtensionIdFromLaunchOrigin(launchOrigin: string | undefined): string {
  const match = launchOrigin?.match(/^chrome-extension:\/\/([a-p]{32})\/$/);

  return match?.[1] ?? "";
}

function readExtensionIds(origins: string[] | undefined): string[] {
  return [...new Set((origins ?? []).flatMap((origin) => {
    const match = origin.match(/^chrome-extension:\/\/([a-p]{32})\/$/);
    return match?.[1] ? [match[1]] : [];
  }))];
}
