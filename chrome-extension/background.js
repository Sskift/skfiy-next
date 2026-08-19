export const NATIVE_MESSAGING_HOST_NAME = "com.sskift.skfiy";
export const CONTENT_SCRIPT_FILE = "content-script.js";
export const MESSAGE_SCHEMA_VERSION = 1;

export const HOST_POLICY_SHAPE = Object.freeze({
  defaultMode: "ask",
  allowedHosts: [],
  currentTurnAllowedHosts: [],
  blockedHosts: []
});

export const MESSAGE_TYPES = Object.freeze({
  PAGE_OBSERVE: "skfiy.page.observe",
  PAGE_OBSERVE_RESULT: "skfiy.page.observe_result",
  PAGE_DIAGNOSTICS: "skfiy.page.diagnostics",
  PAGE_DIAGNOSTICS_RESULT: "skfiy.page.diagnostics_result",
  PAGE_ACTION: "skfiy.page.action",
  PAGE_ACTION_RESULT: "skfiy.page.action_result",
  PAGE_SCREENSHOT: "skfiy.page.screenshot",
  PAGE_SCREENSHOT_RESULT: "skfiy.page.screenshot_result",
  PAGE_CONTROL_WAKE: "skfiy.page_control.wake",
  TABS_DISCOVER: "skfiy.tabs.discover",
  TABS_DISCOVER_RESULT: "skfiy.tabs.discover_result",
  PAGE_CONTROL_HEALTH: "skfiy.page_control.health",
  PAGE_CONTROL_HEALTH_RESULT: "skfiy.page_control.health_result",
  DOWNLOADS_STATUS: "skfiy.downloads.status",
  DOWNLOADS_STATUS_RESULT: "skfiy.downloads.status_result",
  PAGE_SENSITIVE_PAUSE: "skfiy.page.sensitive_pause",
  HOST_POLICY_REQUEST: "skfiy.host_policy.request",
  HOST_POLICY_RESPONSE: "skfiy.host_policy.response",
  HOST_POLICY_SYNC_STATUS: "skfiy.host_policy.sync_status",
  HOST_POLICY_SYNC_REFRESH: "skfiy.host_policy.sync_refresh",
  NATIVE_HEARTBEAT: "skfiy.native.heartbeat",
  NATIVE_HEARTBEAT_RESULT: "skfiy.native.heartbeat_result",
  DEV_RELOAD_STATUS: "skfiy.dev.reload_status",
  DEV_RELOAD_REQUEST: "skfiy.dev.reload",
  DEV_RELOAD_RESULT: "skfiy.dev.reload_result",
  NATIVE_MESSAGE: "skfiy.native.message"
});

const HOST_POLICY_STORAGE_KEY = "skfiyHostPolicy";
const HOST_POLICY_SYNC_STORAGE_KEY = "skfiyHostPolicySync";
const DEV_RELOAD_STORAGE_KEY = "skfiyDevReload";
const LAST_SENSITIVE_PAUSE_KEY = "lastSensitivePause";
const HOST_POLICY_SYNC_REQUEST_PREFIX = "host-policy-sync";
const DEV_RELOAD_DELAY_MS = 250;
const NATIVE_MESSAGE_TIMEOUT_MS = 3_000;
const CONTENT_SCRIPT_DIAGNOSTICS_TIMEOUT_MS = 750;
const MAX_WAKE_DIRECTIVE_AGE_MS = 30_000;
const FALLBACK_EXTENSION_MANIFEST = Object.freeze({
  manifest_version: 3,
  name: "skfiy Chrome Adapter",
  version: "0.0.16",
  minimum_chrome_version: "116",
  permissions: ["activeTab", "downloads", "nativeMessaging", "scripting", "storage", "tabs"],
  optional_host_permissions: ["http://*/*", "https://*/*", "<all_urls>"]
});

let hostPolicySyncPromise = null;
let nativeHeartbeatPromise = null;
const processedWakeDirectiveKeys = new Set();

function readExtensionManifest() {
  if (typeof chrome.runtime.getManifest === "function") {
    return chrome.runtime.getManifest();
  }

  return FALLBACK_EXTENSION_MANIFEST;
}

function readExtensionDiagnostics() {
  const manifest = {
    ...FALLBACK_EXTENSION_MANIFEST,
    ...readExtensionManifest()
  };
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const optionalHostPermissions = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    id: chrome.runtime.id ?? null,
    name: manifest.name ?? FALLBACK_EXTENSION_MANIFEST.name,
    version: manifest.version ?? FALLBACK_EXTENSION_MANIFEST.version,
    manifestVersion: manifest.manifest_version ?? FALLBACK_EXTENSION_MANIFEST.manifest_version,
    minimumChromeVersion: manifest.minimum_chrome_version ?? null,
    capabilities: {
      activeTab: permissions.includes("activeTab"),
      downloads: permissions.includes("downloads"),
      nativeMessaging: permissions.includes("nativeMessaging"),
      scripting: permissions.includes("scripting"),
      storage: permissions.includes("storage"),
      tabs: permissions.includes("tabs"),
      optionalHostPermissions
    }
  };
}

function readPageControlProtocol() {
  const manifest = {
    ...FALLBACK_EXTENSION_MANIFEST,
    ...readExtensionManifest()
  };
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const optionalHostPermissions = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    name: "skfiy.chrome.page-control",
    extensionId: chrome.runtime.id ?? null,
    nativeHostName: NATIVE_MESSAGING_HOST_NAME,
    contentScriptFile: CONTENT_SCRIPT_FILE,
    background: {
      state: "loaded",
      serviceWorker: true
    },
    messageTypes: {
      health: MESSAGE_TYPES.PAGE_CONTROL_HEALTH,
      healthResult: MESSAGE_TYPES.PAGE_CONTROL_HEALTH_RESULT,
      diagnostics: MESSAGE_TYPES.PAGE_DIAGNOSTICS,
      observe: MESSAGE_TYPES.PAGE_OBSERVE,
      action: MESSAGE_TYPES.PAGE_ACTION,
      screenshot: MESSAGE_TYPES.PAGE_SCREENSHOT,
      wake: MESSAGE_TYPES.PAGE_CONTROL_WAKE,
      tabs: MESSAGE_TYPES.TABS_DISCOVER,
      downloads: MESSAGE_TYPES.DOWNLOADS_STATUS,
      hostPolicy: MESSAGE_TYPES.HOST_POLICY_REQUEST
    },
    permissionModel: {
      requiredPermissions: permissions,
      hostPermissions: "optional",
      optionalHostPermissions
    },
    capabilities: {
      health: true,
      diagnostics: permissions.includes("tabs"),
      observe: permissions.includes("scripting"),
      domActions: permissions.includes("scripting"),
      screenshot: permissions.includes("activeTab") && permissions.includes("tabs"),
      downloads: permissions.includes("downloads"),
      nativeMessaging: permissions.includes("nativeMessaging"),
      hostPolicy: true
    }
  };
}

function getHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function getHostPermissionDetails(url) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }

    return {
      origin: parsedUrl.origin,
      host: parsedUrl.host,
      permissionOrigin: `${parsedUrl.protocol}//${parsedUrl.hostname}/*`
    };
  } catch {
    return null;
  }
}

