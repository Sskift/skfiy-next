import type { PetAtlasManifest } from "./pet-atlas";
import type {
  RouteOutcome,
  RouteOutcomeKind,
  RouteOutcomeTone
} from "../shared/route-outcome.js";
import type {
  FirstRunReadinessSnapshot,
  FirstRunReadinessStep
} from "../shared/first-run-readiness.js";
import type {
  ConversationHistorySnapshot,
  ConversationRetryResult
} from "../shared/conversation-history.js";
import type {
  TaskControlRecoveryDispatchResult,
  TaskControlRecoveryPreparationResult,
  TaskControlRecoveryRequest,
  TaskControlSnapshot
} from "../shared/task-control.js";
import type {
  BrowserContextBlocker,
  BrowserContextBlockerCategory,
  BrowserContextDiscoveryState,
  BrowserContextSelectedTab,
  BrowserContextSourceSnapshot,
  BrowserContextTabDiscoveryResult,
  BrowserContextTabSummary
} from "../shared/browser-context-source.js";
import type {
  PolicyBroadening,
  Profile,
  ProfileExportBundle,
  ProfileMemoryScope,
  ProfileRuntimeSnapshot,
  ProfileSummary,
  ProfileSwitchResult
} from "../shared/profile.js";

export type {
  PolicyBroadening,
  Profile,
  ProfileExportBundle,
  ProfileMemoryScope,
  ProfileRuntimeSnapshot,
  ProfileSummary,
  ProfileSwitchResult
};

export type {
  BrowserContextBlocker,
  BrowserContextBlockerCategory,
  BrowserContextDiscoveryState,
  BrowserContextSelectedTab,
  BrowserContextSourceSnapshot,
  BrowserContextTabDiscoveryResult,
  BrowserContextTabSummary
};

export type {
  ConversationHistorySnapshot,
  ConversationRetryResult,
  FirstRunReadinessSnapshot,
  FirstRunReadinessStep,
  RouteOutcome,
  RouteOutcomeKind,
  RouteOutcomeTone,
  TaskControlRecoveryDispatchResult,
  TaskControlRecoveryPreparationResult,
  TaskControlRecoveryRequest,
  TaskControlSnapshot
};

export type TaskStatus =
  | "idle"
  | "planned"
  | "waiting"
  | "observing"
  | "executing"
  | "verifying"
  | "running"
  | "approval_required"
  | "needs_confirmation"
  | "needs_clarification"
  | "completed"
  | "denied"
  | "blocked"
  | "failed"
  | "cancelled";

export type ManualMode = "active" | "quiet";
export type PetWindowMode = "compact" | "expanded";
export type PermissionState = "granted" | "denied" | "not-determined" | "unknown";
export type DesktopSessionDiagnosticState = "controllable" | "blocked" | "unknown";
export type PermissionSettingsTarget =
  | "screen-recording"
  | "accessibility";
export type StartupWarningId = "tmux-launch" | "dev-server" | "unbundled-electron";
export type AppPolicy = "allow" | "ask" | "deny";
export type AssistantAgentMode = "codex" | "claude-code" | "hermes";
export type AssistantAgentProviderLabel = "Codex" | "Claude Code" | "Hermes";
export type AssistantAgentProviderReadiness =
  | "chat-ready"
  | "version-ok"
  | "binary-found"
  | "binary-configured"
  | "auth-or-permission-blocked"
  | "unconfigured"
  | "unavailable";
export type AssistantAgentProviderRuntime = {
  cwd?: string;
  timeoutMs?: number;
};
export type AssistantAgentProviderFallback =
  | {
      kind: "fallback";
      requestedMode: AssistantAgentMode;
      activeMode: AssistantAgentMode;
      reason: string;
    }
  | {
      kind: "offline";
      requestedMode: AssistantAgentMode;
      reason: string;
    };
export type PlannerProviderMode = "local-deterministic" | "external-cua" | "disabled";
export type RiskLevel = "low" | "medium" | "high" | "blocked";
export type TurnTranscriptOutcome =
  | "completed"
  | "approval_required"
  | "needs_confirmation"
  | "needs_clarification"
  | "verification_failed"
  | "denied"
  | "blocked"
  | "cancelled"
  | "failed"
  | "running";
