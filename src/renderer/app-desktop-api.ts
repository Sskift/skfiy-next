import type { DesktopApi } from "./app-types";
import type { BrowserContextSourceSnapshot } from "../shared/browser-context-source.js";
import {
  DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  createDefaultAutomationMonitorPreview
} from "./app-automation-state";
import { DEFAULT_AUTOMATION_RUN_SNAPSHOT } from "./app-automation-run-state";
import {
  DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT,
  DEFAULT_PERSONAL_MEMORY_SETTINGS
} from "./app-memory-state";
import {
  UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS,
  UNKNOWN_PERMISSIONS
} from "./app-permission-state";
import {
  DEFAULT_APP_POLICY_SETTINGS,
  DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
  DEFAULT_PLANNER_PROVIDER_SETTINGS,
  reduceAppPolicySettings,
  reduceAssistantAgentSettingsResponse,
  reducePlannerProviderSettings
} from "./app-settings-state";
import { DEFAULT_PROFILE_RUNTIME_SNAPSHOT } from "./app-profile-state";

declare global {
  interface Window {
    skfiy?: DesktopApi;
  }
}

const DEFAULT_BROWSER_CONTEXT_SOURCE_SNAPSHOT: BrowserContextSourceSnapshot = {
  schemaVersion: 1,
  selectedTab: null,
  contextState: "missing",
  paused: false,
  disconnected: false,
  clearedForTurn: false,
  blockers: [],
  eligibleTabCount: 0,
  discoveryState: "not-probed",
  generatedAt: new Date(0).toISOString()
};

