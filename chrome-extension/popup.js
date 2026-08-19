const DEFAULT_POLICY_LABEL = "Ask by default";
const SENSITIVE_PAUSE_LABEL = "Sensitive content pause";
const HOST_POLICY_STORAGE_KEY = "skfiyHostPolicy";
const LAST_SENSITIVE_PAUSE_KEY = "lastSensitivePause";
const MESSAGE_SCHEMA_VERSION = 1;
const HOST_POLICY_SHAPE = Object.freeze({
  defaultMode: "ask",
  allowedHosts: [],
  currentTurnAllowedHosts: [],
  blockedHosts: []
});

const MESSAGE_TYPES = Object.freeze({
  HOST_POLICY_SYNC_STATUS: "skfiy.host_policy.sync_status",
  HOST_POLICY_SYNC_REFRESH: "skfiy.host_policy.sync_refresh",
  NATIVE_HEARTBEAT: "skfiy.native.heartbeat",
  DEV_RELOAD_REQUEST: "skfiy.dev.reload",
  PAGE_OBSERVE: "skfiy.page.observe",
  PAGE_ACTION: "skfiy.page.action",
  PAGE_SCREENSHOT: "skfiy.page.screenshot",
  PAGE_CONTROL_WAKE: "skfiy.page_control.wake",
  TABS_DISCOVER: "skfiy.tabs.discover",
  NATIVE_MESSAGE: "skfiy.native.message"
});

let pendingHostPermissionOrigins = [];

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function labelForPolicy(policy, host) {
  if (!host) {
    return DEFAULT_POLICY_LABEL;
  }
  if (policy?.blockedHosts?.includes(host)) {
    return "Blocked";
  }
  if (policy?.allowedHosts?.includes(host)) {
    return "Always allowed";
  }
  if (policy?.currentTurnAllowedHosts?.includes(host)) {
    return "Allowed this turn";
  }
  return DEFAULT_POLICY_LABEL;
}

function formatPolicyReason(hostPolicy) {
  switch (hostPolicy?.reason) {
    case "host_allowed":
      return "Host allowed";
    case "blocked_host":
      return "Blocked host";
    case "default_policy":
      return "Default policy";
    case "missing_host":
      return "Missing host";
    case "active_tab_unavailable":
      return "Active tab unavailable";
    default:
      return hostPolicy?.reason || "Unknown";
  }
}

function formatSyncState(state) {
  switch (state) {
    case "synced":
      return "Synced";
    case "syncing":
      return "Syncing";
    case "error":
      return "Error";
    default:
      return "Unknown";
  }
}

function formatConnection(syncStatus, nativeHost = {}) {
  switch (nativeHost.connectionState ?? syncStatus?.state) {
    case "connected":
    case "synced":
      return "Synced with skfiy app";
    case "connecting":
    case "syncing":
      return "Syncing with skfiy app";
    case "unavailable":
    case "error":
      return "skfiy app unavailable";
    default:
      return "Waiting for skfiy app";
  }
}

function formatBridgeState(nativeHost = {}, syncStatus = {}) {
  switch (nativeHost.bridgeState ?? syncStatus?.nativeBridgeState) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "unavailable":
      return "Unavailable";
    case "unknown":
      return "Unknown";
    default:
      return nativeHost.bridgeState ?? syncStatus?.nativeBridgeState ?? "Unknown";
  }
}

function formatLaunchOrigin(nativeHost = {}, syncStatus = {}) {
  return nativeHost.launchOrigin ?? syncStatus?.nativeLaunchOrigin ?? "Not observed";
}

function formatSource(source) {
  if (source === "native_host") {
    return "Native host";
  }
  if (source === "local_storage") {
    return "Local storage";
  }
  return source || "Unknown";
}

function formatPolicyState(state) {
  switch (state) {
    case "configured":
      return "Configured";
    case "default":
      return "Default";
    case "invalid":
      return "Invalid";
    default:
      return "Unknown";
  }
}

function formatHeartbeat(heartbeat, syncStatus = {}) {
  const current = heartbeat && typeof heartbeat === "object"
    ? heartbeat
    : {};
  const state = current.state
    ?? (syncStatus.state === "synced" ? "connected" : syncStatus.state)
    ?? "unknown";
  const updatedAt = current.completedAt ?? current.updatedAt ?? syncStatus.completedAt ?? syncStatus.updatedAt;
  const suffix = updatedAt ? ` at ${formatUpdatedAt(updatedAt)}` : "";
  const lastError = current.lastError ?? syncStatus.lastError ?? syncStatus.error;

  switch (state) {
    case "connected":
      return `Connected${suffix}`;
    case "checking":
    case "syncing":
      return "Checking";
    case "error":
      return lastError ? `Error: ${lastError}` : "Error";
    case "unknown":
      return "Not checked";
    default:
      return formatDiagnosticToken(state);
  }
}

