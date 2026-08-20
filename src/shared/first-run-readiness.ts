export const FIRST_RUN_READINESS_STEP_ORDER = [
  "background-agent",
  "screen-recording",
  "accessibility",
  "finder-automation",
  "browser-context"
] as const;

export const FIRST_RUN_READINESS_REQUIREMENTS = [
  "required-for-chat",
  "computer-use",
  "optional"
] as const;

export const FIRST_RUN_READINESS_STATES = [
  "ready",
  "action-required",
  "blocked",
  "unknown"
] as const;

export const FIRST_RUN_READY_WORKFLOW_ORDER = [
  "chat",
  "computer-use",
  "finder",
  "browser-context"
] as const;

export type FirstRunReadinessStepId = typeof FIRST_RUN_READINESS_STEP_ORDER[number];
export type FirstRunReadinessRequirement = typeof FIRST_RUN_READINESS_REQUIREMENTS[number];
export type FirstRunReadinessState = typeof FIRST_RUN_READINESS_STATES[number];
export type FirstRunReadyWorkflow = typeof FIRST_RUN_READY_WORKFLOW_ORDER[number];

export type FirstRunProviderReadiness =
  | "chat-ready"
  | "version-ok"
  | "binary-found"
  | "binary-configured"
  | "auth-or-permission-blocked"
  | "unconfigured"
  | "unavailable"
  | "unknown";

export type FirstRunPermissionState =
  | "granted"
  | "denied"
  | "not-determined"
  | "unknown";

export type FirstRunDesktopSessionState = "controllable" | "blocked" | "unknown";
export type FirstRunFinderEvidenceState = "proven-by-test" | "blocked" | "unknown";

export type FirstRunChromeNativeHostState =
  | "installed"
  | "missing"
  | "mismatched"
  | "cli-missing"
  | "invalid"
  | "unknown";

export type FirstRunChromeLiveConnectionState =
  | "connected"
  | "stale"
  | "disconnected"
  | "invalid"
  | "unknown";

export type FirstRunBrowserContextState =
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
  | "unavailable"
  | "unknown";

export type FirstRunChromeCompatibilityState =
  | "compatible"
  | "extension_outdated"
  | "extension_untested"
  | "unknown";

export interface FirstRunChromeCompatibility {
  state: FirstRunChromeCompatibilityState;
  extensionVersion?: string | null;
  minVersion?: string;
  reason?: string;
}

interface FirstRunReadinessStepBase {
  id: FirstRunReadinessStepId;
  requirement: FirstRunReadinessRequirement;
  /**
   * Optional non-blocking warning line rendered under the step. Used by the
   * browser-context step to surface extension compatibility warnings without
   * changing the step state (browser-context is an optional step).
   */
  warning?: string;
}

export interface FirstRunReadyStep extends FirstRunReadinessStepBase {
  state: "ready";
  reason?: never;
  nextAction?: never;
}

export interface FirstRunNonReadyStep extends FirstRunReadinessStepBase {
  state: Exclude<FirstRunReadinessState, "ready">;
  reason: string;
  nextAction: string;
}

export type FirstRunReadinessStep = FirstRunReadyStep | FirstRunNonReadyStep;

export interface FirstRunReadinessInput {
  providerReadiness?: FirstRunProviderReadiness;
  permissions?: {
    screenRecording?: FirstRunPermissionState;
    accessibility?: FirstRunPermissionState;
  };
  desktopSession?: {
    state?: FirstRunDesktopSessionState;
    reason?: string;
  };
  finderAutomation?: {
    state?: FirstRunFinderEvidenceState;
    reason?: string;
    nextAction?: string;
  };
  chrome?: {
    nativeHostState?: FirstRunChromeNativeHostState;
    liveConnectionState?: FirstRunChromeLiveConnectionState;
    browserContext?: {
      state?: FirstRunBrowserContextState;
      reason?: string;
      nextAction?: string;
    };
    compatibility?: FirstRunChromeCompatibility;
  };
  previousResumeStepId?: FirstRunReadinessStepId;
}

