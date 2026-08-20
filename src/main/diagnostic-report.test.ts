import { describe, expect, it } from "vitest";
import {
  createDiagnosticReport,
  readComponentVersions,
  readDiagnosticReportForRenderer,
  type ComponentVersionIo,
  type DiagnosticReportSources
} from "./diagnostic-report";
import type { DesktopSessionDiagnostics } from "./desktop-session-diagnostics";
import type { DesktopSessionStatus, PermissionSummary } from "./computer-use/types";
import type { PermissionDiagnostics } from "./permissions";
import type { BrowserReadinessEvidence } from "./main-browser-readiness";
import type { FinderAutomationReadiness } from "./main-finder-automation-readiness";
import type { AssistantAgentProviderState } from "./assistant-agent";
import type { StartupWarning } from "./startup-guard";
import type { ChromeHostPolicyState } from "./chrome-host-policy";
import type { DiagnosticReport } from "../shared/diagnostic-report";
import { renderDiagnosticReportExport } from "../shared/diagnostic-report";

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
    reason: "Browser Context is ready for the current Chrome page.",
    nextAction: "No setup action is required.",
    ...overrides
  };
}

function createFinderAutomationReadiness(
  overrides: Partial<FinderAutomationReadiness> = {}
): FinderAutomationReadiness {
  return {
    state: "proven-by-test",
    code: "finder-automation-ready",
    reason: "skfiy read Finder selection without changing files.",
    nextAction: "Finder workflows are ready for planning and approval.",
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

function createStartupWarnings(): StartupWarning[] {
  return [];
}

function createAllReadyInput() {
  return {
    permissions: createPermissionDiagnostics(),
    desktopSession: createDesktopSessionDiagnostics(),
    browserReadiness: createBrowserReadinessEvidence(),
    chromeHostPolicy: createChromeHostPolicy(),
    finderAutomation: createFinderAutomationReadiness(),
    providerStates: [createProviderState()],
    startupWarnings: createStartupWarnings(),
    componentVersions: []
  };
}

// ---------------------------------------------------------------------------
// Overall report
// ---------------------------------------------------------------------------

describe("createDiagnosticReport", () => {
  it("assembles a ready report when all sections are ready", () => {
    const report = createDiagnosticReport(createAllReadyInput());

    expect(report.schemaVersion).toBe(1);
    expect(report.overallState).toBe("ready");
    expect(report.blockers).toEqual([]);
    expect(report.sections).toHaveLength(7);
    for (const section of report.sections) {
      expect(section.state).toBe("ready");
      expect(section.blockers).toEqual([]);
    }
  });

  it("includes all seven section ids in order", () => {
    const report = createDiagnosticReport(createAllReadyInput());

    expect(report.sections.map((s) => s.id)).toEqual([
      "desktop-session",
      "permissions",
      "provider",
      "chrome",
      "browser-context",
      "finder-automation",
      "startup"
    ]);
  });

  it("produces a JSON-serializable report with no undefined or Error objects", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      desktopSession: createDesktopSessionDiagnostics({
        state: "blocked",
        status: createDesktopSessionStatus({
          controllable: false,
          frontmostBundleId: "com.apple.loginwindow",
          frontmostProcessIdentifier: 591
        }),
        reason: "Desktop session is locked by loginwindow (pid 591)."
      })
    });

    const json = JSON.stringify(report);
    expect(json).toBeTruthy();
    const parsed = JSON.parse(json) as DiagnosticReport;
    expect(parsed.overallState).toBe("blocked");
    expect(parsed.blockers).toHaveLength(1);
    // No undefined values in the parsed JSON
    expect(JSON.stringify(parsed)).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// Desktop session blockers
// ---------------------------------------------------------------------------

describe("desktop session blockers", () => {
  it("derives desktop-session-locked when loginwindow is frontmost", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      desktopSession: createDesktopSessionDiagnostics({
        state: "blocked",
        status: createDesktopSessionStatus({
          controllable: false,
          frontmostBundleId: "com.apple.loginwindow",
          frontmostProcessIdentifier: 591
        }),
        reason: "Desktop session is locked by loginwindow (pid 591)."
      })
    });

    const blocker = report.blockers[0];
    expect(blocker.type).toBe("desktop-session-locked");
    expect(blocker.severity).toBe("blocked");
    expect(blocker.detail).toContain("pid 591");
    expect(blocker.copyable).toContain("desktop-session-locked");
    expect(blocker.copyable).toContain("pid 591");
    expect(report.overallState).toBe("blocked");
  });

  it("derives desktop-session-asleep when mainDisplayAsleep is true", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      desktopSession: createDesktopSessionDiagnostics({
        state: "blocked",
        status: createDesktopSessionStatus({
          controllable: false,
          mainDisplayAsleep: true
        }),
        reason: "Main display is asleep."
      })
    });

    const blocker = report.blockers[0];
    expect(blocker.type).toBe("desktop-session-asleep");
    expect(blocker.severity).toBe("blocked");
    expect(report.overallState).toBe("blocked");
  });

  it("derives desktop-session-not-controllable when blocked without loginwindow", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      desktopSession: createDesktopSessionDiagnostics({
        state: "blocked",
        status: createDesktopSessionStatus({
          controllable: false,
          frontmostBundleId: "com.apple.Safari"
        }),
        reason: "Desktop session is not controllable."
      })
    });

    const blocker = report.blockers[0];
    expect(blocker.type).toBe("desktop-session-not-controllable");
    expect(blocker.severity).toBe("blocked");
  });

  it("derives desktop-session-unknown when state is unknown", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      desktopSession: createDesktopSessionDiagnostics({
        state: "unknown",
        status: null,
        reason: "Desktop session status is unknown."
      })
    });

    const section = report.sections.find((s) => s.id === "desktop-session");
    expect(section?.state).toBe("unknown");
    const blocker = section?.blockers[0];
    expect(blocker?.type).toBe("desktop-session-unknown");
    expect(blocker?.severity).toBe("unknown");
  });

  it("returns unknown section when desktop session data is absent", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      desktopSession: undefined
    });

    const section = report.sections.find((s) => s.id === "desktop-session");
    expect(section?.state).toBe("unknown");
    expect(section?.blockers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Permissions blockers
// ---------------------------------------------------------------------------

describe("permissions blockers", () => {
  it("derives screen-recording-denied when screen recording is denied", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      permissions: createPermissionDiagnostics({
        active: createPermissionSummary({
          screenRecording: { state: "denied" }
        })
      })
    });

    const blocker = report.blockers.find((b) => b.type === "screen-recording-denied");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
    expect(report.overallState).toBe("blocked");
  });

  it("derives screen-recording-not-determined when not yet requested", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      permissions: createPermissionDiagnostics({
        active: createPermissionSummary({
          screenRecording: { state: "not-determined" }
        })
      })
    });

    const blocker = report.blockers.find(
      (b) => b.type === "screen-recording-not-determined"
    );
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("action-required");
    expect(report.overallState).toBe("action-required");
  });

  it("derives screen-recording-unknown when state is unknown", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      permissions: createPermissionDiagnostics({
        active: createPermissionSummary({
          screenRecording: { state: "unknown" }
        })
      })
    });

    const blocker = report.blockers.find((b) => b.type === "screen-recording-unknown");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("unknown");
  });

  it("derives accessibility-denied when accessibility is denied", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      permissions: createPermissionDiagnostics({
        active: createPermissionSummary({
          accessibility: { state: "denied" }
        })
      })
    });

    const blocker = report.blockers.find((b) => b.type === "accessibility-denied");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
  });

  it("derives accessibility-not-determined when not yet requested", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      permissions: createPermissionDiagnostics({
        active: createPermissionSummary({
          accessibility: { state: "not-determined" }
        })
      })
    });

    const blocker = report.blockers.find(
      (b) => b.type === "accessibility-not-determined"
    );
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("action-required");
  });

  it("derives permission-mismatch when app and helper states differ", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      permissions: createPermissionDiagnostics({
        active: createPermissionSummary(),
        appProcess: createPermissionSummary({
          screenRecording: { state: "granted" }
        }),
        helperProcess: createPermissionSummary({
          screenRecording: { state: "denied" }
        }),
        mismatches: [
          {
            permission: "screenRecording",
            appProcess: "granted",
            helperProcess: "denied"
          }
        ]
      })
    });

    const blocker = report.blockers.find((b) => b.type === "permission-mismatch");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
    expect(blocker?.detail).toContain("granted");
    expect(blocker?.detail).toContain("denied");
    expect(blocker?.id).toBe("permission-mismatch-screenRecording");
  });

  it("returns unknown section when permissions data is absent", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      permissions: undefined
    });

    const section = report.sections.find((s) => s.id === "permissions");
    expect(section?.state).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Provider blockers
