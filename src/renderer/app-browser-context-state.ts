import { useCallback, useEffect, useRef, useState } from "react";

import type { DesktopApi } from "./app-types";
import { getDesktopApi } from "./app-desktop-api";
import type {
  BrowserContextSourceSnapshot,
  BrowserContextTabDiscoveryResult
} from "../shared/browser-context-source";

export function createUnknownBrowserContextSourceSnapshot(): BrowserContextSourceSnapshot {
  return {
    schemaVersion: 1,
    selectedTab: null,
    contextState: "missing",
    paused: false,
    disconnected: false,
    clearedForTurn: false,
    blockers: [],
    eligibleTabCount: 0,
    discoveryState: "not-probed",
    generatedAt: new Date(0).toISOString()
  };
}

export interface BrowserContextSourceState {
  snapshot: BrowserContextSourceSnapshot;
  discovery: BrowserContextTabDiscoveryResult | null;
  loading: boolean;
  actionPending: boolean;
  error: string;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  refresh: () => Promise<void>;
  discover: () => Promise<void>;
  selectTab: (tabId: number) => Promise<void>;
  togglePause: () => Promise<void>;
  toggleDisconnect: () => Promise<void>;
  clearForTurn: () => Promise<void>;
}

export function useBrowserContextSource(
  api: DesktopApi = getDesktopApi()
): BrowserContextSourceState {
  const [snapshot, setSnapshot] = useState<BrowserContextSourceSnapshot>(
    createUnknownBrowserContextSourceSnapshot
  );
  const [discovery, setDiscovery] = useState<BrowserContextTabDiscoveryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;

  const applySnapshot = useCallback((next: BrowserContextSourceSnapshot) => {
    setSnapshot(next);
    setError("");
  }, []);

  const runAction = useCallback(async (action: () => Promise<BrowserContextSourceSnapshot>) => {
    setActionPending(true);
    try {
      applySnapshot(await action());
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setActionPending(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [nextSnapshot, nextDiscovery] = await Promise.all([
          apiRef.current.getBrowserContextSource(),
          apiRef.current.discoverBrowserTabs()
        ]);
        if (cancelled) {
          return;
        }
        applySnapshot(nextSnapshot);
        setDiscovery(nextDiscovery);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    const unsubscribe = apiRef.current.onBrowserContextChanged((next) => {
      applySnapshot(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applySnapshot]);

  const refresh = useCallback(() => runAction(() => apiRef.current.refreshBrowserContext()), [runAction]);

  const discover = useCallback(async () => {
    setActionPending(true);
    try {
      const nextDiscovery = await apiRef.current.discoverBrowserTabs();
      setDiscovery(nextDiscovery);
      applySnapshot(await apiRef.current.getBrowserContextSource());
    } catch (discoverError) {
      setError(discoverError instanceof Error ? discoverError.message : String(discoverError));
    } finally {
      setActionPending(false);
    }
  }, [applySnapshot]);

  const selectTab = useCallback(
    (tabId: number) => runAction(async () => {
      const next = await apiRef.current.selectBrowserTab({ tabId });
      setPickerOpen(false);
      return next;
    }),
    [runAction]
  );

  const togglePause = useCallback(
    () => runAction(() => apiRef.current.pauseBrowserContext()),
    [runAction]
  );

  const toggleDisconnect = useCallback(
    () => runAction(() => apiRef.current.disconnectBrowserContext()),
    [runAction]
  );

  const clearForTurn = useCallback(
    () => runAction(() => apiRef.current.clearBrowserContext()),
    [runAction]
  );

  return {
    snapshot,
    discovery,
    loading,
    actionPending,
    error,
    pickerOpen,
    setPickerOpen,
    refresh,
    discover,
    selectTab,
    togglePause,
    toggleDisconnect,
    clearForTurn
  };
}