export interface FirstRunReadinessSnapshot {
  schemaVersion: 1;
  chatReady: boolean;
  computerUseReady: boolean;
  readyWorkflows: FirstRunReadyWorkflow[];
  resumeStepId: FirstRunReadinessStepId | null;
  steps: FirstRunReadinessStep[];
}

const STEP_REQUIREMENTS: Record<FirstRunReadinessStepId, FirstRunReadinessRequirement> = {
  "background-agent": "required-for-chat",
  "screen-recording": "computer-use",
  accessibility: "computer-use",
  "finder-automation": "optional",
  "browser-context": "optional"
};

export function createFirstRunReadinessSnapshot(
  input: FirstRunReadinessInput
): FirstRunReadinessSnapshot {
  const backgroundAgent = createBackgroundAgentStep(input.providerReadiness ?? "unknown");
  const screenRecording = createPermissionStep(
    "screen-recording",
    "Screen Recording",
    input.permissions?.screenRecording ?? "unknown"
  );
  const accessibilityPermission = createPermissionStep(
    "accessibility",
    "Accessibility",
    input.permissions?.accessibility ?? "unknown"
  );
  const accessibility = addDesktopSessionReadiness(
    accessibilityPermission,
    input.desktopSession
  );
  const finderAutomation = createFinderAutomationStep(input.finderAutomation);
  const browserContext = createBrowserContextStep(input.chrome);
  const steps: FirstRunReadinessStep[] = [
    backgroundAgent,
    screenRecording,
    accessibility,
    finderAutomation,
    browserContext
  ];
  const chatReady = backgroundAgent.state === "ready";
  const computerUseReady = screenRecording.state === "ready" && accessibility.state === "ready";
  const readyWorkflows: FirstRunReadyWorkflow[] = [
    ...(chatReady ? ["chat" as const] : []),
    ...(computerUseReady ? ["computer-use" as const] : []),
    ...(computerUseReady && finderAutomation.state === "ready" ? ["finder" as const] : []),
    ...(browserContext.state === "ready" ? ["browser-context" as const] : [])
  ];

  return {
    schemaVersion: 1,
    chatReady,
    computerUseReady,
    readyWorkflows,
    resumeStepId: readResumeStepId(steps, input.previousResumeStepId),
    steps
  };
}

function createBackgroundAgentStep(
  readiness: FirstRunProviderReadiness
): FirstRunReadinessStep {
  if (readiness === "chat-ready") {
    return createReadyStep("background-agent");
  }

  if (readiness === "auth-or-permission-blocked") {
    return createNonReadyStep(
      "background-agent",
      "blocked",
      "Background Agent authentication or permission is blocked.",
      "Sign in to the selected Background Agent, then retry the safe test turn."
    );
  }

  if (readiness === "unavailable") {
    return createNonReadyStep(
      "background-agent",
      "blocked",
      "The selected Background Agent is unavailable.",
      "Install or repair the selected Background Agent, then retry provider discovery."
    );
  }

  if (readiness === "unconfigured") {
    return createNonReadyStep(
      "background-agent",
      "action-required",
      "No Background Agent is configured.",
      "Select and configure a Background Agent."
    );
  }

  if (
    readiness === "version-ok"
    || readiness === "binary-found"
    || readiness === "binary-configured"
  ) {
    return createNonReadyStep(
      "background-agent",
      "action-required",
      "Background Agent chat readiness has not been proven by a safe test turn.",
      "Run a safe Background Agent test turn."
    );
  }

  return createNonReadyStep(
    "background-agent",
    "unknown",
    "Background Agent readiness is unknown.",
    "Refresh Background Agent discovery and run a safe test turn."
  );
}

