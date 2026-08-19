import { readRecord } from "./record-utils.js";

export type BrowserPageContextState =
  | "ready"
  | "partial"
  | "blocked"
  | "blocked_by_chrome_host_permission"
  | "blocked_by_host_policy"
  | "active_tab_unavailable"
  | "content_script_not_loaded"
  | "not_loaded"
  | "sensitive-paused"
  | "not-probed"
  | "missing"
  | "stale"
  | "unavailable";

export interface BrowserPageContext {
  state: BrowserPageContextState;
  url?: string;
  title?: string;
  visibleText?: string;
  observedAt?: string;
  reason?: string;
  nextAction?: string;
}

const MAX_VISIBLE_TEXT_CHARS = 2_000;

export function createBrowserPageContextFromConnection(connection: unknown): BrowserPageContext {
  const record = readRecord(connection);

  if (!record) {
    return normalizeBrowserPageContext(undefined);
  }

  const connectionState = readOptionalString(record.state);
  const connectionObservedAt = readOptionalString(record.observedAt);
  const pageObservation = readRecord(record.pageObservation)
    ?? readRecord(readRecord(record.latestCommand)?.pageObservation);
  const pageControl = readRecord(record.pageControl)
    ?? readRecord(pageObservation?.pageControl);

  if (connectionState === "stale") {
    return normalizeBrowserPageContext({
      state: "stale",
      observedAt: connectionObservedAt,
      reason: readOptionalString(record.reason)
        ?? "Chrome page context heartbeat is stale.",
      nextAction: "Refresh the skfiy Chrome extension before using Browser Context."
    });
  }

  if (connectionState === "invalid") {
    return normalizeBrowserPageContext({
      state: "unavailable",
      observedAt: connectionObservedAt,
      reason: readOptionalString(record.reason)
        ?? "Chrome page context heartbeat is invalid.",
      nextAction: "Refresh the skfiy Chrome extension before using Browser Context."
    });
  }

  if (pageObservation) {
    return normalizeBrowserPageContext({
      state: normalizeConnectionStateForContext(readOptionalString(pageControl?.state) ?? connectionState),
      url: readOptionalString(pageObservation.url),
      title: readOptionalString(pageObservation.title),
      visibleText: readOptionalString(pageObservation.visibleText),
      observedAt: readOptionalString(pageObservation.observedAt) ?? connectionObservedAt,
      reason: readOptionalString(pageControl?.reason) ?? readOptionalString(record.reason),
      nextAction: createBrowserPageControlOperatorNextAction(pageControl)
    });
  }

  if (pageControl) {
    return normalizeBrowserPageContext({
      state: normalizeConnectionStateForContext(readOptionalString(pageControl.state) ?? connectionState),
      observedAt: connectionObservedAt,
      reason: readOptionalString(pageControl.reason) ?? readOptionalString(record.reason),
      nextAction: createBrowserPageControlOperatorNextAction(pageControl)
    });
  }

  return normalizeBrowserPageContext({
    state: connectionState === "connected" ? "missing" : normalizeConnectionStateForContext(connectionState),
    observedAt: connectionObservedAt,
    reason: connectionState === "unavailable"
      ? readOptionalString(record.reason) ?? "Chrome page context is unavailable."
      : "Chrome page context has not been observed yet.",
    nextAction: "Open an http or https page in Chrome and refresh the skfiy extension."
  });
}

export function normalizeBrowserPageContext(raw: unknown): BrowserPageContext {
  const record = readRecord(raw);

  if (!record) {
    return {
      state: "missing",
      reason: "Chrome page context has not been observed yet.",
      nextAction: "Open an http or https page in Chrome and refresh the skfiy extension."
    };
  }

  const state = readBrowserPageContextState(record.state);
  const visibleText = readOptionalString(record.visibleText);

  return {
    state,
    ...(readOptionalString(record.url) ? { url: readOptionalString(record.url) } : {}),
    ...(readOptionalString(record.title) ? { title: readOptionalString(record.title) } : {}),
    ...(visibleText ? { visibleText: visibleText.slice(0, MAX_VISIBLE_TEXT_CHARS) } : {}),
    ...(readOptionalString(record.observedAt) ? { observedAt: readOptionalString(record.observedAt) } : {}),
    ...(readOptionalString(record.reason) ? { reason: readOptionalString(record.reason) } : {}),
    ...(readOptionalString(record.nextAction) ? { nextAction: readOptionalString(record.nextAction) } : {})
  };
}

export function createBrowserPageContextPromptBlock(context: BrowserPageContext): string {
  const lines = context.state === "ready" || context.state === "partial"
    ? [
        "Browser Context:",
        "Current Chrome page",
        `State: ${context.state}`,
        `URL: ${context.url ?? "unknown"}`,
        `Title: ${context.title ?? "unknown"}`,
        `Observed at: ${context.observedAt ?? "unknown"}`,
        "Visible text:",
        context.visibleText ?? ""
      ]
    : [
        "Browser Context:",
        "Browser context unavailable",
        `State: ${context.state}`,
        `Reason: ${context.reason ?? "Chrome page context is not ready."}`,
        ...(context.nextAction ? [`Next action: ${context.nextAction}`] : [])
      ];

  return lines.join("\n").trim();
}

