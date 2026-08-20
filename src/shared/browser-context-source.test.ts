import { describe, expect, it } from "vitest";

import {
  BROWSER_CONTEXT_BLOCKER_CATEGORIES,
  BROWSER_CONTEXT_BLOCKER_LABELS,
  BROWSER_CONTEXT_BLOCKER_NEXT_ACTIONS,
  BROWSER_CONTEXT_SOURCE_SCHEMA_VERSION,
  createBrowserContextBlocker,
  mapBrowserContextBlockerCategory,
  normalizeBrowserContextSourceSnapshot,
  normalizeBrowserContextTabDiscoveryResult,
  normalizeBrowserContextTabSummary
} from "./browser-context-source";

describe("mapBrowserContextBlockerCategory", () => {
  it("maps internal extension pages to the internal-page category", () => {
    expect(mapBrowserContextBlockerCategory("internal_chrome_page")).toBe("internal-page");
    expect(mapBrowserContextBlockerCategory("chrome_extension_page")).toBe("internal-page");
  });

  it("maps file urls to the file-page category", () => {
    expect(mapBrowserContextBlockerCategory("file_url_not_supported")).toBe("file-page");
  });

  it("maps host policy and site access blockers", () => {
    expect(mapBrowserContextBlockerCategory("blocked_by_host_policy")).toBe("host-policy");
    expect(mapBrowserContextBlockerCategory("blocked_by_chrome_host_permission")).toBe("site-access");
    expect(mapBrowserContextBlockerCategory("chrome_host_permission_missing")).toBe("site-access");
  });

  it("maps capture permission and content script blockers", () => {
    expect(mapBrowserContextBlockerCategory("chrome_capture_permission_missing")).toBe("screenshot");
    expect(mapBrowserContextBlockerCategory("content_script_not_loaded")).toBe("content-script");
  });

  it("maps unsupported schemes and rejects unknown blockers", () => {
    expect(mapBrowserContextBlockerCategory("unsupported_url_scheme")).toBe("unsupported-scheme");
    expect(mapBrowserContextBlockerCategory("tab_summary_failed")).toBeUndefined();
    expect(mapBrowserContextBlockerCategory(undefined)).toBeUndefined();
    expect(mapBrowserContextBlockerCategory("")).toBeUndefined();
  });
});

