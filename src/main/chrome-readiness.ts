import {
  readChromeApprovalPolicyHost
} from "./chrome-approval-policy.js";
import {
  readChromeHostPolicyState,
  type ChromeHostPolicyIo,
  type ChromeHostPolicyState
} from "./chrome-host-policy.js";
import {
  CHROME_NATIVE_HOST_NAME,
  createChromeExtensionConnectionStatePath,
  createChromeNativeHostInstallPlan,
  readChromeExtensionConnectionStatus,
  readChromeNativeHostStatus,
  type ChromeExtensionConnectionStatus,
  type ChromeNativeHostIo,
  type ChromeNativeHostStatus
} from "./chrome-native-host.js";

export interface ChromeReadinessDiagnosticsInput {
  homeDir: string;
  cliShimPath: string;
  extensionIds: string[];
  extensionPath?: string;
  approvalProbeCommand?: string;
  generatedAt?: string;
  io?: ChromeNativeHostIo & ChromeHostPolicyIo;
}

export type ChromeReadinessState = "ready" | "needs_setup" | "blocked";

export interface ChromeReadinessSetupAction {
  id:
    | "build-cli"
    | "install-native-host"
    | "repair-native-host-manifest"
    | "repair-host-policy"
    | "load-extension"
    | "verify-live-connection";
  state: "done" | "needed" | "blocked" | "waiting";
  owner: "skfiy" | "user" | "browser";
  title: string;
  reason?: string;
  command?: string[];
}

export interface ChromeReadinessSetupGuide {
  schemaVersion: 1;
  productPath: "dist/skfiy -> Chrome MV3 extension -> Native Messaging";
  state: ChromeReadinessState;
  extensionIds: string[];
  expectedAllowedOrigins: string[];
  nativeHostManifestPath: string;
  cliShimPath: string;
  connectionHeartbeatPath: string;
  hostPolicyPath: string;
  extensionPath?: string;
  recommendedBrowsers: [
    "Google Chrome for Testing",
    "Chromium",
    "Google Chrome with manually installed skfiy extension"
  ];
  installHostCommand: string[];
  verifyStatusCommand: string[];
  smokeCommand: string[];
  nextActions: ChromeReadinessSetupAction[];
}

export interface ChromeReadinessDiagnostics {
  schemaVersion: 1;
  state: ChromeReadinessState;
  generatedAt: string;
  nativeHost: {
    hostName: typeof CHROME_NATIVE_HOST_NAME;
    state: "installed" | "missing" | "mismatched" | "cli-missing" | "invalid";
    manifestPath: string;
    cliShimPath: string;
    allowedOrigins: string[];
    reason: string;
  };
  extensionManifest: {
    state: "planned";
    manifestVersion: 3;
    hostName: typeof CHROME_NATIVE_HOST_NAME;
    allowedOrigins: string[];
    nativeMessaging: true;
    optionalHostPermissions: ["http://*/*", "https://*/*"];
  };
  hostPolicy: {
    schemaVersion: 1;
    state: "default" | "configured" | "invalid";
    path: string;
    defaultMode: "ask";
    entryCount: number;
    reason?: string;
  };
  approvalPolicy: {
    state: "ready" | "no_probe";
    host?: string;
    defaultAction: "allow_current_turn_after_user_approval";
    failClosed: true;
  };
  liveConnection: {
    state: "connected" | "stale" | "unknown" | "invalid";
    liveConnection: "connected" | "stale" | "unknown";
    path: string;
    reason?: string;
    ageSeconds?: number;
    launchOrigin?: string;
    messageType?: string;
    requestId?: string;
  };
  setupGuide: ChromeReadinessSetupGuide;
}