function createHostPermissionMessage(permissionDetails) {
  return `Missing optional Chrome host permission for ${permissionDetails.permissionOrigin}. Grant site access before page diagnostics or actions can run.`;
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function clampDownloadsLimit(value) {
  if (!Number.isFinite(value)) {
    return 20;
  }
  return Math.max(1, Math.min(50, Math.trunc(value)));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function readHostPolicy() {
  const stored = await chrome.storage.local.get(HOST_POLICY_STORAGE_KEY);
  return {
    ...HOST_POLICY_SHAPE,
    ...(stored[HOST_POLICY_STORAGE_KEY] ?? {})
  };
}

function countHostPolicyEntries(policy) {
  return [
    policy?.allowedHosts,
    policy?.currentTurnAllowedHosts,
    policy?.blockedHosts
  ].reduce((count, entries) => {
    return count + (Array.isArray(entries) ? entries.length : 0);
  }, 0);
}

async function readHostPolicySyncStatus(policyOverride) {
  const policy = policyOverride ?? await readHostPolicy();
  const stored = await chrome.storage.local.get(HOST_POLICY_SYNC_STORAGE_KEY);
  const status = stored[HOST_POLICY_SYNC_STORAGE_KEY] ?? {};
  const entryCount = countHostPolicyEntries(policy);
  const lastError = status.lastError ?? status.error ?? null;
  const nativeBridgeState = status.nativeBridgeState
    ?? (status.state === "synced"
      ? "connected"
      : status.state === "syncing"
        ? "connecting"
        : status.state === "error"
          ? "unavailable"
          : "unknown");

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    state: status.state ?? "unknown",
    source: status.source ?? (status.state === "synced" ? "native_host" : "local_storage"),
    updatedAt: status.updatedAt ?? null,
    entryCount,
    trigger: status.trigger ?? null,
    requestId: status.requestId ?? null,
    requestedAt: status.requestedAt ?? null,
    completedAt: status.completedAt ?? null,
    hostPolicyState: status.hostPolicyState ?? null,
    nativeHostPolicyState: status.nativeHostPolicyState ?? status.hostPolicyState ?? null,
    nativeBridgeState,
    nativeLaunchOrigin: status.nativeLaunchOrigin ?? null,
    nativeMessageType: status.nativeMessageType ?? null,
    nativeResponseType: status.nativeResponseType ?? null,
    nativeResponseResult: status.nativeResponseResult ?? null,
    lastError,
    error: status.error ?? null
  };
}

async function writeDevReloadStatus(status) {
  await chrome.storage.local.set({
    [DEV_RELOAD_STORAGE_KEY]: {
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      reloadAvailable: typeof chrome.runtime.reload === "function",
      reloadDelayMs: DEV_RELOAD_DELAY_MS,
      ...status
    }
  });
}

function summarizeHeartbeatFromSyncStatus(syncStatus) {
  const lastError = syncStatus?.lastError ?? syncStatus?.error ?? null;
  const state = syncStatus?.state === "synced"
    ? "connected"
    : syncStatus?.state === "syncing"
      ? "checking"
      : syncStatus?.state === "error"
        ? "error"
        : "unknown";

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    state,
    trigger: syncStatus?.trigger ?? null,
    requestId: syncStatus?.requestId ?? null,
    requestedAt: syncStatus?.requestedAt ?? null,
    completedAt: syncStatus?.completedAt ?? null,
    updatedAt: syncStatus?.updatedAt ?? null,
    bridgeState: syncStatus?.nativeBridgeState ?? null,
    launchOrigin: syncStatus?.nativeLaunchOrigin ?? null,
    messageType: syncStatus?.nativeMessageType ?? null,
    responseType: syncStatus?.nativeResponseType ?? null,
    responseResult: syncStatus?.nativeResponseResult ?? null,
    lastError
  };
}

async function readDevReloadStatus(syncStatusOverride) {
  const stored = await chrome.storage.local.get(DEV_RELOAD_STORAGE_KEY);
  const status = stored[DEV_RELOAD_STORAGE_KEY] ?? {};
  const heartbeat = syncStatusOverride
    ? summarizeHeartbeatFromSyncStatus(syncStatusOverride)
    : status.heartbeat ?? null;

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    state: status.state ?? "idle",
    source: status.source ?? "extension",
    reloadAvailable: typeof chrome.runtime.reload === "function",
    reloadDelayMs: status.reloadDelayMs ?? DEV_RELOAD_DELAY_MS,
    requestedAt: status.requestedAt ?? null,
    completedAt: status.completedAt ?? null,
    reloadAt: status.reloadAt ?? null,
    updatedAt: status.updatedAt ?? null,
    requestId: status.requestId ?? null,
    trigger: status.trigger ?? null,
    reason: status.reason ?? null,
    message: status.message ?? null,
    browserPolicy: status.browserPolicy ?? null,
    heartbeat,
    lastError: status.lastError ?? null
  };
}

async function readActiveTabDiagnosticsTarget(tabId) {
  if (Number.isInteger(tabId)) {
    try {
      return {
        tab: await chrome.tabs.get(tabId),
        lastError: null
      };
    } catch (error) {
      return {
        tab: undefined,
        lastError: readErrorMessage(error)
      };
    }
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return {
      tab: Array.isArray(tabs) ? tabs[0] : undefined,
      lastError: null
    };
  } catch (error) {
    return {
      tab: undefined,
      lastError: readErrorMessage(error)
    };
  }
}

async function readChromeHostPermissionStatus(permissionDetails) {
  if (!permissionDetails) {
    return {
      state: "not_applicable",
      reason: "non_http_page",
      origins: []
    };
  }

  const origins = [permissionDetails.permissionOrigin];
  if (typeof chrome.permissions?.contains !== "function") {
    return {
      state: "unknown",
      reason: "permissions_api_unavailable",
      code: "chrome_host_permission_unknown",
      origin: permissionDetails.origin,
      host: permissionDetails.host,
      origins
    };
  }

  try {
    const granted = await chrome.permissions.contains({ origins });
    if (granted) {
      return {
        state: "granted",
        origin: permissionDetails.origin,
        host: permissionDetails.host,
        origins
      };
    }

    return {
      state: "missing",
      reason: "chrome_host_permission_missing",
      code: "chrome_host_permission_missing",
      origin: permissionDetails.origin,
      host: permissionDetails.host,
      origins,
      message: createHostPermissionMessage(permissionDetails)
    };
  } catch (error) {
    return {
      state: "unknown",
      reason: "permissions_check_failed",
      code: "chrome_host_permission_unknown",
      origin: permissionDetails.origin,
      host: permissionDetails.host,
      origins,
      lastError: readErrorMessage(error)
    };
  }
}

function createChromeCapturePermissionMessage() {
  return "Chrome visible-tab capture requires <all_urls> permission or an activeTab user gesture.";
}

async function readChromeCapturePermissionStatus(tab) {
  if (!Number.isInteger(tab?.id)) {
    return {
      state: "unknown",
      reason: "active_tab_unavailable",
      origins: ["<all_urls>"]
    };
  }
  if (typeof chrome.permissions?.contains !== "function") {
    return {
      state: "unknown",
      reason: "permissions_api_unavailable",
      code: "chrome_capture_permission_unknown",
      origins: ["<all_urls>"]
    };
  }

  try {
    const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    if (granted) {
      return {
        state: "granted",
        reason: "all_urls_granted",
        origins: ["<all_urls>"]
      };
    }

    return {
      state: "missing",
      reason: "chrome_capture_permission_missing",
      code: "chrome_capture_permission_missing",
      origins: ["<all_urls>"],
      message: createChromeCapturePermissionMessage()
    };
  } catch (error) {
    return {
      state: "unknown",
      reason: "permissions_check_failed",
      code: "chrome_capture_permission_unknown",
      origins: ["<all_urls>"],
      lastError: readErrorMessage(error)
    };
  }
}

async function readContentScriptSession(tab, policyDecision, hostPermission, options = {}) {
  if (!Number.isInteger(tab?.id)) {
    return {
      state: "unavailable",
      reason: "missing_tab_id"
    };
  }

  if (policyDecision.decision !== "allowed") {
    return {
      state: "blocked_by_host_policy",
      reason: policyDecision.reason
    };
  }

  if (hostPermission.state !== "granted" && hostPermission.state !== "not_applicable") {
    return {
      state: "blocked_by_chrome_host_permission",
      reason: hostPermission.reason,
      lastError: hostPermission.message ?? hostPermission.lastError ?? null
    };
  }

  const firstAttempt = await requestContentScriptDiagnostics(tab);
  if (firstAttempt.state === "loaded") {
    return firstAttempt;
  }

  if (options.injectContentScript === true && firstAttempt.reason === "content_script_not_loaded") {
    try {
      await ensureContentScript(tab.id);
    } catch (error) {
      return {
        state: "unavailable",
        reason: "content_script_injection_failed",
        lastError: readErrorMessage(error),
        previousState: firstAttempt.state,
        previousReason: firstAttempt.reason
      };
    }

    const secondAttempt = await requestContentScriptDiagnostics(tab);
    return {
      ...secondAttempt,
      injected: true
    };
  }

  return firstAttempt;
}

