import {
  createFirstRunReadinessSnapshot,
  type FirstRunBrowserContextState,
  type FirstRunChromeLiveConnectionState,
  type FirstRunChromeNativeHostState,
  type FirstRunDesktopSessionState,
  type FirstRunFinderEvidenceState,
  type FirstRunPermissionState,
  type FirstRunProviderReadiness,
  type FirstRunReadinessSnapshot
} from "../shared/first-run-readiness.js";
import { readRecord } from "./record-utils.js";

export function createFirstRunReadinessFromStatus(
  status: Record<string, unknown>
): FirstRunReadinessSnapshot {
  const backgroundAgent = readRecord(status.backgroundAgent);
  const permissions = readRecord(status.permissions);
  const desktopSession = readRecord(status.desktopSession);
  const finder = readRecord(status.finder);
  const finderAutomation = readRecord(finder?.automation);
  const latestFinderSmoke = readRecord(finder?.latestSmoke);
  const nativeHost = readRecord(status.nativeHost);
  const extension = readRecord(status.extension);
  const browserContext = readRecord(extension?.browserContext)
    ?? readRecord(extension?.pageControl);

  return createFirstRunReadinessSnapshot({
    providerReadiness: readProviderReadiness(backgroundAgent?.readiness),
    permissions: {
      screenRecording: readPermissionState(permissions?.screenRecording),
      accessibility: readPermissionState(permissions?.accessibility)
    },
    desktopSession: {
      state: readDesktopSessionState(desktopSession?.state),
      ...(readString(desktopSession?.reason) ? { reason: readString(desktopSession?.reason) } : {})
    },
    finderAutomation: {
      state: readFinderEvidenceState(finderAutomation?.state, latestFinderSmoke),
      ...(readString(finderAutomation?.reason) ? { reason: readString(finderAutomation?.reason) } : {}),
      ...(readString(finderAutomation?.nextAction)
        ? { nextAction: readString(finderAutomation?.nextAction) }
        : {})
    },
    chrome: {
      nativeHostState: readChromeNativeHostState(nativeHost?.state),
      liveConnectionState: readChromeLiveConnectionState(extension),
      browserContext: {
        state: readBrowserContextState(browserContext?.state),
        ...(readString(browserContext?.reason) ? { reason: readString(browserContext?.reason) } : {}),
        ...(readString(browserContext?.nextAction)
          ? { nextAction: readString(browserContext?.nextAction) }
          : {})
      }
    }
  });
}

function readProviderReadiness(value: unknown): FirstRunProviderReadiness {
  return value === "chat-ready"
    || value === "version-ok"
    || value === "binary-found"
    || value === "binary-configured"
    || value === "auth-or-permission-blocked"
    || value === "unconfigured"
    || value === "unavailable"
    ? value
    : "unknown";
}

function readPermissionState(value: unknown): FirstRunPermissionState {
  const state = readStateValue(value);
  return state === "granted"
    || state === "denied"
    || state === "not-determined"
    || state === "unknown"
    ? state
    : "unknown";
}

function readDesktopSessionState(value: unknown): FirstRunDesktopSessionState {
  return value === "controllable" || value === "blocked" ? value : "unknown";
}

function readFinderEvidenceState(
  value: unknown,
  latestSmoke: Record<string, unknown> | undefined
): FirstRunFinderEvidenceState {
  if (value === "proven-by-test") {
    return "proven-by-test";
  }
  if (
    value === "proven-by-smoke"
    && latestSmoke?.stale === false
    && latestSmoke.automationEvidence === "proven"
  ) {
    return "proven-by-test";
  }
  if (value === "blocked" || value === "blocked-by-permission") {
    return "blocked";
  }
  return "unknown";
}

function readChromeNativeHostState(value: unknown): FirstRunChromeNativeHostState {
  return value === "installed"
    || value === "missing"
    || value === "mismatched"
    || value === "cli-missing"
    || value === "invalid"
    ? value
    : "unknown";
}

function readChromeLiveConnectionState(
  extension: Record<string, unknown> | undefined
): FirstRunChromeLiveConnectionState {
  const liveConnection = readString(extension?.liveConnection)
    ?? readString(readRecord(extension?.connection)?.state);
  if (liveConnection === "connected" || liveConnection === "stale" || liveConnection === "invalid") {
    return liveConnection;
  }
  if (liveConnection === "disconnected") {
    return "disconnected";
  }

  const extensionState = readString(extension?.state);
  if (extensionState === "connected") {
    return "connected";
  }
  if (extensionState && extensionState !== "unknown") {
    return "disconnected";
  }
  return "unknown";
}

function readBrowserContextState(value: unknown): FirstRunBrowserContextState {
  return value === "ready"
    || value === "partial"
    || value === "blocked"
    || value === "blocked_by_chrome_host_permission"
    || value === "blocked_by_host_policy"
    || value === "active_tab_unavailable"
    || value === "content_script_not_loaded"
    || value === "not_loaded"
    || value === "sensitive-paused"
    || value === "not-probed"
    || value === "missing"
    || value === "stale"
    || value === "unavailable"
    ? value
    : "unknown";
}

function readStateValue(value: unknown): string | undefined {
  return readString(readRecord(value)?.state) ?? readString(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
