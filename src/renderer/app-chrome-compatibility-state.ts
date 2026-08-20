import { useCallback, useEffect, useRef, useState } from "react";

import type { DesktopApi } from "./app-types";
import { getDesktopApi } from "./app-desktop-api";
import type { BrowserContextStateTone } from "./app-browser-context-panel";
import type { ChromeCompatibilityHealth } from "../shared/chrome-extension-compatibility";

export function createUnknownChromeCompatibilityHealth(): ChromeCompatibilityHealth {
  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    appVersion: "unknown",
    nativeHost: {
      state: "unknown",
      installedSkfiyVersion: null,
      reason: "Chrome compatibility has not been checked."
    },
    extension: {
      state: "unknown",
      version: null,
      source: "none"
    },
    compatibility: {
      state: "unknown",
      appVersion: null,
      extensionVersion: null,
      minVersion: "0.0.16",
      maxTestedVersion: "0.0.17",
      reason: "Chrome extension version has not been reported.",
      nextAction: "Reload the unpacked extension from chrome-extension/ to update."
    },
    staleness: {
      nativeHostStale: false,
      extensionStale: false,
      cliStale: false,
      helperStale: false
    }
  };
}

export interface ChromeCompatibilityBanner {
  tone: BrowserContextStateTone;
  title: string;
  detail: string;
  nextAction: string;
}

/**
 * Map the compatibility health record onto the existing tone union:
 * - danger: native host is stale/mismatched (repair required)
 * - warning: extension is outdated or untested (non-blocking)
 * - neutral: compatibility unknown
 * - ready: everything compatible (banner hidden)
 */
export function readChromeCompatibilityTone(
  health: ChromeCompatibilityHealth
): BrowserContextStateTone {
  if (health.staleness.nativeHostStale || health.nativeHost.state === "mismatched") {
    return "danger";
  }

  if (
    health.compatibility.state === "extension_outdated"
    || health.compatibility.state === "extension_untested"
  ) {
    return "warning";
  }

  if (health.compatibility.state === "unknown") {
    return "neutral";
  }

  return "ready";
}

/**
 * Build the banner view-model. Returns null when the installation is
 * compatible (the banner is hidden in that case).
 */
export function readChromeCompatibilityBanner(
  health: ChromeCompatibilityHealth
): ChromeCompatibilityBanner | null {
  const tone = readChromeCompatibilityTone(health);

  if (tone === "ready") {
    return null;
  }

  const extensionVersion = health.compatibility.extensionVersion
    ?? health.extension.version
    ?? "unknown";
  const title = `Chrome extension v${extensionVersion} — desktop app v${health.appVersion}`;
  const detail = health.compatibility.reason ?? health.nativeHost.reason;
  const nextAction = health.compatibility.nextAction
    ?? (health.staleness.nativeHostStale
      ? "Repair the skfiy Chrome Native Messaging host installation."
      : "Reload the unpacked extension from chrome-extension/ to update.");

  return {
    tone,
    title,
    detail,
    nextAction
  };
}

export interface ChromeCompatibilityState {
  health: ChromeCompatibilityHealth;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}

export function useChromeCompatibility(
  api: DesktopApi = getDesktopApi()
): ChromeCompatibilityState {
  const [health, setHealth] = useState<ChromeCompatibilityHealth>(
    createUnknownChromeCompatibilityHealth
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const apiRef = useRef(api);
  apiRef.current = api;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await apiRef.current.getChromeCompatibility();
      setHealth(next);
      setError("");
    } catch (refreshError) {
      setError(
        refreshError instanceof Error ? refreshError.message : String(refreshError)
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await apiRef.current.getChromeCompatibility();
        if (!cancelled) {
          setHealth(next);
          setError("");
        }
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

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    health,
    loading,
    error,
    refresh
  };
}