// ---------------------------------------------------------------------------

describe("provider blockers", () => {
  it("derives provider-unconfigured when readiness is unconfigured", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      providerStates: [
        createProviderState({
          selected: true,
          configured: false,
          readiness: "unconfigured"
        })
      ]
    });

    const blocker = report.blockers.find((b) => b.type === "provider-unconfigured");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("action-required");
    expect(report.overallState).toBe("action-required");
  });

  it("derives provider-unavailable when readiness is unavailable", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      providerStates: [
        createProviderState({
          readiness: "unavailable",
          readinessDetail: "Binary not found on PATH."
        })
      ]
    });

    const blocker = report.blockers.find((b) => b.type === "provider-unavailable");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
    expect(report.overallState).toBe("blocked");
  });

  it("derives provider-auth-blocked when readiness is auth-or-permission-blocked", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      providerStates: [
        createProviderState({
          readiness: "auth-or-permission-blocked",
          readinessDetail: "Authentication required."
        })
      ]
    });

    const blocker = report.blockers.find((b) => b.type === "provider-auth-blocked");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
  });

  it("derives provider-not-proven for version-ok readiness", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      providerStates: [
        createProviderState({
          readiness: "version-ok"
        })
      ]
    });

    const blocker = report.blockers.find((b) => b.type === "provider-not-proven");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("action-required");
  });

  it("derives provider-not-proven for binary-found readiness", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      providerStates: [
        createProviderState({
          readiness: "binary-found"
        })
      ]
    });

    const blocker = report.blockers.find((b) => b.type === "provider-not-proven");
    expect(blocker).toBeDefined();
  });

  it("derives provider-not-proven for binary-configured readiness", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      providerStates: [
        createProviderState({
          readiness: "binary-configured"
        })
      ]
    });

    const blocker = report.blockers.find((b) => b.type === "provider-not-proven");
    expect(blocker).toBeDefined();
  });

  it("returns unknown section when provider states are absent", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      providerStates: undefined
    });

    const section = report.sections.find((s) => s.id === "provider");
    expect(section?.state).toBe("unknown");
  });

  it("returns unknown section when provider states array is empty", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      providerStates: []
    });

    const section = report.sections.find((s) => s.id === "provider");
    expect(section?.state).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Chrome blockers