async function requestContentScriptDiagnostics(tab) {
  let timeout;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tab.id, {
        type: MESSAGE_TYPES.PAGE_DIAGNOSTICS,
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        requestId: `content-diagnostics-${Date.now()}`
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("content_script_diagnostics_timeout"));
        }, CONTENT_SCRIPT_DIAGNOSTICS_TIMEOUT_MS);
      })
    ]);

    if (response?.type === MESSAGE_TYPES.PAGE_DIAGNOSTICS_RESULT && response.session) {
      return {
        state: "loaded",
        ...response.session
      };
    }

    return {
      state: "not_loaded",
      reason: "content_script_not_loaded"
    };
  } catch (error) {
    const lastError = readErrorMessage(error);
    if (lastError.includes("content_script_diagnostics_timeout")) {
      return {
        state: "unavailable",
        reason: "content_script_diagnostics_timeout",
        lastError
      };
    }
    return {
      state: lastError.includes("Receiving end does not exist") ? "not_loaded" : "unavailable",
      reason: lastError.includes("Receiving end does not exist")
        ? "content_script_not_loaded"
        : "content_script_unavailable",
      lastError
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readCurrentTabDiagnostics(policy, tabId, options = {}) {
  const { tab, lastError } = await readActiveTabDiagnosticsTarget(tabId);
  if (!tab) {
    return {
      state: "unavailable",
      host: "",
      hostPolicy: {
        decision: "blocked",
        reason: "active_tab_unavailable"
      },
      chromeHostPermission: {
        state: "unknown",
        reason: "active_tab_unavailable",
        origins: []
      },
      contentScript: {
        state: "not_queried",
        reason: "active_tab_unavailable"
      },
      lastError
    };
  }

  const host = getHost(tab.url ?? "");
  const permissionDetails = getHostPermissionDetails(tab.url ?? "");
  const policyDecision = decideHostPolicy(policy, host);
  const hostPermission = await readChromeHostPermissionStatus(permissionDetails);
  const capturePermission = await readChromeCapturePermissionStatus(tab);
  const contentScript = await readContentScriptSession(tab, policyDecision, hostPermission, options);

  return {
    state: "available",
    tabId: tab.id ?? null,
    windowId: tab.windowId ?? null,
    host,
    origin: permissionDetails?.origin ?? null,
    hostPolicy: policyDecision,
    chromeHostPermission: hostPermission,
    chromeCapturePermission: capturePermission,
    contentScript
  };
}

async function readHostPolicySnapshot(tabId, options = {}) {
  const policy = await readHostPolicy();
  const syncStatus = await readHostPolicySyncStatus(policy);
  const currentTab = await readCurrentTabDiagnostics(policy, tabId, options);
  const devReload = await readDevReloadStatus(syncStatus);
  return {
    policy,
    syncStatus,
    diagnostics: createDiagnostics(policy, syncStatus, currentTab, devReload)
  };
}

function createTabNextAction(blocker) {
  switch (blocker) {
    case "internal_chrome_page":
    case "chrome_extension_page":
    case "file_url_not_supported":
    case "unsupported_url_scheme":
      return "Open a normal HTTP(S) page before asking skfiy to control Chrome.";
    case "blocked_by_host_policy":
      return "Allow this host in skfiy Chrome policy, then retry tab discovery.";
    case "blocked_by_chrome_host_permission":
      return "Grant Chrome site access for this host, then retry tab discovery.";
    case "content_script_not_loaded":
      return "Reload the page or extension so the skfiy content script can load.";
    default:
      return "Inspect Chrome extension status before controlling this tab.";
  }
}

function redactTabUrl(url) {
  if (typeof url !== "string" || url.length === 0) {
    return "";
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === "file:") {
      return "file://<redacted>";
    }
    if (parsedUrl.protocol === "chrome-extension:") {
      return `${parsedUrl.protocol}//${parsedUrl.host}/<redacted>`;
    }
    parsedUrl.hash = "";
    for (const key of Array.from(parsedUrl.searchParams.keys())) {
      parsedUrl.searchParams.set(key, "<redacted>");
    }
    return parsedUrl.toString().replaceAll("%3Credacted%3E", "<redacted>");
  } catch {
    return "";
  }
}

async function summarizeDiscoverableTab(tab, policy) {
  const safeUrl = redactTabUrl(tab?.url ?? "");
  const title = typeof tab?.title === "string" ? tab.title.slice(0, 160) : "";
  let parsedUrl;
  try {
    parsedUrl = new URL(tab?.url ?? "");
  } catch {
    parsedUrl = undefined;
  }
  const scheme = parsedUrl?.protocol ?? "";
  const host = parsedUrl?.host ?? "";
  const base = {
    ...(Number.isInteger(tab?.id) ? { id: tab.id } : {}),
    ...(Number.isInteger(tab?.windowId) ? { windowId: tab.windowId } : {}),
    ...(typeof tab?.active === "boolean" ? { active: tab.active } : {}),
    ...(title ? { title } : {}),
    url: safeUrl,
    host,
    scheme
  };
  const blocked = (blocker, details = {}) => ({
    ...base,
    state: "blocked",
    eligible: false,
    blocker,
    nextAction: createTabNextAction(blocker),
    ...details
  });

  if (!parsedUrl) {
    return blocked("unsupported_url_scheme");
  }
  if (scheme === "chrome:") {
    return blocked("internal_chrome_page");
  }
  if (scheme === "chrome-extension:") {
    return blocked("chrome_extension_page");
  }
  if (scheme === "file:") {
    return blocked("file_url_not_supported");
  }
  if (scheme !== "http:" && scheme !== "https:") {
    return blocked("unsupported_url_scheme");
  }

  const permissionDetails = getHostPermissionDetails(tab?.url ?? "");
  const policyDecision = decideHostPolicy(policy, host);
  if (policyDecision.decision !== "allowed") {
    return blocked("blocked_by_host_policy", {
      hostPolicy: policyDecision
    });
  }

  const chromeHostPermission = await readChromeHostPermissionStatus(permissionDetails);
  if (chromeHostPermission.state !== "granted") {
    return blocked("blocked_by_chrome_host_permission", {
      chromeHostPermission
    });
  }

  const contentScript = await readContentScriptSession(tab, policyDecision, chromeHostPermission, {
    injectContentScript: false
  });
  if (contentScript.state !== "loaded") {
    return blocked(contentScript.reason ?? "content_script_not_loaded", {
      contentScript: {
        state: contentScript.state,
        reason: contentScript.reason ?? null,
        lastError: contentScript.lastError ?? null
      }
    });
  }

  return {
    ...base,
    state: "eligible",
    eligible: true
  };
}

async function discoverChromeTabs(requestId = `tabs-discover-${Date.now()}`) {
  let pageTabs;
  try {
    const policy = await readHostPolicy();
    const tabs = await chrome.tabs.query({});
    const summaries = [];
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      try {
        summaries.push(await summarizeDiscoverableTab(tab, policy));
      } catch (error) {
        summaries.push({
          id: Number.isInteger(tab?.id) ? tab.id : undefined,
          windowId: Number.isInteger(tab?.windowId) ? tab.windowId : undefined,
          title: typeof tab?.title === "string" ? tab.title : "",
          url: redactTabUrl(tab?.url ?? ""),
          host: getHost(tab?.url ?? ""),
          state: "blocked",
          eligible: false,
          blocker: "tab_summary_failed",
          reason: readErrorMessage(error),
          nextAction: "inspect_extension_status"
        });
      }
    }
    pageTabs = {
      result: "passed",
      tabs: summaries
    };
  } catch (error) {
    pageTabs = {
      result: "blocked",
      reason: readErrorMessage(error),
      tabs: []
    };
  }
  let nativeHeartbeat;
  try {
    nativeHeartbeat = await sendNativeMessage({
      type: MESSAGE_TYPES.TABS_DISCOVER,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId,
      payload: {
        pageTabs
      }
    }, {
      syncHostPolicy: false
    });
  } catch (error) {
    nativeHeartbeat = {
      result: "error",
      reason: readErrorMessage(error)
    };
  }

  return {
    type: MESSAGE_TYPES.TABS_DISCOVER_RESULT,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId,
    result: pageTabs.result,
    ...(pageTabs.reason ? { reason: pageTabs.reason } : {}),
    tabs: pageTabs.tabs,
    nativeHeartbeat
  };
}

async function readPageControlHealth(requestId = "page-control-health", tabId) {
  const { policy, syncStatus, diagnostics } = await readHostPolicySnapshot(tabId, {
    injectContentScript: true
  });
  const pageControl = diagnostics.session.pageControl;

  return {
    type: MESSAGE_TYPES.PAGE_CONTROL_HEALTH_RESULT,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId,
    protocol: readPageControlProtocol(),
    readiness: pageControl,
    pageControl,
    blockers: Array.isArray(pageControl?.blockers) ? pageControl.blockers : [],
    policy,
    syncStatus,
    diagnostics
  };
}

function readNativeHostConnectionState(syncStatus) {
  switch (syncStatus.state) {
    case "synced":
      return "connected";
    case "syncing":
      return "connecting";
    case "error":
      return "unavailable";
    default:
      return "unknown";
  }
}

function createControlReadiness(capable, reason, nextAction) {
  return {
    capable,
    state: capable ? "available" : "blocked",
    reason,
    nextAction
  };
}

function nextActionForPageControl(state) {
  switch (state) {
    case "ready":
    case "partial":
      return "ingest_page_control";
    case "sensitive-paused":
    case "needs_confirmation":
      return "confirm_sensitive_page";
    case "blocked_by_chrome_host_permission":
      return "grant_chrome_host_permission";
    case "blocked_by_host_policy":
      return "allow_host";
    case "chrome_capture_permission_missing":
      return "grant_chrome_capture_permission";
    case "content_script_not_loaded":
    case "not_loaded":
      return "reload_or_inject_content_script";
    case "unavailable":
      return "select_active_tab";
    default:
      return "inspect_extension_status";
  }
}

