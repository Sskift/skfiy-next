import { afterEach, describe, expect, it, vi } from "vitest";

const chromeListeners = {
  onMessage: [],
  onInstalled: [],
  onStartup: []
};

globalThis.chrome = {
  runtime: {
    id: "test-extension-id",
    getManifest: () => ({
      manifest_version: 3,
      name: "skfiy Chrome Adapter",
      version: "0.0.16",
      permissions: ["activeTab", "downloads", "nativeMessaging", "scripting", "storage", "tabs"],
      optional_host_permissions: ["http://*/*", "https://*/*", "<all_urls>"]
    }),
    onMessage: {
      addListener: (listener) => chromeListeners.onMessage.push(listener)
    },
    onInstalled: {
      addListener: (listener) => chromeListeners.onInstalled.push(listener)
    },
    onStartup: {
      addListener: (listener) => chromeListeners.onStartup.push(listener)
    }
  }
};
globalThis.__SKFIY_DISABLE_AUTO_HEARTBEAT = true;

const background = await import("./background.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mapTabBlockerCategory", () => {
  it("maps internal extension pages to internal-page", () => {
    expect(background.mapTabBlockerCategory("internal_chrome_page")).toBe("internal-page");
    expect(background.mapTabBlockerCategory("chrome_extension_page")).toBe("internal-page");
  });

  it("maps file urls, host policy, and site access blockers", () => {
    expect(background.mapTabBlockerCategory("file_url_not_supported")).toBe("file-page");
    expect(background.mapTabBlockerCategory("blocked_by_host_policy")).toBe("host-policy");
    expect(background.mapTabBlockerCategory("blocked_by_chrome_host_permission")).toBe("site-access");
    expect(background.mapTabBlockerCategory("chrome_host_permission_missing")).toBe("site-access");
  });

  it("maps capture permission and content script blockers", () => {
    expect(background.mapTabBlockerCategory("chrome_capture_permission_missing")).toBe("screenshot");
    expect(background.mapTabBlockerCategory("content_script_not_loaded")).toBe("content-script");
  });

  it("maps unsupported schemes and rejects unknown blockers", () => {
    expect(background.mapTabBlockerCategory("unsupported_url_scheme")).toBe("unsupported-scheme");
    expect(background.mapTabBlockerCategory("tab_summary_failed")).toBeNull();
    expect(background.mapTabBlockerCategory(undefined)).toBeNull();
  });
});

describe("background service worker source-control wiring", () => {
  it("registers the runtime message, install, and startup listeners", () => {
    expect(chromeListeners.onMessage).toHaveLength(1);
    expect(chromeListeners.onInstalled).toHaveLength(1);
    expect(chromeListeners.onStartup).toHaveLength(1);
  });

  it("exposes the diagnostics surface used by the popup and dashboard", () => {
    expect(globalThis.skfiyChromeAdapterDiagnostics).toBeTruthy();
    expect(typeof globalThis.skfiyChromeAdapterDiagnostics.readStatus).toBe("function");
    expect(typeof globalThis.skfiyChromeAdapterDiagnostics.readPageControlHealth).toBe("function");
  });

  it("keeps the tabs discover message type stable for the native host bridge", () => {
    expect(background.MESSAGE_TYPES.TABS_DISCOVER).toBe("skfiy.tabs.discover");
    expect(background.MESSAGE_TYPES.PAGE_CONTROL_HEALTH).toBe("skfiy.page_control.health");
    expect(background.MESSAGE_TYPES.PAGE_SENSITIVE_PAUSE).toBe("skfiy.page.sensitive_pause");
  });
});