export async function createChromeReadinessDiagnostics({
  homeDir,
  cliShimPath,
  extensionIds,
  extensionPath,
  approvalProbeCommand,
  generatedAt = new Date().toISOString(),
  io
}: ChromeReadinessDiagnosticsInput): Promise<ChromeReadinessDiagnostics> {
  const nativeHost = await readChromeNativeHostStatus({
    homeDir,
    cliShimPath,
    extensionIds,
    io
  });
  const hostPolicyState = await readChromeHostPolicyState({
    homeDir,
    io
  });
  const liveConnection = await readChromeExtensionConnectionStatus({
    homeDir,
    generatedAt,
    io
  });
  const installPlan = createChromeNativeHostInstallPlan({
    homeDir,
    cliShimPath,
    extensionIds
  });
  const approvalHost = approvalProbeCommand
    ? readChromeApprovalPolicyHost(approvalProbeCommand)
    : undefined;
  const hostPolicyEntryCount = hostPolicyState.policy.allowedHosts.length
    + hostPolicyState.policy.currentTurnAllowedHosts.length
    + hostPolicyState.policy.blockedHosts.length;
  const state = deriveChromeReadinessState({
    nativeHostState: nativeHost.state,
    hostPolicyState: hostPolicyState.state
  });
  const setupGuide = createChromeReadinessSetupGuide({
    state,
    nativeHost,
    hostPolicy: hostPolicyState,
    liveConnection,
    extensionIds,
    cliShimPath,
    extensionPath
  });

  return {
    schemaVersion: 1,
    state,
    generatedAt,
    nativeHost: {
      hostName: nativeHost.hostName,
      state: nativeHost.state,
      manifestPath: nativeHost.manifestPath,
      cliShimPath: nativeHost.cliShimPath,
      allowedOrigins: nativeHost.allowedOrigins,
      reason: nativeHost.reason
    },
    extensionManifest: {
      state: "planned",
      manifestVersion: 3,
      hostName: installPlan.hostName,
      allowedOrigins: installPlan.manifest.allowed_origins,
      nativeMessaging: true,
      optionalHostPermissions: ["http://*/*", "https://*/*"]
    },
    hostPolicy: {
      schemaVersion: hostPolicyState.schemaVersion,
      state: hostPolicyState.state,
      path: hostPolicyState.path,
      defaultMode: hostPolicyState.policy.defaultMode,
      entryCount: hostPolicyEntryCount,
      ...(hostPolicyState.reason ? { reason: hostPolicyState.reason } : {})
    },
    approvalPolicy: {
      state: approvalHost ? "ready" : "no_probe",
      ...(approvalHost ? { host: approvalHost } : {}),
      defaultAction: "allow_current_turn_after_user_approval",
      failClosed: true
    },
    liveConnection: {
      state: liveConnection.state,
      liveConnection: liveConnection.liveConnection,
      path: liveConnection.path,
      ...(liveConnection.reason ? { reason: liveConnection.reason } : {}),
      ...(typeof liveConnection.ageSeconds === "number" ? { ageSeconds: liveConnection.ageSeconds } : {}),
      ...(liveConnection.launchOrigin ? { launchOrigin: liveConnection.launchOrigin } : {}),
      ...(liveConnection.messageType ? { messageType: liveConnection.messageType } : {}),
      ...(liveConnection.requestId ? { requestId: liveConnection.requestId } : {})
    },
    setupGuide
  };
}

export function createChromeReadinessConnectionPath(homeDir: string): string {
  return createChromeExtensionConnectionStatePath(homeDir);
}

export function createChromeReadinessSetupGuide({
  state,
  nativeHost,
  hostPolicy,
  liveConnection,
  extensionIds,
  cliShimPath,
  extensionPath
}: {
  state?: ChromeReadinessState;
  nativeHost: Pick<ChromeNativeHostStatus, "state" | "manifestPath" | "allowedOrigins" | "expectedAllowedOrigins" | "reason">;
  hostPolicy: Pick<ChromeHostPolicyState, "state" | "path" | "reason">;
  liveConnection?: Pick<ChromeExtensionConnectionStatus, "state" | "path" | "reason">;
  extensionIds: string[];
  cliShimPath: string;
  extensionPath?: string;
}): ChromeReadinessSetupGuide {
  const readinessState = state ?? deriveChromeReadinessState({
    nativeHostState: nativeHost.state,
    hostPolicyState: hostPolicy.state
  });
  const extensionIdArgs = extensionIds.flatMap((extensionId) => ["--extension-id", extensionId]);
  const installHostCommand = [
    "skfiy",
    "chrome",
    "install-host",
    "--cli",
    cliShimPath,
    ...extensionIdArgs
  ];
  const verifyStatusCommand = [
    "skfiy",
    "chrome",
    "status",
    "--cli",
    cliShimPath,
    ...extensionIdArgs
  ];
  const smokeCommand = [
    "skfiy",
    "smoke",
    "chrome",
    "--output",
    ".skfiy-smoke/chrome.json"
  ];
  const nextActions = createChromeReadinessSetupActions({
    nativeHostState: nativeHost.state,
    nativeHostReason: nativeHost.reason,
    hostPolicyState: hostPolicy.state,
    hostPolicyReason: hostPolicy.reason,
    liveConnectionState: liveConnection?.state ?? "unknown",
    liveConnectionReason: liveConnection?.reason,
    installHostCommand,
    verifyStatusCommand
  });

  return {
    schemaVersion: 1,
    productPath: "dist/skfiy -> Chrome MV3 extension -> Native Messaging",
    state: readinessState,
    extensionIds,
    expectedAllowedOrigins: nativeHost.expectedAllowedOrigins.length > 0
      ? nativeHost.expectedAllowedOrigins
      : nativeHost.allowedOrigins,
    nativeHostManifestPath: nativeHost.manifestPath,
    cliShimPath,
    connectionHeartbeatPath: liveConnection?.path
      ?? createChromeExtensionConnectionStatePath(readHomeDirFromNativeHostManifestPath(nativeHost.manifestPath)),
    hostPolicyPath: hostPolicy.path,
    ...(extensionPath ? { extensionPath } : {}),
    recommendedBrowsers: [
      "Google Chrome for Testing",
      "Chromium",
      "Google Chrome with manually installed skfiy extension"
    ],
    installHostCommand,
    verifyStatusCommand,
    smokeCommand,
    nextActions
  };
}

