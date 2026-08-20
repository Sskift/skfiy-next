import { describe, expect, it, vi } from "vitest";

import type { ChromeExtensionConnectionStatus } from "./chrome-native-host.js";
import type { BrowserContextSourceStoreState } from "./browser-context-source-store.js";
import { createBrowserContextSourceStore } from "./browser-context-source-store.js";
import { readBrowserContextSource } from "./browser-context-source-reader.js";

const FIXED_NOW = new Date("2026-08-20T12:00:30.000Z");
const OBSERVED_AT = "2026-08-20T12:00:00.000Z";

function createStore(overrides: Partial<BrowserContextSourceStoreState> = {}) {
  const store = createBrowserContextSourceStore();
  if (overrides.selectedTabId !== undefined) {
    store.selectTab(overrides.selectedTabId);
  }
  if (overrides.paused) {
    store.setPaused(true);
  }
  if (overrides.disconnected) {
    store.setDisconnected(true);
  }
  if (overrides.clearedForTurn) {
    store.clearForTurn();
  }
  if (overrides.discovery) {
    store.updateDiscovery(overrides.discovery);
  }
  return store;
}

function createConnection(
  overrides: Partial<ChromeExtensionConnectionStatus> = {}
): ChromeExtensionConnectionStatus {
  return {
    state: "connected",
    liveConnection: "connected",
    path: "/tmp/chrome-extension-connection.json",
    observedAt: OBSERVED_AT,
    ...overrides
  };
}

async function readSource(
  store: ReturnType<typeof createBrowserContextSourceStore>,
  connection: ChromeExtensionConnectionStatus
) {
  return readBrowserContextSource({
    store,
    homeDir: "/Users/tester",
    readConnectionStatus: vi.fn(async () => connection),
    now: () => FIXED_NOW
  });
}