function formatDevReload(devReload = {}) {
  const lastError = devReload.lastError;

  switch (devReload.state) {
    case "checking":
      return "Checking heartbeat";
    case "scheduled":
      return devReload.reloadAt
        ? `Reload scheduled for ${formatUpdatedAt(devReload.reloadAt)}`
        : "Reload scheduled";
    case "blocked":
      return devReload.message ?? "Reload blocked";
    case "error":
      return lastError ? `Error: ${lastError}` : "Error";
    case "idle":
    case undefined:
    case null:
      return devReload.reloadAvailable === false
        ? "Unavailable in this browser context"
        : "Idle";
    default:
      return formatDiagnosticToken(devReload.state);
  }
}

function formatCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object") {
    return "Unknown";
  }

  const labels = [
    ["activeTab", "Active tab"],
    ["nativeMessaging", "Native messaging"],
    ["scripting", "Scripting"],
    ["storage", "Storage"],
    ["tabs", "Tabs"],
    ["downloads", "Downloads"]
  ]
    .filter(([key]) => capabilities[key] === true)
    .map(([, label]) => label);

  return labels.length > 0 ? labels.join(", ") : "None";
}

function formatManifestVersion(extension) {
  if (extension?.manifestVersion) {
    return `MV${extension.manifestVersion}`;
  }
  return "Unknown";
}

function formatHostPermission(permission) {
  switch (permission?.state) {
    case "granted":
      return `Granted for ${permission.origins?.[0] ?? permission.origin ?? "current host"}`;
    case "missing":
      return permission.message
        ?? `Missing optional permission for ${permission.origins?.[0] ?? "current host"}`;
    case "not_applicable":
      return "Not required for this page";
    case "unknown":
      return permission.lastError
        ? `Unknown: ${permission.lastError}`
        : "Unknown";
    default:
      return "Unknown";
  }
}

function formatDiagnosticToken(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Unknown";
  }

  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function readPageSessionDiagnostics(diagnostics) {
  const session = diagnostics?.session && typeof diagnostics.session === "object"
    ? diagnostics.session
    : {};
  const contentScript = session.contentScript && typeof session.contentScript === "object"
    ? session.contentScript
    : diagnostics?.currentTab?.contentScript && typeof diagnostics.currentTab.contentScript === "object"
      ? diagnostics.currentTab.contentScript
      : {};

  return {
    ...session,
    ...contentScript
  };
}

function formatPageSafety(pageSafety) {
  const safety = pageSafety && typeof pageSafety === "object"
    ? pageSafety
    : { state: pageSafety };
  const state = safety.state ?? safety.status ?? safety.level ?? safety.kind;

  switch (state) {
    case "safe":
      return safety.reason ? `Safe: ${safety.reason}` : "Safe";
    case "sensitive":
      return safety.reason ? `Sensitive: ${safety.reason}` : "Sensitive";
    case "paused":
    case "sensitive_pause":
      return safety.reason ? `Sensitive pause: ${safety.reason}` : "Sensitive pause";
    case "unknown":
      return "Unknown";
    default: {
      const label = formatDiagnosticToken(state);
      return safety.reason ? `${label}: ${safety.reason}` : label;
    }
  }
}

function readSensitivePauseState(session, storedSensitivePause, host) {
  const pageSafety = session.pageSafety && typeof session.pageSafety === "object"
    ? session.pageSafety
    : {};
  const reason = session.sensitivePauseReason
    ?? session.pauseReason
    ?? pageSafety.sensitivePauseReason
    ?? pageSafety.pauseReason;

  if (session.sensitivePaused === true || reason) {
    return {
      active: true,
      label: reason ? `Active: ${reason}` : "Active",
      reason: reason ?? "review required"
    };
  }

  if (storedSensitivePause && storedSensitivePause.host === host) {
    const storedReason = storedSensitivePause.reason ?? "review required";
    return {
      active: true,
      label: `Active: ${storedReason}`,
      reason: storedReason
    };
  }

  if (session.sensitivePaused === false) {
    return {
      active: false,
      label: "Inactive"
    };
  }

  return {
    active: false,
    label: "Not reported"
  };
}

function formatContentScriptSession(session) {
  const sensitivePaused = session?.sensitivePaused === true || Boolean(session?.sensitivePauseReason);

  switch (session?.state) {
    case "loaded":
      return sensitivePaused ? "Loaded, sensitive pause active" : "Loaded";
    case "blocked_by_host_policy":
      return "Blocked by host policy";
    case "blocked_by_chrome_host_permission":
      return "Blocked by missing host permission";
    case "unavailable":
      return session.lastError ? `Unavailable: ${session.lastError}` : "Unavailable";
    case "unknown":
      return "Unknown";
    case "not_queried":
      return "Not queried";
    case "not_loaded":
      return "Not loaded";
    default:
      return "Unknown";
  }
}