function deriveChromeReadinessState({
  nativeHostState,
  hostPolicyState
}: {
  nativeHostState: ChromeNativeHostStatus["state"];
  hostPolicyState: ChromeHostPolicyState["state"];
}): ChromeReadinessState {
  return nativeHostState === "installed" && hostPolicyState !== "invalid"
    ? "ready"
    : hostPolicyState === "invalid" || nativeHostState === "invalid"
      ? "blocked"
      : "needs_setup";
}

function createChromeReadinessSetupActions({
  nativeHostState,
  nativeHostReason,
  hostPolicyState,
  hostPolicyReason,
  liveConnectionState,
  liveConnectionReason,
  installHostCommand,
  verifyStatusCommand
}: {
  nativeHostState: ChromeNativeHostStatus["state"];
  nativeHostReason?: string;
  hostPolicyState: ChromeHostPolicyState["state"];
  hostPolicyReason?: string;
  liveConnectionState: ChromeExtensionConnectionStatus["state"];
  liveConnectionReason?: string;
  installHostCommand: string[];
  verifyStatusCommand: string[];
}): ChromeReadinessSetupAction[] {
  const actions: ChromeReadinessSetupAction[] = [];

  if (nativeHostState === "cli-missing") {
    actions.push({
      id: "build-cli",
      state: "needed",
      owner: "skfiy",
      title: "Build the packaged skfiy CLI before installing the Chrome native host.",
      reason: nativeHostReason,
      command: ["npm", "run", "build"]
    });
  } else {
    actions.push({
      id: "build-cli",
      state: "done",
      owner: "skfiy",
      title: "Packaged skfiy CLI is available for Native Messaging."
    });
  }

  if (nativeHostState === "installed") {
    actions.push({
      id: "install-native-host",
      state: "done",
      owner: "skfiy",
      title: "Chrome Native Messaging host manifest is installed.",
      command: verifyStatusCommand
    });
  } else {
    actions.push({
      id: nativeHostState === "invalid" ? "repair-native-host-manifest" : "install-native-host",
      state: nativeHostState === "cli-missing" ? "waiting" : "needed",
      owner: "skfiy",
      title: nativeHostState === "invalid"
        ? "Repair the Chrome Native Messaging host manifest."
        : "Install the Chrome Native Messaging host manifest.",
      reason: nativeHostReason,
      command: installHostCommand
    });
  }

  if (hostPolicyState === "invalid") {
    actions.push({
      id: "repair-host-policy",
      state: "blocked",
      owner: "user",
      title: "Reset or repair the Chrome host policy before browser actions can run.",
      reason: hostPolicyReason,
      command: ["skfiy", "chrome", "policy", "reset"]
    });
  } else {
    actions.push({
      id: "repair-host-policy",
      state: "done",
      owner: "skfiy",
      title: "Chrome host policy is readable and fail-closed."
    });
  }

  if (nativeHostState !== "installed" || hostPolicyState === "invalid") {
    actions.push({
      id: "load-extension",
      state: "waiting",
      owner: "browser",
      title: "Load or refresh the skfiy Chrome extension after the native host and policy are ready.",
      command: verifyStatusCommand
    });
    return actions;
  }

  if (liveConnectionState === "connected") {
    actions.push({
      id: "verify-live-connection",
      state: "done",
      owner: "browser",
      title: "Chrome extension has recently connected to the native host.",
      command: verifyStatusCommand
    });
  } else {
    actions.push({
      id: "load-extension",
      state: "waiting",
      owner: "browser",
      title: "Load or refresh the skfiy Chrome extension and run one page observation to record a heartbeat.",
      reason: liveConnectionReason,
      command: verifyStatusCommand
    });
  }

  return actions;
}

function readHomeDirFromNativeHostManifestPath(manifestPath: string): string {
  const marker = "/Library/Application Support/Google/Chrome/NativeMessagingHosts/";
  const markerIndex = manifestPath.indexOf(marker);

  return markerIndex >= 0 ? manifestPath.slice(0, markerIndex) : "";
}