export interface ControlledAppPolicyEntry {
  name: string;
  bundleId: string;
  policy: AppPolicy;
}

export interface AppPolicySettings {
  apps: ControlledAppPolicyEntry[];
}

export interface AssistantAgentSettings {
  mode: AssistantAgentMode;
  codexBinary: string;
  codexBinarySource: "default" | "env";
  claudeCodeBinary: string;
  claudeCodeBinarySource: "default" | "env";
  hermesBinary: string;
  hermesBinarySource: "default" | "env";
  cwd: string;
  timeoutMs: number;
  providerRuntime?: Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>>;
}

export interface AssistantAgentProviderState {
  provider: "assistant";
  id: AssistantAgentMode;
  label: AssistantAgentProviderLabel;
  selected: boolean;
  configured: boolean;
  executablePath?: string;
  executableSource: "default" | "env";
  resolvedExecutablePath?: string;
  readiness: AssistantAgentProviderReadiness;
  readinessDetail?: string;
  version?: string;
  lastError?: string;
}

export interface AssistantAgentSettingsResponse {
  settings: AssistantAgentSettings;
  providers: AssistantAgentProviderState[];
  fallback?: AssistantAgentProviderFallback;
}

export interface PlannerProviderSettings {
  mode: PlannerProviderMode;
  externalProviderLabel: string;
  externalEndpoint?: string;
  externalApiKeyConfigured: boolean;
}

export interface TurnTranscript {
  command?: string;
  risk?: {
    level: RiskLevel;
    reason: string;
    requiresApproval: boolean;
  };
  planner?: {
    providerLabel: string;
    input: string;
    command: string;
    rationale?: string;
  };
  approvalRequired: boolean;
  apps: Array<{
    name: string;
    bundleId?: string;
    pid?: number;
  }>;
  screenshots: Array<{
    stage: "before" | "after";
    path: string;
    bundleId?: string;
    pid?: number;
    accessibilityTrusted?: boolean;
    grounding?: {
      recommendation: string;
      sources: Array<{
        source: string;
        status: string;
        observedElementCount: number;
        labelCount: number;
        notes?: string[];
      }>;
    };
  }>;
  actions: Array<{
    type: string;
    appName?: string;
    bundleId?: string;
    pid?: number;
    turnId?: string;
    toolCallId?: string;
    route?: string;
    text?: string;
    key?: string;
    action?: string;
    actionType?: string;
    status?: string;
    stage?: string;
    message?: string;
    reason?: string;
    decision?: string;
    summary?: string;
    evidenceSummary?: string;
    artifactCount?: number;
    providerLabel?: string;
    command?: string;
    rationale?: string;
    from?: string;
    to?: string;
    source?: string;
    frontmostBundleId?: string;
    targetPath?: string;
    selectedCount?: number;
    rootPath?: string;
    operationCount?: number;
    destructiveOperationCount?: number;
    createFolderCount?: number;
    moveFileCount?: number;
    copyFileCount?: number;
  }>;
  outcome: TurnTranscriptOutcome;
  finderTaskResult?: FinderTaskResult;
}

export interface TurnReplay {
  transcript: TurnTranscript;
  routeOutcome?: RouteOutcome;
  timeline: Array<{
    status: TaskStatus;
    message?: string;
    command?: string;
    route?: string;
    routeReason?: string;
    denialKind?: string;
    policyKind?: string;
    routeOutcome?: RouteOutcome;
    taskControl?: TaskControlSnapshot;
    stopTurnBehavior?: TaskEventStopTurnBehavior;
  }>;
}

export interface PermissionSummary {
  screenRecording: { state: PermissionState };
  accessibility: { state: PermissionState };
}

export interface PermissionDiagnostics {
  active: PermissionSummary;
  appProcess: PermissionSummary;
  helperProcess: PermissionSummary;
  mismatches: Array<{
    permission: keyof PermissionSummary;
    appProcess: PermissionState;
    helperProcess: PermissionState;
  }>;
  identity: {
    appPath: string;
    executablePath: string;
    helperPath: string;
    resourcesPath: string;
    isPackaged: boolean;
  };
}

export interface DesktopSessionStatus {
  frontmostBundleId?: string;
  frontmostLocalizedName?: string;
  frontmostProcessIdentifier?: number;
  controllable: boolean;
}