function readPageControlDiagnostics(diagnostics) {
  if (diagnostics?.currentTab?.pageControl && typeof diagnostics.currentTab.pageControl === "object") {
    return diagnostics.currentTab.pageControl;
  }
  if (diagnostics?.session?.pageControl && typeof diagnostics.session.pageControl === "object") {
    return diagnostics.session.pageControl;
  }
  const session = readPageSessionDiagnostics(diagnostics);
  return session.pageControl && typeof session.pageControl === "object" ? session.pageControl : {};
}

function formatReadyControls(capabilities = {}) {
  const labels = [
    ["screenshot", "screenshot"],
    ["domActions", "DOM actions"],
    ["click", "click"],
    ["fill", "fill"],
    ["submit", "submit"],
    ["scroll", "scroll"]
  ]
    .filter(([key]) => capabilities[key] === true)
    .map(([, label]) => label);

  return labels.length > 0 ? labels.join(", ") : "no controls";
}

function formatPageControlReadiness(pageControl) {
  const capabilities = pageControl?.capabilities && typeof pageControl.capabilities === "object"
    ? pageControl.capabilities
    : {};
  const reason = pageControl?.reason ? `: ${pageControl.reason}` : "";

  switch (pageControl?.state) {
    case "ready":
      return `Ready (${formatReadyControls(capabilities)})`;
    case "partial":
      return `Partial (${formatReadyControls(capabilities)})${reason}`;
    case "sensitive-paused":
      return `Paused${reason}`;
    case "needs_confirmation":
      return `Needs confirmation${reason}`;
    case "blocked_by_chrome_host_permission":
      return "Blocked by missing host permission";
    case "blocked_by_host_policy":
      return "Blocked by host policy";
    case "content_script_not_loaded":
    case "not_loaded":
      return "Content script not loaded";
    case "unavailable":
      return reason ? `Unavailable${reason}` : "Unavailable";
    default: {
      const label = formatDiagnosticToken(pageControl?.state);
      return reason ? `${label}${reason}` : label;
    }
  }
}

function setChip(id, label, state) {
  const element = document.getElementById(id);
  element.textContent = label;
  element.dataset.state = state;
}

function readConnectionChip(syncStatus, nativeHost = {}) {
  const state = nativeHost.connectionState ?? syncStatus?.state;

  if (state === "connected" || state === "synced") {
    return {
      label: "Connected",
      state: "connected"
    };
  }

  if (state === "connecting" || state === "syncing") {
    return {
      label: "Connecting",
      state: "unknown"
    };
  }

  if (state === "unavailable" || state === "error") {
    return {
      label: "Disconnected",
      state: "disconnected"
    };
  }

  return {
    label: "Waiting",
    state: "unknown"
  };
}

function readPermissionOrigin(permission = {}) {
  if (Array.isArray(permission.origins) && permission.origins.length > 0) {
    return permission.origins[0];
  }
  if (permission.origin) {
    return `${permission.origin}/*`;
  }
  return "this site";
}

function applyInteractionSummary(syncStatus, diagnostics) {
  const nativeHost = diagnostics?.nativeHost ?? {};
  const currentTab = diagnostics?.currentTab ?? {};
  const pageControl = readPageControlDiagnostics(diagnostics);
  const connectionChip = readConnectionChip(syncStatus, nativeHost);
  const host = currentTab.host || document.getElementById("current-host").textContent || "This page";
  const permission = currentTab.chromeHostPermission ?? {};
  const pageControlState = pageControl?.state;
  let summary = "Checking this page.";
  let actionSummary = "skfiy is reading the current Chrome tab state.";
  let pageChip = {
    label: "Checking page",
    state: "unknown"
  };

  if (permission.state === "missing" || pageControlState === "blocked_by_chrome_host_permission") {
    const origin = readPermissionOrigin(permission);
    summary = "Grant site access to control this page.";
    actionSummary = `Chrome needs permission for ${origin} before skfiy can observe or act.`;
    pageChip = {
      label: "Needs access",
      state: "blocked"
    };
  } else if (pageControlState === "ready") {
    summary = "Ready to control this page.";
    actionSummary = `${host} can be observed and controlled through skfiy.`;
    pageChip = {
      label: "Ready",
      state: "ready"
    };
  } else if (pageControlState === "partial") {
    summary = "Page control is partially available.";
    actionSummary = pageControl.reason || `${host} can be observed, but some actions are not available.`;
    pageChip = {
      label: "Partial",
      state: "unknown"
    };
  } else if (pageControlState === "blocked_by_host_policy") {
    summary = "Allow this host in skfiy first.";
    actionSummary = pageControl.reason || `${host} is blocked by the current skfiy host policy.`;
    pageChip = {
      label: "Policy blocked",
      state: "blocked"
    };
  } else if (pageControlState === "sensitive-paused") {
    summary = "Sensitive content pause is active.";
    actionSummary = pageControl.reason || "Review the page before allowing skfiy to act here.";
    pageChip = {
      label: "Paused",
      state: "blocked"
    };
  } else if (connectionChip.state === "disconnected") {
    summary = "Connect the skfiy app to control this page.";
    actionSummary = "The Chrome adapter is loaded, but the native skfiy app is not connected.";
    pageChip = {
      label: "No app",
      state: "blocked"
    };
  }

  document.getElementById("interaction-summary").textContent = summary;
  document.getElementById("page-action-summary").textContent = actionSummary;
  setChip("connection-chip", connectionChip.label, connectionChip.state);
  setChip("page-control-chip", pageChip.label, pageChip.state);
}

