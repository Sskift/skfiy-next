import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "./app-types";
import type { ChromeCompatibilityHealth } from "../shared/chrome-extension-compatibility";
import {
  createUnknownChromeCompatibilityHealth,
  readChromeCompatibilityBanner,
  readChromeCompatibilityTone,
  useChromeCompatibility
} from "./app-chrome-compatibility-state";

function createHealth(
  overrides: Partial<ChromeCompatibilityHealth> = {}
): ChromeCompatibilityHealth {
  return {
    ...createUnknownChromeCompatibilityHealth(),
    ...overrides,
    compatibility: {
      ...createUnknownChromeCompatibilityHealth().compatibility,
      ...(overrides.compatibility ?? {})
    },
    staleness: {
      ...createUnknownChromeCompatibilityHealth().staleness,
      ...(overrides.staleness ?? {})
    },
    nativeHost: {
      ...createUnknownChromeCompatibilityHealth().nativeHost,
      ...(overrides.nativeHost ?? {})
    }
  };
}

function createFakeApi(health: ChromeCompatibilityHealth) {
  return {
    getChromeCompatibility: vi.fn(async () => health)
  } as unknown as DesktopApi;
}

describe("readChromeCompatibilityTone", () => {
  it("maps compatible to ready", () => {
    const health = createHealth({
      compatibility: { state: "compatible", appVersion: "0.1.0", extensionVersion: "0.0.17", minVersion: "0.0.16", maxTestedVersion: "0.0.17" }
    });

    expect(readChromeCompatibilityTone(health)).toBe("ready");
  });

  it("maps extension_outdated and extension_untested to warning", () => {
    const outdated = createHealth({
      compatibility: { state: "extension_outdated", appVersion: "0.1.0", extensionVersion: "0.0.1", minVersion: "0.0.16", maxTestedVersion: "0.0.17" }
    });
    const untested = createHealth({
      compatibility: { state: "extension_untested", appVersion: "0.1.0", extensionVersion: "9.9.9", minVersion: "0.0.16", maxTestedVersion: "0.0.17" }
    });

    expect(readChromeCompatibilityTone(outdated)).toBe("warning");
    expect(readChromeCompatibilityTone(untested)).toBe("warning");
  });

  it("maps unknown to neutral", () => {
    const health = createHealth({
      compatibility: { state: "unknown", appVersion: "0.1.0", extensionVersion: null, minVersion: "0.0.16", maxTestedVersion: "0.0.17" }
    });

    expect(readChromeCompatibilityTone(health)).toBe("neutral");
  });

  it("maps a stale or mismatched native host to danger", () => {
    const stale = createHealth({
      staleness: { nativeHostStale: true, extensionStale: false, cliStale: false, helperStale: false },
      nativeHost: { state: "mismatched", installedSkfiyVersion: "0.0.9", reason: "stale" }
    });
    const mismatched = createHealth({
      nativeHost: { state: "mismatched", installedSkfiyVersion: null, reason: "mismatch" }
    });

    expect(readChromeCompatibilityTone(stale)).toBe("danger");
    expect(readChromeCompatibilityTone(mismatched)).toBe("danger");
  });
});

describe("readChromeCompatibilityBanner", () => {
  it("returns null when compatible", () => {
    const health = createHealth({
      appVersion: "0.1.0",
      compatibility: { state: "compatible", appVersion: "0.1.0", extensionVersion: "0.0.17", minVersion: "0.0.16", maxTestedVersion: "0.0.17" }
    });

    expect(readChromeCompatibilityBanner(health)).toBeNull();
  });

  it("includes both versions in the banner copy", () => {
    const health = createHealth({
      appVersion: "0.1.0",
      compatibility: {
        state: "extension_outdated",
        appVersion: "0.1.0",
        extensionVersion: "0.0.16",
        minVersion: "0.0.16",
        maxTestedVersion: "0.0.17",
        reason: "Chrome extension v0.0.16 is older than the minimum supported v0.0.16.",
        nextAction: "Reload the unpacked extension from chrome-extension/ to update."
      }
    });

    const banner = readChromeCompatibilityBanner(health);

    expect(banner).not.toBeNull();
    expect(banner?.title).toContain("v0.0.16");
    expect(banner?.title).toContain("v0.1.0");
    expect(banner?.tone).toBe("warning");
    expect(banner?.nextAction).toContain("Reload the unpacked extension");
  });

  it("falls back to the on-disk extension version in the title", () => {
    const health = createHealth({
      appVersion: "0.1.0",
      extension: { state: "on-disk", version: "0.0.17", source: "packaged-extension-manifest" },
      compatibility: { state: "unknown", appVersion: "0.1.0", extensionVersion: null, minVersion: "0.0.16", maxTestedVersion: "0.0.17" }
    });

    const banner = readChromeCompatibilityBanner(health);

    expect(banner?.title).toContain("v0.0.17");
    expect(banner?.tone).toBe("neutral");
  });
});

describe("useChromeCompatibility", () => {
  it("loads compatibility health from the desktop api", async () => {
    const health = createHealth({
      appVersion: "0.1.0",
      compatibility: { state: "compatible", appVersion: "0.1.0", extensionVersion: "0.0.17", minVersion: "0.0.16", maxTestedVersion: "0.0.17" }
    });
    const api = createFakeApi(health);

    const { result } = renderHook(() => useChromeCompatibility(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.health).toEqual(health);
    expect(result.current.error).toBe("");
  });

  it("refreshes on demand", async () => {
    const first = createHealth({ appVersion: "0.1.0" });
    const second = createHealth({ appVersion: "0.2.0" });
    const api = {
      getChromeCompatibility: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
    } as unknown as DesktopApi;

    const { result } = renderHook(() => useChromeCompatibility(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.health.appVersion).toBe("0.1.0");

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.health.appVersion).toBe("0.2.0");
    expect(api.getChromeCompatibility).toHaveBeenCalledTimes(2);
  });

  it("surfaces load errors without throwing", async () => {
    const api = {
      getChromeCompatibility: vi.fn().mockRejectedValue(new Error("boom"))
    } as unknown as DesktopApi;

    const { result } = renderHook(() => useChromeCompatibility(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("boom");
    expect(result.current.health).toEqual(createUnknownChromeCompatibilityHealth());
  });
});
