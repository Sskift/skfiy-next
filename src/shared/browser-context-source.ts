export const BROWSER_CONTEXT_SOURCE_SCHEMA_VERSION = 1;

export const BROWSER_CONTEXT_BLOCKER_CATEGORIES = [
  "internal-page",
  "file-page",
  "host-policy",
  "site-access",
  "content-script",
  "screenshot",
  "unsupported-scheme"
] as const;

export type BrowserContextBlockerCategory =
  typeof BROWSER_CONTEXT_BLOCKER_CATEGORIES[number];

export const BROWSER_CONTEXT_BLOCKER_LABELS: Record<
  BrowserContextBlockerCategory,
  string
> = {
  "internal-page": "Internal page",
  "file-page": "File page",
  "host-policy": "Host policy",
  "site-access": "Site access",
  "content-script": "Content script",
  screenshot: "Screenshot",
  "unsupported-scheme": "Unsupported scheme"
};

export const BROWSER_CONTEXT_BLOCKER_NEXT_ACTIONS: Record<
  BrowserContextBlockerCategory,
  string
> = {
  "internal-page": "Open a normal http or https page before using Browser Context.",
  "file-page": "Open a normal http or https page before using Browser Context.",
  "host-policy": "Allow this host in skfiy Chrome policy, then re-scan tabs.",
  "site-access": "Grant Chrome site access for this host in the skfiy extension popup, then re-scan tabs.",
  "content-script": "Reload the page so the skfiy content script can load, then re-scan tabs.",
  screenshot: "Grant visible-tab capture in the skfiy extension popup, then re-scan tabs.",
  "unsupported-scheme": "Open a normal http or https page before using Browser Context."
};

export interface BrowserContextBlocker {
  category: BrowserContextBlockerCategory;
  label: string;
  detail?: string;
  nextAction?: string;
}

export interface BrowserContextTabSummary {
  tabId: number;
  windowId?: number;
  active?: boolean;
  title?: string;
  url?: string;
  host?: string;
  scheme?: string;
  eligible: boolean;
  blocker?: string;
  blockerCategory?: BrowserContextBlockerCategory;
  nextAction?: string;
}

export interface BrowserContextTabDiscoveryResult {
  result: "passed" | "blocked";
  tabs: BrowserContextTabSummary[];
  reason?: string;
  observedAt?: string;
}

export interface BrowserContextSelectedTab {
  tabId: number;
  title?: string;
  host?: string;
  url?: string;
  scheme?: string;
  active?: boolean;
  observedAt?: string;
  freshnessSeconds?: number;
  blocker?: string;
  blockerCategory?: BrowserContextBlockerCategory;
  nextAction?: string;
}

export type BrowserContextDiscoveryState = "passed" | "blocked" | "not-probed";

export interface BrowserContextSourceSnapshot {
  schemaVersion: 1;
  selectedTab: BrowserContextSelectedTab | null;
  contextState: string;
  paused: boolean;
  disconnected: boolean;
  clearedForTurn: boolean;
  blockers: BrowserContextBlocker[];
  eligibleTabCount: number;
  discoveryState: BrowserContextDiscoveryState;
  discoveryReason?: string;
  discoveryObservedAt?: string;
  generatedAt: string;
}

const EXTENSION_BLOCKER_CATEGORY_MAP: Record<string, BrowserContextBlockerCategory> = {
  internal_chrome_page: "internal-page",
  chrome_extension_page: "internal-page",
  file_url_not_supported: "file-page",
  blocked_by_host_policy: "host-policy",
  blocked_by_chrome_host_permission: "site-access",
  chrome_host_permission_missing: "site-access",
  chrome_capture_permission_missing: "screenshot",
  unsupported_url_scheme: "unsupported-scheme"
};

const CONTENT_SCRIPT_BLOCKER_PREFIXES = [
  "content_script",
  "content-script"
];

export function mapBrowserContextBlockerCategory(
  blocker: string | undefined
): BrowserContextBlockerCategory | undefined {
  if (!blocker) {
    return undefined;
  }

  const direct = EXTENSION_BLOCKER_CATEGORY_MAP[blocker];
  if (direct) {
    return direct;
  }

  if (CONTENT_SCRIPT_BLOCKER_PREFIXES.some((prefix) => blocker.startsWith(prefix))) {
    return "content-script";
  }

  return undefined;
}

export function createBrowserContextBlocker(input: {
  category: BrowserContextBlockerCategory;
  detail?: string;
  nextAction?: string;
}): BrowserContextBlocker {
  return {
    category: input.category,
    label: BROWSER_CONTEXT_BLOCKER_LABELS[input.category],
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.nextAction ? { nextAction: input.nextAction } : {})
  };
}

export function normalizeBrowserContextTabSummary(
  raw: unknown
): BrowserContextTabSummary | undefined {
  const record = readRecord(raw);
  const tabId = readInteger(record?.tabId) ?? readInteger(record?.id);
  if (!record || tabId === undefined) {
    return undefined;
  }

  const blocker = readOptionalString(record.blocker);
  const blockerCategory = readBlockerCategory(record.blockerCategory)
    ?? mapBrowserContextBlockerCategory(blocker);

  return {
    tabId,
    ...(readInteger(record.windowId) !== undefined
      ? { windowId: readInteger(record.windowId) }
      : {}),
    ...(typeof record.active === "boolean" ? { active: record.active } : {}),
    ...(readOptionalString(record.title) ? { title: readOptionalString(record.title) } : {}),
    ...(readOptionalString(record.url) ? { url: readOptionalString(record.url) } : {}),
    ...(readOptionalString(record.host) ? { host: readOptionalString(record.host) } : {}),
    ...(readOptionalString(record.scheme) ? { scheme: readOptionalString(record.scheme) } : {}),
    eligible: record.eligible === true,
    ...(blocker ? { blocker } : {}),
    ...(blockerCategory ? { blockerCategory } : {}),
    ...(readOptionalString(record.nextAction) ? { nextAction: readOptionalString(record.nextAction) } : {})
  };
}

