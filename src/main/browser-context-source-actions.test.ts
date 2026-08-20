import { describe, expect, it, vi } from "vitest";

import type { ChromeExtensionConnectionStatus } from "./chrome-native-host.js";
import { createBrowserContextSourceActions } from "./browser-context-source-actions.js";
import { createBrowserContextSourceStore } from "./browser-context-source-store.js";

const OBSERVED_AT = "2026-08-20T12:00:00.000Z";

function createReadyConnection(): ChromeExtensionConnectionStatus {
  return {
    state: "connected",
    liveConnection: "connected",
    path: "/tmp/chrome-extension-connection.json",
    observedAt: OBSERVED_AT,
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
        { id: 5, title: "Example", url: "https://example.test/", host: "example.test", scheme: "https:", eligible: true },
        { id: 6, title: "Settings", url: "chrome://settings/", scheme: "chrome:", eligible: false, blocker: "internal_chrome_page" }
      ]
    }
  };
}

function createActions(
  connection: ChromeExtensionConnectionStatus = createReadyConnection()
) {
  const store = createBrowserContextSourceStore();
  const readConnectionStatus = vi.fn(async () => connection);
  const emitChange = vi.fn();
  const actions = createBrowserContextSourceActions({
    store,
    homeDir: "/Users/tester",
    readConnectionStatus,
    emitChange
  });

  return { store, actions, readConnectionStatus, emitChange };
}

describe("createBrowserContextSourceActions", () => {
  it("returns a snapshot from getSnapshot", async () => {
    const { actions } = createActions();

    const snapshot = await actions.getSnapshot();

    expect(snapshot.contextState).toBe("ready");
    expect(snapshot.discoveryState).toBe("passed");
    expect(snapshot.eligibleTabCount).toBe(1);
  });

  it("discovers tabs from the heartbeat and caches them in the store", async () => {
    const { actions, store } = createActions();

    const discovery = await actions.discoverTabs();

    expect(discovery.result).toBe("passed");
    expect(discovery.tabs).toHaveLength(2);
    expect(store.getState().discovery).toEqual(discovery);
  });

  it("reports a blocked discovery when the heartbeat has no pageTabs", async () => {
    const connection = createReadyConnection();
    delete connection.pageTabs;
    const { actions } = createActions(connection);

    const discovery = await actions.discoverTabs();

    expect(discovery.result).toBe("blocked");
    expect(discovery.tabs).toEqual([]);
    expect(discovery.reason).toContain("No tab discovery");
  });

  it("selects an eligible tab and emits a change event", async () => {
    const { actions, store, emitChange } = createActions();

    await actions.discoverTabs();
    const snapshot = await actions.selectTab(5);

    expect(store.getState().selectedTabId).toBe(5);
    expect(snapshot.selectedTab?.tabId).toBe(5);
    expect(snapshot.selectedTab?.host).toBe("example.test");
    expect(emitChange).toHaveBeenCalledWith(snapshot);
  });

  it("rejects selecting a blocked tab", async () => {
    const { actions } = createActions();

    await actions.discoverTabs();

    await expect(actions.selectTab(6)).rejects.toThrow("not eligible");
  });

  it("rejects selecting a tab that is not in discovery", async () => {
    const { actions } = createActions();

    await actions.discoverTabs();

    await expect(actions.selectTab(99)).rejects.toThrow("not found");
  });

  it("rejects an invalid tab id", async () => {
    const { actions } = createActions();

    await expect(actions.selectTab(-1)).rejects.toThrow("positive integer");
  });

  it("refreshes the snapshot from a fresh heartbeat read", async () => {
    const { actions, readConnectionStatus } = createActions();

    await actions.refresh();

    expect(readConnectionStatus).toHaveBeenCalled();
  });

  it("pauses and resumes, emitting snapshots each time", async () => {
    const { actions, store, emitChange } = createActions();

    const paused = await actions.pause();
    expect(paused.paused).toBe(true);
    expect(paused.contextState).toBe("sensitive-paused");
    expect(store.getState().paused).toBe(true);

    const resumed = await actions.resume();
    expect(resumed.paused).toBe(false);
    expect(resumed.contextState).toBe("ready");
    expect(emitChange).toHaveBeenCalledTimes(2);
  });

  it("disconnects and reconnects", async () => {
    const { actions, store } = createActions();

    const disconnected = await actions.disconnect();
    expect(disconnected.disconnected).toBe(true);
    expect(disconnected.contextState).toBe("unavailable");
    expect(store.getState().disconnected).toBe(true);

    const reconnected = await actions.reconnect();
    expect(reconnected.disconnected).toBe(false);
    expect(reconnected.contextState).toBe("ready");
  });

  it("clears for the current turn", async () => {
    const { actions, store } = createActions();

    const cleared = await actions.clearForTurn();
    expect(cleared.clearedForTurn).toBe(true);
    expect(cleared.contextState).toBe("unavailable");
    expect(store.getState().clearedForTurn).toBe(true);
  });

  it("readTurnContext resets clearedForTurn and returns the full context", async () => {
    const { actions, store } = createActions();

    await actions.clearForTurn();
    expect(store.getState().clearedForTurn).toBe(true);

    const context = await actions.readTurnContext();

    expect(store.getState().clearedForTurn).toBe(false);
    expect(context.state).toBe("ready");
    expect(context.visibleText).toBe("Hello");
  });

  it("readTurnContext applies the paused override to the prompt context", async () => {
    const { actions } = createActions();

    await actions.pause();
    const context = await actions.readTurnContext();

    expect(context.state).toBe("sensitive-paused");
    expect(context.visibleText).toBeUndefined();
  });
});
