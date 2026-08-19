import type { DesktopApi } from "./app-types";
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

declare global {
  interface Window {
    skfiy?: DesktopApi;
  }
}

const DEFAULT_AUTOMATION_MONITOR_SNAPSHOT = {
  schemaVersion: 1 as const,
  generatedAt: new Date(0).toISOString(),
  activeCount: 0,
  attentionCount: 0,
  schedulerInactiveCount: 0,
  scheduler: {
    state: "inactive" as const,
    scope: "app-process" as const,
    owner: "skfiy" as const,
    activeTimerCount: 0,
    mutatesSession: false as const,
    reason: "Open skfiy to resume interval checks."
  },
  monitors: []
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
  getPlannerProviderSettings: async () => DEFAULT_PLANNER_PROVIDER_SETTINGS,
  setPlannerProviderSettings: async (update) =>
    reducePlannerProviderSettings(DEFAULT_PLANNER_PROVIDER_SETTINGS, update),
  getTurnReplay: async () => null,
  getAutomationMonitors: async () => DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  upsertTmuxMonitor: async () => DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  runAutomationMonitorNow: async () => DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  getRuntimeStatus: async () => ({
    stopTurnHotkey: {
      accelerator: "",
      label: "",
      registered: false
    }
  }),
  getPetSkin: async () => null,
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
  getTaskControl: async () => null
};

export function getDesktopApi(): DesktopApi {
  return window.skfiy ?? fallbackDesktopApi;
}
