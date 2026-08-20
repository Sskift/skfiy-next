import {
  applyBrowserPageContextSourceOverrides,
  createBrowserPageContextFromConnection,
  type BrowserPageContext
} from "./browser-page-context.js";
import type { ChromeExtensionConnectionStatus } from "./chrome-native-host.js";
import { readRecord } from "./record-utils.js";
import type { BrowserContextSourceStore } from "./browser-context-source-store.js";
import {
  BROWSER_CONTEXT_SOURCE_SCHEMA_VERSION,
  createBrowserContextBlocker,
  mapBrowserContextBlockerCategory,
  normalizeBrowserContextTabDiscoveryResult,
  type BrowserContextBlocker,
  type BrowserContextSelectedTab,
  type BrowserContextSourceSnapshot,
  type BrowserContextTabDiscoveryResult,
  type BrowserContextTabSummary
} from "../shared/browser-context-source.js";

export type ReadChromeExtensionConnectionStatus = (input: {
  homeDir: string;
}) => Promise<ChromeExtensionConnectionStatus>;

export interface BrowserContextSourceRead {
  snapshot: BrowserContextSourceSnapshot;
  context: BrowserPageContext;
}

export async function readBrowserContextSource({
  store,
  homeDir,
  readConnectionStatus,
  now = () => new Date()
}: {
  store: BrowserContextSourceStore;
  homeDir: string;
  readConnectionStatus: ReadChromeExtensionConnectionStatus;
  now?: () => Date;
}): Promise<BrowserContextSourceRead> {
  const storeState = store.getState();

  let connection: ChromeExtensionConnectionStatus;
  let baseContext: BrowserPageContext;
  try {
    connection = await readConnectionStatus({ homeDir });
    baseContext = createBrowserPageContextFromConnection(connection);
  } catch (error) {
    connection = {
      state: "unknown",
      liveConnection: "unknown",
      path: ""
    };
    baseContext = {
      state: "unavailable",
      reason: error instanceof Error
        ? error.message
        : "Chrome extension diagnostics could not be read.",
      nextAction: "Refresh the skfiy Chrome extension before using Browser Context."
    };
  }
  const discovery = readDiscoveryFromConnection(connection) ?? storeState.discovery ?? null;
  const selectedTab = resolveSelectedTab(storeState.selectedTabId, discovery, connection, now);
  const targetedContext = applySelectedTabTargeting(baseContext, storeState.selectedTabId, selectedTab, connection);
  const context = applyBrowserPageContextSourceOverrides(targetedContext, {
    paused: storeState.paused,
    disconnected: storeState.disconnected,
    clearedForTurn: storeState.clearedForTurn
  });
  const blockers = readBrowserContextBlockers({ selectedTab, connection });

  return {
    snapshot: createSnapshot({
      selectedTab,
      context,
      storeState,
      discovery,
      blockers,
      now
    }),
    context
  };
}

export function readDiscoveryFromConnection(
  connection: ChromeExtensionConnectionStatus
): BrowserContextTabDiscoveryResult | null {
  const candidate = readRecord(connection.pageTabs)
    ?? readRecord(connection.latestCommand?.pageTabs);

  return normalizeBrowserContextTabDiscoveryResult(candidate) ?? null;
}

function resolveSelectedTab(
  selectedTabId: number | null,
  discovery: BrowserContextTabDiscoveryResult | null,
  connection: ChromeExtensionConnectionStatus,
  now: () => Date
): BrowserContextSelectedTab | null {
  if (selectedTabId === null) {
    return null;
  }

  const tab = discovery?.tabs.find((entry) => entry.tabId === selectedTabId);
  const observedAt = readOptionalString(connection.observedAt);
  const freshnessSeconds = readFreshnessSeconds(observedAt, now);

  if (!tab) {
    return {
      tabId: selectedTabId,
      ...(observedAt ? { observedAt } : {}),
      ...(freshnessSeconds !== undefined ? { freshnessSeconds } : {})
    };
  }

  return {
    tabId: tab.tabId,
    ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
    ...(tab.active !== undefined ? { active: tab.active } : {}),
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.host ? { host: tab.host } : {}),
    ...(tab.url ? { url: tab.url } : {}),
    ...(tab.scheme ? { scheme: tab.scheme } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(freshnessSeconds !== undefined ? { freshnessSeconds } : {}),
    ...(tab.blocker ? { blocker: tab.blocker } : {}),
    ...(tab.blockerCategory ? { blockerCategory: tab.blockerCategory } : {}),
    ...(tab.nextAction ? { nextAction: tab.nextAction } : {})
  };
}