describe("readBrowserContextSource", () => {
  it("reports a missing context when no heartbeat has been recorded", async () => {
    const store = createStore();
    const connection = createConnection({
      state: "unknown",
      reason: "No Chrome extension connection heartbeat has been recorded."
    });

    const { snapshot, context } = await readSource(store, connection);

    expect(context.state).toBe("missing");
    expect(snapshot.contextState).toBe("missing");
    expect(snapshot.selectedTab).toBeNull();
    expect(snapshot.paused).toBe(false);
    expect(snapshot.disconnected).toBe(false);
    expect(snapshot.clearedForTurn).toBe(false);
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.eligibleTabCount).toBe(0);
    expect(snapshot.discoveryState).toBe("not-probed");
  });

  it("builds a ready snapshot from a connected heartbeat with discovery", async () => {
    const store = createStore();
    const connection = createConnection({
      pageControl: {
        state: "ready",
        activeTab: { state: "available", tabId: 5, host: "example.test" }
      },
      pageObservation: {
        url: "https://example.test/",
        title: "Example",
        visibleText: "Hello",
        observedAt: OBSERVED_AT
      },
      pageTabs: {
        result: "passed",
        observedAt: OBSERVED_AT,
        tabs: [
          { id: 5, active: true, title: "Example", url: "https://example.test/", host: "example.test", scheme: "https:", eligible: true },
          { id: 6, title: "Settings", url: "chrome://settings/", scheme: "chrome:", eligible: false, blocker: "internal_chrome_page" }
        ]
      }
    });

    const { snapshot, context } = await readSource(store, connection);

    expect(context.state).toBe("ready");
    expect(context.visibleText).toBe("Hello");
    expect(snapshot.contextState).toBe("ready");
    expect(snapshot.discoveryState).toBe("passed");
    expect(snapshot.discoveryObservedAt).toBe(OBSERVED_AT);
    expect(snapshot.eligibleTabCount).toBe(1);
    expect(snapshot.blockers).toEqual([]);
  });

  it("resolves the selected tab from discovery with freshness", async () => {
    const store = createStore({ selectedTabId: 5 });
    const connection = createConnection({
      pageControl: {
        state: "ready",
        activeTab: { state: "available", tabId: 5, host: "example.test" }
      },
      pageObservation: { url: "https://example.test/", title: "Example", observedAt: OBSERVED_AT },
      pageTabs: {
        result: "passed",
        tabs: [
          { id: 5, title: "Example", url: "https://example.test/", host: "example.test", scheme: "https:", eligible: true }
        ]
      }
    });

    const { snapshot } = await readSource(store, connection);

    expect(snapshot.selectedTab).toEqual({
      tabId: 5,
      title: "Example",
      host: "example.test",
      url: "https://example.test/",
      scheme: "https:",
      observedAt: OBSERVED_AT,
      freshnessSeconds: 30
    });
  });

  it("downgrades to active_tab_unavailable when the selected tab was not observed", async () => {
    const store = createStore({ selectedTabId: 9 });
    const connection = createConnection({
      pageControl: {
        state: "ready",
        activeTab: { state: "available", tabId: 5, host: "other.test" }
      },
      pageObservation: { url: "https://other.test/", title: "Other", observedAt: OBSERVED_AT },
      pageTabs: {
        result: "passed",
        tabs: [
          { id: 5, title: "Other", url: "https://other.test/", host: "other.test", scheme: "https:", eligible: true },
          { id: 9, title: "Example", url: "https://example.test/", host: "example.test", scheme: "https:", eligible: true }
        ]
      }
    });

    const { snapshot, context } = await readSource(store, connection);

    expect(context.state).toBe("active_tab_unavailable");
    expect(context.visibleText).toBeUndefined();
    expect(snapshot.contextState).toBe("active_tab_unavailable");
    expect(snapshot.selectedTab?.tabId).toBe(9);
    expect(snapshot.selectedTab?.host).toBe("example.test");
  });

  it("reports the selected tab as unavailable when it is no longer in discovery", async () => {
    const store = createStore({ selectedTabId: 42 });
    const connection = createConnection({
      pageControl: { state: "ready", activeTab: { tabId: 5 } },
      pageObservation: { url: "https://example.test/", observedAt: OBSERVED_AT },
      pageTabs: { result: "passed", tabs: [{ id: 5, eligible: true }] }
    });

    const { snapshot, context } = await readSource(store, connection);

    expect(context.state).toBe("active_tab_unavailable");
    expect(snapshot.selectedTab).toEqual({ tabId: 42, observedAt: OBSERVED_AT, freshnessSeconds: 30 });
  });

  it("applies the paused override and strips visible text", async () => {
    const store = createStore({ paused: true });
    const connection = createConnection({
      pageControl: { state: "ready", activeTab: { tabId: 5 } },
      pageObservation: { url: "https://example.test/", visibleText: "secret", observedAt: OBSERVED_AT }
    });

    const { snapshot, context } = await readSource(store, connection);

    expect(context.state).toBe("sensitive-paused");
    expect(context.visibleText).toBeUndefined();
    expect(snapshot.contextState).toBe("sensitive-paused");
    expect(snapshot.paused).toBe(true);
  });

  it("applies the disconnected override", async () => {
    const store = createStore({ disconnected: true });
    const connection = createConnection({
      pageControl: { state: "ready", activeTab: { tabId: 5 } },
      pageObservation: { url: "https://example.test/", visibleText: "secret", observedAt: OBSERVED_AT }
    });

    const { snapshot, context } = await readSource(store, connection);

    expect(context.state).toBe("unavailable");
    expect(context.reason).toBe("Browser Context disconnected by user.");
    expect(snapshot.contextState).toBe("unavailable");
    expect(snapshot.disconnected).toBe(true);
  });

  it("applies the cleared-for-turn override", async () => {
    const store = createStore({ clearedForTurn: true });
    const connection = createConnection({
      pageControl: { state: "ready", activeTab: { tabId: 5 } },
      pageObservation: { url: "https://example.test/", visibleText: "secret", observedAt: OBSERVED_AT }
    });

    const { snapshot, context } = await readSource(store, connection);

    expect(context.state).toBe("unavailable");
    expect(context.reason).toBe("Browser Context cleared for this turn.");
    expect(snapshot.clearedForTurn).toBe(true);
  });

  it("surfaces pageControl blockers as categorized blocker rows", async () => {
    const store = createStore();
    const connection = createConnection({
      pageControl: {
        state: "blocked_by_chrome_host_permission",
        activeTab: { state: "available", tabId: 5, host: "example.test" },
        hostPolicy: { decision: "allowed" },
        chromeHostPermission: { state: "missing", host: "example.test" },
        chromeCapturePermission: { state: "missing" },
        blockers: [{ code: "blocked_by_chrome_host_permission" }]
      }
    });

    const { snapshot } = await readSource(store, connection);

    expect(snapshot.blockers).toEqual([
      { category: "site-access", label: "Site access", detail: "example.test" },
      { category: "screenshot", label: "Screenshot" }
    ]);
  });

  it("surfaces the selected tab blocker as a categorized blocker row", async () => {
    const store = createStore({ selectedTabId: 6 });
    const connection = createConnection({
      pageControl: { state: "unavailable", activeTab: { state: "unavailable" } },
      pageTabs: {
        result: "passed",
        tabs: [
          { id: 6, title: "Settings", url: "chrome://settings/", scheme: "chrome:", eligible: false, blocker: "internal_chrome_page", nextAction: "Open a normal page." }
        ]
      }
    });

    const { snapshot } = await readSource(store, connection);

    expect(snapshot.selectedTab?.blockerCategory).toBe("internal-page");
    expect(snapshot.blockers).toEqual([
      { category: "internal-page", label: "Internal page", nextAction: "Open a normal page." }
    ]);
  });

  it("falls back to the cached discovery when the heartbeat carries no pageTabs", async () => {
    const store = createStore({
      discovery: {
        result: "passed",
        observedAt: OBSERVED_AT,
        tabs: [{ tabId: 5, eligible: true, host: "cached.test" }]
      }
    });
    const connection = createConnection({
      pageControl: { state: "ready", activeTab: { tabId: 5 } },
      pageObservation: { url: "https://cached.test/", observedAt: OBSERVED_AT }
    });

    const { snapshot } = await readSource(store, connection);

    expect(snapshot.discoveryState).toBe("passed");
    expect(snapshot.eligibleTabCount).toBe(1);
  });

  it("surfaces a stale heartbeat as a stale context state", async () => {
    const store = createStore();
    const connection = createConnection({
      state: "stale",
      reason: "Chrome page context heartbeat is stale."
    });

    const { snapshot, context } = await readSource(store, connection);

    expect(context.state).toBe("stale");
    expect(snapshot.contextState).toBe("stale");
  });

  it("tolerates a connection status read failure", async () => {
    const store = createStore();
    const read = await readBrowserContextSource({
      store,
      homeDir: "/Users/tester",
      readConnectionStatus: vi.fn(async () => {
        throw new Error("heartbeat file is locked");
      }),
      now: () => FIXED_NOW
    });

    expect(read.context.state).toBe("unavailable");
    expect(read.snapshot.contextState).toBe("unavailable");
  });
});