// ---------------------------------------------------------------------------

describe("chrome blockers", () => {
  it("derives chrome-native-host-missing when native host is missing", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        nativeHostState: "missing"
      })
    });

    const blocker = report.blockers.find((b) => b.type === "chrome-native-host-missing");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("action-required");
  });

  it("derives chrome-native-host-mismatched when native host is mismatched", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        nativeHostState: "mismatched"
      })
    });

    const blocker = report.blockers.find((b) => b.type === "chrome-native-host-mismatched");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
  });

  it("derives chrome-native-host-cli-missing when CLI is missing", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        nativeHostState: "cli-missing"
      })
    });

    const blocker = report.blockers.find((b) => b.type === "chrome-native-host-cli-missing");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
  });

  it("derives chrome-native-host-invalid when native host is invalid", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        nativeHostState: "invalid"
      })
    });

    const blocker = report.blockers.find((b) => b.type === "chrome-native-host-invalid");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
  });

  it("derives chrome-host-policy-invalid when host policy is invalid", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      chromeHostPolicy: createChromeHostPolicy({
        state: "invalid",
        reason: "Host policy JSON is malformed."
      })
    });

    const blocker = report.blockers.find((b) => b.type === "chrome-host-policy-invalid");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
  });

  it("derives chrome-extension-disconnected when connection is unknown and host installed", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        liveConnectionState: "unknown"
      })
    });

    const blocker = report.blockers.find((b) => b.type === "chrome-extension-disconnected");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
  });

  it("derives chrome-extension-stale when connection is stale", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        liveConnectionState: "stale"
      })
    });

    const blocker = report.blockers.find((b) => b.type === "chrome-extension-stale");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
  });

  it("derives chrome-extension-invalid when connection is invalid", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        liveConnectionState: "invalid"
      })
    });

    const blocker = report.blockers.find((b) => b.type === "chrome-extension-invalid");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
  });

  it("returns unknown section when browser readiness data is absent", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: undefined
    });

    const section = report.sections.find((s) => s.id === "chrome");
    expect(section?.state).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Browser context blockers
