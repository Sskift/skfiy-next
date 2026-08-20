import { describe, expect, it } from "vitest";

import { createBrowserContextSourceStore } from "./browser-context-source-store";

describe("createBrowserContextSourceStore", () => {
  it("starts with no selection and no suppressions", () => {
    const store = createBrowserContextSourceStore();

    expect(store.getState()).toEqual({
      selectedTabId: null,
      paused: false,
      disconnected: false,
      clearedForTurn: false,
      discovery: null
    });
  });

  it("selects and clears a tab", () => {
    const store = createBrowserContextSourceStore();

    store.selectTab(7);
    expect(store.getState().selectedTabId).toBe(7);

    store.selectTab(null);
    expect(store.getState().selectedTabId).toBeNull();
  });

  it("toggles pause and disconnect independently", () => {
    const store = createBrowserContextSourceStore();

    store.setPaused(true);
    expect(store.getState().paused).toBe(true);
    expect(store.getState().disconnected).toBe(false);

    store.setDisconnected(true);
    expect(store.getState().paused).toBe(true);
    expect(store.getState().disconnected).toBe(true);

    store.setPaused(false);
    expect(store.getState().paused).toBe(false);
    expect(store.getState().disconnected).toBe(true);
  });

  it("clears for the current turn and resets on a new turn", () => {
    const store = createBrowserContextSourceStore();

    store.clearForTurn();
    expect(store.getState().clearedForTurn).toBe(true);

    store.resetForNewTurn();
    expect(store.getState().clearedForTurn).toBe(false);
  });

  it("resetForNewTurn keeps pause and disconnect state", () => {
    const store = createBrowserContextSourceStore();

    store.setPaused(true);
    store.setDisconnected(true);
    store.clearForTurn();
    store.resetForNewTurn();

    const state = store.getState();
    expect(state.clearedForTurn).toBe(false);
    expect(state.paused).toBe(true);
    expect(state.disconnected).toBe(true);
  });

  it("resetForNewTurn is a no-op when nothing was cleared", () => {
    const store = createBrowserContextSourceStore();

    store.resetForNewTurn();
    expect(store.getState().clearedForTurn).toBe(false);
  });

  it("caches tab discovery results", () => {
    const store = createBrowserContextSourceStore();
    const discovery = {
      result: "passed" as const,
      tabs: [{ tabId: 1, eligible: true }],
      observedAt: "2026-08-20T00:00:00.000Z"
    };

    store.updateDiscovery(discovery);
    expect(store.getState().discovery).toEqual(discovery);
  });
});
