import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DIAGNOSTIC_REPORT_SCHEMA_VERSION,
  createDiagnosticRedactionCounts,
  createUnknownDiagnosticReport,
  createUnknownDiagnosticReportSection,
  readDiagnosticRedactionSummary,
  renderDiagnosticReportExport,
  sanitizeDiagnosticText,
  type DiagnosticComponentVersion,
  type DiagnosticRedactionCounts,
  type DiagnosticReport,
  type DiagnosticReportBlocker,
  type DiagnosticReportBlockerSeverity,
  type DiagnosticReportBlockerType,
  type DiagnosticReportSection,
  type DiagnosticReportState
} from "../shared/diagnostic-report.js";
import type { AssistantAgentProviderState } from "./assistant-agent.js";
import type { ChromeCompatibilityHealth } from "./chrome-compatibility-health.js";
import type { DesktopSessionDiagnostics } from "./desktop-session-diagnostics.js";
import type { BrowserReadinessEvidence } from "./main-browser-readiness.js";
import type { FinderAutomationReadiness } from "./main-finder-automation-readiness.js";
import type { PermissionDiagnostics } from "./permissions.js";
import type { StartupWarning } from "./startup-guard.js";
import type { ChromeHostPolicyState } from "./chrome-host-policy.js";

// ---------------------------------------------------------------------------
// Input and sources interfaces
// ---------------------------------------------------------------------------

export interface DiagnosticReportInput {
  permissions?: PermissionDiagnostics;
  desktopSession?: DesktopSessionDiagnostics;
  browserReadiness?: BrowserReadinessEvidence;
  chromeHostPolicy?: Pick<ChromeHostPolicyState, "state" | "reason">;
  chromeCompatibility?: ChromeCompatibilityHealth;
  finderAutomation?: FinderAutomationReadiness;
  providerStates?: AssistantAgentProviderState[];
  startupWarnings?: StartupWarning[];
  componentVersions?: DiagnosticComponentVersion[];
  generatedAt?: string;
}

export interface DiagnosticReportSources {
  readPermissions?: () => Promise<PermissionDiagnostics>;
  readDesktopSession?: () => Promise<DesktopSessionDiagnostics>;
  readBrowserReadiness?: () => Promise<BrowserReadinessEvidence>;
  readChromeHostPolicy?: () => Promise<Pick<ChromeHostPolicyState, "state" | "reason">>;
  readChromeCompatibility?: () => Promise<ChromeCompatibilityHealth>;
  readFinderAutomation?: () => Promise<FinderAutomationReadiness>;
  readProviderStates?: () => Promise<AssistantAgentProviderState[]>;
  readStartupWarnings?: () => Promise<StartupWarning[]>;
  readComponentVersions?: () => Promise<DiagnosticComponentVersion[]>;
}

// ---------------------------------------------------------------------------
// Pure factory
// ---------------------------------------------------------------------------

export function createDiagnosticReport(input: DiagnosticReportInput = {}): DiagnosticReport {
  const counts = createDiagnosticRedactionCounts();
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const sections: DiagnosticReportSection[] = [
    createDesktopSessionSection(input.desktopSession, counts),
    createPermissionsSection(input.permissions, counts),
    createProviderSection(input.providerStates, counts),
    createChromeSection(input.browserReadiness, input.chromeHostPolicy, input.chromeCompatibility, counts),
    createBrowserContextSection(input.browserReadiness, counts),
    createFinderAutomationSection(input.finderAutomation, counts),
    createStartupSection(input.startupWarnings, counts)
  ];

  const blockers = sortBlockers(deduplicateBlockers(sections.flatMap((s) => s.blockers)));
  const overallState = deriveOverallState(sections);
  const componentVersions = input.componentVersions ?? [];
  const redactionSummary = readDiagnosticRedactionSummary(counts);

  const report: Omit<DiagnosticReport, "exportPreview"> = {
    schemaVersion: DIAGNOSTIC_REPORT_SCHEMA_VERSION,
    generatedAt,
    overallState,
    sections,
    blockers,
    componentVersions,
    redactionSummary
  };

  return {
    ...report,
    exportPreview: renderDiagnosticReportExport(report)
  };
}

// ---------------------------------------------------------------------------
// IO wrapper
// ---------------------------------------------------------------------------

