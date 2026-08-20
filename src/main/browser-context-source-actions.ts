import type { BrowserPageContext } from "./browser-page-context.js";
import type {
  BrowserContextSourceStore,
  BrowserContextSourceStoreState
} from "./browser-context-source-store.js";
import {
  readBrowserContextSource,
  readDiscoveryFromConnection,
  type ReadChromeExtensionConnectionStatus
} from "./browser-context-source-reader.js";
import type {
  BrowserContextSourceSnapshot,
  BrowserContextTabDiscoveryResult
} from "../shared/browser-context-source.js";

export type BrowserContextSourceChange = (
  snapshot: BrowserContextSourceSnapshot
) => void;

export interface BrowserContextSourceActions {
  getSnapshot(): Promise<BrowserContextSourceSnapshot>;
  discoverTabs(): Promise<BrowserContextTabDiscoveryResult>;
  selectTab(tabId: number): Promise<BrowserContextSourceSnapshot>;
  refresh(): Promise<BrowserContextSourceSnapshot>;
  pause(): Promise<BrowserContextSourceSnapshot>;
  resume(): Promise<BrowserContextSourceSnapshot>;
  disconnect(): Promise<BrowserContextSourceSnapshot>;
  reconnect(): Promise<BrowserContextSourceSnapshot>;
  clearForTurn(): Promise<BrowserContextSourceSnapshot>;
  readTurnContext(): Promise<BrowserPageContext>;
  resetForNewTurn(): void;
}

export function createBrowserContextSourceActions({
  store,
  homeDir,
  readConnectionStatus,
  emitChange
}: {
  store: BrowserContextSourceStore;
  homeDir: string;
  readConnectionStatus: ReadChromeExtensionConnectionStatus;
  emitChange?: BrowserContextSourceChange;
}): BrowserContextSourceActions {
  async function readSnapshot(): Promise<BrowserContextSourceSnapshot> {
    const read = await readBrowserContextSource({
      store,
      homeDir,
      readConnectionStatus
    });
    return read.snapshot;
  }

  async function emit(snapshot: BrowserContextSourceSnapshot): Promise<BrowserContextSourceSnapshot> {
    emitChange?.(snapshot);
    return snapshot;
  }

  return {
    async getSnapshot() {
      return readSnapshot();
    },

    async discoverTabs() {
      const connection = await readConnectionStatus({ homeDir });
      const discovery = readDiscoveryFromConnection(connection)
        ?? store.getState().discovery
        ?? {
          result: "blocked" as const,
          reason: "No tab discovery has been reported by the skfiy Chrome extension yet.",
          tabs: []
        };
      store.updateDiscovery(discovery);
      return discovery;
    },

    async selectTab(tabId) {
      if (!Number.isInteger(tabId) || tabId <= 0) {
        throw new Error("Browser Context tab id must be a positive integer.");
      }

      const discovery = store.getState().discovery;
      const tab = discovery?.tabs.find((entry) => entry.tabId === tabId);
      if (!tab) {
        throw new Error(`Tab ${tabId} was not found in the latest tab discovery. Re-scan tabs and retry.`);
      }
      if (!tab.eligible) {
        throw new Error(`Tab ${tabId} is not eligible for Browser Context: ${tab.blocker ?? "unknown blocker"}.`);
      }

      store.selectTab(tabId);
      return emit(await readSnapshot());
    },

    async refresh() {
      const connection = await readConnectionStatus({ homeDir });
      const discovery = readDiscoveryFromConnection(connection);
      if (discovery) {
        store.updateDiscovery(discovery);
      }
      return emit(await readSnapshot());
    },

    async pause() {
      store.setPaused(true);
      return emit(await readSnapshot());
    },

    async resume() {
      store.setPaused(false);
      return emit(await readSnapshot());
    },

    async disconnect() {
      store.setDisconnected(true);
      return emit(await readSnapshot());
    },

    async reconnect() {
      store.setDisconnected(false);
      return emit(await readSnapshot());
    },

    async clearForTurn() {
      store.clearForTurn();
      return emit(await readSnapshot());
    },

    async readTurnContext() {
      store.resetForNewTurn();
      const read = await readBrowserContextSource({
        store,
        homeDir,
        readConnectionStatus
      });
      return read.context;
    },

    resetForNewTurn() {
      store.resetForNewTurn();
    }
  };
}

export function readBrowserContextSourceStoreState(
  store: BrowserContextSourceStore
): BrowserContextSourceStoreState {
  return store.getState();
}
