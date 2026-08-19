import path from "node:path";

export const DEFAULT_PORT = 9245;
export const DEFAULT_CHROME_PORT = 9444;
export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_SETTLE_MS = 500;
export const EXPECTED_TEXT = "skfiy chrome smoke ready";
export const FORM_EXPECTED_TEXT = "skfiy agent@skfiy.test operator form submitted";
export const CURRENT_PAGE_COMMAND = "观察 Chrome 当前页面并提取正文";
export const SENSITIVE_EXPECTED_RESULT = "sensitive-paused";
export const PRODUCT_PATH = "renderer -> preload -> main -> CDP -> Chrome";
export const NATIVE_HOST_BRIDGE_PRODUCT_PATH =
  "dist/skfiy -> Chrome Native Messaging heartbeat";
export const INSTALLED_EXTENSION_PRODUCT_PATH =
  "Chrome MV3 extension -> Native Messaging -> dist/skfiy heartbeat";
export const INSTALLED_EXTENSION_ACTION_PRODUCT_PATH =
  "dist/skfiy -> chrome tabs/reload-extension/observe/screenshot/fill/click/submit/scroll -> installed Chrome extension";
export const CHROME_EXTENSION_SETUP_GUIDE_PATH = "docs/chrome-extension-setup.md";
export const CHROME_EXTENSION_SETUP_GUIDE_REQUIRED_TERMS = [
  "chrome-extension/manifest.json",
  "com.sskift.skfiy",
  "NativeMessagingHosts/com.sskift.skfiy.json",
  "chrome-extension-connection.json",
  "chrome install-host --extension-id <extension-id>",
  "chrome status --extension-id <extension-id>",
  "Refresh host policy",
  "Host permission",
  "Page session",
  "Chromium Dashboard Dogfood",
  "plcpkkhlcacihjfohlojdknnkademlno",
  "Application Support/Chromium/NativeMessagingHosts/com.sskift.skfiy.json",
  "--extension-chrome-app \"Chromium\"",
  "skfiy.page_control.health",
  "readinessSnapshot",
  "remediation",
  "doctor --json --extension-id <extension-id>",
  "branded_chrome_load_extension_removed"
];
export const INSTALLED_EXTENSION_CHROME_APP_CANDIDATES = [
  "Chromium",
  "Google Chrome for Testing"
];
export const FALLBACK_PRODUCT_PATH =
  "renderer -> preload -> main -> helper observe_app -> Chrome screenshot fallback";
export const FALLBACK_SWITCH_PRODUCT_PATH =
  "renderer -> preload -> main -> CDP failure -> helper observe_app -> Chrome screenshot fallback";
export const CHROME_QUIET_LAUNCH_MODE = "quiet-background";
export const CHROME_FOCUS_STEAL_LAUNCH_MODE = "focus-stealing-field";

export function createDefaultChromeSmokeOptions(rootDir) {
  return {
    appPath: path.join(rootDir, "dist", "skfiy.app"),
    cliPath: path.join(rootDir, "dist", "skfiy"),
    chromeAppName: "Google Chrome",
    extensionChromeAppName: undefined,
    extensionId: undefined,
    port: DEFAULT_PORT,
    chromePort: DEFAULT_CHROME_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    settleMs: DEFAULT_SETTLE_MS,
    keepExisting: false,
    keepOpen: false,
    allowFocusSteal: false,
    launchMode: CHROME_QUIET_LAUNCH_MODE,
    requirePassed: false,
    currentPageEndpoint: undefined,
    outputPath: undefined,
    help: false
  };
}