// ---------------------------------------------------------------------------

describe("browser context blockers", () => {
  const blockedStates = [
    "blocked",
    "blocked_by_host_policy",
    "blocked_by_chrome_host_permission",
    "sensitive-paused",
    "stale",
    "unavailable"
  ] as const;

  for (const state of blockedStates) {
    it(`derives browser-context-blocked for state "${state}"`, () => {
      const report = createDiagnosticReport({
        ...createAllReadyInput(),
        browserReadiness: createBrowserReadinessEvidence({
          browserContextState: state,
          reason: `Browser Context is ${state}.`,
          nextAction: "Resolve the blocker."
        })
      });

      const blocker = report.blockers.find((b) => b.type === "browser-context-blocked");
      expect(blocker).toBeDefined();
      expect(blocker?.severity).toBe("blocked");
      expect(blocker?.detail).toContain(state);
    });
  }

  it("derives browser-context-partial for state 'partial'", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        browserContextState: "partial",
        reason: "Browser Context is partially ready.",
        nextAction: "Resolve the capability blocker."
      })
    });

    const blocker = report.blockers.find((b) => b.type === "browser-context-partial");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("action-required");
  });

  it("derives browser-context-not-probed for state 'not-probed'", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        browserContextState: "not-probed",
        reason: "Browser Context has not been probed.",
        nextAction: "Probe Browser Context readiness."
      })
    });

    const blocker = report.blockers.find((b) => b.type === "browser-context-not-probed");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("action-required");
  });

  it("maps active_tab_unavailable to browser-context-partial", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      browserReadiness: createBrowserReadinessEvidence({
        browserContextState: "active_tab_unavailable",
        reason: "No eligible active tab.",
        nextAction: "Open a page in Chrome."
      })
    });

    const blocker = report.blockers.find((b) => b.type === "browser-context-partial");
    expect(blocker).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Finder automation blockers
// ---------------------------------------------------------------------------