function createPageControlReadiness(capabilities, currentTab) {
  const contentScript = currentTab?.contentScript ?? {};
  const contentControl = contentScript.pageControl && typeof contentScript.pageControl === "object"
    ? contentScript.pageControl
    : {};
  const contentCapabilities = contentControl.capabilities && typeof contentControl.capabilities === "object"
    ? contentControl.capabilities
    : {};
  const activeTabAvailable = currentTab?.state === "available" && Number.isInteger(currentTab?.tabId);
  const hostPolicyAllowed = currentTab?.hostPolicy?.decision === "allowed";
  const hostPermissionReady = ["granted", "not_applicable"].includes(currentTab?.chromeHostPermission?.state);
  const capturePermissionReady = currentTab?.chromeCapturePermission?.state === "granted";
  const contentScriptLoaded = contentScript.state === "loaded";
  const screenshotAvailable = activeTabAvailable
    && hostPolicyAllowed
    && capabilities?.tabs === true
    && capturePermissionReady;
  const screenshotReason = screenshotAvailable
    ? "Visible tab screenshots are available."
    : !activeTabAvailable
      ? "Active Chrome tab is unavailable."
      : !hostPolicyAllowed
        ? "Host policy has not allowed this page."
        : capabilities?.tabs !== true
          ? "Extension tabs permission is unavailable."
          : currentTab?.chromeCapturePermission?.message
            ?? currentTab?.chromeCapturePermission?.lastError
            ?? createChromeCapturePermissionMessage();
  const screenshotNextAction = screenshotAvailable
    ? "capture_visible_tab"
    : currentTab?.chromeCapturePermission?.state === "missing"
      ? "grant_chrome_capture_permission"
      : nextActionForPageControl("partial");
  const domActionsAvailable = hostPolicyAllowed && hostPermissionReady && contentScriptLoaded
    && contentCapabilities.domActions !== false;
  const blockers = [];

  if (!activeTabAvailable) {
    blockers.push({
      code: "active_tab_unavailable",
      message: currentTab?.lastError ?? "Active Chrome tab is unavailable."
    });
  }
  if (activeTabAvailable && !hostPolicyAllowed) {
    blockers.push({
      code: "blocked_by_host_policy",
      reason: currentTab?.hostPolicy?.reason ?? "host_policy_blocked",
      message: "Host policy has not allowed this page."
    });
  }
  if (hostPolicyAllowed && !hostPermissionReady) {
    blockers.push({
      code: "blocked_by_chrome_host_permission",
      reason: currentTab?.chromeHostPermission?.reason ?? "chrome_host_permission_unavailable",
      message: currentTab?.chromeHostPermission?.message
        ?? currentTab?.chromeHostPermission?.lastError
        ?? "Chrome host permission is not ready for this page."
    });
  }
  if (hostPolicyAllowed && hostPermissionReady && !contentScriptLoaded) {
    blockers.push({
      code: contentScript.reason ?? "content_script_not_loaded",
      message: contentScript.lastError ?? "Content script diagnostics are not loaded."
    });
  }

  const state = blockers[0]?.code === "active_tab_unavailable"
    ? "unavailable"
    : blockers[0]?.code
        ? blockers[0].code
        : contentControl.state === "sensitive-paused" || contentControl.state === "needs_confirmation"
          ? contentControl.state
          : screenshotAvailable
            ? "ready"
            : "partial";
  const reason = blockers[0]?.message
    ?? contentControl.reason
    ?? (state === "partial" ? screenshotReason : "Current page is ready for Computer Use controls.");
  const nextAction = nextActionForPageControl(state);
  const actionAvailableReason = domActionsAvailable
    ? "DOM actions are available."
    : reason;
  const contentActions = contentControl.actions && typeof contentControl.actions === "object"
    ? contentControl.actions
    : {};
  const actions = {
    click: contentActions.click ?? createControlReadiness(
      domActionsAvailable && contentCapabilities.click !== false,
      actionAvailableReason,
      nextAction
    ),
    fill: contentActions.fill ?? createControlReadiness(
      domActionsAvailable && contentCapabilities.fill === true,
      actionAvailableReason,
      nextAction
    ),
    submit: contentActions.submit ?? createControlReadiness(
      domActionsAvailable && contentCapabilities.submit === true,
      actionAvailableReason,
      nextAction
    ),
    scroll: contentActions.scroll ?? createControlReadiness(
      domActionsAvailable && contentCapabilities.scroll !== false,
      actionAvailableReason,
      nextAction
    )
  };
  for (const key of Object.keys(actions)) {
    if (!domActionsAvailable || state === "sensitive-paused" || state === "needs_confirmation") {
      actions[key] = {
        ...actions[key],
        capable: false,
        state: "blocked",
        reason,
        nextAction
      };
    }
  }
  const domActionCapable = Object.values(actions).some((action) => action.capable);

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    capable: state === "ready" || state === "partial",
    state,
    reason,
    nextAction,
    activeTab: {
      state: activeTabAvailable ? "available" : "unavailable",
      tabId: currentTab?.tabId ?? null,
      windowId: currentTab?.windowId ?? null,
      host: currentTab?.host ?? ""
    },
    hostPolicy: currentTab?.hostPolicy ?? null,
    chromeHostPermission: currentTab?.chromeHostPermission ?? null,
    chromeCapturePermission: currentTab?.chromeCapturePermission ?? null,
    contentScript: {
      state: contentScript.state ?? "not_queried",
      reason: contentScript.reason ?? null,
      lastError: contentScript.lastError ?? null
    },
    capabilities: {
      diagnostics: contentScriptLoaded,
      observe: domActionsAvailable && contentCapabilities.observe !== false,
      domActions: domActionCapable,
      click: actions.click.capable,
      fill: actions.fill.capable,
      submit: actions.submit.capable,
      scroll: actions.scroll.capable,
      screenshot: screenshotAvailable,
      downloads: capabilities?.downloads === true
    },
    screenshot: createControlReadiness(screenshotAvailable, screenshotReason, screenshotNextAction),
    actions,
    blockers,
    pageSafety: contentControl.pageSafety ?? contentScript.pageSafety ?? null,
    sensitivePause: contentControl.sensitivePause ?? {
      active: contentScript.sensitivePaused === true,
      reason: contentScript.sensitivePauseReason ?? null,
      kind: contentScript.sensitivePauseKind ?? null
    },
    forms: contentControl.forms ?? null,
    sensitiveForms: contentControl.sensitiveForms ?? [],
    counts: contentControl.counts ?? null,
    observedAt: contentScript.observedAt ?? null
  };
}

function createDiagnostics(policy, syncStatus, currentTab, devReload) {
  const extension = readExtensionDiagnostics();
  const pageControl = createPageControlReadiness(extension.capabilities, currentTab);
  const currentTabWithPageControl = currentTab
    ? { ...currentTab, pageControl }
    : currentTab;
  const nativeHostLastError = syncStatus.lastError ?? syncStatus.error ?? null;
  const hostPolicyEntryCounts = {
    allowedHosts: Array.isArray(policy.allowedHosts) ? policy.allowedHosts.length : 0,
    currentTurnAllowedHosts: Array.isArray(policy.currentTurnAllowedHosts)
      ? policy.currentTurnAllowedHosts.length
      : 0,
    blockedHosts: Array.isArray(policy.blockedHosts) ? policy.blockedHosts.length : 0
  };

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    extension: {
      id: extension.id,
      name: extension.name,
      version: extension.version,
      manifestVersion: extension.manifestVersion,
      minimumChromeVersion: extension.minimumChromeVersion
    },
    capabilities: extension.capabilities,
    nativeHost: {
      name: NATIVE_MESSAGING_HOST_NAME,
      connectionState: readNativeHostConnectionState(syncStatus),
      bridgeState: syncStatus.nativeBridgeState ?? readNativeHostConnectionState(syncStatus),
      syncState: syncStatus.state,
      syncSource: syncStatus.source,
      policyState: syncStatus.nativeHostPolicyState ?? syncStatus.hostPolicyState,
      launchOrigin: syncStatus.nativeLaunchOrigin ?? null,
      messageType: syncStatus.nativeMessageType ?? null,
      responseType: syncStatus.nativeResponseType ?? null,
      responseResult: syncStatus.nativeResponseResult ?? null,
      lastError: nativeHostLastError,
      lastRequestId: syncStatus.requestId,
      lastTrigger: syncStatus.trigger,
      updatedAt: syncStatus.updatedAt,
      requestedAt: syncStatus.requestedAt,
      completedAt: syncStatus.completedAt
    },
    hostPolicy: {
      defaultMode: policy.defaultMode,
      entryCount: countHostPolicyEntries(policy),
      ...hostPolicyEntryCounts
    },
    devReload: devReload ?? null,
    currentTab: currentTabWithPageControl,
    session: {
      state: currentTab?.contentScript?.state ?? "not_queried",
      contentScript: currentTab?.contentScript ?? null,
      host: currentTab?.host ?? null,
      pageControl
    },
    lastError: nativeHostLastError
      ?? currentTab?.chromeHostPermission?.lastError
      ?? currentTab?.chromeHostPermission?.message
      ?? currentTab?.contentScript?.lastError
      ?? currentTab?.lastError
      ?? null
  };
}