export const fallbackDesktopApi: DesktopApi = {
  runCommand: async () => undefined,
  approveTask: async () => undefined,
  denyTask: async () => undefined,
  prepareTaskRecovery: async () => ({
    state: "rejected",
    code: "recovery-unknown",
    message: "Task recovery is unavailable in this renderer environment."
  }),
  dispatchTaskRecovery: async () => ({
    state: "rejected",
    code: "recovery-dispatch-unavailable",
    message: "Task recovery dispatch is unavailable in this renderer environment."
  }),
  takeScreenshot: async () => undefined,
  stopTask: async () => undefined,
  getPermissions: async () => UNKNOWN_PERMISSIONS,
  getPermissionDiagnostics: async () => ({
    active: UNKNOWN_PERMISSIONS,
    appProcess: UNKNOWN_PERMISSIONS,
    helperProcess: UNKNOWN_PERMISSIONS,
    mismatches: [],
    identity: {
      appPath: "",
      executablePath: "",
      helperPath: "",
      resourcesPath: "",
      isPackaged: false
    }
  }),
  getDesktopSessionDiagnostics: async () => UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS,
  openPermissionSettings: async () => undefined,
  getStartupWarnings: async () => [],
  getAppPolicySettings: async () => DEFAULT_APP_POLICY_SETTINGS,
  setAppPolicy: async (update) => reduceAppPolicySettings(DEFAULT_APP_POLICY_SETTINGS, update),
  getAssistantAgentSettings: async () => DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
  setAssistantAgentSettings: async (update) =>
    reduceAssistantAgentSettingsResponse(DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE, update),
  testAssistantAgentProvider: async (input) => {
    const provider = DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE.providers.find(
      (candidate) => candidate.id === input.mode
    );
    if (provider) {
      return provider;
    }
    throw new Error("Unknown assistant agent provider mode.");
  },
  getPlannerProviderSettings: async () => DEFAULT_PLANNER_PROVIDER_SETTINGS,
  setPlannerProviderSettings: async (update) =>
    reducePlannerProviderSettings(DEFAULT_PLANNER_PROVIDER_SETTINGS, update),
  getTurnReplay: async () => null,
  getAutomationMonitors: async () => DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  upsertTmuxMonitor: async () => DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  duplicateAutomationMonitor: async () => DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  runAutomationMonitorNow: async () => DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  setAutomationMonitorEnabled: async () => DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  deleteAutomationMonitor: async () => DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  previewTmuxAutomation: async () => createDefaultAutomationMonitorPreview(),
  getAutomationRuns: async () => DEFAULT_AUTOMATION_RUN_SNAPSHOT,
  stopAutomationRun: async () => DEFAULT_AUTOMATION_RUN_SNAPSHOT,
  getRuntimeStatus: async () => ({
    stopTurnHotkey: {
      accelerator: "",
      label: "",
      registered: false
    }
  }),
  getPetSkin: async () => null,
  importPetSkin: async () => null,
  resetPetSkin: async () => undefined,
  getWindowBounds: async () => null,
  moveWindowBy: () => undefined,
  setWindowMode: () => undefined,
  onStopTurnHotkey: () => () => undefined,
  onTaskEvent: () => () => undefined,
  getFirstRunReadiness: async () => ({
    schemaVersion: 1,
    chatReady: false,
    computerUseReady: false,
    readyWorkflows: [],
    resumeStepId: "background-agent",
    steps: []
  }),
  testBackgroundAgent: async () => ({
    schemaVersion: 1,
    chatReady: false,
    computerUseReady: false,
    readyWorkflows: [],
    resumeStepId: "background-agent",
    steps: []
  }),
  testFinderAutomation: async () => ({
    schemaVersion: 1,
    chatReady: false,
    computerUseReady: false,
    readyWorkflows: [],
    resumeStepId: "background-agent",
    steps: []
  }),
  getConversationHistory: async () => ({
    schemaVersion: 1,
    lastActiveSessionId: null,
    sessions: []
  }),
  startConversationSession: async () => ({
    schemaVersion: 1,
    lastActiveSessionId: null,
    sessions: []
  }),
  switchConversationSession: async () => ({
    schemaVersion: 1,
    lastActiveSessionId: null,
    sessions: []
  }),
  renameConversationSession: async () => ({
    schemaVersion: 1,
    lastActiveSessionId: null,
    sessions: []
  }),
  archiveConversationSession: async () => ({
    schemaVersion: 1,
    lastActiveSessionId: null,
    sessions: []
  }),
  deleteConversationSession: async () => ({
    schemaVersion: 1,
    lastActiveSessionId: null,
    sessions: []
  }),
  restoreConversationSession: async () => ({
    schemaVersion: 1,
    lastActiveSessionId: null,
    sessions: []
  }),
  retryConversationTurn: async () => ({
    status: "storage-error",
    message: "Conversation history is unavailable in fallback mode.",
    snapshot: { schemaVersion: 1, lastActiveSessionId: null, sessions: [] }
  }),
  onConversationHistoryChanged: () => () => undefined,
  getTaskControl: async () => null,
  getPersonalMemory: async () => DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT,
  setPersonalMemorySettings: async () => DEFAULT_PERSONAL_MEMORY_SETTINGS,
  forgetPersonalMemory: async () => ({
    result: "not-found",
    snapshot: DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT
  }),
  approvePendingMemory: async () => ({
    result: "not-found",
    snapshot: DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT
  }),
  rejectPendingMemory: async () => ({
    result: "not-found",
    snapshot: DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT
  }),
  onPersonalMemoryChanged: () => () => undefined,
  getBrowserContextSource: async () => DEFAULT_BROWSER_CONTEXT_SOURCE_SNAPSHOT,
  discoverBrowserTabs: async () => ({
    result: "blocked" as const,
    reason: "Browser Context is unavailable in this renderer environment.",
    tabs: []
  }),
  selectBrowserTab: async () => DEFAULT_BROWSER_CONTEXT_SOURCE_SNAPSHOT,
  refreshBrowserContext: async () => DEFAULT_BROWSER_CONTEXT_SOURCE_SNAPSHOT,
  pauseBrowserContext: async () => DEFAULT_BROWSER_CONTEXT_SOURCE_SNAPSHOT,
  disconnectBrowserContext: async () => DEFAULT_BROWSER_CONTEXT_SOURCE_SNAPSHOT,
  clearBrowserContext: async () => DEFAULT_BROWSER_CONTEXT_SOURCE_SNAPSHOT,
  onBrowserContextChanged: () => () => undefined,
  getProfiles: async () => DEFAULT_PROFILE_RUNTIME_SNAPSHOT,
  switchProfile: async (input) => ({
    status: "blocked",
    profileId: input.profileId,
    reason: "Profiles are unavailable in this renderer environment."
  }),
  createProfile: async () => DEFAULT_PROFILE_RUNTIME_SNAPSHOT,
  updateProfile: async () => DEFAULT_PROFILE_RUNTIME_SNAPSHOT,
  deleteProfile: async () => DEFAULT_PROFILE_RUNTIME_SNAPSHOT,
  exportProfile: async () => {
    throw new Error("Profile export is unavailable in this renderer environment.");
  },
  importProfile: async () => DEFAULT_PROFILE_RUNTIME_SNAPSHOT,
  onProfileChanged: () => () => undefined
};

export function getDesktopApi(): DesktopApi {
  return window.skfiy ?? fallbackDesktopApi;
}