function createPermissionStep(
  id: "screen-recording" | "accessibility",
  label: "Screen Recording" | "Accessibility",
  state: FirstRunPermissionState
): FirstRunReadinessStep {
  if (state === "granted") {
    return createReadyStep(id);
  }

  if (state === "denied") {
    return createNonReadyStep(
      id,
      "blocked",
      `${label} permission is denied.`,
      `Open ${label} settings and grant skfiy access.`
    );
  }

  if (state === "not-determined") {
    return createNonReadyStep(
      id,
      "action-required",
      `${label} permission has not been requested.`,
      `Open ${label} settings and grant skfiy access.`
    );
  }

  return createNonReadyStep(
    id,
    "unknown",
    `${label} permission has not been checked.`,
    "Refresh macOS permission status."
  );
}

function addDesktopSessionReadiness(
  accessibility: FirstRunReadinessStep,
  desktopSession: FirstRunReadinessInput["desktopSession"]
): FirstRunReadinessStep {
  if (accessibility.state !== "ready") {
    return accessibility;
  }

  if (desktopSession?.state === "controllable") {
    return accessibility;
  }

  if (desktopSession?.state === "blocked") {
    return createNonReadyStep(
      "accessibility",
      "blocked",
      sanitizeReadinessText(desktopSession.reason) ?? "Desktop session is blocked.",
      "Wake and unlock the Mac, then retry Computer Use."
    );
  }

  return createNonReadyStep(
    "accessibility",
    "unknown",
    sanitizeReadinessText(desktopSession?.reason) ?? "Desktop session status is unknown.",
    "Refresh desktop session status before using Computer Use."
  );
}

function createFinderAutomationStep(
  finderAutomation: FirstRunReadinessInput["finderAutomation"]
): FirstRunReadinessStep {
  if (finderAutomation?.state === "proven-by-test") {
    return createReadyStep("finder-automation");
  }

  if (finderAutomation?.state === "blocked") {
    return createNonReadyStep(
      "finder-automation",
      "blocked",
      sanitizeReadinessText(finderAutomation.reason)
        ?? "Finder Automation is blocked by the latest readiness test.",
      sanitizeReadinessText(finderAutomation.nextAction)
        ?? "Resolve the Finder blocker, then rerun the Finder Automation readiness test."
    );
  }

  return createNonReadyStep(
    "finder-automation",
    "unknown",
    sanitizeReadinessText(finderAutomation?.reason)
      ?? "Finder Automation readiness has not been proven by a test.",
    sanitizeReadinessText(finderAutomation?.nextAction)
      ?? "Run the Finder Automation readiness test."
  );
}