function applyPageDiagnostics(diagnostics, storedSensitivePause, host) {
  const session = readPageSessionDiagnostics(diagnostics);
  const pauseState = readSensitivePauseState(session, storedSensitivePause, host ?? diagnostics?.currentTab?.host);
  const pauseElement = document.getElementById("sensitive-pause");

  document.getElementById("page-safety").textContent = formatPageSafety(session.pageSafety);
  document.getElementById("sensitive-pause-status").textContent = pauseState.label;

  if (pauseState.active) {
    pauseElement.hidden = false;
    pauseElement.textContent = `${SENSITIVE_PAUSE_LABEL}: ${pauseState.reason}`;
  } else {
    pauseElement.hidden = true;
    pauseElement.textContent = SENSITIVE_PAUSE_LABEL;
  }
}

function formatUpdatedAt(updatedAt) {
  if (!updatedAt) {
    return "Never";
  }
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return updatedAt;
  }
  return date.toLocaleString();
}

function applySyncStatus(syncStatus, diagnostics) {
  const nativeHost = diagnostics?.nativeHost ?? {};
  const currentTab = diagnostics?.currentTab ?? {};
  const devReload = diagnostics?.devReload ?? {};
  const lastError = diagnostics?.lastError ?? nativeHost.lastError ?? syncStatus?.lastError ?? syncStatus?.error;

  document.getElementById("native-host").textContent = nativeHost.name ?? "com.sskift.skfiy";
  document.getElementById("extension-version").textContent =
    diagnostics?.extension?.version ? `v${diagnostics.extension.version}` : "Unknown";
  document.getElementById("extension-manifest-version").textContent =
    formatManifestVersion(diagnostics?.extension);
  document.getElementById("extension-capabilities").textContent =
    formatCapabilities(diagnostics?.capabilities);
  document.getElementById("connection-status").textContent = formatConnection(syncStatus, nativeHost);
  document.getElementById("native-bridge-state").textContent = formatBridgeState(nativeHost, syncStatus);
  document.getElementById("native-launch-origin").textContent = formatLaunchOrigin(nativeHost, syncStatus);
  document.getElementById("host-policy-reason").textContent = formatPolicyReason(currentTab.hostPolicy);
  document.getElementById("chrome-host-permission").textContent =
    formatHostPermission(currentTab.chromeHostPermission);
  applyGrantSiteAccessState(currentTab);
  document.getElementById("content-script-session").textContent =
    formatContentScriptSession(readPageSessionDiagnostics(diagnostics));
  document.getElementById("page-control-readiness").textContent =
    formatPageControlReadiness(readPageControlDiagnostics(diagnostics));
  applyInteractionSummary(syncStatus, diagnostics);
  applyPageDiagnostics(diagnostics, undefined, currentTab.host);
  document.getElementById("native-host-policy-state").textContent = formatPolicyState(
    nativeHost.policyState ?? syncStatus?.nativeHostPolicyState ?? syncStatus?.hostPolicyState
  );
  document.getElementById("policy-sync-state").textContent = formatSyncState(syncStatus?.state);
  document.getElementById("native-heartbeat").textContent =
    formatHeartbeat(devReload.heartbeat, syncStatus);
  document.getElementById("dev-reload-status").textContent = formatDevReload(devReload);
  document.getElementById("policy-sync-source").textContent = formatSource(syncStatus?.source);
  document.getElementById("policy-sync-entry-count").textContent = String(syncStatus?.entryCount ?? 0);
  document.getElementById("policy-sync-updated-at").textContent = formatUpdatedAt(syncStatus?.updatedAt);

  const errorLabel = document.getElementById("policy-sync-error-label");
  const errorElement = document.getElementById("policy-sync-error");
  if (lastError) {
    errorLabel.hidden = false;
    errorElement.hidden = false;
    errorElement.textContent = lastError;
  } else {
    errorLabel.hidden = true;
    errorElement.hidden = true;
    errorElement.textContent = "None";
  }
}