function decideHostPolicy(policy, host) {
  if (!host) {
    return { decision: "blocked", reason: "missing_host" };
  }
  if (policy.blockedHosts.includes(host)) {
    return { decision: "blocked", reason: "blocked_host" };
  }
  if (policy.allowedHosts.includes(host) || policy.currentTurnAllowedHosts.includes(host)) {
    return { decision: "allowed", reason: "host_allowed" };
  }
  return { decision: policy.defaultMode, reason: "default_policy" };
}

function normalizeSyncTrigger(trigger) {
  if (typeof trigger !== "string" || trigger.trim().length === 0) {
    return "manual";
  }
  return trigger.trim().replace(/[^a-z0-9_.-]/gi, "_").slice(0, 64);
}

async function writeHostPolicySyncStatus(status) {
  await chrome.storage.local.set({
    [HOST_POLICY_SYNC_STORAGE_KEY]: {
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      ...status
    }
  });
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE]
  });
}

async function ensureHostPermission(tab) {
  const permissionDetails = getHostPermissionDetails(tab?.url ?? "");
  if (!permissionDetails) {
    return {
      ok: true,
      chromeHostPermission: await readChromeHostPermissionStatus(permissionDetails)
    };
  }

  const chromeHostPermission = await readChromeHostPermissionStatus(permissionDetails);
  if (chromeHostPermission.state === "granted") {
    return {
      ok: true,
      chromeHostPermission
    };
  }

  return {
    ok: false,
    reason: chromeHostPermission.reason ?? "chrome_host_permission_missing",
    code: chromeHostPermission.code ?? "chrome_host_permission_missing",
    message: chromeHostPermission.message ?? chromeHostPermission.lastError ?? createHostPermissionMessage(permissionDetails),
    chromeHostPermission,
    ...permissionDetails
  };
}

async function routePageMessage(message) {
  const tab = message.tabId ? await chrome.tabs.get(message.tabId) : await getActiveTab();
  const host = getHost(tab?.url ?? "");
  const policy = await readHostPolicy();
  const policyDecision = decideHostPolicy(policy, host);

  if (!tab?.id || policyDecision.decision !== "allowed") {
    return {
      type: MESSAGE_TYPES.HOST_POLICY_RESPONSE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      host,
      policyDecision
    };
  }

  const permissionDecision = await ensureHostPermission(tab);
  if (!permissionDecision.ok) {
    return {
      type: MESSAGE_TYPES.HOST_POLICY_RESPONSE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      result: "blocked",
      reason: permissionDecision.reason,
      code: permissionDecision.code,
      message: permissionDecision.message,
      host,
      origin: permissionDecision.origin,
      chromeHostPermission: {
        state: permissionDecision.chromeHostPermission?.state ?? "missing",
        origins: [permissionDecision.permissionOrigin],
        message: permissionDecision.message
      },
      policyDecision
    };
  }

  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, {
    ...message,
    schemaVersion: MESSAGE_SCHEMA_VERSION
  });
}

async function routePageScreenshot(message) {
  const tab = message.tabId ? await chrome.tabs.get(message.tabId) : await getActiveTab();
  const host = getHost(tab?.url ?? "");
  const policy = await readHostPolicy();
  const policyDecision = decideHostPolicy(policy, host);

  if (!tab?.id || policyDecision.decision !== "allowed") {
    return {
      type: MESSAGE_TYPES.HOST_POLICY_RESPONSE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      host,
      policyDecision
    };
  }

  const format = message.payload?.format === "jpeg" ? "jpeg" : "png";
  const capturePermission = await readChromeCapturePermissionStatus(tab);
  if (capturePermission.state !== "granted") {
    return {
      type: MESSAGE_TYPES.PAGE_SCREENSHOT_RESULT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      result: "blocked",
      reason: capturePermission.message ?? capturePermission.lastError ?? createChromeCapturePermissionMessage(),
      code: capturePermission.code ?? capturePermission.reason ?? "chrome_capture_permission_missing",
      chromeCapturePermission: capturePermission,
      host,
      tabId: tab.id,
      format
    };
  }

  let dataUrl;
  try {
    if (typeof chrome.tabs.update === "function") {
      await chrome.tabs.update(tab.id, {
        active: true
      });
    }
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format,
      ...(format === "jpeg" && typeof message.payload?.quality === "number"
        ? { quality: message.payload.quality }
        : {})
    });
  } catch (error) {
    return {
      type: MESSAGE_TYPES.PAGE_SCREENSHOT_RESULT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      result: "blocked",
      reason: error instanceof Error ? error.message : "capture_visible_tab_failed",
      host,
      tabId: tab.id,
      format
    };
  }

  return {
    type: MESSAGE_TYPES.PAGE_SCREENSHOT_RESULT,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId: message.requestId,
    host,
    tabId: tab.id,
    format,
    dataUrl
  };
}

async function readDownloadsStatus(message) {
  const limit = clampDownloadsLimit(message.payload?.limit);
  const includeFilePaths = message.payload?.includeFilePaths === true;

  if (includeFilePaths && message.payload?.confirmed !== true) {
    return {
      type: MESSAGE_TYPES.DOWNLOADS_STATUS_RESULT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      result: "blocked",
      reason: "download_path_exposure_requires_confirmation"
    };
  }

  const downloads = await chrome.downloads.search({
    limit,
    orderBy: ["-startTime"]
  });

  return {
    type: MESSAGE_TYPES.DOWNLOADS_STATUS_RESULT,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId: message.requestId,
    downloads: downloads.map((download) => ({
      id: download.id,
      state: download.state,
      danger: download.danger,
      paused: download.paused,
      exists: download.exists,
      canResume: download.canResume,
      mime: download.mime,
      bytesReceived: download.bytesReceived,
      totalBytes: download.totalBytes,
      startTime: download.startTime,
      endTime: download.endTime,
      urlHost: getHost(download.url ?? ""),
      ...(includeFilePaths ? { filename: download.filename } : {})
    }))
  };
}

function unwrapNativeMessage(message) {
  const shouldUnwrap = message?.type === MESSAGE_TYPES.NATIVE_MESSAGE;
  const payload = shouldUnwrap && message?.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
    ? message.payload
    : message;

  return {
    ...payload,
    requestId: payload.requestId ?? message.requestId,
    schemaVersion: MESSAGE_SCHEMA_VERSION
  };
}

async function persistHostPolicyResponse(response) {
  if (response?.hostPolicy?.policy) {
    await chrome.storage.local.set({
      [HOST_POLICY_STORAGE_KEY]: {
        ...HOST_POLICY_SHAPE,
        ...response.hostPolicy.policy
      }
    });
  }
}

export async function syncHostPolicy(trigger = "manual") {
  const normalizedTrigger = normalizeSyncTrigger(trigger);
  const requestedAt = new Date().toISOString();
  const requestId = `${HOST_POLICY_SYNC_REQUEST_PREFIX}-${normalizedTrigger}-${Date.now()}`;

  await writeHostPolicySyncStatus({
    state: "syncing",
    trigger: normalizedTrigger,
    requestId,
    requestedAt
  });

  try {
    const response = await sendNativeMessage({
      type: MESSAGE_TYPES.HOST_POLICY_REQUEST,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId
    }, {
      syncHostPolicy: false
    });
    const completedAt = new Date().toISOString();

    if (response?.hostPolicy?.policy) {
      await writeHostPolicySyncStatus({
        state: "synced",
        source: "native_host",
        trigger: normalizedTrigger,
        requestId,
        requestedAt,
        completedAt,
        hostPolicyState: response.hostPolicy.state ?? "unknown",
        nativeHostPolicyState: response.hostPolicy.state ?? "unknown",
        nativeBridgeState: response.bridgeState ?? "connected",
        nativeLaunchOrigin: response.launchOrigin ?? null,
        nativeMessageType: response.messageType ?? MESSAGE_TYPES.HOST_POLICY_REQUEST,
        nativeResponseType: response.type ?? null,
        nativeResponseResult: response.result ?? null,
        entryCount: countHostPolicyEntries(response.hostPolicy.policy)
      });
    } else {
      const message = response?.error ?? response?.reason ?? "host_policy_unavailable";
      await writeHostPolicySyncStatus({
        state: "error",
        source: "native_host",
        trigger: normalizedTrigger,
        requestId,
        requestedAt,
        completedAt,
        entryCount: countHostPolicyEntries(await readHostPolicy()),
        nativeBridgeState: response?.bridgeState ?? "unavailable",
        nativeLaunchOrigin: response?.launchOrigin ?? null,
        nativeMessageType: response?.messageType ?? null,
        nativeResponseType: response?.type ?? null,
        nativeResponseResult: response?.result ?? null,
        lastError: message,
        error: message
      });
    }

    return response;
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);

    await writeHostPolicySyncStatus({
      state: "error",
      source: "native_host",
      trigger: normalizedTrigger,
      requestId,
      requestedAt,
      completedAt,
      entryCount: countHostPolicyEntries(await readHostPolicy()),
      nativeBridgeState: "unavailable",
      nativeLaunchOrigin: null,
      nativeMessageType: MESSAGE_TYPES.HOST_POLICY_REQUEST,
      nativeResponseType: null,
      nativeResponseResult: null,
      lastError: message,
      error: message
    });

    return {
      type: MESSAGE_TYPES.HOST_POLICY_RESPONSE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId,
      ok: false,
      error: message
    };
  }
}

