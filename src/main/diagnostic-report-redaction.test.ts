import { describe, expect, it } from "vitest";
import {
  createDiagnosticReport,
  type DiagnosticReportInput
} from "./diagnostic-report";
import {
  createDiagnosticRedactionCounts,
  readDiagnosticRedactionSummary,
  sanitizeDiagnosticText
} from "../shared/diagnostic-report";
import type { DesktopSessionDiagnostics } from "./desktop-session-diagnostics";
import type { DesktopSessionStatus, PermissionSummary } from "./computer-use/types";
import type { PermissionDiagnostics } from "./permissions";
import type { BrowserReadinessEvidence } from "./main-browser-readiness";
import type { FinderAutomationReadiness } from "./main-finder-automation-readiness";
import type { AssistantAgentProviderState } from "./assistant-agent";
import type { StartupWarning } from "./startup-guard";
import type { ChromeHostPolicyState } from "./chrome-host-policy";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createDesktopSessionStatus(
  overrides: Partial<DesktopSessionStatus> = {}
): DesktopSessionStatus {
  return {
    controllable: true,
    ...overrides
  };
}

function createDesktopSessionDiagnostics(
  overrides: Partial<DesktopSessionDiagnostics> = {}
): DesktopSessionDiagnostics {
  return {
    state: "controllable",
    status: createDesktopSessionStatus(),
    reason: "Desktop session is controllable.",
    ...overrides
  };
}

function createPermissionSummary(
  overrides: Partial<PermissionSummary> = {}
): PermissionSummary {
  return {
    screenRecording: { state: "granted" },
    accessibility: { state: "granted" },
    ...overrides
  };
}

function createPermissionDiagnostics(
  overrides: Partial<PermissionDiagnostics> = {}
): PermissionDiagnostics {
  const summary = createPermissionSummary();
  return {
    active: summary,
    appProcess: summary,
    helperProcess: summary,
    mismatches: [],
    identity: {
      appPath: "/Applications/skfiy.app",
      executablePath: "/Applications/skfiy.app/Contents/MacOS/skfiy",
      helperPath: "/Applications/skfiy.app/Contents/MacOS/skfiy-helper",
      resourcesPath: "/Applications/skfiy.app/Contents/Resources",
      isPackaged: true
    },
    ...overrides
  };
}

function createBrowserReadinessEvidence(
  overrides: Partial<BrowserReadinessEvidence> = {}
): BrowserReadinessEvidence {
  return {
    nativeHostState: "installed",
    liveConnectionState: "connected",
    browserContextState: "ready",
    reason: "Browser Context is ready.",
    nextAction: "No action required.",
    ...overrides
  };
}

function createFinderAutomationReadiness(
  overrides: Partial<FinderAutomationReadiness> = {}
): FinderAutomationReadiness {
  return {
    state: "proven-by-test",
    code: "finder-automation-ready",
    reason: "Finder Automation is ready.",
    nextAction: "No action required.",
    evidenceSource: "finder-selection-test",
    ...overrides
  };
}

function createProviderState(
  overrides: Partial<AssistantAgentProviderState> = {}
): AssistantAgentProviderState {
  return {
    provider: "assistant",
    id: "codex",
    label: "Codex",
    selected: true,
    configured: true,
    executableSource: "default",
    readiness: "chat-ready",
    version: "0.1.0",
    ...overrides
  };
}

function createChromeHostPolicy(
  overrides: Partial<Pick<ChromeHostPolicyState, "state" | "reason">> = {}
): Pick<ChromeHostPolicyState, "state" | "reason"> {
  return {
    state: "default",
    ...overrides
  };
}

function createInputWithAdversarialText(
  adversarialDetail: string,
  adversarialNextAction = "Resolve the issue."
): DiagnosticReportInput {
  return {
    permissions: createPermissionDiagnostics(),
    desktopSession: createDesktopSessionDiagnostics({
      state: "blocked",
      status: createDesktopSessionStatus({
        controllable: false,
        frontmostBundleId: "com.apple.loginwindow",
        frontmostProcessIdentifier: 591
      }),
      reason: adversarialDetail
    }),
    browserReadiness: createBrowserReadinessEvidence({
      browserContextState: "blocked",
      reason: adversarialDetail,
      nextAction: adversarialNextAction
    }),
    chromeHostPolicy: createChromeHostPolicy(),
    finderAutomation: createFinderAutomationReadiness({
      state: "blocked",
      code: "finder-automation-denied",
      reason: adversarialDetail,
      nextAction: adversarialNextAction
    }),
    providerStates: [
      createProviderState({
        readiness: "unavailable",
        readinessDetail: adversarialDetail
      })
    ],
    startupWarnings: [] as StartupWarning[],
    componentVersions: []
  };
}

// ---------------------------------------------------------------------------
// sanitizeDiagnosticText unit tests
// ---------------------------------------------------------------------------