function applyGrantSiteAccessState(currentTab) {
  const button = document.getElementById("grant-site-access-button");
  const chromeHostPermission = currentTab?.chromeHostPermission;
  const chromeCapturePermission = currentTab?.chromeCapturePermission;
  const hostOrigins = Array.isArray(chromeHostPermission?.origins)
    ? chromeHostPermission.origins.filter((origin) => typeof origin === "string" && origin.length > 0)
    : [];
  const captureOrigins = Array.isArray(chromeCapturePermission?.origins)
    ? chromeCapturePermission.origins.filter((origin) => typeof origin === "string" && origin.length > 0)
    : [];
  pendingHostPermissionOrigins = [
    ...(chromeHostPermission?.state === "missing" ? hostOrigins : []),
    ...(chromeCapturePermission?.state === "missing" ? captureOrigins : [])
  ].filter((origin, index, origins) => origins.indexOf(origin) === index);
  button.hidden = pendingHostPermissionOrigins.length === 0;
  button.disabled = false;
  if (pendingHostPermissionOrigins.length > 0) {
    button.textContent = `Grant ${pendingHostPermissionOrigins.join(" + ")} and observe`;
  } else {
    button.textContent = "Grant site access";
  }
}

async function requestPolicySnapshot(type, requestId = `popup-${Date.now()}`) {
  const targetTabId = readTargetTabId();
  return chrome.runtime.sendMessage({
    type,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId,
    ...(Number.isInteger(targetTabId) ? { tabId: targetTabId } : {})
  });
}

async function renderPopup() {
  const tab = await readPopupTargetTab();
  const host = hostFromUrl(tab?.url ?? "");
  const stored = await chrome.storage.local.get([HOST_POLICY_STORAGE_KEY, LAST_SENSITIVE_PAUSE_KEY]);
  const snapshot = await requestPolicySnapshot(MESSAGE_TYPES.HOST_POLICY_SYNC_STATUS);
  const policy = {
    ...HOST_POLICY_SHAPE,
    ...(snapshot?.policy ?? stored[HOST_POLICY_STORAGE_KEY] ?? {})
  };
  const sensitivePause = stored[LAST_SENSITIVE_PAUSE_KEY];

  document.getElementById("current-host").textContent = host || "Unknown";
  document.getElementById("host-policy").textContent = labelForPolicy(policy, host);
  applySyncStatus(snapshot?.syncStatus, snapshot?.diagnostics);
  applyPageDiagnostics(snapshot?.diagnostics, sensitivePause, host);
}

function shouldAutoCheckHeartbeat() {
  try {
    return new URL(globalThis.location?.href ?? "").searchParams.has("skfiyWake");
  } catch {
    return false;
  }
}