export async function readDiagnosticReportForRenderer({
  sources,
  onError
}: {
  sources: DiagnosticReportSources;
  onError?: (message: string) => void;
}): Promise<DiagnosticReport> {
  try {
    const [
      permissions,
      desktopSession,
      browserReadiness,
      chromeHostPolicy,
      chromeCompatibility,
      finderAutomation,
      providerStates,
      startupWarnings,
      componentVersions
    ] = await Promise.all([
      readSourceSafely(sources.readPermissions, "permissions", onError),
      readSourceSafely(sources.readDesktopSession, "desktop session", onError),
      readSourceSafely(sources.readBrowserReadiness, "browser readiness", onError),
      readSourceSafely(sources.readChromeHostPolicy, "chrome host policy", onError),
      readSourceSafely(sources.readChromeCompatibility, "chrome compatibility", onError),
      readSourceSafely(sources.readFinderAutomation, "finder automation", onError),
      readSourceSafely(sources.readProviderStates, "provider states", onError),
      readSourceSafely(sources.readStartupWarnings, "startup warnings", onError),
      readSourceSafely(sources.readComponentVersions, "component versions", onError)
    ]);

    return createDiagnosticReport({
      permissions,
      desktopSession,
      browserReadiness,
      chromeHostPolicy,
      chromeCompatibility,
      finderAutomation,
      providerStates,
      startupWarnings,
      componentVersions
    });
  } catch (error) {
    onError?.(
      error instanceof Error ? error.message : "Diagnostic report could not be assembled."
    );
    return createUnknownDiagnosticReport();
  }
}