function readBrowserPageContextState(value: unknown): BrowserPageContextState {
  if (
    value === "ready"
    || value === "partial"
    || value === "blocked"
    || value === "blocked_by_chrome_host_permission"
    || value === "blocked_by_host_policy"
    || value === "active_tab_unavailable"
    || value === "content_script_not_loaded"
    || value === "not_loaded"
    || value === "sensitive-paused"
    || value === "not-probed"
    || value === "missing"
    || value === "stale"
    || value === "unavailable"
  ) {
    return value;
  }

  return "missing";
}

function normalizeConnectionStateForContext(value: string | undefined): BrowserPageContextState {
  if (value === "connected") {
    return "ready";
  }
  if (value === "invalid") {
    return "unavailable";
  }

  return readBrowserPageContextState(value);
}

function createBrowserPageControlOperatorNextAction(
  pageControl: Record<string, unknown> | undefined
): string | undefined {
  const reportedNextAction = readOptionalString(pageControl?.nextAction);

  if (!reportedNextAction) {
    return undefined;
  }
  if (!isBrowserPageControlMachineNextAction(reportedNextAction)) {
    return reportedNextAction;
  }

  const state = readOptionalString(pageControl?.state);
  const activeTab = readRecord(pageControl?.activeTab);
  const chromeHostPermission = readRecord(pageControl?.chromeHostPermission);
  const chromeCapturePermission = readRecord(pageControl?.chromeCapturePermission);
  const blockerCodes = Array.isArray(pageControl?.blockers)
    ? pageControl.blockers
      .map((blocker) => readOptionalString(readRecord(blocker)?.code))
      .filter(Boolean)
    : [];
  const host = readOptionalString(activeTab?.host)
    ?? readOptionalString(chromeHostPermission?.host)
    ?? readHostFromPermissionOrigin(readOptionalString(chromeHostPermission?.origin));
  const chromeHostOrigins = readStringArray(chromeHostPermission?.origins);
  const chromeCaptureOrigins = readStringArray(chromeCapturePermission?.origins);
  const chromePopupGrantOrigins = [
    ...(reportedNextAction === "grant_chrome_host_permission"
      || readOptionalString(chromeHostPermission?.state) === "missing"
      || blockerCodes.includes("chrome_host_permission_missing")
      ? [chromeHostOrigins[0] ?? readOptionalString(chromeHostPermission?.origin) ?? "the active page"]
      : []),
    ...(reportedNextAction === "grant_chrome_capture_permission"
      || readOptionalString(chromeCapturePermission?.state) === "missing"
      || blockerCodes.includes("chrome_capture_permission_missing")
      ? [chromeCaptureOrigins[0] ?? "<all_urls>"]
      : [])
  ].filter((origin, index, origins) => origins.indexOf(origin) === index);
  const actions: string[] = [];

  if (state === "ready") {
    return "Chrome pageControl is ready for the current page.";
  }

  if (
    reportedNextAction === "allow_host"
    || state === "blocked_by_host_policy"
    || blockerCodes.includes("blocked_by_host_policy")
  ) {
    actions.push(host
      ? `Run \`${formatCommandLine(["skfiy", "chrome", "policy", "set", "--host", host, "--action", "allow-current-turn"])}\` or approve the host in Dashboard Chrome policy.`
      : "Allow the current host in Dashboard Chrome policy.");
  }

  if (chromePopupGrantOrigins.length > 0) {
    actions.push(
      `Open Dashboard > Browser and click Open access page, then click Grant ${chromePopupGrantOrigins.join(" + ")} and observe.`
    );
    actions.push(
      `Open the skfiy extension popup and click Grant ${chromePopupGrantOrigins.join(" + ")} and observe.`
    );
  }

  if (actions.length === 0) {
    actions.push("Refresh the skfiy Chrome extension and rerun diagnostics.");
  }

  return actions.join(" ");
}

function isBrowserPageControlMachineNextAction(value: string): boolean {
  return value === "allow_host"
    || value === "grant_chrome_host_permission"
    || value === "grant_chrome_capture_permission"
    || value === "send_page_action";
}

function readHostFromPermissionOrigin(origin: string | undefined): string | undefined {
  if (!origin) {
    return undefined;
  }

  try {
    return new URL(origin).host || undefined;
  } catch {
    return undefined;
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function formatCommandLine(commandLine: string[]): string {
  return commandLine.map(formatCommandArg).join(" ");
}

function formatCommandArg(arg: string): string {
  return /^[A-Za-z0-9_./:@%#{}=-]+$/.test(arg)
    ? arg
    : JSON.stringify(arg);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