describe("finder automation blockers", () => {
  it("derives finder-automation-denied when state is blocked", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      finderAutomation: createFinderAutomationReadiness({
        state: "blocked",
        code: "finder-automation-denied",
        reason: "macOS denied skfiy permission to control Finder.",
        nextAction: "Open Privacy & Security > Automation and allow skfiy to control Finder."
      })
    });

    const blocker = report.blockers.find((b) => b.type === "finder-automation-denied");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("blocked");
    expect(report.overallState).toBe("blocked");
  });

  it("derives finder-automation-not-tested when code is not-tested", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      finderAutomation: createFinderAutomationReadiness({
        state: "unknown",
        code: "finder-automation-not-tested",
        reason: "Finder Automation has not been tested from the pet yet.",
        nextAction: "Run the read-only Finder test."
      })
    });

    const blocker = report.blockers.find((b) => b.type === "finder-automation-not-tested");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("unknown");
  });

  it("derives finder-automation-test-failed when code is test-failed", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      finderAutomation: createFinderAutomationReadiness({
        state: "unknown",
        code: "finder-automation-test-failed",
        reason: "The read-only Finder Automation test did not complete.",
        nextAction: "Make sure Finder is available, then retry."
      })
    });

    const blocker = report.blockers.find((b) => b.type === "finder-automation-test-failed");
    expect(blocker).toBeDefined();
    expect(blocker?.severity).toBe("unknown");
  });

  it("returns unknown section when finder automation data is absent", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      finderAutomation: undefined
    });

    const section = report.sections.find((s) => s.id === "finder-automation");
    expect(section?.state).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Startup section
// ---------------------------------------------------------------------------

describe("startup section", () => {
  it("is ready when there are no warnings", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      startupWarnings: []
    });

    const section = report.sections.find((s) => s.id === "startup");
    expect(section?.state).toBe("ready");
    expect(section?.blockers).toEqual([]);
  });

  it("is action-required when there are warnings", () => {
    const warnings: StartupWarning[] = [
      {
        id: "dev-server",
        title: "正在使用开发入口",
        message: "Vite/Electron 调试入口只适合工程调试。"
      }
    ];

    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      startupWarnings: warnings
    });

    const section = report.sections.find((s) => s.id === "startup");
    expect(section?.state).toBe("action-required");
    expect(section?.summary).toContain("正在使用开发入口");
  });
});

// ---------------------------------------------------------------------------
// Blocker sorting and deduplication
// ---------------------------------------------------------------------------

describe("blocker aggregation", () => {
  it("flattens blockers from all sections and sorts by severity", () => {
    const report = createDiagnosticReport({
      permissions: createPermissionDiagnostics({
        active: createPermissionSummary({
          screenRecording: { state: "denied" },
          accessibility: { state: "not-determined" }
        })
      }),
      desktopSession: createDesktopSessionDiagnostics({
        state: "blocked",
        status: createDesktopSessionStatus({
          controllable: false,
          frontmostBundleId: "com.apple.loginwindow",
          frontmostProcessIdentifier: 591
        }),
        reason: "Desktop session is locked by loginwindow (pid 591)."
      }),
      providerStates: [
        createProviderState({
          readiness: "version-ok"
        })
      ],
      browserReadiness: createBrowserReadinessEvidence(),
      chromeHostPolicy: createChromeHostPolicy(),
      finderAutomation: createFinderAutomationReadiness(),
      startupWarnings: []
    });

    // 2 blocked (desktop-session-locked, screen-recording-denied)
    // 2 action-required (accessibility-not-determined, provider-not-proven)
    expect(report.blockers.length).toBeGreaterThanOrEqual(4);

    const severities = report.blockers.map((b) => b.severity);
    const blockedIndex = severities.indexOf("blocked");
    const actionRequiredIndex = severities.indexOf("action-required");
    expect(blockedIndex).toBeGreaterThanOrEqual(0);
    expect(actionRequiredIndex).toBeGreaterThan(blockedIndex);
  });

  it("deduplicates blockers by id", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      permissions: createPermissionDiagnostics({
        active: createPermissionSummary(),
        appProcess: createPermissionSummary(),
        helperProcess: createPermissionSummary(),
        mismatches: [
          {
            permission: "screenRecording",
            appProcess: "granted",
            helperProcess: "denied"
          }
        ]
      })
    });

    const mismatchBlockers = report.blockers.filter(
      (b) => b.type === "permission-mismatch"
    );
    expect(mismatchBlockers).toHaveLength(1);
    expect(mismatchBlockers[0].id).toBe("permission-mismatch-screenRecording");
  });

  it("includes copyable field on every blocker", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      desktopSession: createDesktopSessionDiagnostics({
        state: "blocked",
        status: createDesktopSessionStatus({
          controllable: false,
          frontmostBundleId: "com.apple.loginwindow",
          frontmostProcessIdentifier: 591
        }),
        reason: "Desktop session is locked by loginwindow (pid 591)."
      })
    });

    for (const blocker of report.blockers) {
      expect(blocker.copyable).toContain(blocker.type);
      expect(blocker.copyable).toContain(blocker.detail);
      expect(blocker.copyable).toContain(blocker.nextAction);
    }
  });
});

