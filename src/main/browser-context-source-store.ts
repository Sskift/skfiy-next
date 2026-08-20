import type { BrowserContextTabDiscoveryResult } from "../shared/browser-context-source.js";

export interface BrowserContextSourceStoreState {
  selectedTabId: number | null;
  paused: boolean;
  disconnected: boolean;
  clearedForTurn: boolean;
  discovery: BrowserContextTabDiscoveryResult | null;
}

export interface BrowserContextSourceStore {
  getState(): BrowserContextSourceStoreState;
  selectTab(tabId: number | null): void;
  setPaused(paused: boolean): void;
  setDisconnected(disconnected: boolean): void;
  clearForTurn(): void;
  resetForNewTurn(): void;
  updateDiscovery(discovery: BrowserContextTabDiscoveryResult): void;
}

export function createBrowserContextSourceStore(): BrowserContextSourceStore {
  let state: BrowserContextSourceStoreState = {
    selectedTabId: null,
    paused: false,
    disconnected: false,
    clearedForTurn: false,
    discovery: null
  };

  return {
    getState() {
      return state;
    },
    selectTab(tabId) {
      state = {
        ...state,
        selectedTabId: tabId
      };
    },
    setPaused(paused) {
      state = {
        ...state,
        paused
      };
    },
    setDisconnected(disconnected) {
      state = {
        ...state,
        disconnected
      };
    },
    clearForTurn() {
      state = {
        ...state,
        clearedForTurn: true
      };
    },
    resetForNewTurn() {
      if (!state.clearedForTurn) {
        return;
      }
      state = {
        ...state,
        clearedForTurn: false
      };
    },
    updateDiscovery(discovery) {
      state = {
        ...state,
        discovery
      };
    }
  };
}