function applySelectedTabTargeting(
  context: BrowserPageContext,
  selectedTabId: number | null,
  selectedTab: BrowserContextSelectedTab | null,
  connection: ChromeExtensionConnectionStatus
): BrowserPageContext {
  if (selectedTabId === null) {
    return context;
  }

  if (selectedTab === null || !selectedTab.host) {
    return {
      state: "active_tab_unavailable",
      reason: "Selected tab is no longer open in Chrome.",
      nextAction: "Re-scan tabs and pick an eligible tab."
    };
  }

  const observedTabId = readObservedTabId(connection);
  if (
    observedTabId !== undefined
    && observedTabId !== selectedTabId
    && (context.state === "ready" || context.state === "partial")
  ) {
    return {
      state: "active_tab_unavailable",
      reason: `Selected tab ${selectedTab.host} has not been observed yet.`,
      nextAction: "Switch to the selected tab in Chrome, then refresh Browser Context."
    };
  }

  return context;
}

function readObservedTabId(connection: ChromeExtensionConnectionStatus): number | undefined {
  const pageControl = readRecord(connection.pageControl)
    ?? readRecord(readRecord(connection.pageObservation)?.pageControl);
  const activeTab = readRecord(pageControl?.activeTab);
  const activeTabId = activeTab?.tabId;

  return typeof activeTabId === "number" && Number.isInteger(activeTabId)
    ? activeTabId
    : undefined;
}

function readBrowserContextBlockers({
  selectedTab,
  connection
}: {
  selectedTab: BrowserContextSelectedTab | null;
  connection: ChromeExtensionConnectionStatus;
}): BrowserContextBlocker[] {
  const blockers: BrowserContextBlocker[] = [];
  const seen = new Set<string>();

  const push = (blocker: BrowserContextBlocker | undefined) => {
    if (!blocker || seen.has(blocker.category)) {
      return;
    }
    seen.add(blocker.category);
    blockers.push(blocker);
  };

  if (selectedTab?.blockerCategory) {
    push(createBrowserContextBlocker({
      category: selectedTab.blockerCategory,
      ...(selectedTab.host ? { detail: selectedTab.host } : {}),
      ...(selectedTab.nextAction ? { nextAction: selectedTab.nextAction } : {})
    }));
  }

  const pageControl = readRecord(connection.pageControl)
    ?? readRecord(readRecord(connection.pageObservation)?.pageControl);
  if (pageControl) {
    const host = readOptionalString(readRecord(pageControl.activeTab)?.host)
      ?? readOptionalString(readRecord(pageControl.chromeHostPermission)?.host);
    const hostPolicyDecision = readOptionalString(readRecord(pageControl.hostPolicy)?.decision);
    if (host && hostPolicyDecision && hostPolicyDecision !== "allowed") {
      push(createBrowserContextBlocker({ category: "host-policy", detail: host }));
    }

    const chromeHostPermissionState = readOptionalString(
      readRecord(pageControl.chromeHostPermission)?.state
    );
    if (chromeHostPermissionState === "missing") {
      push(createBrowserContextBlocker({
        category: "site-access",
        ...(host ? { detail: host } : {})
      }));
    }

    const chromeCapturePermissionState = readOptionalString(
      readRecord(pageControl.chromeCapturePermission)?.state
    );
    if (chromeCapturePermissionState === "missing") {
      push(createBrowserContextBlocker({ category: "screenshot" }));
    }

    const blockerCodes = Array.isArray(pageControl.blockers)
      ? pageControl.blockers
        .map((entry) => readOptionalString(readRecord(entry)?.code))
        .filter((code): code is string => Boolean(code))
      : [];
    for (const code of blockerCodes) {
      const category = mapBrowserContextBlockerCategory(code);
      if (category) {
        push(createBrowserContextBlocker({ category }));
      }
    }
  }

  return blockers;
}

function createSnapshot({
  selectedTab,
  context,
  storeState,
  discovery,
  blockers,
  now
}: {
  selectedTab: BrowserContextSelectedTab | null;
  context: BrowserPageContext;
  storeState: ReturnType<BrowserContextSourceStore["getState"]>;
  discovery: BrowserContextTabDiscoveryResult | null;
  blockers: BrowserContextBlocker[];
  now: () => Date;
}): BrowserContextSourceSnapshot {
  return {
    schemaVersion: BROWSER_CONTEXT_SOURCE_SCHEMA_VERSION,
    selectedTab,
    contextState: context.state,
    paused: storeState.paused,
    disconnected: storeState.disconnected,
    clearedForTurn: storeState.clearedForTurn,
    blockers,
    eligibleTabCount: discovery
      ? discovery.tabs.filter((tab) => tab.eligible).length
      : 0,
    discoveryState: !discovery
      ? "not-probed"
      : discovery.result === "blocked"
        ? "blocked"
        : "passed",
    ...(discovery?.reason ? { discoveryReason: discovery.reason } : {}),
    ...(discovery?.observedAt ? { discoveryObservedAt: discovery.observedAt } : {}),
    generatedAt: now().toISOString()
  };
}

function readFreshnessSeconds(
  observedAt: string | undefined,
  now: () => Date
): number | undefined {
  if (!observedAt) {
    return undefined;
  }

  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) {
    return undefined;
  }

  return Math.max(0, Math.floor((now().getTime() - observedMs) / 1000));
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