export interface DesktopSessionDiagnostics {
  state: DesktopSessionDiagnosticState;
  status: DesktopSessionStatus | null;
  reason: string;
}

export interface StartupWarning {
  id: StartupWarningId;
  title: string;
  message: string;
}

export interface RuntimeStatus {
  stopTurnHotkey: {
    accelerator: string;
    label: string;
    registered: boolean;
  };
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AutomationMonitorStatus =
  | "observing"
  | "needs_attention"
  | "blocked"
  | "idle"
  | "disabled"
  | "error"
  | "scheduler_inactive";
export type AutomationSchedulerState = "active" | "inactive";
export type AutomationMonitorLastResult = "observing" | "needs_attention" | "blocked" | "error";
export type AutomationMonitorTriggerMode = "manual" | "scheduled" | "local-state";

export interface AutomationMonitorSchedulerStatus {
  state: AutomationSchedulerState;
  scope: "app-process";
  owner: "skfiy";
  activeTimerCount: number;
  mutatesSession: false;
  startedAt?: string;
  reason?: string;
}

export interface AutomationMonitorDefinitionPreview {
  adapter: "tmux-supervision";
  triggerModes: ["manual", "scheduled"];
  target: {
    kind: "tmux-session";
    sessionName: string;
  };
  requiredPermissions: [];
  readWriteBehavior: "read-only";
  approvalMode: "not-required";
  timeoutMs: number;
  verification: "tmux session, window, pane, and bounded recent pane-output observation";
  mutatesSession: false;
}

export interface AutomationMonitorRuntime {
  id: string;
  kind: "tmux-session";
  label: string;
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  triggerMode: AutomationMonitorTriggerMode;
  sessionName: string;
  preview: AutomationMonitorDefinitionPreview;
  status: AutomationMonitorStatus;
  checkCount: number;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  lastChangedAt?: string;
  lastSummary?: string;
  lastError?: string;
  lastReport?: unknown;
  lastResult?: AutomationMonitorLastResult;
  lastResultAt?: string;
  observedSession?: string;
  schedulerState?: AutomationSchedulerState;
  schedulerScope?: "app-process";
  mutatesSession?: false;
}

export interface AutomationMonitorSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  activeCount: number;
  attentionCount: number;
  schedulerInactiveCount: number;
  scheduler: AutomationMonitorSchedulerStatus;
  monitors: AutomationMonitorRuntime[];
}

export type AutomationRunState =
  | "queued"
  | "running"
  | "waiting"
  | "attention"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type AutomationRunTrigger = "manual" | "scheduled" | "local-state" | "cli" | "mcp";

export type AutomationRunCancellationSource = "pet" | "dashboard" | "cli" | "mcp";

export interface AutomationRunTimelineEntry {
  at: string;
  step: string;
  detail?: string;
}

export interface AutomationRunRecoveryProposal {
  proposalId: string;
  actionKind: "send_input" | "restart_step" | "collect_summary";
  reason: string;
  risk: "low" | "medium" | "high" | "blocked";
  mutatesSession: boolean;
}

export interface AutomationRunVerification {
  at: string;
  kind: "tmux-observation" | "manual" | "none";
  status: "observing" | "needs_attention" | "blocked" | "error";
  summary: string;
  recoveryProposals?: AutomationRunRecoveryProposal[];
}

export interface AutomationRunCancellation {
  requestedBy: AutomationRunCancellationSource;
  at: string;
}

export interface AutomationRunConfig {
  sessionName: string;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  runTtlMs: number;
  concurrencyPolicy: "skip" | "queue" | "allow";
  maxConcurrency: number;
}

export interface AutomationRunRecord {
  schemaVersion: 1;
  runId: string;
  monitorId: string;
  trigger: AutomationRunTrigger;
  state: AutomationRunState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
  retryAvailableAt?: string;
  currentStep: string;
  nextAction?: string;
  attempt: number;
  maxAttempts: number;
  timeline: AutomationRunTimelineEntry[];
  latestVerification?: AutomationRunVerification;
  terminalReason?: string;
  cancellation?: AutomationRunCancellation;
  error?: string;
  config: AutomationRunConfig;
}

