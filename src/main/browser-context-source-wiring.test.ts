import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_CONTEXT_SOURCE_IPC_CHANNELS,
  registerBrowserContextSourceIpc,
  type BrowserContextSourceIpcMain
} from "./browser-context-source-wiring.js";
import type { BrowserContextSourceActions } from "./browser-context-source-actions.js";
import type {
  BrowserContextSourceSnapshot,
  BrowserContextTabDiscoveryResult
} from "../shared/browser-context-source.js";

function createSnapshot(
  overrides: Partial<BrowserContextSourceSnapshot> = {}
): BrowserContextSourceSnapshot {
  return {
    schemaVersion: 1,
    selectedTab: null,
    contextState: "ready",
    paused: false,
    disconnected: false,
    clearedForTurn: false,
    blockers: [],
    eligibleTabCount: 1,
    discoveryState: "passed",
    generatedAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  };
}

function createFakeActions(): {
  actions: BrowserContextSourceActions;
  calls: string[];
} {
  const calls: string[] = [];
  const snapshot = createSnapshot();
  const actions: BrowserContextSourceActions = {
    getSnapshot: vi.fn(async () => {
      calls.push("getSnapshot");
      return snapshot;
    }),
    discoverTabs: vi.fn(async () => {
      calls.push("discoverTabs");
      return { result: "passed" as const, tabs: [] } satisfies BrowserContextTabDiscoveryResult;
    }),
    selectTab: vi.fn(async (tabId) => {
      calls.push(`selectTab:${tabId}`);
      return createSnapshot({ selectedTab: { tabId } });
    }),
    refresh: vi.fn(async () => {
      calls.push("refresh");
      return snapshot;
    }),
    pause: vi.fn(async () => {
      calls.push("pause");
      return createSnapshot({ paused: true, contextState: "sensitive-paused" });
    }),
    resume: vi.fn(async () => {
      calls.push("resume");
      return snapshot;
    }),
    disconnect: vi.fn(async () => {
      calls.push("disconnect");
      return createSnapshot({ disconnected: true, contextState: "unavailable" });
    }),
    reconnect: vi.fn(async () => {
      calls.push("reconnect");
      return snapshot;
    }),
    clearForTurn: vi.fn(async () => {
      calls.push("clearForTurn");
      return createSnapshot({ clearedForTurn: true, contextState: "unavailable" });
    }),
    readTurnContext: vi.fn(async () => {
      calls.push("readTurnContext");
      return { state: "ready" as const };
    }),
    resetForNewTurn: vi.fn(() => {
      calls.push("resetForNewTurn");
    })
  };

  return { actions, calls };
}

function createFakeIpcMain(): BrowserContextSourceIpcMain & {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };
}

describe("registerBrowserContextSourceIpc", () => {
  it("registers every browser context IPC channel", () => {
    const ipcMain = createFakeIpcMain();
    const { actions } = createFakeActions();

    registerBrowserContextSourceIpc({ ipcMain, actions });

    for (const channel of BROWSER_CONTEXT_SOURCE_IPC_CHANNELS) {
      expect(ipcMain.handlers.has(channel)).toBe(true);
    }
  });

  it("returns the snapshot from the get handler", async () => {
    const ipcMain = createFakeIpcMain();
    const { actions } = createFakeActions();
    registerBrowserContextSourceIpc({ ipcMain, actions });

    const result = await ipcMain.handlers.get("skfiy:get-browser-context-source")?.({},);

    expect(result).toEqual(createSnapshot());
  });

  it("returns the discovery result from the discover handler", async () => {
    const ipcMain = createFakeIpcMain();
    const { actions } = createFakeActions();
    registerBrowserContextSourceIpc({ ipcMain, actions });

    const result = await ipcMain.handlers.get("skfiy:discover-browser-tabs")?.({});

    expect(result).toEqual({ result: "passed", tabs: [] });
  });

  it("selects a tab from a validated input payload", async () => {
    const ipcMain = createFakeIpcMain();
    const { actions } = createFakeActions();
    registerBrowserContextSourceIpc({ ipcMain, actions });

    const result = await ipcMain.handlers.get("skfiy:select-browser-tab")?.({}, { tabId: 7 });

    expect((result as BrowserContextSourceSnapshot).selectedTab?.tabId).toBe(7);
    expect(actions.selectTab).toHaveBeenCalledWith(7);
  });

  it("rejects a select payload without a positive integer tabId", async () => {
    const ipcMain = createFakeIpcMain();
    const { actions } = createFakeActions();
    registerBrowserContextSourceIpc({ ipcMain, actions });

    await expect(
      ipcMain.handlers.get("skfiy:select-browser-tab")?.({}, { tabId: "7" })
    ).rejects.toThrow("positive integer");
    expect(actions.selectTab).not.toHaveBeenCalled();
  });

  it("toggles pause based on the current snapshot", async () => {
    const ipcMain = createFakeIpcMain();
    const { actions, calls } = createFakeActions();
    registerBrowserContextSourceIpc({ ipcMain, actions });

    await ipcMain.handlers.get("skfiy:pause-browser-context")?.({});
    expect(calls).toContain("pause");

    const pausedActions = createFakeActions();
    const pausedIpc = createFakeIpcMain();
    vi.mocked(pausedActions.actions.getSnapshot).mockResolvedValueOnce(
      createSnapshot({ paused: true })
    );
    registerBrowserContextSourceIpc({ ipcMain: pausedIpc, actions: pausedActions.actions });
    await pausedIpc.handlers.get("skfiy:pause-browser-context")?.({});
    expect(pausedActions.calls).toContain("resume");
  });

  it("toggles disconnect based on the current snapshot", async () => {
    const ipcMain = createFakeIpcMain();
    const { actions, calls } = createFakeActions();
    registerBrowserContextSourceIpc({ ipcMain, actions });

    await ipcMain.handlers.get("skfiy:disconnect-browser-context")?.({});
    expect(calls).toContain("disconnect");

    const disconnectedActions = createFakeActions();
    const disconnectedIpc = createFakeIpcMain();
    vi.mocked(disconnectedActions.actions.getSnapshot).mockResolvedValueOnce(
      createSnapshot({ disconnected: true })
    );
    registerBrowserContextSourceIpc({
      ipcMain: disconnectedIpc,
      actions: disconnectedActions.actions
    });
    await disconnectedIpc.handlers.get("skfiy:disconnect-browser-context")?.({});
    expect(disconnectedActions.calls).toContain("reconnect");
  });

  it("clears for the current turn", async () => {
    const ipcMain = createFakeIpcMain();
    const { actions, calls } = createFakeActions();
    registerBrowserContextSourceIpc({ ipcMain, actions });

    const result = await ipcMain.handlers.get("skfiy:clear-browser-context")?.({});

    expect(calls).toContain("clearForTurn");
    expect((result as BrowserContextSourceSnapshot).clearedForTurn).toBe(true);
  });

  it("refreshes the snapshot", async () => {
    const ipcMain = createFakeIpcMain();
    const { actions, calls } = createFakeActions();
    registerBrowserContextSourceIpc({ ipcMain, actions });

    await ipcMain.handlers.get("skfiy:refresh-browser-context")?.({});
    expect(calls).toContain("refresh");
  });
});