// ---------------------------------------------------------------------------
// Component versions
// ---------------------------------------------------------------------------

describe("readComponentVersions", () => {
  function createIo(overrides: Partial<ComponentVersionIo> = {}): ComponentVersionIo {
    return {
      execFile: async () => ({ stdout: "skfiy 0.1.0\n", stderr: "" }),
      readFile: async () => "",
      exists: async () => true,
      ...overrides
    };
  }

  const baseOptions = {
    appVersion: "0.1.0",
    cliShimPath: "/app/dist/skfiy",
    helperInfoPlistPath: "/app/macos-helper/Sources/skfiy-helper/Info.plist",
    extensionManifestPath: "/app/chrome-extension/manifest.json",
    nativeHostManifestPath: "/home/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sskift.skfiy.json",
    providerStates: [createProviderState({ version: "0.1.0" })]
  };

  it("collects all six component versions", async () => {
    const io = createIo({
      readFile: async (filePath: string) => {
        if (filePath.endsWith("Info.plist")) {
          return '<key>CFBundleShortVersionString</key><string>0.1.0</string>';
        }
        if (filePath.endsWith("manifest.json")) {
          return JSON.stringify({ version: "0.0.16" });
        }
        return "";
      }
    });

    const versions = await readComponentVersions({ ...baseOptions, io });

    expect(versions).toHaveLength(6);
    const components = versions.map((v) => v.component);
    expect(components).toEqual([
      "app",
      "cli",
      "helper",
      "provider",
      "chrome-extension",
      "native-host"
    ]);
  });

  it("reports app version from electron app.getVersion", async () => {
    const versions = await readComponentVersions({ ...baseOptions, io: createIo() });
    const app = versions.find((v) => v.component === "app");
    expect(app?.version).toBe("0.1.0");
    expect(app?.source).toBe("electron-app.getVersion");
    expect(app?.state).toBe("available");
  });

  it("probes CLI version from shim --version", async () => {
    const versions = await readComponentVersions({ ...baseOptions, io: createIo() });
    const cli = versions.find((v) => v.component === "cli");
    expect(cli?.version).toBe("0.1.0");
    expect(cli?.source).toBe("cli-shim --version");
    expect(cli?.state).toBe("available");
  });

  it("reports CLI as missing when shim does not exist", async () => {
    const io = createIo({
      exists: async (filePath: string) => !filePath.includes("skfiy") || filePath.endsWith(".json") || filePath.endsWith(".plist")
    });
    const versions = await readComponentVersions({ ...baseOptions, io });
    const cli = versions.find((v) => v.component === "cli");
    expect(cli?.state).toBe("missing");
    expect(cli?.version).toBeNull();
  });

  it("reports CLI as unknown when probe fails", async () => {
    const io = createIo({
      execFile: async () => {
        throw new Error("probe failed");
      }
    });
    const versions = await readComponentVersions({ ...baseOptions, io });
    const cli = versions.find((v) => v.component === "cli");
    expect(cli?.state).toBe("unknown");
    expect(cli?.version).toBeNull();
  });

  it("reads helper version from Info.plist", async () => {
    const io = createIo({
      readFile: async (filePath: string) => {
        if (filePath.endsWith("Info.plist")) {
          return `<?xml version="1.0"?>
<plist>
<dict>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
</dict>
</plist>`;
        }
        return "";
      }
    });
    const versions = await readComponentVersions({ ...baseOptions, io });
    const helper = versions.find((v) => v.component === "helper");
    expect(helper?.version).toBe("0.1.0");
    expect(helper?.source).toBe("helper-Info.plist");
    expect(helper?.state).toBe("available");
  });

  it("reports helper as missing when Info.plist does not exist", async () => {
    const io = createIo({
      exists: async (filePath: string) => !filePath.endsWith("Info.plist")
    });
    const versions = await readComponentVersions({ ...baseOptions, io });
    const helper = versions.find((v) => v.component === "helper");
    expect(helper?.state).toBe("missing");
    expect(helper?.version).toBeNull();
  });

  it("reports provider version from selected provider state", async () => {
    const versions = await readComponentVersions({ ...baseOptions, io: createIo() });
    const provider = versions.find((v) => v.component === "provider");
    expect(provider?.version).toBe("0.1.0");
    expect(provider?.source).toBe("codex --version");
    expect(provider?.state).toBe("available");
    expect(provider?.detail).toContain("codex");
  });

  it("reports provider as unknown when no provider is selected", async () => {
    const versions = await readComponentVersions({
      ...baseOptions,
      providerStates: [createProviderState({ selected: false })],
      io: createIo()
    });
    const provider = versions.find((v) => v.component === "provider");
    expect(provider?.state).toBe("unknown");
    expect(provider?.version).toBeNull();
  });

  it("reads chrome extension version from manifest.json", async () => {
    const io = createIo({
      readFile: async (filePath: string) => {
        if (filePath.endsWith("manifest.json")) {
          return JSON.stringify({ name: "skfiy Chrome Adapter", version: "0.0.16" });
        }
        return "";
      }
    });
    const versions = await readComponentVersions({ ...baseOptions, io });
    const extension = versions.find((v) => v.component === "chrome-extension");
    expect(extension?.version).toBe("0.0.16");
    expect(extension?.source).toBe("chrome-extension/manifest.json");
    expect(extension?.state).toBe("available");
  });

  it("reports native host as available when manifest exists", async () => {
    const versions = await readComponentVersions({ ...baseOptions, io: createIo() });
    const nativeHost = versions.find((v) => v.component === "native-host");
    expect(nativeHost?.state).toBe("available");
    expect(nativeHost?.version).toBeNull();
    expect(nativeHost?.source).toBe("native-host-manifest");
  });

  it("reports native host as missing when manifest does not exist", async () => {
    const io = createIo({
      exists: async (filePath: string) => !filePath.includes("NativeMessagingHosts")
    });
    const versions = await readComponentVersions({ ...baseOptions, io });
    const nativeHost = versions.find((v) => v.component === "native-host");
    expect(nativeHost?.state).toBe("missing");
    expect(nativeHost?.version).toBeNull();
  });

  it("never throws on any probe failure", async () => {
    const io = createIo({
      execFile: async () => {
        throw new Error("exec failed");
      },
      readFile: async () => {
        throw new Error("read failed");
      },
      exists: async () => {
        throw new Error("exists failed");
      }
    });

    const versions = await readComponentVersions({ ...baseOptions, io });
    expect(versions).toHaveLength(6);
    for (const v of versions) {
      expect(["available", "missing", "unknown"]).toContain(v.state);
    }
  });
});

