import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "./app-types";
import type {
  BrowserContextSourceSnapshot,
  BrowserContextTabDiscoveryResult
} from "../shared/browser-context-source";
import { createUnknownBrowserContextSourceSnapshot, useBrowserContextSource } from "./app-browser-context-state";

function createSnapshot(
  overrides: Partial<BrowserContextSourceSnapshot> = {}
): BrowserContextSourceSnapshot {
  return {
    ...createUnknownBrowserContextSourceSnapshot(),
    ...overrides
  };
}

function createDiscovery(
  overrides: Partial<BrowserContextTabDiscoveryResult> = {}
): BrowserContextTabDiscoveryResult {
  return {
    result: "passed",
    tabs: [],
    ...overrides
  };
}

function createFakeApi(
  snapshot: BrowserContextSourceSnapshot = createSnapshot()
) {
  const changeListeners = new Set<(snapshot: BrowserContextSourceSnapshot) => void>();
  const api = {
    getBrowserContextSource: vi.fn(async () => snapshot),
    discoverBrowserTabs: vi.fn(async () => createDiscovery()),
    selectBrowserTab: vi.fn(async (input: { tabId: number }) =>
      createSnapshot({ selectedTab: { tabId: input.tabId, host: "example.test" } })
    ),
    refreshBrowserContext: vi.fn(async () =>
      createSnapshot({ contextState: "ready" })
    ),
    pauseBrowserContext: vi.fn(async () =>
      createSnapshot({ paused: true, contextState: "sensitive-paused" })
    ),
    disconnectBrowserContext: vi.fn(async () =>
      createSnapshot({ disconnected: true, contextState: "unavailable" })
    ),
    clearBrowserContext: vi.fn(async () =>
      createSnapshot({ clearedForTurn: true, contextState: "unavailable" })
    ),
    onBrowserContextChanged: vi.fn((callback: (snapshot: BrowserContextSourceSnapshot) => void) => {
      changeListeners.add(callback);
      return () => changeListeners.delete(callback);
    })
  } as unknown as DesktopApi & {
    emitChange: (snapshot: BrowserContextSourceSnapshot) => void;
  };
  (api as unknown as { emitChange: (snapshot: BrowserContextSourceSnapshot) => void }).emitChange =
    (next) => changeListeners.forEach((listener) => listener(next));

  return { api, changeListeners };
}

describe("useBrowserContextSource", () => {
  it("loads the snapshot and discovery on mount", async () => {
    const { api } = createFakeApi(createSnapshot({ contextState: "ready" }));
    const { result } = renderHook(() => useBrowserContextSource(api));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.snapshot.contextState).toBe("ready");
    expect(result.current.discovery?.result).toBe("passed");
    expect(api.getBrowserContextSource).toHaveBeenCalledTimes(1);
    expect(api.discoverBrowserTabs).toHaveBeenCalledTimes(1);
  });

  it("subscribes to browser context change events", async () => {
    const { api, changeListeners } = createFakeApi();
    const { result } = renderHook(() => useBrowserContextSource(api));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      for (const listener of changeListeners) {
        listener(createSnapshot({ contextState: "partial" }));
      }
    });

    expect(result.current.snapshot.contextState).toBe("partial");
  });

  it("unsubscribes on unmount", async () => {
    const { api, changeListeners } = createFakeApi();
    const { unmount } = renderHook(() => useBrowserContextSource(api));

    await waitFor(() => expect(changeListeners.size).toBe(1));

    unmount();
    expect(changeListeners.size).toBe(0);
  });

  it("refreshes the snapshot and tracks pending state", async () => {
    const { api } = createFakeApi();
    const { result } = renderHook(() => useBrowserContextSource(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });

    expect(api.refreshBrowserContext).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.contextState).toBe("ready");
    expect(result.current.actionPending).toBe(false);
  });

  it("selects a tab and closes the picker", async () => {
    const { api } = createFakeApi();
    const { result } = renderHook(() => useBrowserContextSource(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setPickerOpen(true));
    expect(result.current.pickerOpen).toBe(true);

    await act(async () => {
      await result.current.selectTab(7);
    });

    expect(api.selectBrowserTab).toHaveBeenCalledWith({ tabId: 7 });
    expect(result.current.snapshot.selectedTab?.tabId).toBe(7);
    expect(result.current.pickerOpen).toBe(false);
  });

  it("toggles pause and disconnect through the api", async () => {
    const { api } = createFakeApi();
    const { result } = renderHook(() => useBrowserContextSource(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.togglePause();
    });
    expect(api.pauseBrowserContext).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.paused).toBe(true);

    await act(async () => {
      await result.current.toggleDisconnect();
    });
    expect(api.disconnectBrowserContext).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.disconnected).toBe(true);
  });

  it("clears for the current turn", async () => {
    const { api } = createFakeApi();
    const { result } = renderHook(() => useBrowserContextSource(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.clearForTurn();
    });

    expect(api.clearBrowserContext).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.clearedForTurn).toBe(true);
  });

  it("re-discovers tabs and refreshes the snapshot", async () => {
    const { api } = createFakeApi();
    const { result } = renderHook(() => useBrowserContextSource(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.discover();
    });

    expect(api.discoverBrowserTabs).toHaveBeenCalledTimes(2);
    expect(api.getBrowserContextSource).toHaveBeenCalledTimes(2);
  });

  it("surfaces action errors without crashing", async () => {
    const { api } = createFakeApi();
    api.refreshBrowserContext = vi.fn(async () => {
      throw new Error("extension offline");
    });
    const { result } = renderHook(() => useBrowserContextSource(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe("extension offline");
    expect(result.current.actionPending).toBe(false);
  });
});