export async function pingNativeHeartbeat(trigger = "manual", tabId) {
  await syncHostPolicy(trigger);
  const { policy, syncStatus, diagnostics } = await readHostPolicySnapshot(tabId, {
    injectContentScript: true
  });
  const pageControlHeartbeat = await sendPageControlNativeHeartbeat(
    trigger,
    diagnostics.session.pageControl
  );

  return {
    type: MESSAGE_TYPES.NATIVE_HEARTBEAT_RESULT,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId: pageControlHeartbeat.requestId
      ?? syncStatus.requestId
      ?? `${HOST_POLICY_SYNC_REQUEST_PREFIX}-${normalizeSyncTrigger(trigger)}`,
    policy,
    syncStatus,
    heartbeat: summarizeHeartbeatFromSyncStatus(syncStatus),
    pageControlHeartbeat,
    pageControl: diagnostics.session.pageControl,
    diagnostics
  };
}

async function sendPageControlNativeHeartbeat(trigger, pageControl) {
  const normalizedTrigger = normalizeSyncTrigger(trigger);
  const requestId = `page-control-health-${normalizedTrigger}-${Date.now()}`;

  try {
    const response = await sendNativeMessage({
      type: MESSAGE_TYPES.PAGE_OBSERVE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId,
      payload: {
        mode: "current_page",
        include: ["title", "url", "visible_text", "forms", "interactive_elements"],
        source: "page_control_health",
        pageControl
      }
    }, {
      syncHostPolicy: false
    });

    return {
      state: response?.result === "accepted" ? "recorded" : "error",
      requestId,
      result: response?.result ?? "unknown",
      responseType: response?.type ?? null,
      reason: response?.reason ?? response?.error ?? null
    };
  } catch (error) {
    return {
      state: "error",
      requestId,
      result: "error",
      responseType: null,
      reason: readErrorMessage(error)
    };
  }
}

export async function requestDevReload(requestId = `dev-reload-${Date.now()}`) {
  const requestedAt = new Date().toISOString();
  const reloadAvailable = typeof chrome.runtime.reload === "function";
  const trigger = "popup_dev_reload";

  await writeDevReloadStatus({
    state: "checking",
    source: "extension",
    trigger,
    requestId,
    requestedAt,
    message: "Checking Native Messaging heartbeat before reload."
  });

  const heartbeatSnapshot = await pingNativeHeartbeat(trigger);
  const completedAt = new Date().toISOString();
  const heartbeat = heartbeatSnapshot.heartbeat;
  const reloadAt = reloadAvailable
    ? new Date(Date.now() + DEV_RELOAD_DELAY_MS).toISOString()
    : null;
  const devReload = {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    state: reloadAvailable ? "scheduled" : "blocked",
    source: "extension",
    reloadAvailable,
    reloadDelayMs: DEV_RELOAD_DELAY_MS,
    requestedAt,
    completedAt,
    reloadAt,
    updatedAt: completedAt,
    requestId,
    trigger,
    reason: reloadAvailable
      ? (heartbeat.state === "connected" ? "heartbeat_connected" : "heartbeat_not_connected")
      : "runtime_reload_unavailable",
    message: reloadAvailable
      ? (heartbeat.state === "connected"
        ? "Reload scheduled after a connected Native Messaging heartbeat."
        : "Reload scheduled, but the Native Messaging heartbeat is not connected. Check Last error before relying on liveConnection.")
      : "Chrome runtime.reload is unavailable in this browser context. Reload from chrome://extensions.",
    browserPolicy: reloadAvailable ? "extension_context_reload" : "chrome_runtime_reload_unavailable",
    heartbeat,
    lastError: reloadAvailable ? null : "runtime_reload_unavailable"
  };

  await writeDevReloadStatus(devReload);
  const { policy, syncStatus, diagnostics } = await readHostPolicySnapshot();

  if (reloadAvailable) {
    globalThis.setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch (error) {
        void writeDevReloadStatus({
          ...devReload,
          state: "error",
          updatedAt: new Date().toISOString(),
          lastError: readErrorMessage(error),
          message: readErrorMessage(error)
        });
      }
    }, DEV_RELOAD_DELAY_MS);
  }

  return {
    type: MESSAGE_TYPES.DEV_RELOAD_RESULT,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId,
    policy,
    syncStatus,
    heartbeat,
    pageControlHeartbeat: heartbeatSnapshot.pageControlHeartbeat,
    devReload,
    pageControl: diagnostics.session.pageControl,
    diagnostics
  };
}

function scheduleHostPolicySync(trigger) {
  if (!hostPolicySyncPromise) {
    hostPolicySyncPromise = syncHostPolicy(trigger).finally(() => {
      hostPolicySyncPromise = null;
    });
  }
  return hostPolicySyncPromise;
}