export interface AutomationRunSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  runs: AutomationRunRecord[];
}

export interface VisiblePetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TaskEvent {
  status: TaskStatus;
  message?: string;
  command?: string;
  route?: string;
  routeReason?: string;
  denialKind?: string;
  policyKind?: string;
  routeOutcome?: RouteOutcome;
  taskControl?: TaskControlSnapshot;
  stopTurnBehavior?: TaskEventStopTurnBehavior;
  replayReset?: boolean;
  replayRecord?: ObserveAppReplayRecord;
  finderSelection?: FinderSelectionResult;
  finderPlanPreview?: FinderPlanPreview;
  finderTaskResult?: FinderTaskResult;
  tmuxSupervisionReport?: unknown;
}

export interface TaskEventStopTurnBehavior {
  result?: string;
  source?: string;
  command?: string;
  beforeStatus?: string;
  beforeMessage?: string;
  afterStatus?: string;
  afterMessage?: string;
}

export interface FinderPlanPreview {
  rootPath: string;
  operationCount: number;
  destructiveOperationCount: number;
  createFolders: string[];
  moveFiles: Array<{
    from: string;
    to: string;
  }>;
  copyFiles?: Array<{
    from: string;
    to: string;
  }>;
}

export type FinderTaskErrorCode =
  | "destination-exists"
  | "source-missing"
  | "source-changed"
  | "cross-device"
  | "permission-denied"
  | "rollback-incomplete"
  | "filesystem-error"
  | "verification-failed";

export type FinderTaskResolution =
  | "create"
  | "move"
  | "copy"
  | "skip"
  | "rename"
  | "replace";

export interface FinderTaskCompletedItem {
  operationId: string;
  operationType: "create_folder" | "move_file" | "copy_file";
  from?: string;
  to: string;
  resultingName: string;
  resolution: FinderTaskResolution;
}

export interface FinderTaskFailedItem {
  operationId: string;
  operationType: "create_folder" | "move_file" | "copy_file";
  from?: string;
  to: string;
  reason: string;
  errorCode: FinderTaskErrorCode;
}

export interface FinderTaskResult {
  schemaVersion: 1;
  rootPath: string;
  destinationPath: string;
  collisionPolicy: "cancel" | "skip" | "rename" | "replace";
  totalOperationCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  completedItems: FinderTaskCompletedItem[];
  failedItems: FinderTaskFailedItem[];
  destinationVerified: boolean;
  resultingNamesVerified: boolean;
}

export interface FinderSelectionResult {
  source: "finder-applescript";
  frontmostBundleId?: string;
  targetPath?: string;
  selection: Array<{
    path: string;
    name: string;
    kind: "file" | "directory" | "other";
  }>;
}

