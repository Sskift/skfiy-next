/**
 * Unified Diagnostics Report — shared contract.
 *
 * This module is the single source of truth for the diagnostic report type,
 * the typed blocker union, the redaction function, and the export-preview
 * renderer. Main, preload, and renderer all import from here so the contract
 * is never duplicated across surfaces.
 */

export const DIAGNOSTIC_REPORT_SCHEMA_VERSION = 1;

export type DiagnosticReportState = "ready" | "action-required" | "blocked" | "unknown";

export type DiagnosticReportSectionId =
  | "desktop-session"
  | "permissions"
  | "provider"
  | "chrome"
  | "browser-context"
  | "finder-automation"
  | "startup";

export type DiagnosticReportBlockerType =
  // Desktop session
  | "desktop-session-locked"
  | "desktop-session-asleep"
  | "desktop-session-not-controllable"
  | "desktop-session-unknown"
  // Permissions
  | "screen-recording-denied"
  | "screen-recording-not-determined"
  | "screen-recording-unknown"
  | "accessibility-denied"
  | "accessibility-not-determined"
  | "accessibility-unknown"
  | "permission-mismatch"
  // Provider / Background Agent
  | "provider-unconfigured"
  | "provider-unavailable"
  | "provider-auth-blocked"
  | "provider-not-proven"
  | "provider-unknown"
  // Chrome / browser
  | "chrome-native-host-missing"
  | "chrome-native-host-mismatched"
  | "chrome-native-host-cli-missing"
  | "chrome-native-host-invalid"
  | "chrome-native-host-stale"
  | "chrome-host-policy-invalid"
  | "chrome-extension-disconnected"
  | "chrome-extension-stale"
  | "chrome-extension-invalid"
  | "chrome-extension-outdated"
  // Browser context
  | "browser-context-blocked"
  | "browser-context-partial"
  | "browser-context-not-probed"
  | "browser-context-unknown"
  // Finder automation
  | "finder-automation-denied"
  | "finder-automation-not-tested"
  | "finder-automation-test-failed";

export type DiagnosticReportBlockerSeverity = "blocked" | "action-required" | "unknown";

export interface DiagnosticReportBlocker {
  /** Stable slug, e.g. "desktop-session-locked". */
  id: string;
  type: DiagnosticReportBlockerType;
  severity: DiagnosticReportBlockerSeverity;
  title: string;
  detail: string;
  nextAction: string;
  /** Pre-assembled one-line "type: detail — nextAction" for clipboard. */
  copyable: string;
}

export interface DiagnosticReportSection {
  id: DiagnosticReportSectionId;
  state: DiagnosticReportState;
  summary: string;
  blockers: DiagnosticReportBlocker[];
}

export type DiagnosticComponentName =
  | "app"
  | "cli"
  | "helper"
  | "provider"
  | "chrome-extension"
  | "native-host";

export type DiagnosticComponentState = "available" | "missing" | "unknown";

export interface DiagnosticComponentVersion {
  component: DiagnosticComponentName;
  version: string | null;
  source: string;
  state: DiagnosticComponentState;
  detail?: string;
  /** Embedded build-info commit (short SHA), for the app component when packaged. */
  commit?: string;
  /** Embedded build-info build time (ISO-8601), for the app component when packaged. */
  buildTime?: string;
}

export interface DiagnosticReportRedaction {
  rule: string;
  count: number;
}

