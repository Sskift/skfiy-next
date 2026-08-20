/**
 * Pure page-state classifiers for Chrome multi-step workflows.
 *
 * These functions consume untrusted page/extension signals (CDP snapshots,
 * extension pageSafety findings, download status, and tab targets) and return
 * typed recovery decisions. They never execute CDP commands themselves — the
 * orchestrator injects the observations — so every classifier is a pure
 * function that can be unit-tested in isolation.
 */

export interface ChromePageStateSnapshot {
  url: string;
  documentId: string;
}

export type ChromePageStateChange =
  | { kind: "unchanged" }
  | { kind: "navigation"; fromUrl: string; toUrl: string }
  | { kind: "reload"; url: string };

/**
 * Classifies what happened to the bound page between two observations.
 * A URL change (beyond the fragment) is a recoverable navigation; a documentId
 * change with the same URL is a reload; anything else is unchanged.
 */
export function classifyPageStateChange(
  previous: ChromePageStateSnapshot,
  current: ChromePageStateSnapshot
): ChromePageStateChange {
  if (!areEquivalentUrls(previous.url, current.url)) {
    return {
      kind: "navigation",
      fromUrl: previous.url,
      toUrl: current.url
    };
  }

  if (previous.documentId !== current.documentId) {
    return {
      kind: "reload",
      url: current.url
    };
  }

  return { kind: "unchanged" };
}

function areEquivalentUrls(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return left === right;
  }
}

// ---------------------------------------------------------------------------
// Auth-wall detection (extension pageSafety signal)
// ---------------------------------------------------------------------------

export interface ChromePageSafetyFinding {
  kind: string;
  severity: string;
}

export interface ChromePageSafetyState {
  findings: ChromePageSafetyFinding[];
  needsConfirmation: boolean;
}

export type ChromeAuthWallDecision =
  | {
      detected: true;
      reason: string;
      findings: ChromePageSafetyFinding[];
    }
  | { detected: false };

/**
 * pageSafety finding kinds that indicate an authentication or payment wall.
 * Mirrors the extension content-script PAGE_RISK_PATTERNS classification;
 * treated as untrusted data but authoritative for typed blocker emission.
 */
export const CHROME_AUTH_WALL_FINDING_KINDS = [
  "credential_or_otp_prompt",
  "payment_or_billing_flow",
  "account_risk",
  "financial_transfer",
  "secret_exposure"
] as const;

export function detectAuthWall(safety: ChromePageSafetyState): ChromeAuthWallDecision {
  const matchingFindings = safety.findings.filter((finding) =>
    (CHROME_AUTH_WALL_FINDING_KINDS as readonly string[]).includes(finding.kind)
  );

  if (!safety.needsConfirmation && matchingFindings.length === 0) {
    return { detected: false };
  }

  const reason = matchingFindings.length > 0
    ? `Chrome page shows an auth wall: ${matchingFindings
        .map((finding) => finding.kind)
        .join(", ")}.`
    : "Chrome page requires confirmation for sensitive content.";

  return {
    detected: true,
    reason,
    findings: matchingFindings.length > 0 ? matchingFindings : safety.findings
  };
}

// ---------------------------------------------------------------------------
// Download detection (extension DOWNLOADS_STATUS signal)
// ---------------------------------------------------------------------------

export interface ChromeDownloadRecord {
  id: string;
  url: string;
  state: string;
}

export interface ChromeDownloadsStatus {
  downloads: ChromeDownloadRecord[];
}

export type ChromeDownloadDecision =
  | {
      detected: true;
      downloadHost: string;
      reason: string;
    }
  | { detected: false };

/**
 * Detects downloads that appeared after a mutating step. Only the download
 * URL host is reported — the full path is never exposed, matching the
 * extension's path-exposure protection.
 */
export function detectDownload(
  previous: ChromeDownloadsStatus,
  current: ChromeDownloadsStatus
): ChromeDownloadDecision {
  const previousIds = new Set(previous.downloads.map((download) => download.id));
  const newDownloads = current.downloads.filter((download) => !previousIds.has(download.id));

  if (newDownloads.length === 0) {
    return { detected: false };
  }

  const first = newDownloads[0];
  return {
    detected: true,
    downloadHost: readDownloadUrlHost(first.url),
    reason: `Chrome triggered ${newDownloads.length} download${newDownloads.length === 1 ? "" : "s"} after the last action; the page content may be stale.`
  };
}

export function readDownloadUrlHost(url: string): string {
  try {
    return new URL(url).host || "unknown host";
  } catch {
    return "unknown host";
  }
}

// ---------------------------------------------------------------------------
// New-tab detection (CDP /json/list targets)
// ---------------------------------------------------------------------------

export interface ChromePageTarget {
  id: string;
  url: string;
  type: "page";
}

export type ChromeNewTabDecision =
  | {
      detected: true;
      tabUrl: string;
      reason: string;
    }
  | { detected: false };

/**
 * Detects page targets that appeared after a mutating step. A new tab would
 * silently hijack the CDP client's first-page-target selection, so the
 * workflow must block and ask whether to re-bind.
 */
export function detectNewTab(
  previous: readonly ChromePageTarget[],
  current: readonly ChromePageTarget[]
): ChromeNewTabDecision {
  const previousIds = new Set(previous.map((target) => target.id));
  const newTargets = current.filter((target) => !previousIds.has(target.id));

  if (newTargets.length === 0) {
    return { detected: false };
  }

  const first = newTargets[0];
  return {
    detected: true,
    tabUrl: first.url,
    reason: `Chrome opened ${newTargets.length} new tab${newTargets.length === 1 ? "" : "s"} after the last action; re-bind to the new tab or stay on the original.`
  };
}