// ---------------------------------------------------------------------------
// Export preview
// ---------------------------------------------------------------------------

describe("exportPreview", () => {
  it("includes the overall state and section summaries", () => {
    const report = createDiagnosticReport(createAllReadyInput());

    expect(report.exportPreview).toContain("Overall State: ready");
    expect(report.exportPreview).toContain("[desktop-session] ready");
    expect(report.exportPreview).toContain("[permissions] ready");
    expect(report.exportPreview).toContain("Component Versions");
    expect(report.exportPreview).toContain("Redactions");
  });

  it("includes blocker details in the export", () => {
    const report = createDiagnosticReport({
      ...createAllReadyInput(),
      desktopSession: createDesktopSessionDiagnostics({
        state: "blocked",
        status: createDesktopSessionStatus({
          controllable: false,
          frontmostBundleId: "com.apple.loginwindow",
          frontmostProcessIdentifier: 591
        }),
        reason: "Desktop session is locked by loginwindow (pid 591)."
      })
    });

    expect(report.exportPreview).toContain("desktop-session-locked");
    expect(report.exportPreview).toContain("pid 591");
    expect(report.exportPreview).toContain("Blockers (sorted by severity)");
  });

  it("is the exact string that would be exported", () => {
    const report = createDiagnosticReport(createAllReadyInput());
    // The exportPreview is generated by the main process and is the exact
    // string the renderer would write to a file or clipboard.
    expect(typeof report.exportPreview).toBe("string");
    expect(report.exportPreview.length).toBeGreaterThan(0);
    // Verify it's stable (re-rendering produces the same string)
    const { exportPreview: _omit, ...rest } = report;
    expect(renderDiagnosticReportExport(rest)).toBe(report.exportPreview);
  });
});