function createBrowserContextStep(
  chrome: FirstRunReadinessInput["chrome"]
): FirstRunReadinessStep {
  const nativeHostState = chrome?.nativeHostState ?? "unknown";

  if (nativeHostState === "unknown") {
    return withChromeCompatibilityWarning(
      createNonReadyStep(
        "browser-context",
        "unknown",
        "Chrome Native Messaging host status is unknown.",
        "Refresh Chrome setup status."
      ),
      chrome?.compatibility
    );
  }

  if (nativeHostState === "missing") {
    return withChromeCompatibilityWarning(
      createNonReadyStep(
        "browser-context",
        "action-required",
        "Chrome Native Messaging host is not installed.",
        "Install the skfiy Chrome Native Messaging host."
      ),
      chrome?.compatibility
    );
  }

  if (nativeHostState !== "installed") {
    const reasonByState: Record<Exclude<FirstRunChromeNativeHostState, "installed" | "missing" | "unknown">, string> = {
      mismatched: "Chrome Native Messaging host does not match the current skfiy build.",
      "cli-missing": "Chrome Native Messaging host cannot find the packaged skfiy CLI.",
      invalid: "Chrome Native Messaging host configuration is invalid."
    };

    return withChromeCompatibilityWarning(
      createNonReadyStep(
        "browser-context",
        "blocked",
        reasonByState[nativeHostState],
        "Repair the skfiy Chrome Native Messaging host installation."
      ),
      chrome?.compatibility
    );
  }

  const liveConnectionState = chrome?.liveConnectionState ?? "unknown";

  if (liveConnectionState === "unknown") {
    return withChromeCompatibilityWarning(
      createNonReadyStep(
        "browser-context",
        "unknown",
        "Chrome extension connection status is unknown.",
        "Refresh Chrome extension connection status."
      ),
      chrome?.compatibility
    );
  }

  if (liveConnectionState === "stale") {
    return withChromeCompatibilityWarning(
      createNonReadyStep(
        "browser-context",
        "blocked",
        "Chrome extension connection is stale.",
        "Refresh the skfiy Chrome extension connection."
      ),
      chrome?.compatibility
    );
  }

  if (liveConnectionState === "disconnected") {
    return withChromeCompatibilityWarning(
      createNonReadyStep(
        "browser-context",
        "blocked",
        "Chrome extension is not connected.",
        "Open Chrome and connect the skfiy extension."
      ),
      chrome?.compatibility
    );
  }

  if (liveConnectionState === "invalid") {
    return withChromeCompatibilityWarning(
      createNonReadyStep(
        "browser-context",
        "blocked",
        "Chrome extension connection evidence is invalid.",
        "Reload the skfiy Chrome extension, then refresh connection status."
      ),
      chrome?.compatibility
    );
  }

  return withChromeCompatibilityWarning(
    createBrowserPageContextStep(chrome?.browserContext),
    chrome?.compatibility
  );
}

/**
 * Attach a non-blocking compatibility warning to the browser-context step
 * when the extension is outdated or its version is unknown. The warning
 * never changes the step state, so it cannot block chat/computer-use
 * readiness.
 */
function withChromeCompatibilityWarning(
  step: FirstRunReadinessStep,
  compatibility: FirstRunChromeCompatibility | undefined
): FirstRunReadinessStep {
  const warning = readChromeCompatibilityWarning(compatibility);

  return warning ? { ...step, warning } : step;
}

function readChromeCompatibilityWarning(
  compatibility: FirstRunChromeCompatibility | undefined
): string | undefined {
  if (!compatibility) {
    return undefined;
  }

  if (compatibility.state === "extension_outdated") {
    const extensionVersion = compatibility.extensionVersion ?? "unknown";
    const minVersion = compatibility.minVersion ?? "a newer";
    return sanitizeReadinessText(compatibility.reason)
      ?? `Chrome extension v${extensionVersion} is older than the minimum supported v${minVersion}. Reload the unpacked extension from chrome-extension/ to update.`;
  }

  if (compatibility.state === "unknown") {
    return sanitizeReadinessText(compatibility.reason)
      ?? "Chrome extension version is unknown, so compatibility cannot be verified. Reload the unpacked extension from chrome-extension/ to update.";
  }

  return undefined;
}