function isOwnExtensionUrl(url) {
  return typeof url === "string"
    && url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function readWakeSearchParams(url) {
  if (!isOwnExtensionUrl(url)) {
    return undefined;
  }

  try {
    return new URL(url).searchParams;
  } catch {
    return undefined;
  }
}

function readWakeTargetTabIdFromParams(params) {
  const value = params?.get("skfiyTargetTabId");
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function readWakeTargetTabId(url) {
  return readWakeTargetTabIdFromParams(readWakeSearchParams(url));
}

function readWakeAction(url) {
  return readWakeSearchParams(url)?.get("skfiyWakeAction") ?? "";
}

function readWakeDirective(url) {
  const params = readWakeSearchParams(url);
  if (!params) {
    return undefined;
  }

  const dyValue = params.get("skfiyDy");
  const dy = dyValue ? Number.parseInt(dyValue, 10) : NaN;
  return {
    wakeId: params.get("skfiyWake") ?? "",
    requestId: params.get("skfiyRequestId") ?? "",
    targetTabId: readWakeTargetTabIdFromParams(params),
    wakeAction: params.get("skfiyWakeAction") ?? "",
    selector: params.get("skfiySelector") ?? "",
    text: params.get("skfiyText") ?? "",
    dy: Number.isFinite(dy) ? dy : 0
  };
}

function normalizeWakeDirective(directive) {
  const record = readObject(directive) ?? {};
  const targetTabId = Number.isInteger(record.targetTabId) ? record.targetTabId : undefined;
  const dy = Number.isFinite(record.dy) ? record.dy : 0;

  return {
    wakeId: readString(record.wakeId) ?? "",
    requestId: readString(record.requestId) ?? "",
    targetTabId,
    wakeTabId: Number.isInteger(record.wakeTabId) ? record.wakeTabId : undefined,
    wakeAction: readString(record.wakeAction) ?? "",
    selector: readString(record.selector) ?? "",
    text: readString(record.text) ?? "",
    dy
  };
}

function mergeWakeDirectives(primary, fallback) {
  if (!primary) {
    return fallback;
  }
  if (!fallback) {
    return primary;
  }

  return {
    wakeId: primary.wakeId || fallback.wakeId,
    requestId: primary.requestId || fallback.requestId,
    targetTabId: Number.isInteger(primary.targetTabId) ? primary.targetTabId : fallback.targetTabId,
    wakeTabId: Number.isInteger(primary.wakeTabId) ? primary.wakeTabId : fallback.wakeTabId,
    wakeAction: primary.wakeAction || fallback.wakeAction,
    selector: primary.selector || fallback.selector,
    text: primary.text || fallback.text,
    dy: Number.isFinite(primary.dy) ? primary.dy : fallback.dy
  };
}

function withWakeTabId(directive, tabId) {
  if (!directive || !Number.isInteger(tabId)) {
    return directive;
  }

  return {
    ...directive,
    wakeTabId: tabId
  };
}

function createWakeDirectiveKey(directive) {
  if (!directive) {
    return undefined;
  }
  if (!Number.isInteger(directive.targetTabId) && directive.wakeAction !== "tabs") {
    return undefined;
  }

  return [
    directive.wakeId || "no-wake-id",
    directive.requestId || "no-request-id",
    directive.targetTabId,
    directive.wakeAction || "heartbeat",
    directive.selector || "",
    directive.dy ?? "",
    directive.text ? "text" : ""
  ].join("|");
}

function claimWakeDirective(directive) {
  const key = createWakeDirectiveKey(directive);
  if (!key) {
    return true;
  }
  if (processedWakeDirectiveKeys.has(key)) {
    return false;
  }
  processedWakeDirectiveKeys.add(key);
  if (processedWakeDirectiveKeys.size > 200) {
    processedWakeDirectiveKeys.clear();
    processedWakeDirectiveKeys.add(key);
  }
  return true;
}

function isStaleTimestampedWakeDirective(directive) {
  const wakeId = readString(directive?.wakeId);
  if (!wakeId || !/^\d{12,}$/.test(wakeId)) {
    return false;
  }

  const createdAt = Number.parseInt(wakeId, 10);
  return Number.isFinite(createdAt)
    && createdAt > 0
    && createdAt < Date.now() - MAX_WAKE_DIRECTIVE_AGE_MS;
}

function scheduleWakeDirective(directive) {
  const wakeTargetTabId = directive?.targetTabId;
  const wakeAction = directive?.wakeAction ?? "";
  if (isStaleTimestampedWakeDirective(directive)) {
    void closeWakeTab(directive);
    return true;
  }
  if (wakeAction === "tabs") {
    void executeWakeDirective(directive);
    return true;
  }
  if (!Number.isInteger(wakeTargetTabId)) {
    return false;
  }
  setTimeout(() => {
    void executeWakeDirective(directive);
  }, 150);
  return true;
}

async function executeWakeDirective(directive) {
  const wakeAction = directive?.wakeAction ?? "";
  if (isStaleTimestampedWakeDirective(directive)) {
    return "ignored";
  }
  if (wakeAction !== "tabs" && !Number.isInteger(directive?.targetTabId)) {
    return "blocked";
  }
  if (!claimWakeDirective(directive)) {
    return "deduplicated";
  }

  try {
    await runWakeDirective(directive);
  } finally {
    await closeWakeTab(directive);
  }
  return "executed";
}

async function runWakeDirective(directive) {
  const wakeAction = directive?.wakeAction ?? "";
  if (wakeAction === "tabs") {
    return discoverChromeTabs(directive?.requestId || "tabs-discover-wake");
  }
  if (wakeAction === "observe") {
    return sendWakePageObservation(directive);
  }
  if (["screenshot", "click", "fill", "submit", "scroll"].includes(wakeAction)) {
    return sendWakePageControlAction(directive);
  }
  return pingNativeHeartbeat("popup_wake", directive.targetTabId);
}

async function closeWakeTab(directive) {
  const wakeTabId = directive?.wakeTabId;
  if (!Number.isInteger(wakeTabId) || typeof chrome.tabs?.remove !== "function") {
    return;
  }

  try {
    await chrome.tabs.remove(wakeTabId);
  } catch {
    // Best-effort cleanup; wake evidence must not fail just because Chrome already closed the tab.
  }
}

function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function readPageObservation(response) {
  const snapshot = readObject(response?.snapshot);
  if (snapshot) {
    return snapshot;
  }
  return readObject(response?.pageObservation);
}

function readString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createWakePageControlRequest(directive) {
  const requestId = directive.requestId || `page-control-${directive.wakeAction}-popup_wake-${Date.now()}`;
  if (directive.wakeAction === "screenshot") {
    return {
      type: MESSAGE_TYPES.PAGE_SCREENSHOT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId,
      tabId: directive.targetTabId,
      payload: {
        format: "png"
      }
    };
  }

  const action = (() => {
    if (directive.wakeAction === "click") {
      return { kind: "click", selector: directive.selector };
    }
    if (directive.wakeAction === "fill") {
      return { kind: "fill", selector: directive.selector, value: directive.text };
    }
    if (directive.wakeAction === "submit") {
      return { kind: "submit", selector: directive.selector, confirmed: true };
    }
    if (directive.wakeAction === "scroll") {
      return { kind: "scroll", deltaY: directive.dy };
    }
    return undefined;
  })();

  if (!action) {
    return undefined;
  }

  return {
    type: MESSAGE_TYPES.PAGE_ACTION,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId,
    tabId: directive.targetTabId,
    payload: {
      action
    }
  };
}

function summarizeWakePageActionResult(response, targetTabId, action, requestId) {
  const record = readObject(response) ?? {};
  const actionName = readString(record.action) ?? readString(action?.kind);
  const selector = readString(record.selector) ?? readString(action?.selector);
  const deltaY = readNumber(record.deltaY) ?? readNumber(action?.deltaY);
  const result = readString(record.result) ?? "blocked";
  const reason = readString(record.reason) ?? (readObject(response) ? undefined : "page_action_no_response");
  const code = readString(record.code);
  const message = readString(record.message);
  const chromeHostPermission = readObject(record.chromeHostPermission);

  return {
    type: readString(record.type) ?? MESSAGE_TYPES.PAGE_ACTION_RESULT,
    requestId: readString(record.requestId) ?? requestId,
    result,
    ...(actionName ? { action: actionName } : {}),
    ...(reason ? { reason } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    targetTabId,
    ...(selector ? { selector } : {}),
    ...(typeof deltaY === "number" ? { deltaY } : {}),
    ...(chromeHostPermission ? { chromeHostPermission } : {})
  };
}

function summarizeWakePageScreenshot(response, targetTabId) {
  const record = readObject(response) ?? {};
  const dataUrl = readString(record.dataUrl);
  const hasDataUrl = Boolean(dataUrl);

  return {
    type: readString(record.type) ?? MESSAGE_TYPES.PAGE_SCREENSHOT_RESULT,
    ...(readString(record.requestId) ? { requestId: record.requestId } : {}),
    ...(readString(record.result) ? { result: record.result } : {}),
    ...(readNumber(record.tabId) ? { tabId: record.tabId } : {}),
    targetTabId,
    ...(readString(record.host) ? { host: record.host } : {}),
    ...(readString(record.format) ? { format: record.format } : {}),
    hasDataUrl,
    ...(hasDataUrl ? { dataUrlBytes: dataUrl.length } : {}),
    ...(readString(record.reason) ? { reason: record.reason } : {})
  };
}

async function sendWakePageObservation(directive) {
  const targetTabId = directive.targetTabId;
  const observeRequestId = directive.requestId || `page-control-observe-popup_wake-${Date.now()}`;
  const nativeRequestId = directive.requestId || `page-control-observe-native-popup_wake-${Date.now()}`;
  const observeResponse = await routePageMessage({
    type: MESSAGE_TYPES.PAGE_OBSERVE,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId: observeRequestId,
    tabId: targetTabId,
    payload: {
      mode: "current_page",
      include: ["title", "url", "visible_text", "forms", "interactive_elements"],
      source: "popup_wake"
    }
  });
  const pageObservation = readPageObservation(observeResponse);

  return sendNativeMessage({
    type: MESSAGE_TYPES.PAGE_OBSERVE,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId: nativeRequestId,
    payload: {
      mode: "current_page",
      include: ["title", "url", "visible_text", "forms", "interactive_elements"],
      source: "popup_wake",
      targetTabId,
      ...(pageObservation ? { pageObservation } : {})
    }
  }, {
    syncHostPolicy: false
  });
}

async function sendWakePageControlAction(directive) {
  const request = createWakePageControlRequest(directive);
  if (!request) {
    return pingNativeHeartbeat("popup_wake", directive.targetTabId);
  }

  let response;
  try {
    response = request.type === MESSAGE_TYPES.PAGE_SCREENSHOT
      ? await routePageScreenshot(request)
      : await routePageMessage(request);
  } catch (error) {
    response = {
      type: request.type === MESSAGE_TYPES.PAGE_SCREENSHOT
        ? MESSAGE_TYPES.PAGE_SCREENSHOT_RESULT
        : MESSAGE_TYPES.PAGE_ACTION_RESULT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: request.requestId,
      result: "blocked",
      reason: readErrorMessage(error)
    };
  }
  const nativeRequestId = directive.requestId || `page-control-${directive.wakeAction}-native-popup_wake-${Date.now()}`;
  const payload = request.type === MESSAGE_TYPES.PAGE_SCREENSHOT
    ? {
        source: "popup_wake",
        targetTabId: directive.targetTabId,
        format: request.payload.format,
        pageScreenshot: summarizeWakePageScreenshot(response, directive.targetTabId)
      }
    : {
        source: "popup_wake",
        targetTabId: directive.targetTabId,
        action: request.payload.action,
        pageActionResult: summarizeWakePageActionResult(
          response,
          directive.targetTabId,
          request.payload.action,
          request.requestId
        )
      };

  return sendNativeMessage({
    type: request.type,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId: nativeRequestId,
    payload
  }, {
    syncHostPolicy: false
  });
}

async function readNativeHeartbeatTabDirective(tabId) {
  if (!Number.isInteger(tabId)) {
    return {
      skip: false
    };
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url ?? tab?.pendingUrl;
    if (!isOwnExtensionUrl(url)) {
      return {
        skip: false
      };
    }

    return {
      skip: true,
      targetTabId: readWakeTargetTabId(url),
      wakeAction: readWakeAction(url)
    };
  } catch {
    return {
      skip: false
    };
  }
}

async function scheduleNativeHeartbeat(trigger, tabId) {
  if (Number.isInteger(tabId)) {
    const directive = await readNativeHeartbeatTabDirective(tabId);
    if (Number.isInteger(directive.targetTabId)) {
      return pingNativeHeartbeat("popup_wake", directive.targetTabId);
    }
    if (directive.skip) {
      return undefined;
    }
    return pingNativeHeartbeat(trigger, tabId);
  }

  if (!nativeHeartbeatPromise) {
    nativeHeartbeatPromise = pingNativeHeartbeat(trigger).finally(() => {
      nativeHeartbeatPromise = null;
    });
  }
  return nativeHeartbeatPromise;
}

function scheduleExtensionLoadedHeartbeat() {
  if (globalThis.__SKFIY_DISABLE_AUTO_HEARTBEAT === true) {
    return;
  }

  setTimeout(() => {
    void scheduleExistingWakeTabs();
    void scheduleNativeHeartbeat("service_worker_loaded");
  }, 0);
}

async function scheduleExistingWakeTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      scheduleWakeDirective(withWakeTabId(
        readWakeDirective(tab?.pendingUrl ?? tab?.url),
        tab?.id
      ));
    }
  } catch {
    // Best-effort startup recovery; normal tab update listeners still handle later wake URLs.
  }
}