export interface ObserveAppReplayRecord {
  stage: "before" | "after";
  bundleId: string;
  isRunning: boolean;
  isActive: boolean;
  screenshotPath: string;
  frontmostBundleId?: string;
  accessibilityTrusted?: boolean;
  windows?: Array<{
    title?: string;
    layer: number;
    bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  ocrLabels?: Array<{
    text: string;
    confidence: number;
    bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
}

export interface PersonalMemorySettings {
  postTurnLearningEnabled: boolean;
  writeApprovalEnabled: boolean;
}

export interface PersonalMemoryUsageBucket {
  usedChars: number;
  limitChars: number;
  percent: number;
}

export interface PendingPersonalMemoryWrite {
  id: string;
  createdAt: string;
  source: string;
  action: "add" | "replace" | "remove";
  target: "user" | "agent";
  content: string;
  previousContent?: string;
}

export interface PersonalMemoryJournalEntry {
  id: string;
  createdAt: string;
  source: string;
  stage: "durable" | "pending";
  turnId: string;
  providerLabel: string;
  userInput: string;
  action: "add" | "replace" | "remove";
  target: "user" | "agent";
  content: string;
  previousContent?: string;
}

export interface PersonalMemoryDashboardSnapshot {
  schemaVersion: 1;
  userEntries: string[];
  agentEntries: string[];
  usage: {
    user: PersonalMemoryUsageBucket;
    agent: PersonalMemoryUsageBucket;
  };
  pendingWrites: PendingPersonalMemoryWrite[];
  journal: PersonalMemoryJournalEntry[];
  sessionCount: number;
  latestUpdatedAt?: string;
  settings: PersonalMemorySettings;
}

export interface PersonalMemoryForgetResult {
  result: "forgotten" | "not-found";
  snapshot: PersonalMemoryDashboardSnapshot;
}

export interface PersonalMemoryPendingApprovalResult {
  result: "approved" | "not-found";
  applied?: number;
  ignored?: number;
  blocked?: number;
  snapshot: PersonalMemoryDashboardSnapshot;
}

export interface PersonalMemoryPendingRejectResult {
  result: "rejected" | "not-found";
  snapshot: PersonalMemoryDashboardSnapshot;
}

export interface DesktopApi {
  runCommand: (command: string, options: { mode: ManualMode }) => Promise<void>;
  approveTask: (input: TaskApprovalDecisionInput) => Promise<void>;
  denyTask: (input: TaskApprovalDecisionInput) => Promise<void>;
  prepareTaskRecovery: (
    input: TaskControlRecoveryRequest
  ) => Promise<TaskControlRecoveryPreparationResult>;
  dispatchTaskRecovery: (
    input: TaskControlRecoveryRequest
  ) => Promise<TaskControlRecoveryDispatchResult>;
  takeScreenshot: () => Promise<void>;
  stopTask: () => Promise<void>;
  getPermissions: () => Promise<PermissionSummary>;
  getPermissionDiagnostics: () => Promise<PermissionDiagnostics>;
  getDesktopSessionDiagnostics: () => Promise<DesktopSessionDiagnostics>;
  openPermissionSettings: (permission: PermissionSettingsTarget) => Promise<void>;
  getStartupWarnings: () => Promise<StartupWarning[]>;
  getAppPolicySettings: () => Promise<AppPolicySettings>;
  setAppPolicy: (update: { bundleId: string; policy: AppPolicy }) => Promise<AppPolicySettings>;
  getAssistantAgentSettings: () => Promise<AssistantAgentSettingsResponse>;
  setAssistantAgentSettings: (
    update: {
      mode?: AssistantAgentMode;
      providerRuntime?: Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>>;
    }
  ) => Promise<AssistantAgentSettingsResponse>;
  testAssistantAgentProvider: (
    input: { mode: AssistantAgentMode }
  ) => Promise<AssistantAgentProviderState>;
  getFirstRunReadiness: () => Promise<FirstRunReadinessSnapshot>;
  testBackgroundAgent: () => Promise<FirstRunReadinessSnapshot>;
  testFinderAutomation: () => Promise<FirstRunReadinessSnapshot>;
  getPlannerProviderSettings: () => Promise<PlannerProviderSettings>;
  setPlannerProviderSettings: (
    update: Partial<Pick<PlannerProviderSettings, "mode">>
  ) => Promise<PlannerProviderSettings>;
  getConversationHistory: () => Promise<ConversationHistorySnapshot>;
  startConversationSession: () => Promise<ConversationHistorySnapshot>;
  switchConversationSession: (sessionId: string) => Promise<ConversationHistorySnapshot>;
  renameConversationSession: (
    input: { sessionId: string; title: string }
  ) => Promise<ConversationHistorySnapshot>;
  archiveConversationSession: (sessionId: string) => Promise<ConversationHistorySnapshot>;
  deleteConversationSession: (sessionId: string) => Promise<ConversationHistorySnapshot>;
  restoreConversationSession: (sessionId: string) => Promise<ConversationHistorySnapshot>;
  retryConversationTurn: (
    input: { sessionId: string; turnId: string; requestId: string }
  ) => Promise<ConversationRetryResult>;
  getTaskControl: () => Promise<TaskControlSnapshot | null>;
  getTurnReplay: () => Promise<TurnReplay | null>;
  getAutomationMonitors: () => Promise<AutomationMonitorSnapshot>;
  upsertTmuxMonitor: (
    input: {
      monitorId?: string;
      sessionName: string;
      label?: string;
      intervalMs: number;
      timeoutMs?: number;
      triggerMode?: AutomationMonitorTriggerMode;
      enabled?: boolean;
    }
  ) => Promise<AutomationMonitorSnapshot>;
  duplicateAutomationMonitor: (id: string) => Promise<AutomationMonitorSnapshot>;
  runAutomationMonitorNow: (id: string) => Promise<AutomationMonitorSnapshot>;
  setAutomationMonitorEnabled: (id: string, enabled: boolean) => Promise<AutomationMonitorSnapshot>;
  deleteAutomationMonitor: (id: string) => Promise<AutomationMonitorSnapshot>;
  previewTmuxAutomation: (
    input: {
      sessionName: string;
      timeoutMs?: number;
      triggerMode?: AutomationMonitorTriggerMode;
    }
  ) => Promise<AutomationMonitorDefinitionPreview | null>;
  getAutomationRuns: () => Promise<AutomationRunSnapshot>;
  stopAutomationRun: (runId: string) => Promise<AutomationRunSnapshot>;
  getRuntimeStatus: () => Promise<RuntimeStatus>;
  getPetSkin: () => Promise<PetAtlasManifest | null>;
  importPetSkin: () => Promise<PetAtlasManifest | null>;
  resetPetSkin: () => Promise<void>;
  getWindowBounds: () => Promise<WindowBounds | null>;
  moveWindowBy: (deltaX: number, deltaY: number, visibleRect?: VisiblePetRect) => void;
  setWindowMode: (mode: PetWindowMode) => void;
  onStopTurnHotkey: (callback: () => void) => () => void;
  onTaskEvent: (callback: (event: TaskEvent) => void) => () => void;
  onConversationHistoryChanged: (
    callback: (snapshot: ConversationHistorySnapshot) => void
  ) => () => void;
  getPersonalMemory: () => Promise<PersonalMemoryDashboardSnapshot>;
  setPersonalMemorySettings: (
    update: { postTurnLearningEnabled?: boolean; writeApprovalEnabled?: boolean }
  ) => Promise<PersonalMemorySettings>;
  forgetPersonalMemory: (
    input: { target: "user" | "agent"; content: string }
  ) => Promise<PersonalMemoryForgetResult>;
  approvePendingMemory: (pendingId: string) => Promise<PersonalMemoryPendingApprovalResult>;
  rejectPendingMemory: (pendingId: string) => Promise<PersonalMemoryPendingRejectResult>;
  onPersonalMemoryChanged: (
    callback: (snapshot: PersonalMemoryDashboardSnapshot) => void
  ) => () => void;
  getBrowserContextSource: () => Promise<BrowserContextSourceSnapshot>;
  discoverBrowserTabs: () => Promise<BrowserContextTabDiscoveryResult>;
  selectBrowserTab: (input: { tabId: number }) => Promise<BrowserContextSourceSnapshot>;
  refreshBrowserContext: () => Promise<BrowserContextSourceSnapshot>;
  pauseBrowserContext: () => Promise<BrowserContextSourceSnapshot>;
  disconnectBrowserContext: () => Promise<BrowserContextSourceSnapshot>;
  clearBrowserContext: () => Promise<BrowserContextSourceSnapshot>;
  onBrowserContextChanged: (
    callback: (snapshot: BrowserContextSourceSnapshot) => void
  ) => () => void;
  getProfiles: () => Promise<ProfileRuntimeSnapshot>;
  switchProfile: (
    input: { profileId: string; confirm?: boolean }
  ) => Promise<ProfileSwitchResult>;
  createProfile: (input: {
    name: string;
    memoryScope?: ProfileMemoryScope;
    cloneFromActive?: boolean;
    defaultManualMode?: "active" | "quiet";
  }) => Promise<ProfileRuntimeSnapshot>;
  updateProfile: (
    input: { profileId: string; name?: string }
  ) => Promise<ProfileRuntimeSnapshot>;
  deleteProfile: (profileId: string) => Promise<ProfileRuntimeSnapshot>;
  exportProfile: (input: {
    profileId: string;
    includeMemory?: boolean
  }) => Promise<ProfileExportBundle>;
  importProfile: (bundle: ProfileExportBundle) => Promise<ProfileRuntimeSnapshot>;
  onProfileChanged: (
    callback: (snapshot: ProfileRuntimeSnapshot) => void
  ) => () => void;
}

export interface TaskApprovalDecisionInput {
  executionId: string;
  planId: string;
}