function createBrowserPageContextStep(
  browserContext: NonNullable<FirstRunReadinessInput["chrome"]>["browserContext"]
): FirstRunReadinessStep {
  const state = browserContext?.state ?? "unknown";

  if (state === "ready") {
    return createReadyStep("browser-context");
  }

  const suppliedReason = sanitizeReadinessText(browserContext?.reason);
  const suppliedNextAction = sanitizeReadinessText(browserContext?.nextAction);

  if (state === "blocked_by_host_policy") {
    return createNonReadyStep(
      "browser-context",
      "blocked",
      suppliedReason ?? "The active Chrome host is blocked by skfiy host policy.",
      suppliedNextAction ?? "Approve the active host for the current turn."
    );
  }

  if (state === "blocked_by_chrome_host_permission") {
    return createNonReadyStep(
      "browser-context",
      "blocked",
      suppliedReason ?? "Chrome has not granted site access for the active page.",
      suppliedNextAction ?? "Grant site access from the skfiy extension popup."
    );
  }

  if (state === "partial") {
    return createNonReadyStep(
      "browser-context",
      "action-required",
      suppliedReason ?? "Browser Context is only partially ready for the active page.",
      suppliedNextAction ?? "Resolve the reported Browser Context capability blocker."
    );
  }

  if (state === "active_tab_unavailable") {
    return createNonReadyStep(
      "browser-context",
      "action-required",
      suppliedReason ?? "Chrome does not have an eligible active tab.",
      suppliedNextAction ?? "Open an http or https page in Chrome and retry Browser Context."
    );
  }

  if (state === "content_script_not_loaded" || state === "not_loaded") {
    return createNonReadyStep(
      "browser-context",
      "action-required",
      suppliedReason ?? "The skfiy Chrome content script is not loaded for the active page.",
      suppliedNextAction ?? "Reload the active page and refresh the skfiy Chrome extension."
    );
  }

  if (state === "not-probed") {
    return createNonReadyStep(
      "browser-context",
      "action-required",
      suppliedReason ?? "Browser Context readiness has not been probed for the active page.",
      suppliedNextAction ?? "Probe Browser Context readiness from the skfiy Chrome extension."
    );
  }

  if (state === "missing") {
    return createNonReadyStep(
      "browser-context",
      "action-required",
      suppliedReason ?? "Browser Context has not observed an eligible Chrome page.",
      suppliedNextAction ?? "Open an http or https page in Chrome and refresh the skfiy extension."
    );
  }

  if (state === "sensitive-paused") {
    return createNonReadyStep(
      "browser-context",
      "blocked",
      suppliedReason ?? "Browser Context is paused for a sensitive page.",
      suppliedNextAction ?? "Leave the sensitive page or explicitly resume Browser Context."
    );
  }

  if (state === "stale") {
    return createNonReadyStep(
      "browser-context",
      "blocked",
      suppliedReason ?? "Browser Context for the active page is stale.",
      suppliedNextAction ?? "Refresh Browser Context from the skfiy Chrome extension."
    );
  }

  if (state === "blocked" || state === "unavailable") {
    return createNonReadyStep(
      "browser-context",
      "blocked",
      suppliedReason ?? "Browser Context is unavailable for the active page.",
      suppliedNextAction ?? "Resolve the reported Browser Context blocker, then retry."
    );
  }

  return createNonReadyStep(
    "browser-context",
    "unknown",
    suppliedReason ?? "Browser Context readiness is unknown.",
    suppliedNextAction ?? "Refresh Browser Context readiness."
  );
}

function createReadyStep(id: FirstRunReadinessStepId): FirstRunReadyStep {
  return {
    id,
    requirement: STEP_REQUIREMENTS[id],
    state: "ready"
  };
}

function createNonReadyStep(
  id: FirstRunReadinessStepId,
  state: Exclude<FirstRunReadinessState, "ready">,
  reason: string,
  nextAction: string
): FirstRunNonReadyStep {
  return {
    id,
    requirement: STEP_REQUIREMENTS[id],
    state,
    reason,
    nextAction
  };
}

function readResumeStepId(
  steps: FirstRunReadinessStep[],
  previousResumeStepId: FirstRunReadinessStepId | undefined
): FirstRunReadinessStepId | null {
  if (
    previousResumeStepId
    && steps.some((step) => step.id === previousResumeStepId && step.state !== "ready")
  ) {
    return previousResumeStepId;
  }

  return steps.find((step) => step.state !== "ready")?.id ?? null;
}

function sanitizeReadinessText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed
    .slice(0, 500)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b((?:api[_-]?key|authorization|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/https?:\/\/[^\s,;)'\"]+/g, "[page]")
    .replace(/file:\/\/\/[^\s,;)'\"]+/g, "[local path]")
    .replace(/(^|[\s(`'\"])\/[^\s,;)'\"]+/g, "$1[local path]")
    .replace(/[A-Za-z]:\\[^\s,;)'\"]+/g, "[local path]");
}