describe("createBrowserContextBlocker", () => {
  it("fills the label from the category taxonomy", () => {
    const blocker = createBrowserContextBlocker({ category: "host-policy", detail: "example.test" });

    expect(blocker.label).toBe("Host policy");
    expect(blocker.detail).toBe("example.test");
    expect(blocker.nextAction).toBeUndefined();
  });

  it("keeps an explicit next action", () => {
    const blocker = createBrowserContextBlocker({
      category: "screenshot",
      nextAction: "Grant capture."
    });

    expect(blocker.label).toBe("Screenshot");
    expect(blocker.nextAction).toBe("Grant capture.");
  });

  it("exposes a label and next action for every category", () => {
    for (const category of BROWSER_CONTEXT_BLOCKER_CATEGORIES) {
      expect(BROWSER_CONTEXT_BLOCKER_LABELS[category].length).toBeGreaterThan(0);
      expect(BROWSER_CONTEXT_BLOCKER_NEXT_ACTIONS[category].length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeBrowserContextTabSummary", () => {
  it("normalizes an eligible tab", () => {
    const summary = normalizeBrowserContextTabSummary({
      id: 7,
      windowId: 2,
      active: true,
      title: "Example",
      url: "https://example.test/",
      host: "example.test",
      scheme: "https:",
      state: "eligible",
      eligible: true
    });

    expect(summary).toEqual({
      tabId: 7,
      windowId: 2,
      active: true,
      title: "Example",
      url: "https://example.test/",
      host: "example.test",
      scheme: "https:",
      eligible: true
    });
  });

  it("normalizes a blocked tab and derives the blocker category", () => {
    const summary = normalizeBrowserContextTabSummary({
      id: 9,
      title: "Settings",
      url: "chrome://settings/",
      host: "",
      scheme: "chrome:",
      eligible: false,
      blocker: "internal_chrome_page",
      nextAction: "Open a normal HTTP(S) page."
    });

    expect(summary).toEqual({
      tabId: 9,
      title: "Settings",
      url: "chrome://settings/",
      scheme: "chrome:",
      eligible: false,
      blocker: "internal_chrome_page",
      blockerCategory: "internal-page",
      nextAction: "Open a normal HTTP(S) page."
    });
  });

  it("rejects entries without a tab id", () => {
    expect(normalizeBrowserContextTabSummary({ title: "no id" })).toBeUndefined();
    expect(normalizeBrowserContextTabSummary(null)).toBeUndefined();
    expect(normalizeBrowserContextTabSummary("tab")).toBeUndefined();
  });
});

describe("normalizeBrowserContextTabDiscoveryResult", () => {
  it("normalizes a passed discovery result", () => {
    const result = normalizeBrowserContextTabDiscoveryResult({
      result: "passed",
      tabs: [
        { id: 1, eligible: true },
        { id: 2, eligible: false, blocker: "file_url_not_supported" }
      ],
      observedAt: "2026-08-20T00:00:00.000Z"
    });

    expect(result?.result).toBe("passed");
    expect(result?.tabs).toHaveLength(2);
    expect(result?.tabs[1]?.blockerCategory).toBe("file-page");
    expect(result?.observedAt).toBe("2026-08-20T00:00:00.000Z");
  });

  it("defaults to passed and drops invalid tabs", () => {
    const result = normalizeBrowserContextTabDiscoveryResult({
      tabs: [{ eligible: true }, "bad", { id: 4, eligible: false }]
    });

    expect(result?.result).toBe("passed");
    expect(result?.tabs).toHaveLength(1);
    expect(result?.tabs[0]?.tabId).toBe(4);
  });
});

describe("normalizeBrowserContextSourceSnapshot", () => {
  const validSnapshot = {
    schemaVersion: BROWSER_CONTEXT_SOURCE_SCHEMA_VERSION,
    selectedTab: {
      tabId: 3,
      title: "Example",
      host: "example.test",
      url: "https://example.test/",
      scheme: "https:",
      active: false,
      observedAt: "2026-08-20T00:00:00.000Z",
      freshnessSeconds: 12
    },
    contextState: "ready",
    paused: false,
    disconnected: false,
    clearedForTurn: false,
    blockers: [
      { category: "site-access", label: "Site access", detail: "example.test" }
    ],
    eligibleTabCount: 2,
    discoveryState: "passed",
    discoveryObservedAt: "2026-08-20T00:00:00.000Z",
    generatedAt: "2026-08-20T00:00:01.000Z"
  };

  it("normalizes a complete snapshot", () => {
    const snapshot = normalizeBrowserContextSourceSnapshot(validSnapshot);

    expect(snapshot).toEqual(validSnapshot);
  });

  it("normalizes a snapshot without a selected tab", () => {
    const snapshot = normalizeBrowserContextSourceSnapshot({
      ...validSnapshot,
      selectedTab: null,
      contextState: "missing",
      blockers: [],
      eligibleTabCount: 0,
      discoveryState: "not-probed"
    });

    expect(snapshot?.selectedTab).toBeNull();
    expect(snapshot?.contextState).toBe("missing");
    expect(snapshot?.discoveryState).toBe("not-probed");
  });

  it("rejects snapshots with the wrong schema version", () => {
    expect(normalizeBrowserContextSourceSnapshot({
      ...validSnapshot,
      schemaVersion: 2
    })).toBeNull();
  });

  it("rejects snapshots without a context state or generated timestamp", () => {
    expect(normalizeBrowserContextSourceSnapshot({
      ...validSnapshot,
      contextState: ""
    })).toBeNull();
    expect(normalizeBrowserContextSourceSnapshot({
      ...validSnapshot,
      generatedAt: ""
    })).toBeNull();
  });

  it("drops blockers with an unknown category and defaults the discovery state", () => {
    const snapshot = normalizeBrowserContextSourceSnapshot({
      ...validSnapshot,
      blockers: [
        { category: "mystery" },
        { category: "host-policy" }
      ],
      discoveryState: "weird"
    });

    expect(snapshot?.blockers).toEqual([
      { category: "host-policy", label: "Host policy" }
    ]);
    expect(snapshot?.discoveryState).toBe("not-probed");
  });

  it("returns null for non-object input", () => {
    expect(normalizeBrowserContextSourceSnapshot(null)).toBeNull();
    expect(normalizeBrowserContextSourceSnapshot("snapshot")).toBeNull();
  });
});