describe("sanitizeDiagnosticText", () => {
  it("redacts Bearer tokens", () => {
    const result = sanitizeDiagnosticText(
      "Authorization failed for Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    );
    expect(result).toContain("Bearer [redacted]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts api_key assignments", () => {
    const result = sanitizeDiagnosticText("config has api_key=sk-****cdef");
    expect(result).toContain("api_key=[redacted]");
    expect(result).not.toContain("secret12345678abcdef");
  });

  it("redacts token assignments", () => {
    const result = sanitizeDiagnosticText("token: abc123secret");
    expect(result).toContain("token: [redacted]");
  });

  it("redacts password assignments", () => {
    const result = sanitizeDiagnosticText("password=hunter2hunter2");
    expect(result).toContain("password=[redacted]");
  });

  it("redacts secret assignments", () => {
    const result = sanitizeDiagnosticText("secret: my-secret-value");
    expect(result).toContain("secret: [redacted]");
  });

  it("redacts authorization assignments", () => {
    const result = sanitizeDiagnosticText("authorization: Basic dXNlcjpwYXNz");
    expect(result).toContain("authorization: [redacted]");
  });

  it("redacts sk- prefixed keys", () => {
    const result = sanitizeDiagnosticText("using key sk-abc123def456ghi789");
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("sk-abc123def456ghi789");
  });

  it("redacts HTTP URLs", () => {
    const result = sanitizeDiagnosticText("fetch from https://example.com/secret/path");
    expect(result).toContain("[page]");
    expect(result).not.toContain("example.com");
  });

  it("redacts HTTPS URLs", () => {
    const result = sanitizeDiagnosticText("fetch from https://api.example.com/v1/data");
    expect(result).toContain("[page]");
    expect(result).not.toContain("api.example.com");
  });

  it("redacts file:/// URLs", () => {
    const result = sanitizeDiagnosticText("file:///Users/tester/secret/document.txt");
    expect(result).toContain("[local path]");
    expect(result).not.toContain("Users/tester");
  });

  it("redacts absolute POSIX paths", () => {
    const result = sanitizeDiagnosticText("file at /Users/tester/Documents/file.txt");
    expect(result).toContain("[local path]");
    expect(result).not.toContain("Users/tester");
  });

  it("redacts Windows paths", () => {
    const result = sanitizeDiagnosticText("file at C:\\Users\\tester\\file.txt");
    expect(result).toContain("[local path]");
    expect(result).not.toContain("tester");
  });

  it("truncates text longer than 500 chars", () => {
    const longText = "a".repeat(600);
    const result = sanitizeDiagnosticText(longText);
    expect(result).toHaveLength(500);
  });

  it("returns undefined for empty text", () => {
    expect(sanitizeDiagnosticText("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only text", () => {
    expect(sanitizeDiagnosticText("   ")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(sanitizeDiagnosticText(undefined)).toBeUndefined();
  });

  it("trims whitespace", () => {
    const result = sanitizeDiagnosticText("  hello world  ");
    expect(result).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// Redaction summary counts
// ---------------------------------------------------------------------------

describe("redaction summary", () => {
  it("counts bearer token redactions", () => {
    const counts = createDiagnosticRedactionCounts();
    sanitizeDiagnosticText("Bearer token1 and Bearer token2", counts);
    const summary = readDiagnosticRedactionSummary(counts);
    const bearerEntry = summary.find((r) => r.rule === "bearer-token");
    expect(bearerEntry?.count).toBe(2);
  });

  it("counts URL redactions", () => {
    const counts = createDiagnosticRedactionCounts();
    sanitizeDiagnosticText("visit https://a.com and https://b.com", counts);
    const summary = readDiagnosticRedactionSummary(counts);
    const urlEntry = summary.find((r) => r.rule === "url");
    expect(urlEntry?.count).toBe(2);
  });

  it("counts absolute path redactions", () => {
    const counts = createDiagnosticRedactionCounts();
    sanitizeDiagnosticText("/path/a and /path/b", counts);
    const summary = readDiagnosticRedactionSummary(counts);
    const pathEntry = summary.find((r) => r.rule === "absolute-path");
    expect(pathEntry?.count).toBe(2);
  });

  it("returns empty summary when no redactions fire", () => {
    const counts = createDiagnosticRedactionCounts();
    sanitizeDiagnosticText("clean text with no secrets", counts);
    const summary = readDiagnosticRedactionSummary(counts);
    expect(summary).toEqual([]);
  });

  it("sorts summary by count descending", () => {
    const counts = createDiagnosticRedactionCounts();
    sanitizeDiagnosticText("Bearer token1", counts);
    sanitizeDiagnosticText("/path/a and /path/b", counts);
    const summary = readDiagnosticRedactionSummary(counts);
    expect(summary[0].count).toBeGreaterThanOrEqual(summary[1].count);
  });
});

// ---------------------------------------------------------------------------
// End-to-end redaction in assembled reports
// ---------------------------------------------------------------------------

describe("report redaction", () => {
  it("redacts Bearer tokens in blocker detail", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText(
        "Auth failed: Bearer eyJsecret.token-value"
      )
    );

    for (const blocker of report.blockers) {
      expect(blocker.detail).not.toContain("eyJsecret.token-value");
      expect(blocker.copyable).not.toContain("eyJsecret.token-value");
    }
    expect(JSON.stringify(report)).not.toContain("eyJsecret.token-value");
  });

  it("redacts api_key in blocker detail", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText("config api_key=super-secret-key-123")
    );

    for (const blocker of report.blockers) {
      expect(blocker.detail).not.toContain("super-secret-key-123");
    }
    expect(JSON.stringify(report)).not.toContain("super-secret-key-123");
  });

  it("redacts sk- keys in blocker detail", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText("key sk-abcdefgh12345678")
    );

    expect(JSON.stringify(report)).not.toContain("sk-abcdefgh12345678");
  });

  it("redacts URLs in blocker detail", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText("fetch https://secret.example.com/data")
    );

    expect(JSON.stringify(report)).not.toContain("secret.example.com");
  });

  it("redacts file:/// URLs in blocker detail", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText("file:///Users/tester/secret.txt")
    );

    expect(JSON.stringify(report)).not.toContain("Users/tester");
  });

  it("redacts absolute POSIX paths in blocker detail", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText("path /Users/tester/Documents/secret.txt")
    );

    expect(JSON.stringify(report)).not.toContain("Users/tester");
  });

  it("redacts Windows paths in blocker detail", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText("path C:\\Users\\tester\\secret.txt")
    );

    expect(JSON.stringify(report)).not.toContain("tester");
  });

  it("redacts paths in nextAction", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText(
        "Something is blocked.",
        "Check /Users/tester/.config/skfiy/settings.json"
      )
    );

    for (const blocker of report.blockers) {
      expect(blocker.nextAction).not.toContain("Users/tester");
      expect(blocker.copyable).not.toContain("Users/tester");
    }
  });

  it("includes redaction summary when redactions fire", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText("Bearer secret-token and /secret/path")
    );

    expect(report.redactionSummary.length).toBeGreaterThan(0);
    const rules = report.redactionSummary.map((r) => r.rule);
    expect(rules).toContain("bearer-token");
    expect(rules).toContain("absolute-path");
  });

  it("has empty redaction summary for clean text", () => {
    const report = createDiagnosticReport(
      createInputWithAdversarialText("Desktop session is locked.")
    );

    expect(report.redactionSummary).toEqual([]);
  });

  it("does not include screenshot paths in the report", () => {
    const report = createDiagnosticReport({
      ...createInputWithAdversarialText("blocked"),
      desktopSession: createDesktopSessionDiagnostics({
        state: "blocked",
        status: createDesktopSessionStatus({
          controllable: false,
          frontmostBundleId: "com.apple.loginwindow"
        }),
        reason: "Desktop session is locked."
      })
    });

    const json = JSON.stringify(report);
    // No screenshot data should be present
    expect(json).not.toContain("screenshot");
    expect(json).not.toContain(".png");
  });

  it("does not include raw browser context URLs in the report", () => {
    const report = createDiagnosticReport({
      ...createInputWithAdversarialText("blocked"),
      browserReadiness: createBrowserReadinessEvidence({
        browserContextState: "blocked",
        reason: "Blocked on https://private.example.com/secret/page",
        nextAction: "Resolve the blocker."
      })
    });

    const json = JSON.stringify(report);
    expect(json).not.toContain("private.example.com");
  });

  it("does not include command stdout/stderr or lastError in the report", () => {
    const report = createDiagnosticReport({
      ...createInputWithAdversarialText("blocked"),
      providerStates: [
        createProviderState({
          readiness: "unavailable",
          readinessDetail: "Background Agent binary could not be found.",
          lastError: "stdout: some raw output\nstderr: some raw error"
        })
      ]
    });

    // lastError may contain raw command output and must never be embedded.
    const json = JSON.stringify(report);
    expect(json).not.toContain("some raw output");
    expect(json).not.toContain("some raw error");
    expect(json).not.toContain("lastError");
    // The human-readable readinessDetail IS included (after redaction).
    expect(json).toContain("Background Agent binary could not be found.");
  });

  it("does not include private paths from permission identity", () => {
    const report = createDiagnosticReport({
      ...createInputWithAdversarialText("blocked"),
      permissions: createPermissionDiagnostics({
        identity: {
          appPath: "/Users/tester/Applications/skfiy.app",
          executablePath: "/Users/tester/Applications/skfiy.app/Contents/MacOS/skfiy",
          helperPath: "/Users/tester/Applications/skfiy.app/Contents/MacOS/skfiy-helper",
          resourcesPath: "/Users/tester/Applications/skfiy.app/Contents/Resources",
          isPackaged: true
        }
      })
    });

    const json = JSON.stringify(report);
    expect(json).not.toContain("Users/tester");
  });

  it("does not include env var values in the report", () => {
    const report = createDiagnosticReport({
      ...createInputWithAdversarialText("blocked"),
      startupWarnings: [
        {
          id: "dev-server",
          title: "Dev server running",
          message: "SKFIY_HELPER_PATH=/secret/path/to/helper"
        }
      ]
    });

    const json = JSON.stringify(report);
    expect(json).not.toContain("/secret/path/to/helper");
  });
});