// ---------------------------------------------------------------------------
// readDiagnosticReportForRenderer
// ---------------------------------------------------------------------------

describe("readDiagnosticReportForRenderer", () => {
  it("assembles a report from all sources", async () => {
    const sources: DiagnosticReportSources = {
      readPermissions: async () => createPermissionDiagnostics(),
      readDesktopSession: async () => createDesktopSessionDiagnostics(),
      readBrowserReadiness: async () => createBrowserReadinessEvidence(),
      readChromeHostPolicy: async () => createChromeHostPolicy(),
      readFinderAutomation: async () => createFinderAutomationReadiness(),
      readProviderStates: async () => [createProviderState()],
      readStartupWarnings: async () => [],
      readComponentVersions: async () => []
    };

    const report = await readDiagnosticReportForRenderer({ sources });
    expect(report.overallState).toBe("ready");
    expect(report.sections).toHaveLength(7);
  });

  it("falls back to unknown sections when a source throws", async () => {
    const messages: string[] = [];
    const sources: DiagnosticReportSources = {
      readPermissions: async () => {
        throw new Error("permissions unavailable");
      },
      readDesktopSession: async () => createDesktopSessionDiagnostics(),
      readBrowserReadiness: async () => createBrowserReadinessEvidence(),
      readChromeHostPolicy: async () => createChromeHostPolicy(),
      readFinderAutomation: async () => createFinderAutomationReadiness(),
      readProviderStates: async () => [createProviderState()],
      readStartupWarnings: async () => [],
      readComponentVersions: async () => []
    };

    const report = await readDiagnosticReportForRenderer({
      sources,
      onError: (msg) => messages.push(msg)
    });

    const permissionsSection = report.sections.find((s) => s.id === "permissions");
    expect(permissionsSection?.state).toBe("unknown");
    expect(messages.some((m) => m.includes("permissions unavailable"))).toBe(true);
    // Other sections should still be ready
    const desktopSection = report.sections.find((s) => s.id === "desktop-session");
    expect(desktopSection?.state).toBe("ready");
  });

  it("returns unknown report when all sources are absent", async () => {
    const report = await readDiagnosticReportForRenderer({ sources: {} });
    expect(report.overallState).toBe("unknown");
    for (const section of report.sections) {
      expect(section.state).toBe("unknown");
    }
  });

  it("returns unknown report when assembly throws", async () => {
    const sources: DiagnosticReportSources = {
      readPermissions: async () => {
        throw new Error("fatal");
      }
    };

    const report = await readDiagnosticReportForRenderer({ sources });
    expect(report.overallState).toBe("unknown");
    expect(report.schemaVersion).toBe(1);
  });
});