export function parseChromeSmokeArgs(argv, defaults) {
  const options = { ...defaults };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--app":
        options.appPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--cli":
        options.cliPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--chrome-app":
        options.chromeAppName = readValue(argv, index, arg);
        index += 1;
        break;
      case "--extension-chrome-app":
        options.extensionChromeAppName = readValue(argv, index, arg);
        index += 1;
        break;
      case "--extension-id":
        options.extensionId = readChromeExtensionId(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--port":
        options.port = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--chrome-port":
        options.chromePort = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--settle-ms":
        options.settleMs = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--keep-existing":
        options.keepExisting = true;
        break;
      case "--keep-open":
        options.keepOpen = true;
        break;
      case "--allow-focus-steal":
        options.allowFocusSteal = true;
        options.launchMode = CHROME_FOCUS_STEAL_LAUNCH_MODE;
        break;
      case "--require-passed":
        options.requirePassed = true;
        break;
      case "--current-page-endpoint":
        options.currentPageEndpoint = normalizeEndpoint(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--output":
        options.outputPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function assertChromeFocusStealAllowed(options) {
  const blocker = readChromeFocusStealBlocker(options);
  if (!blocker) {
    return;
  }

  throw new Error(blocker);
}

export function readChromeFocusStealBlocker(options) {
  return null;
}

export function createHelpText(defaults) {
  return `Usage: npm run smoke:chrome -- [options]

Runs the packaged skfiy app through a Chrome test-page product path.
Chrome extension setup guide: ${CHROME_EXTENSION_SETUP_GUIDE_PATH}
Default: quiet background Chromium/skfiy launch without focus or keyboard input.

Options:
  --app <path>          App bundle path. Default: ${defaults.appPath}
  --cli <path>          Packaged CLI path for Native Messaging heartbeat. Default: ${defaults.cliPath}
  --chrome-app <name>   macOS Chrome app name. Default: ${defaults.chromeAppName}
  --extension-chrome-app <name>
                        Browser app for installed-extension smoke. Auto-prefers Chromium, then Chrome for Testing, when available.
  --extension-id <id>   Manually installed skfiy Chrome extension id for action smoke.
  --port <number>       Electron remote debugging port. Default: ${defaults.port}
  --chrome-port <num>   Chrome DevTools Protocol port. Default: ${defaults.chromePort}
  --timeout-ms <number> Renderer and Chrome wait timeout. Default: ${defaults.timeoutMs}
  --settle-ms <number>  Delay after renderer actions. Default: ${defaults.settleMs}
  --output <path>       Persist smoke evidence JSON.
  --require-passed      Exit non-zero unless the smoke result is passed.
  --allow-focus-steal   Use the old visible field lane that may focus Chrome/skfiy.
  --current-page-endpoint <url>
                        Attach to an existing Chrome CDP endpoint and observe the current page only.
  --keep-existing       Do not quit an existing skfiy app before launch.
  --keep-open           Leave skfiy open after the smoke run.
  -h, --help            Show this help.
`;
}

export function validateChromeExtensionSetupGuide(source) {
  const text = String(source ?? "");
  const missingTerms = CHROME_EXTENSION_SETUP_GUIDE_REQUIRED_TERMS
    .filter((term) => !text.includes(term));

  return {
    ok: missingTerms.length === 0,
    missingTerms
  };
}

export function selectInstalledExtensionChromeApp({
  chromeAppName,
  extensionChromeAppName,
  availableAppNames = []
}) {
  const normalizedAvailable = availableAppNames.filter((name) => typeof name === "string");
  const candidates = INSTALLED_EXTENSION_CHROME_APP_CANDIDATES;

  if (extensionChromeAppName) {
    return {
      chromeAppName: extensionChromeAppName,
      source: "explicit-extension-chrome-app",
      loadExtensionFriendly: isLoadExtensionFriendlyChromeAppName(extensionChromeAppName),
      candidateAppNames: candidates,
      availableAppNames: normalizedAvailable
    };
  }

  if (isLoadExtensionFriendlyChromeAppName(chromeAppName)) {
    return {
      chromeAppName,
      source: "primary-browser",
      loadExtensionFriendly: true,
      candidateAppNames: candidates,
      availableAppNames: normalizedAvailable
    };
  }

  const discovered = candidates.find((candidate) => normalizedAvailable.includes(candidate));
  if (discovered) {
    return {
      chromeAppName: discovered,
      source: "auto-discovered-loadable-browser",
      loadExtensionFriendly: true,
      candidateAppNames: candidates,
      availableAppNames: normalizedAvailable
    };
  }

  return {
    chromeAppName,
    source: "fallback-primary-browser",
    loadExtensionFriendly: isLoadExtensionFriendlyChromeAppName(chromeAppName),
    candidateAppNames: candidates,
    availableAppNames: normalizedAvailable,
    recommendedBrowser: "Chrome for Testing or Chromium"
  };
}

export function isLoadExtensionFriendlyChromeAppName(chromeAppName) {
  return /Chrome for Testing|Chromium/i.test(String(chromeAppName ?? ""));
}

export function classifyChromeSmokeEvidence({
  events = [],
  extractedText = "",
  expectedText = EXPECTED_TEXT,
  runnerHasTmux = false,
  appLaunchViaOpen = false,
  chromeLaunchViaOpen = false,
  productPath,
  nativeHostBridgeRun,
  installedExtensionRun,
  pageControl,
  readinessDiagnostics
}) {
  const last = events.at(-1);

  if (!last) {
    return "no-events";
  }

  if (last.status === "approval_required") {
    return "needs-user-confirmation";
  }

  if (last.status === "needs_confirmation" && isChromeSensitivePauseMessage(last.message)) {
    return SENSITIVE_EXPECTED_RESULT;
  }

  if (last.status === "failed" && isChromeBlockedMessage(last.message)) {
    return "blocked";
  }

  if (last.status !== "completed") {
    return last.status ?? "failed";
  }

  if (
    runnerHasTmux
    || appLaunchViaOpen !== true
    || chromeLaunchViaOpen !== true
    || productPath !== PRODUCT_PATH
    || !hasChromeReadinessDiagnostics(readinessDiagnostics)
    || !hasNativeHostBridgeEvidence(nativeHostBridgeRun)
    || !hasInstalledExtensionSmokeEvidence(installedExtensionRun)
    || !hasChromePageControlEvidence(pageControl, installedExtensionRun)
    || !String(extractedText).includes(expectedText)
  ) {
    return "failed";
  }

  return "passed";
}

function hasInstalledExtensionSmokeEvidence(run) {
  if (isKnownInstalledExtensionSmokeBlocker(run)) {
    return true;
  }

  return run
    && typeof run === "object"
    && run.result === "passed"
    && run.productPath === INSTALLED_EXTENSION_PRODUCT_PATH
    && typeof run.extensionId === "string"
    && run.extensionId.length === 32
    && run.launchOrigin === `chrome-extension://${run.extensionId}/`
    && run.response?.type === "skfiy.native.response"
    && run.response?.requestId === "chrome-smoke-installed-extension"
    && run.response?.result === "accepted"
    && typeof run.heartbeatPath === "string"
    && run.heartbeatPath.includes("Application Support/skfiy/chrome-extension-connection.json")
    && hasInstalledExtensionHeartbeatEvidence(run.heartbeat, `chrome-extension://${run.extensionId}/`)
    && hasInstalledExtensionStatusDiagnostics(run.extensionStatus, run.extensionId)
    && hasInstalledExtensionPageControlHealth(run.pageControlHealth, run.extensionId);
}

function hasInstalledExtensionHeartbeatEvidence(heartbeat, launchOrigin) {
  const record = readRecord(heartbeat);

  return record?.hostName === "com.sskift.skfiy"
    && record?.launchOrigin === launchOrigin;
}

function isKnownInstalledExtensionSmokeBlocker(run) {
  return run
    && typeof run === "object"
    && run.result === "blocked"
    && run.productPath === INSTALLED_EXTENSION_PRODUCT_PATH
    && run.blockedReason === "branded_chrome_load_extension_removed"
    && typeof run.chromeVersion === "string"
    && typeof run.extensionPath === "string"
    && run.recommendedBrowser === "Chrome for Testing or Chromium";
}

export function hasChromePageControlEvidence(pageControl, installedExtensionRun) {
  if (
    !pageControl
    || typeof pageControl !== "object"
    || Array.isArray(pageControl)
    || pageControl.schemaVersion !== 1
    || pageControl.capability !== "chrome-extension-page-control"
    || typeof pageControl.state !== "string"
    || pageControl.state.length === 0
    || pageControl.state === "unknown"
    || typeof pageControl.reason !== "string"
    || pageControl.reason.length === 0
    || typeof pageControl.source !== "string"
    || pageControl.source.length === 0
    || typeof pageControl.capable !== "boolean"
    || !pageControl.capabilities
    || typeof pageControl.capabilities !== "object"
    || Array.isArray(pageControl.capabilities)
  ) {
    return false;
  }

  if (isKnownInstalledExtensionSmokeBlocker(installedExtensionRun)) {
    const blockers = Array.isArray(pageControl.blockers) ? pageControl.blockers : [];
    return pageControl.state === "unavailable"
      && blockers.some((blocker) => blocker?.code === installedExtensionRun.blockedReason);
  }

  return installedExtensionRun?.result === "passed"
    && [
      "ready",
      "partial",
      "sensitive-paused",
      "needs_confirmation",
      "blocked_by_host_policy",
      "blocked_by_chrome_host_permission",
      "content_script_not_loaded",
      "not_loaded",
      "unavailable",
      "active_tab_unavailable",
      "not-probed",
      "needs-action"
    ].includes(pageControl.state);
}

export function selectInstalledExtensionActionTargetTab(tabs = [], fixtureUrl = "") {
  const fixture = parseUrl(fixtureUrl);

  if (!fixture) {
    return undefined;
  }

  return tabs.find((tab) => {
    const record = readRecord(tab);
    const url = parseUrl(record?.url);

    return record
      && url
      && (record.eligible === true || record.state === "eligible")
      && ["http:", "https:"].includes(url.protocol)
      && url.origin === fixture.origin
      && url.pathname === fixture.pathname
      && isCompatibleFixtureSearch(url, fixture);
  });
}

export function readInstalledExtensionActionTargetTabs(tabsRun = {}) {
  const record = readRecord(tabsRun);

  if (!record) {
    return [];
  }

  const sources = [
    record.tabs,
    readRecord(readRecord(record.extensionConnection)?.latestCommand)?.pageTabs?.tabs,
    readRecord(record.extensionConnection)?.pageTabs?.tabs
  ];
  const tabs = [];
  const seen = new Set();

  for (const source of sources) {
    if (!Array.isArray(source)) {
      continue;
    }

    for (const tab of source) {
      const entry = readRecord(tab);
      if (!entry) {
        continue;
      }

      const key = `${String(entry.id ?? "")}:${String(entry.url ?? "")}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      tabs.push(entry);
    }
  }

  return tabs;
}

export function classifyInstalledExtensionActionSmokeEvidence(run = {}) {
  const record = readRecord(run);

  if (!record) {
    return "not-run";
  }

  if (
    record.runnerHasTmux === true
    || record.productPath !== INSTALLED_EXTENSION_ACTION_PRODUCT_PATH
  ) {
    return "failed";
  }

  if (
    typeof record.extensionId !== "string"
    || record.extensionId.length !== 32
  ) {
    return "blocked";
  }

  if (record.result === "blocked" && isKnownInstalledExtensionActionBlocker(record.reason)) {
    return "blocked";
  }

  const tabsRun = readRecord(record.tabsRun);
  const tabs = readInstalledExtensionActionTargetTabs(tabsRun);
  const selectedTargetTab = readRecord(record.selectedTargetTab)
    ?? selectInstalledExtensionActionTargetTab(tabs, String(record.fixtureUrl ?? ""));

  if (
    tabsRun?.result !== "verified"
    || !selectedTargetTab
  ) {
    return "blocked";
  }

  const reloadRun = readRecord(record.reloadRun);
  if (!isAcceptableInstalledExtensionReloadRun(reloadRun)) {
    if (reloadRun?.result === "blocked") {
      return isKnownInstalledExtensionActionBlocker(reloadRun.reason) ? "blocked" : "failed";
    }

    return "failed";
  }

  const blockedStep = [
    record.observeRun,
    record.fillRun,
    record.clickRun,
    record.submitRun,
    record.scrollRun
  ].map(readRecord).find((step) => step?.result === "blocked");

  if (blockedStep) {
    return isKnownInstalledExtensionActionBlocker(blockedStep.reason) ? "blocked" : "failed";
  }

  if (
    ![
      record.observeRun,
      record.fillRun,
      record.clickRun,
      record.submitRun,
      record.scrollRun
    ].every(isVerifiedChromeCliRun)
  ) {
    return "failed";
  }

  const finalText = String(
    record.finalVisibleText
      ?? readRecord(readRecord(record.finalObserveRun)?.extensionConnection)?.pageObservation?.visibleText
      ?? ""
  );

  if (
    !finalText.includes("clicked")
    || !finalText.includes("submitted skfiy")
  ) {
    return "failed";
  }

  const screenshotRun = readRecord(record.screenshotRun);

  if (hasVerifiedChromeScreenshotRun(screenshotRun)) {
    return "passed";
  }

  if (isKnownScreenshotBlockedRun(screenshotRun)) {
    return "screenshot-blocked";
  }

  return "failed";
}

export function createInstalledExtensionBlockerRemediation({
  blockedReason = "skfiy_extension_worker_not_loaded",
  chromeAppName,
  chromeVersion,
  recommendedBrowser = "Chrome for Testing or Chromium"
} = {}) {
  const common = {
    schemaVersion: 1,
    code: blockedReason,
    docsPath: CHROME_EXTENSION_SETUP_GUIDE_PATH,
    chromeAppName: typeof chromeAppName === "string" ? chromeAppName : undefined,
    chromeVersion: typeof chromeVersion === "string" ? chromeVersion : undefined,
    recommendedBrowser
  };

  if (blockedReason === "branded_chrome_load_extension_removed") {
    return {
      ...common,
      summary: "Branded Google Chrome blocked automated unpacked extension loading for the installed-extension smoke proof.",
      nextAction: `Use ${recommendedBrowser}, pass --extension-chrome-app "Chromium", or manually install the skfiy extension before rerunning smoke:chrome.`,
      commands: [
        "npm run smoke:chrome -- --extension-chrome-app \"Chromium\" --output .skfiy-smoke/chrome-extension.json"
      ]
    };
  }

  return {
    ...common,
    summary: "The skfiy extension service worker was not visible in Chrome DevTools targets.",
    nextAction: `Open chrome://extensions, verify the unpacked skfiy extension is loaded, or rerun smoke:chrome with ${recommendedBrowser}.`,
    commands: [
      "npm run smoke:chrome -- --extension-chrome-app \"Chromium\" --output .skfiy-smoke/chrome-extension.json"
    ]
  };
}

export function createInstalledExtensionBlockers(input = {}) {
  const remediation = createInstalledExtensionBlockerRemediation(input);

  return [
    {
      code: remediation.code,
      message: remediation.summary,
      nextAction: remediation.nextAction,
      docsPath: remediation.docsPath,
      recommendedBrowser: remediation.recommendedBrowser,
      ...(remediation.chromeAppName ? { chromeAppName: remediation.chromeAppName } : {}),
      ...(remediation.chromeVersion ? { chromeVersion: remediation.chromeVersion } : {})
    }
  ];
}

export function createInstalledExtensionReadinessSnapshot({
  result,
  extensionId,
  launchOrigin,
  extensionStatus,
  pageControlHealth,
  response,
  heartbeat,
  heartbeatReadError,
  blockedReason,
  blockers = [],
  remediation
} = {}) {
  const statusRecord = readRecord(extensionStatus) ?? {};
  const healthRecord = readRecord(pageControlHealth) ?? {};
  const diagnostics = readRecord(statusRecord.diagnostics) ?? {};
  const healthDiagnostics = readRecord(healthRecord.diagnostics) ?? {};
  const extension = readRecord(diagnostics.extension) ?? {};
  const nativeHost = readRecord(diagnostics.nativeHost) ?? {};
  const syncStatus = readRecord(statusRecord.syncStatus) ?? {};
  const session = readRecord(diagnostics.session) ?? {};
  const healthSession = readRecord(healthDiagnostics.session) ?? {};
  const currentTab = readRecord(diagnostics.currentTab) ?? {};
  const currentTabContentScript = readRecord(currentTab.contentScript) ?? {};
  const pageControl = readRecord(statusRecord.pageControl)
    ?? readRecord(healthRecord.pageControl)
    ?? readRecord(healthRecord.readiness)
    ?? readRecord(diagnostics.pageControl)
    ?? readRecord(currentTab.pageControl)
    ?? readRecord(session.pageControl)
    ?? readRecord(healthSession.pageControl);
  const protocol = readRecord(healthRecord.protocol);
  const contentScript = readRecord(session.contentScript)
    ?? readRecord(healthSession.contentScript)
    ?? currentTabContentScript;
  const heartbeatState = heartbeat
    ? "recorded"
    : heartbeatReadError
      ? "error"
      : "not-read";

  return {
    schemaVersion: 1,
    state: result === "passed" ? "ready" : blockedReason ? "blocked" : "unknown",
    extension: {
      id: extensionId ?? extension.id ?? null,
      version: extension.version ?? null,
      manifestVersion: extension.manifestVersion ?? null,
      minimumChromeVersion: extension.minimumChromeVersion ?? null,
      capabilities: readRecord(diagnostics.capabilities) ?? null
    },
    nativeHost: {
      state: syncStatus.state === "synced" && nativeHost.bridgeState === "connected"
        ? "connected"
        : syncStatus.state ?? nativeHost.bridgeState ?? "unknown",
      bridgeState: nativeHost.bridgeState ?? syncStatus.nativeBridgeState ?? null,
      syncState: syncStatus.state ?? nativeHost.syncState ?? null,
      launchOrigin: launchOrigin ?? nativeHost.launchOrigin ?? syncStatus.nativeLaunchOrigin ?? null,
      messageType: nativeHost.messageType ?? syncStatus.nativeMessageType ?? null,
      policyState: nativeHost.policyState ?? syncStatus.nativeHostPolicyState ?? syncStatus.hostPolicyState ?? null,
      lastError: nativeHost.lastError ?? syncStatus.lastError ?? syncStatus.error ?? null
    },
    handshake: {
      nativeMessage: response?.result ?? null,
      statusSync: syncStatus.state ?? null,
      heartbeat: heartbeatState,
      ...(heartbeatReadError ? { heartbeatReadError } : {})
    },
    protocol: protocol
      ? {
          name: protocol.name ?? null,
          health: protocol.messageTypes?.health === "skfiy.page_control.health",
          contentScriptFile: protocol.contentScriptFile ?? null,
          hostPermissions: protocol.permissionModel?.hostPermissions ?? null
        }
      : null,
    contentScript: {
      state: session.state ?? healthSession.state ?? contentScript.state ?? "not-probed",
      reason: contentScript.reason ?? null,
      lastError: contentScript.lastError ?? null,
      observedAt: session.observedAt ?? healthSession.observedAt ?? contentScript.observedAt ?? null
    },
    pageControl: pageControl
      ? {
          state: pageControl.state ?? "unknown",
          capable: typeof pageControl.capable === "boolean" ? pageControl.capable : null,
          nextAction: pageControl.nextAction ?? null,
          blockerCount: Array.isArray(pageControl.blockers) ? pageControl.blockers.length : 0
        }
      : null,
    blockers: Array.isArray(blockers) ? blockers : [],
    remediation: remediation ?? null
  };
}

function hasNativeHostBridgeEvidence(run) {
  return run
    && typeof run === "object"
    && run.result === "passed"
    && run.productPath === NATIVE_HOST_BRIDGE_PRODUCT_PATH
    && Array.isArray(run.command)
    && typeof run.command[0] === "string"
    && path.basename(run.command[0]) === "skfiy"
    && run.response?.type === "skfiy.native.response"
    && run.response?.requestId === "chrome-smoke-native-host"
    && run.response?.result === "accepted"
    && run.hostPolicyResponse?.type === "skfiy.native.response"
    && run.hostPolicyResponse?.requestId === "chrome-smoke-host-policy"
    && run.hostPolicyResponse?.result === "accepted"
    && run.hostPolicyResponse?.hostPolicy?.schemaVersion === 1
    && (run.hostPolicyResponse.hostPolicy.state === "default"
      || run.hostPolicyResponse.hostPolicy.state === "configured"
      || run.hostPolicyResponse.hostPolicy.state === "invalid")
    && run.hostPolicyResponse.hostPolicy.policy?.defaultMode === "ask"
    && Array.isArray(run.hostPolicyResponse.hostPolicy.policy?.allowedHosts)
    && Array.isArray(run.hostPolicyResponse.hostPolicy.policy?.currentTurnAllowedHosts)
    && Array.isArray(run.hostPolicyResponse.hostPolicy.policy?.blockedHosts)
    && typeof run.heartbeatPath === "string"
    && run.heartbeatPath.includes("Application Support/skfiy/chrome-extension-connection.json")
    && run.heartbeat?.hostName === "com.sskift.skfiy"
    && run.heartbeat?.launchOrigin === "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
    && run.heartbeat?.messageType === "skfiy.page.observe"
    && run.heartbeat?.requestId === "chrome-smoke-native-host"
    && hasNativeHostBridgeDiagnostics(run.diagnostics);
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function hasInstalledExtensionStatusDiagnostics(status, extensionId) {
  return status
    && typeof status === "object"
    && status.type === "skfiy.host_policy.response"
    && status.requestId === "chrome-smoke-extension-status"
    && status.syncStatus?.state === "synced"
    && status.syncStatus?.source === "native_host"
    && status.syncStatus?.lastError === null
    && status.syncStatus?.nativeBridgeState === "connected"
    && status.syncStatus?.nativeLaunchOrigin === `chrome-extension://${extensionId}/`
    && status.syncStatus?.nativeMessageType === "skfiy.host_policy.request"
    && (
      status.syncStatus?.hostPolicyState === "default"
      || status.syncStatus?.hostPolicyState === "configured"
      || status.syncStatus?.hostPolicyState === "invalid"
    )
    && status.diagnostics?.extension?.id === extensionId
    && typeof status.diagnostics?.extension?.version === "string"
    && status.diagnostics.extension.version.length > 0
    && status.diagnostics?.capabilities?.nativeMessaging === true
    && status.diagnostics?.capabilities?.scripting === true
    && status.diagnostics?.nativeHost?.name === "com.sskift.skfiy"
    && status.diagnostics?.nativeHost?.bridgeState === "connected"
    && status.diagnostics?.nativeHost?.launchOrigin === `chrome-extension://${extensionId}/`
    && status.diagnostics?.nativeHost?.messageType === "skfiy.host_policy.request"
    && status.diagnostics?.nativeHost?.lastError === null
    && (
      status.diagnostics?.nativeHost?.policyState === "default"
      || status.diagnostics?.nativeHost?.policyState === "configured"
      || status.diagnostics?.nativeHost?.policyState === "invalid"
    )
    && status.diagnostics?.hostPolicy?.defaultMode === "ask"
    && Number.isInteger(status.diagnostics?.hostPolicy?.entryCount);
}

function hasInstalledExtensionPageControlHealth(health, extensionId) {
  const protocol = readRecord(health?.protocol);
  const pageControl = readRecord(health?.pageControl) ?? readRecord(health?.readiness);

  return health
    && typeof health === "object"
    && health.type === "skfiy.page_control.health_result"
    && health.schemaVersion === 1
    && health.requestId === "chrome-smoke-page-control-health"
    && protocol?.name === "skfiy.chrome.page-control"
    && protocol?.extensionId === extensionId
    && protocol?.nativeHostName === "com.sskift.skfiy"
    && protocol?.contentScriptFile === "content-script.js"
    && protocol?.messageTypes?.health === "skfiy.page_control.health"
    && protocol?.messageTypes?.diagnostics === "skfiy.page.diagnostics"
    && protocol?.messageTypes?.observe === "skfiy.page.observe"
    && protocol?.messageTypes?.action === "skfiy.page.action"
    && protocol?.messageTypes?.screenshot === "skfiy.page.screenshot"
    && protocol?.permissionModel?.hostPermissions === "optional"
    && Array.isArray(protocol?.permissionModel?.optionalHostPermissions)
    && protocol.permissionModel.optionalHostPermissions.includes("http://*/*")
    && protocol.permissionModel.optionalHostPermissions.includes("https://*/*")
    && pageControl
    && pageControl.schemaVersion === 1
    && typeof pageControl.state === "string"
    && typeof pageControl.capable === "boolean"
    && health.diagnostics?.extension?.id === extensionId
    && health.diagnostics?.nativeHost?.name === "com.sskift.skfiy";
}

function hasNativeHostBridgeDiagnostics(diagnostics) {
  return diagnostics
    && typeof diagnostics === "object"
    && diagnostics.nativeHost?.name === "com.sskift.skfiy"
    && diagnostics.nativeHost?.heartbeatState === "recorded"
    && typeof diagnostics.nativeHost?.launchOrigin === "string"
    && diagnostics.nativeHost.launchOrigin.startsWith("chrome-extension://")
    && diagnostics.nativeHost?.messageType === "skfiy.page.observe"
    && diagnostics.nativeHost?.lastError === null
    && (
      diagnostics.nativeHost?.policyState === "default"
      || diagnostics.nativeHost?.policyState === "configured"
      || diagnostics.nativeHost?.policyState === "invalid"
    )
    && diagnostics.capabilities?.nativeMessaging === true
    && diagnostics.capabilities?.hostPolicySync === true
    && diagnostics.capabilities?.connectionHeartbeat === true
    && diagnostics.hostPolicy?.defaultMode === "ask"
    && Number.isInteger(diagnostics.hostPolicy?.entryCount);
}

function hasChromeReadinessDiagnostics(diagnostics) {
  const allowedStates = new Set(["ready", "needs_setup", "blocked"]);
  const allowedNativeHostStates = new Set([
    "installed",
    "missing",
    "mismatched",
    "cli-missing",
    "invalid"
  ]);
  const allowedHostPolicyStates = new Set(["default", "configured", "invalid"]);
  const allowedLiveConnectionStates = new Set(["connected", "stale", "unknown", "invalid"]);

  return diagnostics
    && typeof diagnostics === "object"
    && diagnostics.schemaVersion === 1
    && allowedStates.has(diagnostics.state)
    && typeof diagnostics.generatedAt === "string"
    && diagnostics.nativeHost?.hostName === "com.sskift.skfiy"
    && allowedNativeHostStates.has(diagnostics.nativeHost?.state)
    && typeof diagnostics.nativeHost?.manifestPath === "string"
    && diagnostics.nativeHost.manifestPath.includes("NativeMessagingHosts/com.sskift.skfiy.json")
    && typeof diagnostics.nativeHost?.cliShimPath === "string"
    && Array.isArray(diagnostics.nativeHost?.allowedOrigins)
    && diagnostics.nativeHost.allowedOrigins.every((origin) =>
      typeof origin === "string" && origin.startsWith("chrome-extension://")
    )
    && typeof diagnostics.nativeHost?.reason === "string"
    && diagnostics.extensionManifest?.state === "planned"
    && diagnostics.extensionManifest?.manifestVersion === 3
    && diagnostics.extensionManifest?.hostName === "com.sskift.skfiy"
    && diagnostics.extensionManifest?.nativeMessaging === true
    && Array.isArray(diagnostics.extensionManifest?.optionalHostPermissions)
    && diagnostics.extensionManifest.optionalHostPermissions.includes("http://*/*")
    && diagnostics.extensionManifest.optionalHostPermissions.includes("https://*/*")
    && diagnostics.hostPolicy?.schemaVersion === 1
    && allowedHostPolicyStates.has(diagnostics.hostPolicy?.state)
    && typeof diagnostics.hostPolicy?.path === "string"
    && diagnostics.hostPolicy.path.includes("Application Support/skfiy/chrome-host-policy.json")
    && diagnostics.hostPolicy?.defaultMode === "ask"
    && Number.isInteger(diagnostics.hostPolicy?.entryCount)
    && (
      diagnostics.approvalPolicy?.state === "ready"
      || diagnostics.approvalPolicy?.state === "no_probe"
    )
    && diagnostics.approvalPolicy?.defaultAction === "allow_current_turn_after_user_approval"
    && diagnostics.approvalPolicy?.failClosed === true
    && allowedLiveConnectionStates.has(diagnostics.liveConnection?.state)
    && ["connected", "stale", "unknown"].includes(diagnostics.liveConnection?.liveConnection)
    && typeof diagnostics.liveConnection?.path === "string"
    && diagnostics.liveConnection.path.includes("Application Support/skfiy/chrome-extension-connection.json")
    && hasChromeReadinessSetupGuide(diagnostics.setupGuide);
}

function hasChromeReadinessSetupGuide(guide) {
  const allowedStates = new Set(["ready", "needs_setup", "blocked"]);

  return guide
    && typeof guide === "object"
    && guide.schemaVersion === 1
    && guide.productPath === "dist/skfiy -> Chrome MV3 extension -> Native Messaging"
    && allowedStates.has(guide.state)
    && Array.isArray(guide.extensionIds)
    && guide.extensionIds.every((extensionId) =>
      typeof extensionId === "string" && extensionId.length === 32
    )
    && Array.isArray(guide.expectedAllowedOrigins)
    && guide.expectedAllowedOrigins.every((origin) =>
      typeof origin === "string" && origin.startsWith("chrome-extension://")
    )
    && typeof guide.nativeHostManifestPath === "string"
    && guide.nativeHostManifestPath.includes("NativeMessagingHosts/com.sskift.skfiy.json")
    && typeof guide.cliShimPath === "string"
    && typeof guide.connectionHeartbeatPath === "string"
    && guide.connectionHeartbeatPath.includes("Application Support/skfiy/chrome-extension-connection.json")
    && typeof guide.hostPolicyPath === "string"
    && guide.hostPolicyPath.includes("Application Support/skfiy/chrome-host-policy.json")
    && Array.isArray(guide.recommendedBrowsers)
    && guide.recommendedBrowsers.includes("Google Chrome for Testing")
    && guide.recommendedBrowsers.includes("Chromium")
    && isCommand(guide.installHostCommand, "install-host")
    && isCommand(guide.verifyStatusCommand, "status")
    && isCommand(guide.smokeCommand, "chrome")
    && Array.isArray(guide.nextActions)
    && guide.nextActions.some((action) =>
      action
      && typeof action === "object"
      && (action.id === "install-native-host" || action.id === "verify-live-connection")
      && typeof action.state === "string"
      && typeof action.title === "string"
    );
}

function isCommand(command, expectedTail) {
  return Array.isArray(command)
    && command[0] === "skfiy"
    && command.includes(expectedTail);
}

export function classifyChromeFallbackSmokeEvidence({
  events = [],
  runnerHasTmux = false,
  appLaunchViaOpen = false,
  productPath
}) {
  const last = events.at(-1);

  if (!last) {
    return "no-events";
  }

  if (last.status === "approval_required") {
    return "needs-user-confirmation";
  }

  if (
    runnerHasTmux
    || appLaunchViaOpen !== true
    || productPath !== FALLBACK_PRODUCT_PATH
  ) {
    return "failed";
  }

  if (
    last.status === "needs_confirmation"
    && typeof last.message === "string"
    && last.message.includes("screenshot fallback observation captured")
    && hasChromeFallbackScreenshotEvidence(events)
  ) {
    return "fallback-observed";
  }

  if (
    (last.status === "needs_confirmation" || last.status === "failed")
    && typeof last.message === "string"
    && (
      last.message.includes("screenshot fallback failed")
      || last.message.includes("screenshot fallback activation failed")
      || last.message.includes("screenshot fallback did not return app state")
      || last.message.includes("screenshot fallback is unavailable")
      || last.message.includes("Screen Recording permission is required")
      || last.message.includes("Accessibility permission is required")
    )
  ) {
    return "fallback-blocked";
  }

  return last.status ?? "failed";
}

export function classifyChromeCurrentPageSmokeEvidence({
  events = [],
  pageSnapshot,
  expectedText = EXPECTED_TEXT,
  runnerHasTmux = false,
  appLaunchViaOpen = false,
  chromeLaunchViaOpen = false,
  productPath
}) {
  const last = events.at(-1);

  if (!last) {
    return "no-events";
  }

  if (last.status === "approval_required") {
    return "needs-user-confirmation";
  }

  if (last.status === "failed" && isChromeBlockedMessage(last.message)) {
    return "blocked";
  }

  if (last.status !== "completed") {
    return last.status ?? "failed";
  }

  if (
    runnerHasTmux
    || appLaunchViaOpen !== true
    || chromeLaunchViaOpen !== true
    || productPath !== PRODUCT_PATH
    || !hasChromeCurrentPageSnapshotEvidence(events, pageSnapshot, expectedText)
    || hasTaskEventMessage(events, "Verified navigate:")
  ) {
    return "failed";
  }

  return "passed";
}

export function classifyChromeBringYourOwnCurrentPageEvidence({
  events = [],
  pageSnapshot,
  runnerHasTmux = false,
  appLaunchViaOpen = false,
  chromeLaunchViaOpen = false,
  productPath,
  chromeEndpoint
}) {
  const last = events.at(-1);

  if (!last) {
    return "no-events";
  }

  if (last.status === "approval_required") {
    return "needs-user-confirmation";
  }

  if (last.status === "needs_confirmation" && isChromeSensitivePauseMessage(last.message)) {
    return SENSITIVE_EXPECTED_RESULT;
  }

  if (
    (last.status === "failed" || last.status === "needs_confirmation")
    && isChromeBlockedMessage(last.message)
  ) {
    return "blocked";
  }

  if (last.status !== "completed") {
    return last.status ?? "failed";
  }

  if (
    runnerHasTmux
    || appLaunchViaOpen !== true
    || chromeLaunchViaOpen !== false
    || productPath !== PRODUCT_PATH
    || typeof chromeEndpoint !== "string"
    || chromeEndpoint.length === 0
    || !hasBringYourOwnChromeCurrentPageSnapshotEvidence(events, pageSnapshot)
    || hasTaskEventMessage(events, "Verified navigate:")
  ) {
    return "failed";
  }

  return "passed";
}

export function classifyChromeFallbackSwitchEvidence({
  events = [],
  runnerHasTmux = false,
  appLaunchViaOpen = false,
  productPath,
  configuredEndpoint
}) {
  const last = events.at(-1);

  if (!last) {
    return "no-events";
  }

  if (
    runnerHasTmux
    || appLaunchViaOpen !== true
    || productPath !== FALLBACK_SWITCH_PRODUCT_PATH
    || typeof configuredEndpoint !== "string"
    || configuredEndpoint.length === 0
    || !hasChromeFallbackSwitchEvent(events)
  ) {
    return "failed";
  }

  if (
    last.status === "needs_confirmation"
    && typeof last.message === "string"
    && last.message.includes("screenshot fallback observation captured")
    && hasChromeFallbackScreenshotEvidence(events)
  ) {
    return "fallback-switched-observed";
  }

  if (
    (last.status === "needs_confirmation" || last.status === "failed")
    && typeof last.message === "string"
    && (
      last.message.includes("screenshot fallback failed")
      || last.message.includes("screenshot fallback activation failed")
      || last.message.includes("screenshot fallback did not return app state")
      || last.message.includes("screenshot fallback is unavailable")
      || last.message.includes("Screen Recording permission is required")
      || last.message.includes("Accessibility permission is required")
    )
  ) {
    return "fallback-switched-blocked";
  }

  return last.status ?? "failed";
}

function hasChromeFallbackScreenshotEvidence(events) {
  return Array.isArray(events)
    && events.some((event) =>
      event?.status === "observing"
        && event?.replayRecord?.stage === "before"
        && event.replayRecord.bundleId === "com.google.Chrome"
        && typeof event.replayRecord.screenshotPath === "string"
        && event.replayRecord.screenshotPath.length > 0
    );
}

function hasChromeFallbackSwitchEvent(events) {
  return Array.isArray(events)
    && events.some((event) =>
      event?.status === "executing"
        && typeof event.message === "string"
        && /Switching Chrome control from cdp to screenshot_fallback/i.test(event.message)
    );
}

function hasChromeCurrentPageSnapshotEvidence(events, pageSnapshot, expectedText) {
  return pageSnapshot
    && typeof pageSnapshot === "object"
    && typeof pageSnapshot.url === "string"
    && pageSnapshot.url.length > 0
    && typeof pageSnapshot.title === "string"
    && pageSnapshot.title.length > 0
    && typeof pageSnapshot.text === "string"
    && pageSnapshot.text.includes(expectedText)
    && hasTaskEventMessage(events, "Verified current_page_snapshot:")
    && hasTaskEventMessage(events, "Chrome current page extracted:");
}

function hasBringYourOwnChromeCurrentPageSnapshotEvidence(events, pageSnapshot) {
  return pageSnapshot
    && typeof pageSnapshot === "object"
    && typeof pageSnapshot.url === "string"
    && pageSnapshot.url.length > 0
    && typeof pageSnapshot.title === "string"
    && pageSnapshot.title.length > 0
    && typeof pageSnapshot.text === "string"
    && pageSnapshot.text.trim().length > 0
    && hasTaskEventMessage(events, "Verified current_page_snapshot:")
    && hasTaskEventMessage(events, "Chrome current page extracted:");
}

function hasTaskEventMessage(events, prefix) {
  return Array.isArray(events)
    && events.some((event) =>
      typeof event?.message === "string"
        && event.message.startsWith(prefix)
    );
}

function isChromeSensitivePauseMessage(message) {
  return typeof message === "string"
    && (
      message.includes("Verification failed (sensitive): Sensitive UI text is visible.")
      || message.includes("Verification failed (sensitive): Sensitive form input is not allowed for Chrome Computer Use.")
    );
}

function isChromeBlockedMessage(message) {
  if (typeof message !== "string") {
    return false;
  }

  const normalized = message.toLowerCase();

  return normalized.includes("chrome")
    && (
      normalized.includes("not configured")
      || normalized.includes("endpoint")
      || normalized.includes("unavailable")
      || (
        normalized.includes("screenshot fallback")
        && (
          normalized.includes("screen recording permission")
          || normalized.includes("accessibility permission")
        )
      )
    );
}

function readPositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function readChromeExtensionId(value, name) {
  const normalized = String(value ?? "").trim();

  if (!/^[a-z]{32}$/i.test(normalized)) {
    throw new Error(`${name} must be a 32-character Chrome extension id.`);
  }

  return normalized.toLowerCase();
}

function normalizeEndpoint(value, name) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("invalid protocol");
    }

    return parsed.href.replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an http(s) URL.`);
  }
}

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

function parseUrl(value) {
  try {
    return new URL(String(value ?? ""));
  } catch {
    return undefined;
  }
}

function isCompatibleFixtureSearch(url, fixture) {
  if (url.search === fixture.search) {
    return true;
  }

  const urlKeys = Array.from(url.searchParams.keys());
  const fixtureKeys = Array.from(fixture.searchParams.keys());

  if (
    urlKeys.length !== fixtureKeys.length
    || urlKeys.some((key, index) => key !== fixtureKeys[index])
  ) {
    return false;
  }

  return fixtureKeys.every((key) => {
    const urlValues = url.searchParams.getAll(key);
    const fixtureValues = fixture.searchParams.getAll(key);

    return urlValues.length === fixtureValues.length
      && urlValues.every((value, index) => (
        value === fixtureValues[index] || value === "<redacted>"
      ));
  });
}

function isVerifiedChromeCliRun(run) {
  return readRecord(run)?.result === "verified";
}

function isAcceptableInstalledExtensionReloadRun(run) {
  const record = readRecord(run);

  return record?.result === "verified"
    || (
      record?.result === "blocked"
      && (
        record.reason === "desktop-session-locked"
        || record.reason === "reload-target-not-found"
      )
    );
}

function hasVerifiedChromeScreenshotRun(run) {
  const record = readRecord(run);
  const extensionConnection = readRecord(record?.extensionConnection);
  const latestCommand = readRecord(extensionConnection?.latestCommand);
  const pageScreenshot = readRecord(latestCommand?.pageScreenshot)
    ?? readRecord(extensionConnection?.pageScreenshot)
    ?? readRecord(record?.pageScreenshot);

  return record?.result === "verified"
    && pageScreenshot?.hasDataUrl === true;
}

function isKnownScreenshotBlockedRun(run) {
  const record = readRecord(run);
  const extensionConnection = readRecord(record?.extensionConnection);
  const latestCommand = readRecord(extensionConnection?.latestCommand);
  const pageScreenshot = readRecord(latestCommand?.pageScreenshot)
    ?? readRecord(extensionConnection?.pageScreenshot)
    ?? readRecord(record?.pageScreenshot);
  const pageControl = readRecord(extensionConnection?.pageControl);
  const screenshot = readRecord(pageControl?.screenshot);
  const reason = String(record?.reason ?? pageScreenshot?.reason ?? "");

  return record?.result === "blocked"
    && (
      reason === "chrome-capture-permission-missing"
      || reason === "chrome-capture-blocked"
      || reason.includes("<all_urls>")
      || reason.includes("activeTab")
      || (
        reason === "page-control-screenshot-not-verified"
        && pageControl?.state === "ready"
        && screenshot?.state === "available"
      )
    );
}

function isKnownInstalledExtensionActionBlocker(reason) {
  return [
    "extension-registration-stale",
    "extension-card-reload-required",
    "desktop-session-locked",
    "chrome_host_permission_missing",
    "chrome-host-permission-missing",
    "skfiy_host_policy_missing",
    "skfiy-host-policy-missing",
    "blocked_by_host_policy",
    "blocked_by_chrome_host_permission",
    "chrome-active-tab-unavailable",
    "target-tab-unavailable-after-reload",
    "sensitive-paused"
  ].includes(String(reason ?? ""));
}

function hasBlockedInstalledExtensionActionCleanup(record) {
  const cleanupRuns = [
    readRecord(record?.cleanupBeforeRun),
    ...(Array.isArray(record?.cleanupBetweenCommands)
      ? record.cleanupBetweenCommands.map(readRecord)
      : []),
    readRecord(record?.cleanupAfterRun)
  ].filter(Boolean);

  return cleanupRuns.some((cleanup) =>
    cleanup.result === "blocked" || cleanup.result === "error"
  );
}