export function normalizeBrowserContextTabDiscoveryResult(
  raw: unknown
): BrowserContextTabDiscoveryResult | undefined {
  const record = readRecord(raw);
  if (!record) {
    return undefined;
  }

  const tabs = Array.isArray(record.tabs)
    ? record.tabs
      .map((tab) => normalizeBrowserContextTabSummary(tab))
      .filter((tab): tab is BrowserContextTabSummary => Boolean(tab))
    : [];

  return {
    result: record.result === "blocked" ? "blocked" : "passed",
    tabs,
    ...(readOptionalString(record.reason) ? { reason: readOptionalString(record.reason) } : {}),
    ...(readOptionalString(record.observedAt) ? { observedAt: readOptionalString(record.observedAt) } : {})
  };
}

export function normalizeBrowserContextSourceSnapshot(
  raw: unknown
): BrowserContextSourceSnapshot | null {
  const record = readRecord(raw);
  if (!record || record.schemaVersion !== BROWSER_CONTEXT_SOURCE_SCHEMA_VERSION) {
    return null;
  }

  const contextState = readOptionalString(record.contextState);
  if (!contextState) {
    return null;
  }

  const generatedAt = readOptionalString(record.generatedAt);
  if (!generatedAt) {
    return null;
  }

  const selectedTabRecord = readRecord(record.selectedTab);
  const selectedTabId = readInteger(selectedTabRecord?.tabId);
  const selectedTab = selectedTabRecord && selectedTabId !== undefined
    ? {
        tabId: selectedTabId,
        ...(readInteger(selectedTabRecord.windowId) !== undefined
          ? { windowId: readInteger(selectedTabRecord.windowId) }
          : {}),
        ...(typeof selectedTabRecord.active === "boolean"
          ? { active: selectedTabRecord.active }
          : {}),
        ...(readOptionalString(selectedTabRecord.title)
          ? { title: readOptionalString(selectedTabRecord.title) }
          : {}),
        ...(readOptionalString(selectedTabRecord.host)
          ? { host: readOptionalString(selectedTabRecord.host) }
          : {}),
        ...(readOptionalString(selectedTabRecord.url)
          ? { url: readOptionalString(selectedTabRecord.url) }
          : {}),
        ...(readOptionalString(selectedTabRecord.scheme)
          ? { scheme: readOptionalString(selectedTabRecord.scheme) }
          : {}),
        ...(readOptionalString(selectedTabRecord.observedAt)
          ? { observedAt: readOptionalString(selectedTabRecord.observedAt) }
          : {}),
        ...(readInteger(selectedTabRecord.freshnessSeconds) !== undefined
          ? { freshnessSeconds: readInteger(selectedTabRecord.freshnessSeconds) }
          : {}),
        ...(readOptionalString(selectedTabRecord.blocker)
          ? { blocker: readOptionalString(selectedTabRecord.blocker) }
          : {}),
        ...(readBlockerCategory(selectedTabRecord.blockerCategory)
          ? { blockerCategory: readBlockerCategory(selectedTabRecord.blockerCategory) }
          : {}),
        ...(readOptionalString(selectedTabRecord.nextAction)
          ? { nextAction: readOptionalString(selectedTabRecord.nextAction) }
          : {})
      }
    : null;

  const blockers = Array.isArray(record.blockers)
    ? record.blockers
      .map((blocker) => normalizeBrowserContextBlocker(blocker))
      .filter((blocker): blocker is BrowserContextBlocker => Boolean(blocker))
    : [];

  const discoveryState = readDiscoveryState(record.discoveryState);
  const eligibleTabCount = readInteger(record.eligibleTabCount) ?? 0;

  return {
    schemaVersion: BROWSER_CONTEXT_SOURCE_SCHEMA_VERSION,
    selectedTab,
    contextState,
    paused: record.paused === true,
    disconnected: record.disconnected === true,
    clearedForTurn: record.clearedForTurn === true,
    blockers,
    eligibleTabCount,
    discoveryState,
    generatedAt,
    ...(readOptionalString(record.discoveryReason)
      ? { discoveryReason: readOptionalString(record.discoveryReason) }
      : {}),
    ...(readOptionalString(record.discoveryObservedAt)
      ? { discoveryObservedAt: readOptionalString(record.discoveryObservedAt) }
      : {})
  };
}

function normalizeBrowserContextBlocker(raw: unknown): BrowserContextBlocker | undefined {
  const record = readRecord(raw);
  const category = readBlockerCategory(record?.category);
  if (!record || !category) {
    return undefined;
  }

  return {
    category,
    label: readOptionalString(record.label) ?? BROWSER_CONTEXT_BLOCKER_LABELS[category],
    ...(readOptionalString(record.detail) ? { detail: readOptionalString(record.detail) } : {}),
    ...(readOptionalString(record.nextAction)
      ? { nextAction: readOptionalString(record.nextAction) }
      : {})
  };
}

function readDiscoveryState(value: unknown): BrowserContextDiscoveryState {
  return value === "passed" || value === "blocked" || value === "not-probed"
    ? value
    : "not-probed";
}

function readBlockerCategory(value: unknown): BrowserContextBlockerCategory | undefined {
  return typeof value === "string"
    && (BROWSER_CONTEXT_BLOCKER_CATEGORIES as readonly string[]).includes(value)
    ? value as BrowserContextBlockerCategory
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