function readTargetTabId() {
  try {
    const value = new URL(globalThis.location?.href ?? "").searchParams.get("skfiyTargetTabId");
    const parsed = value ? Number.parseInt(value, 10) : NaN;
    return Number.isInteger(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readWakeAction() {
  try {
    return new URL(globalThis.location?.href ?? "").searchParams.get("skfiyWakeAction") ?? "";
  } catch {
    return "";
  }
}

function readWakeParam(name) {
  try {
    return new URL(globalThis.location?.href ?? "").searchParams.get(name) ?? "";
  } catch {
    return "";
  }
}

function readWakeDy() {
  const parsed = Number.parseInt(readWakeParam("skfiyDy"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createWakeDirectiveFromLocation() {
  const targetTabId = readTargetTabId();
  return {
    wakeId: readWakeParam("skfiyWake"),
    requestId: readWakeParam("skfiyRequestId"),
    ...(Number.isInteger(targetTabId) ? { targetTabId } : {}),
    wakeAction: readWakeAction(),
    selector: readWakeParam("skfiySelector"),
    text: readWakeParam("skfiyText"),
    dy: readWakeDy()
  };
}

async function readPopupTargetTab() {
  const targetTabId = readTargetTabId();
  const wakeAction = readWakeAction();
  if (!wakeAction && Number.isInteger(targetTabId) && typeof chrome.tabs.get === "function") {
    try {
      return await chrome.tabs.get(targetTabId);
    } catch {
      // Fall through to active-tab diagnostics when a wake URL points at a stale tab.
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshHostPolicy() {
  const button = document.getElementById("sync-policy-button");
  button.disabled = true;
  applySyncStatus({ state: "syncing", source: "native_host", entryCount: 0 }, undefined);

  try {
    const tab = await readPopupTargetTab();
    const host = hostFromUrl(tab?.url ?? "");
    const snapshot = await requestPolicySnapshot(MESSAGE_TYPES.HOST_POLICY_SYNC_REFRESH);
    const policy = {
      ...HOST_POLICY_SHAPE,
      ...(snapshot?.policy ?? {})
    };

    document.getElementById("host-policy").textContent = labelForPolicy(policy, host);
    applySyncStatus(snapshot?.syncStatus, snapshot?.diagnostics);
  } catch (error) {
    applySyncStatus({
      state: "error",
      source: "native_host",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : "Unable to refresh policy",
      error: error instanceof Error ? error.message : "Unable to refresh policy"
    }, undefined);
  } finally {
    button.disabled = false;
  }
}

async function checkHeartbeat() {
  const button = document.getElementById("heartbeat-button");
  button.disabled = true;
  document.getElementById("native-heartbeat").textContent = "Checking";

  try {
    const targetTabId = readTargetTabId();
    const snapshot = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.NATIVE_HEARTBEAT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: `popup-${Date.now()}`,
      ...(Number.isInteger(targetTabId) ? { tabId: targetTabId } : {})
    });
    applySyncStatus(snapshot?.syncStatus, snapshot?.diagnostics);
  } catch (error) {
    applySyncStatus({
      state: "error",
      source: "native_host",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : "Unable to check heartbeat",
      error: error instanceof Error ? error.message : "Unable to check heartbeat"
    }, undefined);
  } finally {
    button.disabled = false;
  }
}

async function observeCurrentPageFromWake(source = "popup_observe") {
  const targetTabId = readTargetTabId();
  const wakeRequestId = readWakeParam("skfiyRequestId");
  const observeRequestId = wakeRequestId || `popup-observe-${Date.now()}`;
  const nativeRequestId = wakeRequestId || `popup-observe-native-${Date.now()}`;

  try {
    const observeResponse = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.PAGE_OBSERVE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: observeRequestId,
      payload: {
        mode: "current_page",
        include: ["title", "url", "visible_text", "forms", "interactive_elements"],
        source
      },
      ...(Number.isInteger(targetTabId) ? { tabId: targetTabId } : {})
    });
    const pageObservation = observeResponse?.snapshot && typeof observeResponse.snapshot === "object"
      ? observeResponse.snapshot
      : observeResponse?.pageObservation;
    const snapshot = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.NATIVE_MESSAGE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: nativeRequestId,
      payload: {
        type: MESSAGE_TYPES.PAGE_OBSERVE,
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        requestId: nativeRequestId,
        payload: {
          mode: "current_page",
          include: ["title", "url", "visible_text", "forms", "interactive_elements"],
          source,
          ...(Number.isInteger(targetTabId) ? { targetTabId } : {}),
          ...(pageObservation ? { pageObservation } : {})
        }
      }
    });
    applySyncStatus({
      state: snapshot?.result === "accepted" ? "synced" : "error",
      source: "native_host",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      nativeBridgeState: snapshot?.result === "accepted" ? "connected" : "unavailable",
      nativeLaunchOrigin: snapshot?.syncStatus?.nativeLaunchOrigin ?? snapshot?.launchOrigin,
      nativeMessageType: MESSAGE_TYPES.PAGE_OBSERVE,
      lastError: snapshot?.reason ?? snapshot?.error ?? null,
      error: snapshot?.reason ?? snapshot?.error ?? null
    }, undefined);
  } catch (error) {
    applySyncStatus({
      state: "error",
      source: "native_host",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : "Unable to observe page",
      error: error instanceof Error ? error.message : "Unable to observe page"
    }, undefined);
  }
}

function createPageControlRequestFromWake() {
  const targetTabId = readTargetTabId();
  const wakeAction = readWakeAction();
  const requestId = readWakeParam("skfiyRequestId") || `popup-${wakeAction}-${Date.now()}`;

  if (wakeAction === "screenshot") {
    return {
      type: MESSAGE_TYPES.PAGE_SCREENSHOT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId,
      ...(Number.isInteger(targetTabId) ? { tabId: targetTabId } : {}),
      payload: {
        format: "png"
      }
    };
  }

  const selector = readWakeParam("skfiySelector");
  const action = (() => {
    if (wakeAction === "click") {
      return { kind: "click", selector };
    }
    if (wakeAction === "fill") {
      return { kind: "fill", selector, value: readWakeParam("skfiyText") };
    }
    if (wakeAction === "submit") {
      return { kind: "submit", selector, confirmed: true };
    }
    if (wakeAction === "scroll") {
      return { kind: "scroll", deltaY: readWakeDy() };
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
    ...(Number.isInteger(targetTabId) ? { tabId: targetTabId } : {}),
    payload: {
      action
    }
  };
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function readString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function summarizePageScreenshot(response, targetTabId) {
  const record = readRecord(response) ?? {};
  const dataUrl = readString(record.dataUrl);

  return {
    type: readString(record.type) ?? "skfiy.page.screenshot_result",
    ...(readString(record.requestId) ? { requestId: record.requestId } : {}),
    ...(readString(record.result) ? { result: record.result } : {}),
    ...(readNumber(record.tabId) ? { tabId: record.tabId } : {}),
    ...(Number.isInteger(targetTabId) ? { targetTabId } : {}),
    ...(readString(record.host) ? { host: record.host } : {}),
    ...(readString(record.format) ? { format: record.format } : {}),
    hasDataUrl: Boolean(dataUrl),
    ...(dataUrl ? { dataUrlBytes: dataUrl.length } : {}),
    ...(readString(record.reason) ? { reason: record.reason } : {})
  };
}

function summarizePageActionResult(response, targetTabId, action) {
  const record = readRecord(response) ?? {};
  const actionName = readString(record.action) ?? readString(action?.kind);
  const selector = readString(record.selector) ?? readString(action?.selector);
  const deltaY = readNumber(record.deltaY) ?? readNumber(action?.deltaY);

  return {
    type: readString(record.type) ?? "skfiy.page.action_result",
    ...(readString(record.requestId) ? { requestId: record.requestId } : {}),
    ...(readString(record.result) ? { result: record.result } : {}),
    ...(actionName ? { action: actionName } : {}),
    ...(readString(record.reason) ? { reason: record.reason } : {}),
    ...(Number.isInteger(targetTabId) ? { targetTabId } : {}),
    ...(selector ? { selector } : {}),
    ...(typeof deltaY === "number" ? { deltaY } : {})
  };
}

async function captureScreenshotFromWake(targetTabId, format, requestId) {
  let tab;
  try {
    if (Number.isInteger(targetTabId) && typeof chrome.tabs.get === "function") {
      tab = await chrome.tabs.get(targetTabId);
    }
    if (Number.isInteger(targetTabId) && typeof chrome.tabs.update === "function") {
      await chrome.tabs.update(targetTabId, {
        active: true
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (typeof chrome.tabs.captureVisibleTab !== "function") {
      throw new Error("chrome.tabs.captureVisibleTab is unavailable");
    }

    const windowId = readNumber(tab?.windowId);
    const captureOptions = { format };
    const dataUrl = typeof windowId === "number"
      ? await chrome.tabs.captureVisibleTab(windowId, captureOptions)
      : await chrome.tabs.captureVisibleTab(captureOptions);

    return {
      type: "skfiy.page.screenshot_result",
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId,
      result: "passed",
      ...(Number.isInteger(targetTabId) ? { tabId: targetTabId } : {}),
      ...(readString(hostFromUrl(tab?.url ?? "")) ? { host: hostFromUrl(tab?.url ?? "") } : {}),
      format,
      dataUrl
    };
  } catch (error) {
    return {
      type: "skfiy.page.screenshot_result",
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId,
      result: "blocked",
      reason: error instanceof Error ? error.message : "capture_visible_tab_failed",
      ...(Number.isInteger(targetTabId) ? { tabId: targetTabId } : {}),
      ...(readString(hostFromUrl(tab?.url ?? "")) ? { host: hostFromUrl(tab?.url ?? "") } : {}),
      format
    };
  }
}

async function runPageControlFromWake() {
  const request = createPageControlRequestFromWake();
  const targetTabId = readTargetTabId();

  if (!request) {
    await checkHeartbeat();
    return;
  }

  try {
    const response = request.type === MESSAGE_TYPES.PAGE_SCREENSHOT
      ? await captureScreenshotFromWake(targetTabId, request.payload.format, request.requestId)
      : await chrome.runtime.sendMessage(request);
    const nativeRequestId = readWakeParam("skfiyRequestId") || `popup-${readWakeAction()}-native-${Date.now()}`;
    const payload = request.type === MESSAGE_TYPES.PAGE_SCREENSHOT
      ? {
          source: "popup_wake",
          ...(Number.isInteger(targetTabId) ? { targetTabId } : {}),
          format: request.payload.format,
          pageScreenshot: summarizePageScreenshot(response, targetTabId)
        }
      : {
          source: "popup_wake",
          ...(Number.isInteger(targetTabId) ? { targetTabId } : {}),
          action: request.payload.action,
          pageActionResult: summarizePageActionResult(response, targetTabId, request.payload.action)
        };
    const snapshot = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.NATIVE_MESSAGE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: nativeRequestId,
      payload: {
        type: request.type,
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        requestId: nativeRequestId,
        payload
      }
    });
    applySyncStatus({
      state: snapshot?.result === "accepted" ? "synced" : "error",
      source: "native_host",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      nativeBridgeState: snapshot?.result === "accepted" ? "connected" : "unavailable",
      nativeMessageType: request.type,
      lastError: snapshot?.reason ?? snapshot?.error ?? null,
      error: snapshot?.reason ?? snapshot?.error ?? null
    }, undefined);
  } catch (error) {
    applySyncStatus({
      state: "error",
      source: "native_host",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : "Unable to run page action",
      error: error instanceof Error ? error.message : "Unable to run page action"
    }, undefined);
  }
}

async function delegatePageControlWakeToBackground() {
  const directive = createWakeDirectiveFromLocation();
  const requestId = directive.requestId || `popup-${directive.wakeAction}-wake-${Date.now()}`;

  try {
    const snapshot = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.PAGE_CONTROL_WAKE,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId,
      directive
    });
    applySyncStatus({
      state: snapshot?.result === "scheduled" ? "syncing" : "error",
      source: "extension_background",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      nativeBridgeState: "unknown",
      nativeMessageType: MESSAGE_TYPES.PAGE_CONTROL_WAKE,
      lastError: snapshot?.reason ?? snapshot?.error ?? null,
      error: snapshot?.reason ?? snapshot?.error ?? null
    }, undefined);
  } catch (error) {
    applySyncStatus({
      state: "error",
      source: "extension_background",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : "Unable to delegate page action",
      error: error instanceof Error ? error.message : "Unable to delegate page action"
    }, undefined);
  }
}

async function runTabDiscoveryFromWake() {
  try {
    const wakeRequestId = readWakeParam("skfiyRequestId");
    const snapshot = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.TABS_DISCOVER,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: wakeRequestId || `popup-tabs-${Date.now()}`
    });
    applySyncStatus({
      state: snapshot?.nativeHeartbeat?.result === "accepted" ? "synced" : "error",
      source: "native_host",
      entryCount: Array.isArray(snapshot?.tabs) ? snapshot.tabs.length : 0,
      updatedAt: new Date().toISOString(),
      nativeBridgeState: snapshot?.nativeHeartbeat?.result === "accepted" ? "connected" : "unavailable",
      nativeMessageType: MESSAGE_TYPES.TABS_DISCOVER,
      lastError: snapshot?.nativeHeartbeat?.reason ?? snapshot?.nativeHeartbeat?.error ?? null,
      error: snapshot?.nativeHeartbeat?.reason ?? snapshot?.nativeHeartbeat?.error ?? null
    }, undefined);
  } catch (error) {
    applySyncStatus({
      state: "error",
      source: "native_host",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : "Unable to discover tabs",
      error: error instanceof Error ? error.message : "Unable to discover tabs"
    }, undefined);
  }
}

async function reloadExtension() {
  const button = document.getElementById("dev-reload-button");
  button.disabled = true;
  document.getElementById("dev-reload-status").textContent = "Checking heartbeat";

  try {
    const snapshot = await requestPolicySnapshot(
      MESSAGE_TYPES.DEV_RELOAD_REQUEST,
      readWakeParam("skfiyRequestId") || `popup-${Date.now()}`
    );
    applySyncStatus(snapshot?.syncStatus, snapshot?.diagnostics);
    document.getElementById("dev-reload-status").textContent =
      formatDevReload(snapshot?.devReload ?? snapshot?.diagnostics?.devReload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reload extension";
    document.getElementById("dev-reload-status").textContent = `Error: ${message}`;
    applySyncStatus({
      state: "error",
      source: "native_host",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      lastError: message,
      error: message
    }, undefined);
  } finally {
    button.disabled = false;
  }
}

async function grantSiteAccess() {
  const button = document.getElementById("grant-site-access-button");
  const origins = [...pendingHostPermissionOrigins];
  if (origins.length === 0) {
    button.hidden = true;
    return;
  }

  button.disabled = true;
  button.textContent = "Requesting access";

  try {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      button.textContent = "Access not granted";
      return;
    }
    button.textContent = "Access granted";
    await refreshHostPolicy();
    await observeCurrentPageFromWake("popup_grant_observe");
  } catch (error) {
    button.textContent = error instanceof Error ? error.message : "Unable to request access";
  } finally {
    button.disabled = false;
  }
}

document.getElementById("sync-policy-button").addEventListener("click", () => {
  void refreshHostPolicy();
});

document.getElementById("grant-site-access-button").addEventListener("click", () => {
  void grantSiteAccess();
});

document.getElementById("heartbeat-button").addEventListener("click", () => {
  void observeCurrentPageFromWake();
});

document.getElementById("dev-reload-button").addEventListener("click", () => {
  void reloadExtension();
});

let autoWakeActionStarted = false;

function startAutoWakeAction() {
  if (!shouldAutoCheckHeartbeat() || autoWakeActionStarted) {
    return false;
  }

  autoWakeActionStarted = true;
  const wakeAction = readWakeAction();
  if (wakeAction === "observe") {
    void delegatePageControlWakeToBackground();
    return true;
  }
  if (wakeAction === "tabs") {
    void runTabDiscoveryFromWake();
    return true;
  }
  if (wakeAction === "dev-reload") {
    void reloadExtension();
    return true;
  }
  if (["screenshot", "click", "fill", "submit", "scroll"].includes(wakeAction)) {
    void delegatePageControlWakeToBackground();
    return true;
  }

  void checkHeartbeat();
  return true;
}

if (shouldAutoCheckHeartbeat() && readWakeAction()) {
  startAutoWakeAction();
}

void renderPopup()
  .then(() => {
    startAutoWakeAction();
  })
  .catch((error) => {
    document.getElementById("connection-status").textContent =
      error instanceof Error ? error.message : "Unable to read status";
    applySyncStatus({
      state: "error",
      source: "local_storage",
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : "Unable to read status",
      error: error instanceof Error ? error.message : "Unable to read status"
    }, undefined);
  });