function registerTabHeartbeatListeners() {
  chrome.tabs?.onCreated?.addListener?.((tab) => {
    const wakeDirective = withWakeTabId(
      readWakeDirective(tab?.pendingUrl ?? tab?.url),
      tab?.id
    );
    if (scheduleWakeDirective(wakeDirective)) {
      return;
    }
  });
  chrome.tabs?.onActivated?.addListener?.((activeInfo) => {
    setTimeout(() => {
      void scheduleNativeHeartbeat("tab_activated", activeInfo?.tabId);
    }, 150);
  });
  chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo, tab) => {
    if (changeInfo?.status === "complete" || typeof changeInfo?.url === "string") {
      const wakeDirective = mergeWakeDirectives(
        withWakeTabId(readWakeDirective(changeInfo?.url), tabId),
        withWakeTabId(readWakeDirective(tab?.url), tab?.id ?? tabId)
      );
      if (scheduleWakeDirective(wakeDirective)) {
        return;
      }
      if (isOwnExtensionUrl(changeInfo?.url) || isOwnExtensionUrl(tab?.url)) {
        setTimeout(() => {
          void scheduleExistingWakeTabs();
        }, 150);
        return;
      }
      setTimeout(() => {
        void scheduleNativeHeartbeat("tab_updated", tabId);
      }, 150);
    }
  });
}

function sendNativeMessage(message, options = {}) {
  return new Promise((resolve) => {
    const nativeMessage = unwrapNativeMessage(message);
    if (options.syncHostPolicy !== false && nativeMessage.type !== MESSAGE_TYPES.HOST_POLICY_REQUEST) {
      void scheduleHostPolicySync("native_host_connect");
    }

    const port = chrome.runtime.connectNative(NATIVE_MESSAGING_HOST_NAME);
    let settled = false;
    const finish = (response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        port.disconnect();
      } catch {
        // The port may already be closed by Chrome after the response frame.
      }
      resolve(response);
    };
    const timeout = setTimeout(() => {
      finish({
        type: MESSAGE_TYPES.NATIVE_MESSAGE,
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        requestId: nativeMessage.requestId ?? "unknown",
        ok: false,
        error: "native_host_timeout",
        reason: `Native Messaging host did not respond within ${NATIVE_MESSAGE_TIMEOUT_MS}ms.`
      });
    }, NATIVE_MESSAGE_TIMEOUT_MS);

    port.onMessage.addListener((response) => {
      void persistHostPolicyResponse(response).finally(() => finish(response));
    });
    port.onDisconnect.addListener(() => {
      finish({
        type: MESSAGE_TYPES.NATIVE_MESSAGE,
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        requestId: nativeMessage.requestId ?? "unknown",
        ok: false,
        error: chrome.runtime.lastError?.message ?? "native_host_disconnected"
      });
    });
    port.postMessage(nativeMessage);
  });
}

async function handleRuntimeMessage(message) {
  if (message?.type === MESSAGE_TYPES.PAGE_OBSERVE || message?.type === MESSAGE_TYPES.PAGE_ACTION) {
    return routePageMessage(message);
  }

  if (message?.type === MESSAGE_TYPES.PAGE_SCREENSHOT) {
    return routePageScreenshot(message);
  }

  if (message?.type === MESSAGE_TYPES.TABS_DISCOVER) {
    return discoverChromeTabs(message.requestId);
  }

  if (message?.type === MESSAGE_TYPES.PAGE_CONTROL_HEALTH) {
    return readPageControlHealth(message.requestId, message.tabId);
  }

  if (message?.type === MESSAGE_TYPES.PAGE_CONTROL_WAKE) {
    const directive = normalizeWakeDirective(message.directive);
    const result = await executeWakeDirective(directive);
    return {
      type: MESSAGE_TYPES.PAGE_CONTROL_WAKE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId ?? directive.requestId,
      result,
      ...(result === "blocked" ? { reason: "invalid_wake_directive" } : {})
    };
  }

  if (message?.type === MESSAGE_TYPES.DOWNLOADS_STATUS) {
    return readDownloadsStatus(message);
  }

  if (message?.type === MESSAGE_TYPES.HOST_POLICY_REQUEST) {
    const { policy, syncStatus, diagnostics } = await readHostPolicySnapshot(message.tabId);
    return {
      type: MESSAGE_TYPES.HOST_POLICY_RESPONSE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      policy,
      syncStatus,
      pageControl: diagnostics.session.pageControl,
      diagnostics
    };
  }

  if (message?.type === MESSAGE_TYPES.HOST_POLICY_SYNC_STATUS) {
    const { policy, syncStatus, diagnostics } = await readHostPolicySnapshot(message.tabId);
    return {
      type: MESSAGE_TYPES.HOST_POLICY_RESPONSE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      policy,
      syncStatus,
      pageControl: diagnostics.session.pageControl,
      diagnostics
    };
  }

  if (message?.type === MESSAGE_TYPES.HOST_POLICY_SYNC_REFRESH) {
    await syncHostPolicy("popup_manual");
    const { policy, syncStatus, diagnostics } = await readHostPolicySnapshot(message.tabId);
    return {
      type: MESSAGE_TYPES.HOST_POLICY_RESPONSE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      policy,
      syncStatus,
      pageControl: diagnostics.session.pageControl,
      diagnostics
    };
  }

  if (message?.type === MESSAGE_TYPES.NATIVE_HEARTBEAT) {
    const result = await pingNativeHeartbeat("popup_heartbeat", message.tabId);
    return {
      ...result,
      requestId: message.requestId
    };
  }

  if (message?.type === MESSAGE_TYPES.DEV_RELOAD_STATUS) {
    const { policy, syncStatus, diagnostics } = await readHostPolicySnapshot(message.tabId);
    return {
      type: MESSAGE_TYPES.DEV_RELOAD_STATUS,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      policy,
      syncStatus,
      devReload: diagnostics.devReload,
      pageControl: diagnostics.session.pageControl,
      diagnostics
    };
  }

  if (message?.type === MESSAGE_TYPES.DEV_RELOAD_REQUEST) {
    return requestDevReload(message.requestId);
  }

  if (message?.type === MESSAGE_TYPES.PAGE_SENSITIVE_PAUSE) {
    await chrome.storage.local.set({
      [LAST_SENSITIVE_PAUSE_KEY]: {
        ...message,
        observedAt: new Date().toISOString()
      }
    });
    return { ok: true };
  }

  if (message?.type === MESSAGE_TYPES.NATIVE_MESSAGE) {
    return sendNativeMessage(message);
  }

  return { ok: false, error: "unsupported_message" };
}

globalThis.skfiyChromeAdapterDiagnostics = Object.freeze({
  readStatus(requestId = "extension-diagnostics") {
    return handleRuntimeMessage({
      type: MESSAGE_TYPES.HOST_POLICY_SYNC_STATUS,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId
    });
  },
  refreshHostPolicy(requestId = "extension-diagnostics-refresh") {
    return handleRuntimeMessage({
      type: MESSAGE_TYPES.HOST_POLICY_SYNC_REFRESH,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId
    });
  },
  pingNativeHeartbeat(requestId = "extension-diagnostics-heartbeat") {
    return handleRuntimeMessage({
      type: MESSAGE_TYPES.NATIVE_HEARTBEAT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId
    });
  },
  requestDevReload(requestId = "extension-diagnostics-dev-reload") {
    return handleRuntimeMessage({
      type: MESSAGE_TYPES.DEV_RELOAD_REQUEST,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId
    });
  },
  readPageControlHealth(requestId = "extension-page-control-health") {
    return handleRuntimeMessage({
      type: MESSAGE_TYPES.PAGE_CONTROL_HEALTH,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleRuntimeMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void scheduleNativeHeartbeat("runtime_installed");
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleNativeHeartbeat("runtime_startup");
});

registerTabHeartbeatListeners();
scheduleExtensionLoadedHeartbeat();