export interface DiagnosticReport {
  schemaVersion: 1;
  generatedAt: string;
  overallState: DiagnosticReportState;
  sections: DiagnosticReportSection[];
  blockers: DiagnosticReportBlocker[];
  componentVersions: DiagnosticComponentVersion[];
  redactionSummary: DiagnosticReportRedaction[];
  /** Exact text that would be exported/copied. Preview === export. */
  exportPreview: string;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const MAX_DIAGNOSTIC_TEXT_LENGTH = 500;

export type DiagnosticRedactionCounts = Map<string, number>;

export function createDiagnosticRedactionCounts(): DiagnosticRedactionCounts {
  return new Map();
}

/**
 * Sanitize free-text diagnostic fields. Applies the same rules as
 * sanitizeReadinessText in first-run-readiness.ts — Bearer tokens, credential
 * assignments, sk- keys, URLs, file:/// URLs, absolute POSIX paths, and
 * Windows paths are redacted before serialization.
 *
 * When `counts` is supplied, each fired rule is accumulated so the report can
 * include a redactionSummary for transparency.
 */
export function sanitizeDiagnosticText(
  value: string | undefined,
  counts?: DiagnosticRedactionCounts
): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  let text = trimmed.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);

  text = applyRedactionRule(
    text,
    /\bBearer\s+[^\s,;]+/gi,
    "Bearer [redacted]",
    "bearer-token",
    counts
  );
  text = applyRedactionRule(
    text,
    /\b((?:api[_-]?key|authorization|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
    "$1[redacted]",
    "credential-assignment",
    counts
  );
  text = applyRedactionRule(
    text,
    /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    "[redacted]",
    "sk-key",
    counts
  );
  text = applyRedactionRule(
    text,
    /https?:\/\/[^\s,;)'\"]+/g,
    "[page]",
    "url",
    counts
  );
  text = applyRedactionRule(
    text,
    /file:\/\/\/[^\s,;)'\"]+/g,
    "[local path]",
    "file-url",
    counts
  );
  text = applyRedactionRule(
    text,
    /(^|[\s(`'\"])\/[^\s,;)'\"]+/g,
    "$1[local path]",
    "absolute-path",
    counts
  );
  text = applyRedactionRule(
    text,
    /[A-Za-z]:\\[^\s,;)'\"]+/g,
    "[local path]",
    "windows-path",
    counts
  );

  return text;
}

function applyRedactionRule(
  text: string,
  pattern: RegExp,
  replacement: string,
  rule: string,
  counts?: DiagnosticRedactionCounts
): string {
  if (!counts) {
    return text.replace(pattern, replacement);
  }

  const matches = text.match(pattern);
  if (matches && matches.length > 0) {
    counts.set(rule, (counts.get(rule) ?? 0) + matches.length);
  }

  return text.replace(pattern, replacement);
}

export function readDiagnosticRedactionSummary(
  counts: DiagnosticRedactionCounts
): DiagnosticReportRedaction[] {
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

// ---------------------------------------------------------------------------
// Unknown fallbacks
// ---------------------------------------------------------------------------

export function createUnknownDiagnosticReportSection(
  id: DiagnosticReportSectionId,
  summary = "Diagnostic status is unknown."
): DiagnosticReportSection {
  return {
    id,
    state: "unknown",
    summary,
    blockers: []
  };
}

type ReportWithoutPreview = Omit<DiagnosticReport, "exportPreview">;

export function createUnknownDiagnosticReport(
  generatedAt: string = new Date(0).toISOString()
): DiagnosticReport {
  const sections: DiagnosticReportSection[] = [
    createUnknownDiagnosticReportSection("desktop-session", "Desktop session status is unknown."),
    createUnknownDiagnosticReportSection("permissions", "Permission status is unknown."),
    createUnknownDiagnosticReportSection("provider", "Background Agent provider status is unknown."),
    createUnknownDiagnosticReportSection("chrome", "Chrome readiness is unknown."),
    createUnknownDiagnosticReportSection("browser-context", "Browser Context status is unknown."),
    createUnknownDiagnosticReportSection("finder-automation", "Finder Automation status is unknown."),
    createUnknownDiagnosticReportSection("startup", "Startup warnings are unknown.")
  ];

  const report: ReportWithoutPreview = {
    schemaVersion: DIAGNOSTIC_REPORT_SCHEMA_VERSION,
    generatedAt,
    overallState: "unknown",
    sections,
    blockers: [],
    componentVersions: [],
    redactionSummary: []
  };

  return {
    ...report,
    exportPreview: renderDiagnosticReportExport(report)
  };
}

export const UNKNOWN_DIAGNOSTIC_REPORT: DiagnosticReport = createUnknownDiagnosticReport();

// ---------------------------------------------------------------------------
// Export preview renderer
// ---------------------------------------------------------------------------

/**
 * Render the exact plain-text representation of the report that would be
 * written to a file or put on the clipboard. The renderer shows this string
 * in a preview modal; when the user clicks "Export" the same string is
 * written/copied — guaranteeing preview === export.
 */
export function renderDiagnosticReportExport(report: ReportWithoutPreview): string {
  const lines: string[] = [
    "skfiy Diagnostic Report",
    "======================",
    `Generated: ${report.generatedAt}`,
    `Schema Version: ${report.schemaVersion}`,
    `Overall State: ${report.overallState}`,
    "",
    "Sections",
    "--------"
  ];

  for (const section of report.sections) {
    lines.push(`[${section.id}] ${section.state}`);
    lines.push(`  ${section.summary}`);
    if (section.blockers.length > 0) {
      lines.push("  Blockers:");
      for (const blocker of section.blockers) {
        lines.push(
          `    - ${blocker.type} (${blocker.severity}): ${blocker.detail} — ${blocker.nextAction}`
        );
      }
    }
    lines.push("");
  }

  lines.push("Blockers (sorted by severity)");
  lines.push("-----------------------------");
  if (report.blockers.length === 0) {
    lines.push("None.");
  } else {
    for (const blocker of report.blockers) {
      lines.push(
        `- [${blocker.severity}] ${blocker.type}: ${blocker.detail} — ${blocker.nextAction}`
      );
    }
  }
  lines.push("");

  lines.push("Component Versions");
  lines.push("------------------");
  for (const component of report.componentVersions) {
    const version = component.version ?? "unknown";
    const detail = component.detail ? ` — ${component.detail}` : "";
    lines.push(
      `- ${component.component}: ${version} (${component.state}) [${component.source}]${detail}`
    );
  }
  lines.push("");

  lines.push("Redactions");
  lines.push("----------");
  if (report.redactionSummary.length === 0) {
    lines.push("None.");
  } else {
    for (const redaction of report.redactionSummary) {
      lines.push(`- ${redaction.rule}: ${redaction.count}`);
    }
  }

  return lines.join("\n");
}