async function readSourceSafely<T>(
  reader: (() => Promise<T>) | undefined,
  label: string,
  onError?: (message: string) => void
): Promise<T | undefined> {
  if (!reader) {
    return undefined;
  }

  try {
    return await reader();
  } catch (error) {
    onError?.(`${label}: ${error instanceof Error ? error.message : "unknown error"}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function createDesktopSessionSection(
  diagnostics: DesktopSessionDiagnostics | undefined,
  counts: DiagnosticRedactionCounts
): DiagnosticReportSection {
  if (!diagnostics) {
    return createUnknownDiagnosticReportSection("desktop-session", "Desktop session status is unknown.");
  }

  if (diagnostics.state === "controllable") {
    return {
      id: "desktop-session",
      state: "ready",
      summary: "Desktop session is controllable.",
      blockers: []
    };
  }

  if (diagnostics.state === "unknown") {
    const summary = sanitizeDiagnosticText(diagnostics.reason, counts)
      ?? "Desktop session status is unknown.";
    return {
      id: "desktop-session",
      state: "unknown",
      summary,
      blockers: [
        createBlocker({
          type: "desktop-session-unknown",
          severity: "unknown",
          title: "Desktop session status is unknown",
          detail: diagnostics.reason,
          nextAction: "Refresh desktop session status.",
          counts
        })
      ]
    };
  }

  // blocked
  const status = diagnostics.status;
  const blockers: DiagnosticReportBlocker[] = [];

  if (status?.frontmostBundleId === "com.apple.loginwindow") {
    const pid = typeof status.frontmostProcessIdentifier === "number"
      ? ` (pid ${status.frontmostProcessIdentifier})`
      : "";
    blockers.push(
      createBlocker({
        type: "desktop-session-locked",
        severity: "blocked",
        title: "Desktop session is locked",
        detail: `Desktop session is locked by loginwindow${pid}.`,
        nextAction: "Unlock the Mac and keep the display awake, then retry.",
        counts
      })
    );
  } else if (status?.mainDisplayAsleep === true) {
    blockers.push(
      createBlocker({
        type: "desktop-session-asleep",
        severity: "blocked",
        title: "Main display is asleep",
        detail: "Main display is asleep.",
        nextAction: "Wake the display and unlock the Mac, then retry.",
        counts
      })
    );
  } else {
    blockers.push(
      createBlocker({
        type: "desktop-session-not-controllable",
        severity: "blocked",
        title: "Desktop session is not controllable",
        detail: sanitizeDiagnosticText(diagnostics.reason, counts)
          ?? "Desktop session is not controllable.",
        nextAction: "Keep the display awake and unlocked, then retry.",
        counts
      })
    );
  }

  return {
    id: "desktop-session",
    state: "blocked",
    summary: sanitizeDiagnosticText(diagnostics.reason, counts)
      ?? "Desktop session is blocked.",
    blockers
  };
}

function createPermissionsSection(
  diagnostics: PermissionDiagnostics | undefined,
  counts: DiagnosticRedactionCounts
): DiagnosticReportSection {
  if (!diagnostics) {
    return createUnknownDiagnosticReportSection("permissions", "Permission status is unknown.");
  }

  const blockers: DiagnosticReportBlocker[] = [];

  // Screen Recording
  const screenRecording = diagnostics.active.screenRecording.state;
  if (screenRecording === "denied") {
    blockers.push(
      createBlocker({
        type: "screen-recording-denied",
        severity: "blocked",
        title: "Screen Recording permission is denied",
        detail: "Screen Recording permission is denied.",
        nextAction: "Open Screen Recording settings and grant skfiy access.",
        counts
      })
    );
  } else if (screenRecording === "not-determined") {
    blockers.push(
      createBlocker({
        type: "screen-recording-not-determined",
        severity: "action-required",
        title: "Screen Recording permission has not been requested",
        detail: "Screen Recording permission has not been requested.",
        nextAction: "Open Screen Recording settings and grant skfiy access.",
        counts
      })
    );
  } else if (screenRecording === "unknown") {
    blockers.push(
      createBlocker({
        type: "screen-recording-unknown",
        severity: "unknown",
        title: "Screen Recording permission status is unknown",
        detail: "Screen Recording permission status is unknown.",
        nextAction: "Refresh macOS permission status.",
        counts
      })
    );
  }

  // Accessibility
  const accessibility = diagnostics.active.accessibility.state;
  if (accessibility === "denied") {
    blockers.push(
      createBlocker({
        type: "accessibility-denied",
        severity: "blocked",
        title: "Accessibility permission is denied",
        detail: "Accessibility permission is denied.",
        nextAction: "Open Accessibility settings and grant skfiy access.",
        counts
      })
    );
  } else if (accessibility === "not-determined") {
    blockers.push(
      createBlocker({
        type: "accessibility-not-determined",
        severity: "action-required",
        title: "Accessibility permission has not been requested",
        detail: "Accessibility permission has not been requested.",
        nextAction: "Open Accessibility settings and grant skfiy access.",
        counts
      })
    );
  } else if (accessibility === "unknown") {
    blockers.push(
      createBlocker({
        type: "accessibility-unknown",
        severity: "unknown",
        title: "Accessibility permission status is unknown",
        detail: "Accessibility permission status is unknown.",
        nextAction: "Refresh macOS permission status.",
        counts
      })
    );
  }

  // Mismatches between app and helper process
  for (const mismatch of diagnostics.mismatches) {
    blockers.push(
      createBlocker({
        type: "permission-mismatch",
        severity: "blocked",
        title: "Permission state mismatch between app and helper",
        detail: `${mismatch.permission}: app process is ${mismatch.appProcess}, helper process is ${mismatch.helperProcess}.`,
        nextAction: "Restart skfiy so the app and helper share the same permission state.",
        counts,
        id: `permission-mismatch-${mismatch.permission}`
      })
    );
  }

  const state = deriveSectionState(blockers);
  const summary = blockers.length > 0
    ? blockers[0].detail
    : "All permissions are granted.";

  return {
    id: "permissions",
    state,
    summary,
    blockers
  };
}

function createProviderSection(
  providerStates: AssistantAgentProviderState[] | undefined,
  counts: DiagnosticRedactionCounts
): DiagnosticReportSection {
  if (!providerStates || providerStates.length === 0) {
    return createUnknownDiagnosticReportSection(
      "provider",
      "Background Agent provider status is unknown."
    );
  }

  const selected = providerStates.find((p) => p.selected) ?? null;

  if (!selected) {
    return {
      id: "provider",
      state: "action-required",
      summary: "No Background Agent provider is selected.",
      blockers: [
        createBlocker({
          type: "provider-unconfigured",
          severity: "action-required",
          title: "No Background Agent is configured",
          detail: "No Background Agent provider is selected.",
          nextAction: "Select and configure a Background Agent.",
          counts
        })
      ]
    };
  }

  const label = `${selected.label} (${selected.id})`;

  if (selected.readiness === "chat-ready") {
    return {
      id: "provider",
      state: "ready",
      summary: `Background Agent ${label} is chat-ready.`,
      blockers: []
    };
  }

  if (selected.readiness === "unconfigured") {
    return {
      id: "provider",
      state: "action-required",
      summary: `Background Agent ${label} is not configured.`,
      blockers: [
        createBlocker({
          type: "provider-unconfigured",
          severity: "action-required",
          title: "Background Agent is not configured",
          detail: `Background Agent ${label} is not configured.`,
          nextAction: "Select and configure a Background Agent.",
          counts
        })
      ]
    };
  }

  if (selected.readiness === "unavailable") {
    return {
      id: "provider",
      state: "blocked",
      summary: `Background Agent ${label} is unavailable.`,
      blockers: [
        createBlocker({
          type: "provider-unavailable",
          severity: "blocked",
          title: "Background Agent is unavailable",
          detail: sanitizeDiagnosticText(selected.readinessDetail, counts)
            ?? `Background Agent ${label} is unavailable.`,
          nextAction: "Install or repair the selected Background Agent, then retry provider discovery.",
          counts
        })
      ]
    };
  }

  if (selected.readiness === "auth-or-permission-blocked") {
    return {
      id: "provider",
      state: "blocked",
      summary: `Background Agent ${label} authentication or permission is blocked.`,
      blockers: [
        createBlocker({
          type: "provider-auth-blocked",
          severity: "blocked",
          title: "Background Agent authentication is blocked",
          detail: sanitizeDiagnosticText(selected.readinessDetail, counts)
            ?? `Background Agent ${label} authentication or permission is blocked.`,
          nextAction: "Sign in to the selected Background Agent, then retry the safe test turn.",
          counts
        })
      ]
    };
  }

  // version-ok | binary-found | binary-configured → chat not proven
  return {
    id: "provider",
    state: "action-required",
    summary: `Background Agent ${label} chat readiness has not been proven.`,
    blockers: [
      createBlocker({
        type: "provider-not-proven",
        severity: "action-required",
        title: "Background Agent chat readiness has not been proven",
        detail: `Background Agent ${label} is installed but chat readiness has not been proven by a safe test turn.`,
        nextAction: "Run a safe Background Agent test turn.",
        counts
      })
    ]
  };
}

function createChromeSection(
  evidence: BrowserReadinessEvidence | undefined,
  hostPolicy: Pick<ChromeHostPolicyState, "state" | "reason"> | undefined,
  compatibility: ChromeCompatibilityHealth | undefined,
  counts: DiagnosticRedactionCounts
): DiagnosticReportSection {
  if (!evidence) {
    return createUnknownDiagnosticReportSection("chrome", "Chrome readiness is unknown.");
  }

  const blockers: DiagnosticReportBlocker[] = [];

  // Native host
  const nativeHostState = evidence.nativeHostState;
  if (nativeHostState === "missing") {
    blockers.push(
      createBlocker({
        type: "chrome-native-host-missing",
        severity: "action-required",
        title: "Chrome Native Messaging host is not installed",
        detail: "Chrome Native Messaging host is not installed.",
        nextAction: "Install the skfiy Chrome Native Messaging host.",
        counts
      })
    );
  } else if (nativeHostState === "mismatched") {
    blockers.push(
      createBlocker({
        type: "chrome-native-host-mismatched",
        severity: "blocked",
        title: "Chrome Native Messaging host does not match the current build",
        detail: "Chrome Native Messaging host does not match the current skfiy build.",
        nextAction: "Repair the skfiy Chrome Native Messaging host installation.",
        counts
      })
    );
  } else if (nativeHostState === "cli-missing") {
    blockers.push(
      createBlocker({
        type: "chrome-native-host-cli-missing",
        severity: "blocked",
        title: "Chrome Native Messaging host cannot find the packaged CLI",
        detail: "Chrome Native Messaging host cannot find the packaged skfiy CLI.",
        nextAction: "Reinstall or rebuild skfiy, then refresh Browser setup.",
        counts
      })
    );
  } else if (nativeHostState === "invalid") {
    blockers.push(
      createBlocker({
        type: "chrome-native-host-invalid",
        severity: "blocked",
        title: "Chrome Native Messaging host configuration is invalid",
        detail: "Chrome Native Messaging host configuration is invalid.",
        nextAction: "Repair the skfiy Chrome Native Messaging host installation.",
        counts
      })
    );
  }

  // Host policy
  if (hostPolicy?.state === "invalid") {
    blockers.push(
      createBlocker({
        type: "chrome-host-policy-invalid",
        severity: "blocked",
        title: "Chrome host policy is invalid",
        detail: sanitizeDiagnosticText(hostPolicy.reason, counts)
          ?? "Chrome host policy configuration is invalid.",
        nextAction: "Reset or repair the Chrome host policy before browser actions can run.",
        counts
      })
    );
  }

  // Extension connection
  const liveConnection = evidence.liveConnectionState;
  if (liveConnection === "stale") {
    blockers.push(
      createBlocker({
        type: "chrome-extension-stale",
        severity: "blocked",
        title: "Chrome extension connection is stale",
        detail: "Chrome extension connection is stale.",
        nextAction: "Refresh the skfiy Chrome extension connection.",
        counts
      })
    );
  } else if (liveConnection === "invalid") {
    blockers.push(
      createBlocker({
        type: "chrome-extension-invalid",
        severity: "blocked",
        title: "Chrome extension connection evidence is invalid",
        detail: "Chrome extension connection evidence is invalid.",
        nextAction: "Reload the skfiy Chrome extension, then refresh connection status.",
        counts
      })
    );
  } else if (liveConnection === "unknown" && nativeHostState === "installed") {
    blockers.push(
      createBlocker({
        type: "chrome-extension-disconnected",
        severity: "blocked",
        title: "Chrome extension is not connected",
        detail: "Chrome extension has not connected to the native host recently.",
        nextAction: "Open Chrome and connect the skfiy extension.",
        counts
      })
    );
  }

  // Compatibility warnings (non-blocking unless the native host is stale)
  if (compatibility?.staleness.nativeHostStale) {
    const installedVersion = compatibility.nativeHost.installedSkfiyVersion ?? "unknown";
    blockers.push(
      createBlocker({
        type: "chrome-native-host-stale",
        severity: "blocked",
        title: "Chrome Native Messaging host is from an older skfiy build",
        detail: `Chrome Native Messaging host was installed by skfiy v${installedVersion} but the current app is v${compatibility.appVersion}.`,
        nextAction: "Repair the skfiy Chrome Native Messaging host installation.",
        counts
      })
    );
  }

  if (compatibility?.compatibility.state === "extension_outdated") {
    const extensionVersion = compatibility.compatibility.extensionVersion ?? "unknown";
    const minVersion = compatibility.compatibility.minVersion;
    blockers.push(
      createBlocker({
        type: "chrome-extension-outdated",
        severity: "action-required",
        title: "Chrome extension is older than the minimum supported version",
        detail: `Chrome extension v${extensionVersion} is older than the minimum supported v${minVersion}.`,
        nextAction: "Reload the unpacked extension from chrome-extension/ to update.",
        counts
      })
    );
  }

  const state = deriveSectionState(blockers);
  const summary = blockers.length > 0
    ? blockers[0].detail
    : "Chrome native host, host policy, and extension connection are ready.";

  return {
    id: "chrome",
    state,
    summary,
    blockers
  };
}

function createBrowserContextSection(
  evidence: BrowserReadinessEvidence | undefined,
  counts: DiagnosticRedactionCounts
): DiagnosticReportSection {
  if (!evidence) {
    return createUnknownDiagnosticReportSection(
      "browser-context",
      "Browser Context status is unknown."
    );
  }

  const state = evidence.browserContextState;

  if (state === "ready") {
    return {
      id: "browser-context",
      state: "ready",
      summary: "Browser Context is ready for the current Chrome page.",
      blockers: []
    };
  }

  const reason = sanitizeDiagnosticText(evidence.reason, counts)
    ?? "Browser Context is not ready for the current page.";
  const nextAction = sanitizeDiagnosticText(evidence.nextAction, counts)
    ?? "Refresh Browser Context from the skfiy Chrome extension.";

  const blockedStates = new Set([
    "blocked",
    "blocked_by_host_policy",
    "blocked_by_chrome_host_permission",
    "sensitive-paused",
    "stale",
    "unavailable"
  ]);

  if (blockedStates.has(state)) {
    return {
      id: "browser-context",
      state: "blocked",
      summary: reason,
      blockers: [
        createBlocker({
          type: "browser-context-blocked",
          severity: "blocked",
          title: "Browser Context is blocked",
          detail: `${reason} (state: ${state})`,
          nextAction,
          counts
        })
      ]
    };
  }

  if (state === "not-probed") {
    return {
      id: "browser-context",
      state: "action-required",
      summary: reason,
      blockers: [
        createBlocker({
          type: "browser-context-not-probed",
          severity: "action-required",
          title: "Browser Context has not been probed",
          detail: `${reason} (state: ${state})`,
          nextAction,
          counts
        })
      ]
    };
  }

  // partial | active_tab_unavailable | content_script_not_loaded | not_loaded | missing
  return {
    id: "browser-context",
    state: "action-required",
    summary: reason,
    blockers: [
      createBlocker({
        type: "browser-context-partial",
        severity: "action-required",
        title: "Browser Context is partially ready",
        detail: `${reason} (state: ${state})`,
        nextAction,
        counts
      })
    ]
  };
}

function createFinderAutomationSection(
  readiness: FinderAutomationReadiness | undefined,
  counts: DiagnosticRedactionCounts
): DiagnosticReportSection {
  if (!readiness) {
    return createUnknownDiagnosticReportSection(
      "finder-automation",
      "Finder Automation status is unknown."
    );
  }

  if (readiness.state === "proven-by-test") {
    return {
      id: "finder-automation",
      state: "ready",
      summary: "Finder Automation is ready.",
      blockers: []
    };
  }

  if (readiness.state === "blocked") {
    return {
      id: "finder-automation",
      state: "blocked",
      summary: sanitizeDiagnosticText(readiness.reason, counts)
        ?? "Finder Automation is blocked.",
      blockers: [
        createBlocker({
          type: "finder-automation-denied",
          severity: "blocked",
          title: "Finder Automation is denied",
          detail: readiness.reason,
          nextAction: readiness.nextAction,
          counts
        })
      ]
    };
  }

  // unknown
  const type: DiagnosticReportBlockerType = readiness.code === "finder-automation-test-failed"
    ? "finder-automation-test-failed"
    : "finder-automation-not-tested";

  return {
    id: "finder-automation",
    state: "unknown",
    summary: sanitizeDiagnosticText(readiness.reason, counts)
      ?? "Finder Automation readiness is unknown.",
    blockers: [
      createBlocker({
        type,
        severity: "unknown",
        title: type === "finder-automation-test-failed"
          ? "Finder Automation test failed"
          : "Finder Automation has not been tested",
        detail: readiness.reason,
        nextAction: readiness.nextAction,
        counts
      })
    ]
  };
}

function createStartupSection(
  warnings: StartupWarning[] | undefined,
  counts: DiagnosticRedactionCounts
): DiagnosticReportSection {
  if (!warnings) {
    return createUnknownDiagnosticReportSection("startup", "Startup warnings are unknown.");
  }

  if (warnings.length === 0) {
    return {
      id: "startup",
      state: "ready",
      summary: "No startup warnings.",
      blockers: []
    };
  }

  const summary = warnings
    .map((w) => sanitizeDiagnosticText(w.title, counts) ?? w.title)
    .join("; ");

  return {
    id: "startup",
    state: "action-required",
    summary,
    blockers: []
  };
}

// ---------------------------------------------------------------------------
// Blocker helpers
// ---------------------------------------------------------------------------

function createBlocker({
  type,
  severity,
  title,
  detail,
  nextAction,
  counts,
  id
}: {
  type: DiagnosticReportBlockerType;
  severity: DiagnosticReportBlockerSeverity;
  title: string;
  detail: string;
  nextAction: string;
  counts: DiagnosticRedactionCounts;
  id?: string;
}): DiagnosticReportBlocker {
  const sanitizedTitle = sanitizeDiagnosticText(title, counts) ?? title;
  const sanitizedDetail = sanitizeDiagnosticText(detail, counts) ?? detail;
  const sanitizedNextAction = sanitizeDiagnosticText(nextAction, counts) ?? nextAction;

  return {
    id: id ?? type,
    type,
    severity,
    title: sanitizedTitle,
    detail: sanitizedDetail,
    nextAction: sanitizedNextAction,
    copyable: `${type}: ${sanitizedDetail} — ${sanitizedNextAction}`
  };
}

function deriveSectionState(blockers: DiagnosticReportBlocker[]): DiagnosticReportState {
  if (blockers.length === 0) {
    return "ready";
  }
  if (blockers.some((b) => b.severity === "blocked")) {
    return "blocked";
  }
  if (blockers.some((b) => b.severity === "action-required")) {
    return "action-required";
  }
  return "unknown";
}

function deriveOverallState(sections: DiagnosticReportSection[]): DiagnosticReportState {
  const states = sections.map((s) => s.state);
  if (states.includes("blocked")) {
    return "blocked";
  }
  if (states.includes("action-required")) {
    return "action-required";
  }
  if (states.includes("unknown")) {
    return "unknown";
  }
  return "ready";
}

const SEVERITY_ORDER: Record<DiagnosticReportBlockerSeverity, number> = {
  blocked: 0,
  "action-required": 1,
  unknown: 2
};

function sortBlockers(blockers: DiagnosticReportBlocker[]): DiagnosticReportBlocker[] {
  return [...blockers].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
      || a.type.localeCompare(b.type)
  );
}

function deduplicateBlockers(
  blockers: DiagnosticReportBlocker[]
): DiagnosticReportBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((b) => {
    if (seen.has(b.id)) {
      return false;
    }
    seen.add(b.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Component versions
// ---------------------------------------------------------------------------

export interface ComponentVersionIo {
  execFile: (
    command: string,
    args: string[],
    options: { timeout: number }
  ) => Promise<{ stdout: string; stderr: string }>;
  readFile: (filePath: string) => Promise<string>;
  exists: (filePath: string) => Promise<boolean>;
}

export interface ComponentVersionReaderOptions {
  appVersion: string;
  cliShimPath: string;
  helperInfoPlistPath: string;
  extensionManifestPath: string;
  nativeHostManifestPath: string;
  providerStates: AssistantAgentProviderState[];
  /**
   * Path to the embedded Contents/Resources/build-info.json. Wired in main.ts
   * from process.resourcesPath when packaged; undefined in dev builds.
   */
  buildInfoPath?: string;
  io?: Partial<ComponentVersionIo>;
}

const CLI_VERSION_PROBE_TIMEOUT_MS = 5_000;

export async function readComponentVersions({
  appVersion,
  cliShimPath,
  helperInfoPlistPath,
  extensionManifestPath,
  nativeHostManifestPath,
  providerStates,
  buildInfoPath,
  io
}: ComponentVersionReaderOptions): Promise<DiagnosticComponentVersion[]> {
  const resolvedIo = resolveComponentVersionIo(io);

  const [app, cli, helper, provider, extension, nativeHost] = await Promise.all([
    readAppComponentVersion(appVersion, buildInfoPath, resolvedIo),
    readCliComponentVersion(cliShimPath, resolvedIo),
    readHelperComponentVersion(helperInfoPlistPath, resolvedIo),
    readProviderComponentVersion(providerStates),
    readExtensionComponentVersion(extensionManifestPath, resolvedIo),
    readNativeHostComponentVersion(nativeHostManifestPath, resolvedIo)
  ]);

  return [app, cli, helper, provider, extension, nativeHost];
}

function resolveComponentVersionIo(io?: Partial<ComponentVersionIo>): ComponentVersionIo {
  return {
    execFile: io?.execFile ?? defaultExecFile,
    readFile: io?.readFile ?? defaultReadFile,
    exists: io?.exists ?? defaultExists
  };
}

function defaultExecFile(
  command: string,
  args: string[],
  options: { timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      command,
      args,
      { timeout: options.timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString()
        });
      }
    );
  });
}

async function defaultReadFile(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, "utf8");
}

async function defaultExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readAppComponentVersion(
  appVersion: string,
  buildInfoPath: string | undefined,
  io: ComponentVersionIo
): Promise<DiagnosticComponentVersion> {
  const base: DiagnosticComponentVersion = {
    component: "app",
    version: appVersion,
    source: "electron-app.getVersion",
    state: "available"
  };

  if (!buildInfoPath) {
    // Dev builds have no embedded build-info; version still comes from
    // app.getVersion().
    return base;
  }

  try {
    if (!(await io.exists(buildInfoPath))) {
      return { ...base, state: "unknown" };
    }
    const buildInfo = JSON.parse(await io.readFile(buildInfoPath)) as {
      schemaVersion?: unknown;
      appName?: unknown;
      commitShortSha?: unknown;
      buildTimeIso?: unknown;
    };
    if (buildInfo.schemaVersion !== 1 || buildInfo.appName !== "skfiy") {
      return { ...base, state: "unknown" };
    }
    return {
      ...base,
      ...(typeof buildInfo.commitShortSha === "string"
        ? { commit: buildInfo.commitShortSha }
        : {}),
      ...(typeof buildInfo.buildTimeIso === "string"
        ? { buildTime: buildInfo.buildTimeIso }
        : {})
    };
  } catch {
    return { ...base, state: "unknown" };
  }
}

async function readCliComponentVersion(
  cliShimPath: string,
  io: ComponentVersionIo
): Promise<DiagnosticComponentVersion> {
  try {
    if (!(await io.exists(cliShimPath))) {
      return {
        component: "cli",
        version: null,
        source: "cli-shim --version",
        state: "missing"
      };
    }

    const result = await io.execFile(cliShimPath, ["--version"], {
      timeout: CLI_VERSION_PROBE_TIMEOUT_MS
    });
    const version = parseVersionOutput(result.stdout);

    if (version) {
      return {
        component: "cli",
        version,
        source: "cli-shim --version",
        state: "available"
      };
    }

    return {
      component: "cli",
      version: null,
      source: "cli-shim --version",
      state: "unknown"
    };
  } catch {
    return {
      component: "cli",
      version: null,
      source: "cli-shim --version",
      state: "unknown"
    };
  }
}

async function readHelperComponentVersion(
  infoPlistPath: string,
  io: ComponentVersionIo
): Promise<DiagnosticComponentVersion> {
  try {
    if (!(await io.exists(infoPlistPath))) {
      return {
        component: "helper",
        version: null,
        source: "helper-Info.plist",
        state: "missing"
      };
    }

    const plist = await io.readFile(infoPlistPath);
    const version = parseInfoPlistVersion(plist);

    if (version) {
      return {
        component: "helper",
        version,
        source: "helper-Info.plist",
        state: "available"
      };
    }

    return {
      component: "helper",
      version: null,
      source: "helper-Info.plist",
      state: "unknown"
    };
  } catch {
    return {
      component: "helper",
      version: null,
      source: "helper-Info.plist",
      state: "unknown"
    };
  }
}

async function readProviderComponentVersion(
  providerStates: AssistantAgentProviderState[]
): Promise<DiagnosticComponentVersion> {
  const selected = providerStates.find((p) => p.selected) ?? null;

  if (!selected) {
    return {
      component: "provider",
      version: null,
      source: "provider-binary --version",
      state: "unknown",
      detail: "no provider selected"
    };
  }

  const detail = `${selected.id} (${selected.label})`;

  if (selected.version) {
    return {
      component: "provider",
      version: selected.version,
      source: `${selected.id} --version`,
      state: "available",
      detail
    };
  }

  return {
    component: "provider",
    version: null,
    source: `${selected.id} --version`,
    state: "unknown",
    detail
  };
}

async function readExtensionComponentVersion(
  manifestPath: string,
  io: ComponentVersionIo
): Promise<DiagnosticComponentVersion> {
  try {
    if (!(await io.exists(manifestPath))) {
      return {
        component: "chrome-extension",
        version: null,
        source: "chrome-extension/manifest.json",
        state: "missing"
      };
    }

    const manifest = JSON.parse(await io.readFile(manifestPath)) as { version?: string };

    if (manifest.version) {
      return {
        component: "chrome-extension",
        version: manifest.version,
        source: "chrome-extension/manifest.json",
        state: "available"
      };
    }

    return {
      component: "chrome-extension",
      version: null,
      source: "chrome-extension/manifest.json",
      state: "unknown"
    };
  } catch {
    return {
      component: "chrome-extension",
      version: null,
      source: "chrome-extension/manifest.json",
      state: "unknown"
    };
  }
}

async function readNativeHostComponentVersion(
  manifestPath: string,
  io: ComponentVersionIo
): Promise<DiagnosticComponentVersion> {
  try {
    if (!(await io.exists(manifestPath))) {
      return {
        component: "native-host",
        version: null,
        source: "native-host-manifest",
        state: "missing"
      };
    }

    // The native host manifest has no independent version field. Its version
    // is implicitly the app version that installed it; report "unknown"
    // unless a version field is added in a future iteration.
    return {
      component: "native-host",
      version: null,
      source: "native-host-manifest",
      state: "available",
      detail: "installed (no version field in manifest)"
    };
  } catch {
    return {
      component: "native-host",
      version: null,
      source: "native-host-manifest",
      state: "unknown"
    };
  }
}

function parseVersionOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  // Match common version patterns: "0.1.0", "v0.1.0", "skfiy 0.1.0", etc.
  const match = trimmed.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/);
  return match?.[1] ?? null;
}

function parseInfoPlistVersion(plist: string): string | null {
  const keyIndex = plist.indexOf("CFBundleShortVersionString");
  if (keyIndex < 0) {
    return null;
  }

  const afterKey = plist.slice(keyIndex);
  const match = afterKey.match(/<string>([^<]+)<\/string>/);
  return match?.[1]?.trim() ?? null;
}

// re-export path for callers that need to resolve the helper Info.plist path
export function resolveHelperInfoPlistPath({
  appPath,
  isPackaged,
  resourcesPath
}: {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
}): string {
  if (isPackaged) {
    return path.join(resourcesPath, "..", "Info.plist");
  }
  return path.join(appPath, "macos-helper", "Sources", "skfiy-helper", "Info.plist");
}
