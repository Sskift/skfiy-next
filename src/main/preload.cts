import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  ConversationHistorySnapshot,
  ConversationMessage,
  ConversationRetryResult,
  ConversationSession,
  ConversationTurn
} from "../shared/conversation-history.js";
import type {
  TaskControlRecoveryDescriptor,
  TaskControlRecoveryDispatchResult,
  TaskControlRecoveryPreparationResult,
  TaskControlRecoveryRequest,
  TaskControlSnapshot
} from "../shared/task-control.js";
import type {
  PolicyBroadening,
  ProfileExportBundle,
  ProfileMemoryScope,
  ProfileRuntimeSnapshot,
  ProfileSummary,
  ProfileSwitchResult
} from "../shared/profile.js";
import type {
  DataDomain,
  DataExportBundle
} from "../shared/data-export.js";
import {
  isDataExportBundle,
  isDataDomain
} from "../shared/data-export.js";
import type {
  RetentionSettings,
  RetentionSettingsUpdate
} from "../shared/retention.js";
import { isRetentionSettings } from "../shared/retention.js";

type DataAdminDomain = DataDomain;

interface DataRestorePreviewEntry {
  domain: DataAdminDomain;
  action: "replace" | "merge" | "skip";
  currentSummary: string;
  incomingSummary: string;
  conflicts: string[];
  warnings: string[];
}

interface DataRestorePreview {
  domains: DataRestorePreviewEntry[];
  requiresConfirmation: boolean;
  backupPlan: { path: string; createdAt: string };
  bundle: DataExportBundle;
}

interface DataRestoreResult {
  appliedDomains: DataAdminDomain[];
  skipped: { domain: DataAdminDomain; reason: string }[];
  backupPath: string;
  restoredAt: string;
}

interface DataDomainResetResult {
  domain: DataAdminDomain;
  resetImpact: string;
  cleared: string[];
}

interface StorageFileHealth {
  domain: DataAdminDomain;
  relativePath: string;
  status: "ok" | "missing" | "corrupt" | "future-schema";
  schemaVersion?: number;
  expectedSchemaVersion?: number;
  error?: string;
}

interface StorageHealthSummary {
  status: "ok" | "corrupt" | "future-schema";
  files: StorageFileHealth[];
  counts: {
    total: number;
    ok: number;
    missing: number;
    corrupt: number;
    futureSchema: number;
  };
  recoveryHint?: string;
}

interface ApplyRetentionResult {
  replay: { status: "applied" | "disabled" | "noop"; note: string };
  screenshots: { status: "applied" | "disabled"; scanned: number; deleted: number };
  runHistory: { status: "applied" | "disabled"; before: number; after: number };
}
import {
  createUnknownDiagnosticReport,
  type DiagnosticComponentName,
  type DiagnosticComponentState,
  type DiagnosticReport,
  type DiagnosticReportBlocker,
  type DiagnosticReportBlockerSeverity,
  type DiagnosticReportBlockerType,
  type DiagnosticReportRedaction,
  type DiagnosticReportSection,
  type DiagnosticReportSectionId,
  type DiagnosticReportState
} from "../shared/diagnostic-report.js";
import {
  type ChromeCompatibilityHealth
} from "../shared/chrome-extension-compatibility.js";

type ManualMode = "active" | "quiet";
type PetWindowMode = "compact" | "expanded";
interface TaskApprovalDecisionInput {
  executionId: string;
  planId: string;
}
type TaskStatus =
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
type PermissionState = "granted" | "denied" | "not-determined" | "unknown";
type DesktopSessionDiagnosticState = "controllable" | "blocked" | "unknown";
type PermissionSettingsTarget =
  | "screen-recording"
  | "accessibility"
  | "automation-finder";
type StartupWarningId = "tmux-launch" | "dev-server" | "unbundled-electron";
type AppPolicy = "allow" | "ask" | "deny";
type AssistantAgentMode = "codex" | "claude-code" | "hermes";
type AssistantAgentProviderId = AssistantAgentMode;
type AssistantAgentProviderLabel = "Codex" | "Claude Code" | "Hermes";
type AssistantAgentProviderReadiness =
  | "chat-ready"
  | "version-ok"
  | "binary-found"
  | "binary-configured"
  | "auth-or-permission-blocked"
  | "unconfigured"
  | "unavailable";
type AssistantAgentExecutableSource = "default" | "env";
type AssistantAgentProviderRuntime = {
  cwd?: string;
  timeoutMs?: number;
};
type AssistantAgentProviderFallback =
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
type FirstRunReadinessStepId =
  | "background-agent"
  | "screen-recording"
  | "accessibility"
  | "finder-automation"
  | "browser-context";
type FirstRunReadinessRequirement = "required-for-chat" | "computer-use" | "optional";
type FirstRunReadinessState = "ready" | "action-required" | "blocked" | "unknown";
type FirstRunReadyWorkflow = "chat" | "computer-use" | "finder" | "browser-context";
type PlannerProviderMode = "local-deterministic" | "external-cua" | "disabled";
type RiskLevel = "low" | "medium" | "high" | "blocked";
type TurnTranscriptOutcome =
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
type RouteOutcomeKind =
  | "idle"
  | "running"
  | "approval_required"
  | "needs_confirmation"
  | "needs_clarification"
  | "app_policy_denied"
  | "chrome_host_policy_denied"
  | "user_denied"
  | "blocked"
  | "cancelled"
  | "stopped"
  | "failed"
  | "completed"
  | "unknown";
type RouteOutcomeTone = "success" | "warning" | "danger" | "neutral";

const routeOutcomeKinds = new Set<RouteOutcomeKind>([
  "idle",
  "running",
  "approval_required",
  "needs_confirmation",
  "needs_clarification",
  "app_policy_denied",
  "chrome_host_policy_denied",
  "user_denied",
  "blocked",
  "cancelled",
  "stopped",
  "failed",
  "completed",
  "unknown"
]);
const routeOutcomeTones = new Set<RouteOutcomeTone>([
  "success",
  "warning",
  "danger",
  "neutral"
]);

const taskControlRoutes = new Set(["ghostty", "chrome", "finder", "desktop", "tmux_supervision"]);
const taskControlRiskLevels = new Set(["low", "medium", "high", "blocked"]);
const taskControlPhases = new Set(["waiting", "approval", "executing", "verifying", "terminal"]);
const taskControlOutcomes = new Set([
  "app_policy_denied",
  "user_denied",
  "blocked",
  "confirmation_required",
  "failed",
  "cancelled",
  "completed"
]);
const taskControlRecoveryActions = new Set([
  "retry_observation",
  "retry_verification",
  "revise_plan",
  "open_readiness"
]);
const taskControlFailureStages = new Set([
  "preflight",
  "approval",
  "observation",
  "execution",
  "verification"
]);
const taskControlRecoveryModes = new Set(["prepare_only", "draft_only", "navigation"]);
const taskControlRecoveryResultCodes = new Set([
  "recovery-prepared",
  "recovery-invalid-request",
  "recovery-invalid-response",
  "recovery-stale-execution",
  "recovery-unknown",
  "recovery-mismatched"
]);
const taskControlRecoveryDispatchResultCodes = new Set([
  "recovery-dispatched",
  "recovery-dispatch-invalid-request",
  "recovery-dispatch-invalid-response",
  "recovery-dispatch-stale-execution",
  "recovery-dispatch-unknown",
  "recovery-dispatch-mismatched",
  "recovery-not-prepared",
  "recovery-already-dispatched",
  "recovery-dispatch-unavailable"
]);
const taskControlSideEffectStates = new Set(["none", "possible", "occurred"]);
const taskControlPlanKeys = new Set([
  "planId",
  "route",
  "appName",
  "target",
  "risk",
  "approvalRequired",
  "expectedVerification",
  "mutating"
]);
const taskControlRiskKeys = new Set(["level", "reason", "requiresApproval"]);
const taskControlApprovalKeys = new Set([
  "gate",
  "planId",
  "finderPlanPreview",
  "chromeSubmitBinding"
]);
const taskControlChromeSubmitBindingKeys = new Set([
  "schemaVersion",
  "url",
  "fieldSelectors",
  "submitSelector"
]);
const taskControlFinderPreviewKeys = new Set([
  "rootPath",
  "operationCount",
  "destructiveOperationCount",
  "createFolders",
  "moveFiles",
  "copyFiles"
]);
const taskControlFinderPreviewRequiredKeys = [
  "rootPath",
  "operationCount",
  "destructiveOperationCount",
  "createFolders",
  "moveFiles"
];
const taskControlFinderMoveKeys = new Set(["from", "to"]);
const taskControlRecoveryDescriptorKeys = new Set([
  "recoveryId",
  "action",
  "mode",
  "executionId",
  "planId",
  "route",
  "outcome",
  "failureStage"
]);
const taskControlRecoveryRequestKeys = new Set([
  "recoveryId",
  "action",
  "executionId",
  "planId",
  "route",
  "outcome",
  "failureStage"
]);
const taskControlRecoveryResultKeys = new Set([
  "state",
  "code",
  "message",
  "descriptor",
  "draft"
]);
const taskControlRecoveryDispatchResultKeys = new Set([
  "state",
  "code",
  "message",
  "descriptor",
  "recoveryExecutionId"
]);
const taskApprovalDecisionKeys = new Set(["executionId", "planId"]);
const taskControlSnapshotKeys = new Set([
  "schemaVersion",
  "executionId",
  "phase",
  "status",
  "message",
  "plan",
  "sideEffectState",
  "replayAvailable",
  "recoveryActions",
  "executionPlanId",
  "failureStage",
  "recoveryDescriptors",
  "approval",
  "outcome"
]);
const taskControlActiveStatusByPhase = {
  waiting: "waiting",
  approval: "approval_required",
  executing: "executing",
  verifying: "verifying"
} as const;

interface TaskEvent {
  status: TaskStatus;
  message?: string;
  command?: string;
  route?: string;
  routeReason?: string;
  denialKind?: string;
  policyKind?: string;
  backgroundAgentFailure?: true;
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

interface TaskEventStopTurnBehavior {
  result?: string;
  source?: string;
  command?: string;
  beforeStatus?: string;
  beforeMessage?: string;
  afterStatus?: string;
  afterMessage?: string;
}

interface FinderPlanPreview {
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

interface FinderTaskResult {
  schemaVersion: 1;
  rootPath: string;
  destinationPath: string;
  collisionPolicy: "cancel" | "skip" | "rename" | "replace";
  totalOperationCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  completedItems: Array<{
    operationId: string;
    operationType: "create_folder" | "move_file" | "copy_file";
    from?: string;
    to: string;
    resultingName: string;
    resolution: "create" | "move" | "copy" | "skip" | "rename" | "replace";
  }>;
  failedItems: Array<{
    operationId: string;
    operationType: "create_folder" | "move_file" | "copy_file";
    from?: string;
    to: string;
    reason: string;
    errorCode: string;
  }>;
  destinationVerified: boolean;
  resultingNamesVerified: boolean;
}

interface FinderSelectionResult {
  source: "finder-applescript";
  frontmostBundleId?: string;
  targetPath?: string;
  selection: Array<{
    path: string;
    name: string;
    kind: "file" | "directory" | "other";
  }>;
}

interface ObserveAppReplayRecord {
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

interface ControlledAppPolicyEntry {
  name: string;
  bundleId: string;
  policy: AppPolicy;
}

interface AppPolicySettings {
  apps: ControlledAppPolicyEntry[];
}

interface AssistantAgentSettings {
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

interface AssistantAgentProviderState {
  provider: "assistant";
  id: AssistantAgentProviderId;
  label: AssistantAgentProviderLabel;
  selected: boolean;
  configured: boolean;
  executablePath?: string;
  executableSource: AssistantAgentExecutableSource;
  resolvedExecutablePath?: string;
  readiness: AssistantAgentProviderReadiness;
  readinessDetail?: string;
  version?: string;
  lastError?: string;
}

interface AssistantAgentSettingsResponse {
  settings: AssistantAgentSettings;
  providers: AssistantAgentProviderState[];
  fallback?: AssistantAgentProviderFallback;
}

interface FirstRunReadinessStep {
  id: FirstRunReadinessStepId;
  requirement: FirstRunReadinessRequirement;
  state: FirstRunReadinessState;
  reason?: string;
  nextAction?: string;
}

interface FirstRunReadinessSnapshot {
  schemaVersion: 1;
  chatReady: boolean;
  computerUseReady: boolean;
  readyWorkflows: FirstRunReadyWorkflow[];
  resumeStepId: FirstRunReadinessStepId | null;
  steps: FirstRunReadinessStep[];
}

interface PlannerProviderSettings {
  mode: PlannerProviderMode;
  externalProviderLabel: string;
  externalEndpoint?: string;
  externalApiKeyConfigured: boolean;
}

interface PersonalMemorySettings {
  postTurnLearningEnabled: boolean;
  writeApprovalEnabled: boolean;
}

interface PersonalMemoryUsageBucket {
  usedChars: number;
  limitChars: number;
  percent: number;
}

interface PendingPersonalMemoryWrite {
  id: string;
  createdAt: string;
  source: string;
  action: "add" | "replace" | "remove";
  target: "user" | "agent";
  content: string;
  previousContent?: string;
}

interface PersonalMemoryJournalEntry {
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

interface PersonalMemoryDashboardSnapshot {
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

interface PersonalMemoryForgetResult {
  result: "forgotten" | "not-found";
  snapshot: PersonalMemoryDashboardSnapshot;
}

interface PersonalMemoryPendingApprovalResult {
  result: "approved" | "not-found";
  applied?: number;
  ignored?: number;
  blocked?: number;
  snapshot: PersonalMemoryDashboardSnapshot;
}

interface PersonalMemoryPendingRejectResult {
  result: "rejected" | "not-found";
  snapshot: PersonalMemoryDashboardSnapshot;
}

interface TurnTranscript {
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
    bundleId: string;
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
}

interface TurnReplay {
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

interface RouteOutcome {
  kind: RouteOutcomeKind;
  title: string;
  value: string;
  detail: string;
  tone: RouteOutcomeTone;
  source: string;
  routeLabel: string;
  state: string;
  denialKind?: string;
  policyKind?: string;
}

interface PermissionSummary {
  screenRecording: { state: PermissionState };
  accessibility: { state: PermissionState };
}

interface PermissionDiagnostics {
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

interface DesktopSessionStatus {
  frontmostBundleId?: string;
  frontmostLocalizedName?: string;
  frontmostProcessIdentifier?: number;
  controllable: boolean;
}

interface DesktopSessionDiagnostics {
  state: DesktopSessionDiagnosticState;
  status: DesktopSessionStatus | null;
  reason: string;
}

interface StartupWarning {
  id: StartupWarningId;
  title: string;
  message: string;
}

interface RuntimeStatus {
  stopTurnHotkey: {
    accelerator: string;
    label: string;
    registered: boolean;
  };
}

type BrowserContextBlockerCategory =
  | "internal-page"
  | "file-page"
  | "host-policy"
  | "site-access"
  | "content-script"
  | "screenshot"
  | "unsupported-scheme";

interface BrowserContextBlocker {
  category: BrowserContextBlockerCategory;
  label: string;
  detail?: string;
  nextAction?: string;
}

interface BrowserContextTabSummary {
  tabId: number;
  windowId?: number;
  active?: boolean;
  title?: string;
  url?: string;
  host?: string;
  scheme?: string;
  eligible: boolean;
  blocker?: string;
  blockerCategory?: BrowserContextBlockerCategory;
  nextAction?: string;
}

interface BrowserContextTabDiscoveryResult {
  result: "passed" | "blocked";
  tabs: BrowserContextTabSummary[];
  reason?: string;
  observedAt?: string;
}

interface BrowserContextSelectedTab {
  tabId: number;
  title?: string;
  host?: string;
  url?: string;
  scheme?: string;
  active?: boolean;
  observedAt?: string;
  freshnessSeconds?: number;
  blocker?: string;
  blockerCategory?: BrowserContextBlockerCategory;
  nextAction?: string;
}

type BrowserContextDiscoveryState = "passed" | "blocked" | "not-probed";

interface BrowserContextSourceSnapshot {
  schemaVersion: 1;
  selectedTab: BrowserContextSelectedTab | null;
  contextState: string;
  paused: boolean;
  disconnected: boolean;
  clearedForTurn: boolean;
  blockers: BrowserContextBlocker[];
  eligibleTabCount: number;
  discoveryState: BrowserContextDiscoveryState;
  discoveryReason?: string;
  discoveryObservedAt?: string;
  generatedAt: string;
}

type AutomationMonitorStatus =
  | "observing"
  | "needs_attention"
  | "blocked"
  | "idle"
  | "disabled"
  | "error"
  | "scheduler_inactive";
type AutomationSchedulerState = "active" | "inactive";
type AutomationMonitorLastResult = "observing" | "needs_attention" | "blocked" | "error";
type AutomationMonitorTriggerMode = "manual" | "scheduled" | "local-state";

interface AutomationMonitorSchedulerStatus {
  state: AutomationSchedulerState;
  scope: "app-process";
  owner: "skfiy";
  activeTimerCount: number;
  mutatesSession: false;
  startedAt?: string;
  reason?: string;
}

interface AutomationMonitorDefinitionPreview {
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

interface AutomationMonitorRuntime {
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

interface AutomationMonitorSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  activeCount: number;
  attentionCount: number;
  schedulerInactiveCount: number;
  scheduler: AutomationMonitorSchedulerStatus;
  monitors: AutomationMonitorRuntime[];
}

type AutomationRunState =
  | "queued"
  | "running"
  | "waiting"
  | "attention"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

type AutomationRunTrigger = "manual" | "scheduled" | "local-state" | "cli" | "mcp";

type AutomationRunCancellationSource = "pet" | "dashboard" | "cli" | "mcp";

interface AutomationRunTimelineEntry {
  at: string;
  step: string;
  detail?: string;
}

interface AutomationRunRecoveryProposal {
  proposalId: string;
  actionKind: "send_input" | "restart_step" | "collect_summary";
  reason: string;
  risk: "low" | "medium" | "high" | "blocked";
  mutatesSession: boolean;
}

interface AutomationRunVerification {
  at: string;
  kind: "tmux-observation" | "manual" | "none";
  status: "observing" | "needs_attention" | "blocked" | "error";
  summary: string;
  recoveryProposals?: AutomationRunRecoveryProposal[];
}

interface AutomationRunCancellation {
  requestedBy: AutomationRunCancellationSource;
  at: string;
}

interface AutomationRunConfig {
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

interface AutomationRunRecord {
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

interface AutomationRunSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  runs: AutomationRunRecord[];
}

interface PetAnimationState {
  row: number;
  frames: number;
  frameMs: number;
}

interface PetSkinManifest {
  displayName: string;
  slug: string;
  asset: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  source?: "custom-user";
  rendering?: {
    mode: "sprite-atlas" | "animated-raster";
    ambientMotion?: boolean;
    failureShake?: boolean;
  };
  layout?: {
    hitboxWidth: number;
    hitboxHeight: number;
    visualScale?: number;
  };
  states: Record<string, PetAnimationState>;
}

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface VisiblePetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DesktopApi {
  runCommand: (command: string, options: { mode: ManualMode }) => Promise<void>;
  approveTask: (input: TaskApprovalDecisionInput) => Promise<void>;
  denyTask: (input: TaskApprovalDecisionInput) => Promise<void>;
  takeScreenshot: () => Promise<void>;
  stopTask: () => Promise<void>;
  getPermissions: () => Promise<PermissionSummary>;
  getPermissionDiagnostics: () => Promise<PermissionDiagnostics>;
  getDesktopSessionDiagnostics: () => Promise<DesktopSessionDiagnostics>;
  getDiagnosticReport: () => Promise<DiagnosticReport>;
  getChromeCompatibility: () => Promise<ChromeCompatibilityHealth>;
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
  prepareTaskRecovery: (
    input: TaskControlRecoveryRequest
  ) => Promise<TaskControlRecoveryPreparationResult>;
  dispatchTaskRecovery: (
    input: TaskControlRecoveryRequest
  ) => Promise<TaskControlRecoveryDispatchResult>;
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
  getPetSkin: () => Promise<PetSkinManifest | null>;
  importPetSkin: () => Promise<PetSkinManifest | null>;
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
    includeMemory?: boolean;
  }) => Promise<ProfileExportBundle>;
  importProfile: (bundle: ProfileExportBundle) => Promise<ProfileRuntimeSnapshot>;
  onProfileChanged: (
    callback: (snapshot: ProfileRuntimeSnapshot) => void
  ) => () => void;
  exportData: (input?: { domains?: DataDomain[] }) => Promise<DataExportBundle>;
  previewRestoreData: (bundle: DataExportBundle) => Promise<DataRestorePreview>;
  restoreData: (preview: DataRestorePreview) => Promise<DataRestoreResult>;
  resetDataDomain: (input: {
    domain: DataDomain;
    confirm: true;
  }) => Promise<DataDomainResetResult>;
  getStorageHealth: () => Promise<StorageHealthSummary>;
  getRetention: () => Promise<RetentionSettings>;
  setRetention: (update: RetentionSettingsUpdate) => Promise<RetentionSettings>;
  applyRetention: () => Promise<ApplyRetentionResult>;
  onDataRestored: (callback: () => void) => () => void;
}

const taskStatuses = new Set<TaskStatus>([
  "idle",
  "planned",
  "waiting",
  "observing",
  "executing",
  "verifying",
  "running",
  "approval_required",
  "needs_confirmation",
  "needs_clarification",
  "completed",
  "denied",
  "blocked",
  "failed",
  "cancelled"
]);

function isTaskEvent(value: unknown): value is TaskEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TaskEvent>;
  const baseValid = (
    typeof candidate.status === "string"
    && taskStatuses.has(candidate.status)
    && (candidate.message === undefined || typeof candidate.message === "string")
    && (candidate.command === undefined || typeof candidate.command === "string")
    && (candidate.route === undefined || typeof candidate.route === "string")
    && (candidate.routeReason === undefined || typeof candidate.routeReason === "string")
    && (candidate.denialKind === undefined || typeof candidate.denialKind === "string")
    && (candidate.policyKind === undefined || typeof candidate.policyKind === "string")
    && (candidate.backgroundAgentFailure === undefined || candidate.backgroundAgentFailure === true)
    && (candidate.routeOutcome === undefined || isRouteOutcome(candidate.routeOutcome))
    && (
      candidate.taskControl === undefined
      || isTaskControlSnapshot(candidate.taskControl)
    )
    && (
      candidate.stopTurnBehavior === undefined
      || isTaskEventStopTurnBehavior(candidate.stopTurnBehavior)
    )
  );
  return baseValid;
}

function isConversationHistorySnapshot(value: unknown): value is ConversationHistorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const snapshot = value as Partial<ConversationHistorySnapshot>;
  return snapshot.schemaVersion === 1
    && (snapshot.lastActiveSessionId === null || isBoundedConversationText(snapshot.lastActiveSessionId))
    && Array.isArray(snapshot.sessions)
    && snapshot.sessions.every(isConversationSession);
}

function isConversationSession(value: unknown): value is ConversationSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const session = value as Partial<ConversationSession>;
  return isBoundedConversationText(session.id)
    && isBoundedConversationTitle(session.title)
    && (session.titleSource === "generated" || session.titleSource === "user")
    && isConversationTimestamp(session.createdAt)
    && isConversationTimestamp(session.updatedAt)
    && (session.archivedAt === undefined || isConversationTimestamp(session.archivedAt))
    && (session.deletedAt === undefined || isConversationTimestamp(session.deletedAt))
    && Array.isArray(session.turns)
    && session.turns.every(isConversationTurn);
}

function isConversationTurn(value: unknown): value is ConversationTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const turn = value as Partial<ConversationTurn>;
  return isBoundedConversationText(turn.id)
    && isBoundedConversationText(turn.submissionId)
    && typeof turn.attempt === "number"
    && Number.isInteger(turn.attempt)
    && turn.attempt > 0
    && (turn.retryOfTurnId === undefined || isBoundedConversationText(turn.retryOfTurnId))
    && (turn.retryRequestId === undefined || isBoundedConversationText(turn.retryRequestId))
    && isConversationTimestamp(turn.createdAt)
    && isConversationTimestamp(turn.updatedAt)
    && (
      turn.status === "pending"
      || turn.status === "completed"
      || turn.status === "provider-failed"
      || turn.status === "denied"
      || turn.status === "blocked"
      || turn.status === "failed"
      || turn.status === "cancelled"
      || turn.status === "stopped"
    )
    && isConversationProvider(turn.provider)
    && (
      turn.computerUseState === "none"
      || turn.computerUseState === "requested"
      || turn.computerUseState === "dispatching"
      || turn.computerUseState === "finished"
      || turn.computerUseState === "unknown"
    )
    && Array.isArray(turn.messages)
    && turn.messages.every(isConversationMessage);
}

function isConversationProvider(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const provider = value as { id?: unknown; label?: unknown };
  return isBoundedConversationText(provider.id) && isBoundedConversationText(provider.label);
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (
    !isBoundedConversationText(message.id)
    || !isBoundedConversationText(message.turnId)
    || !isConversationTimestamp(message.createdAt)
    || !isConversationBodyText(message.text)
  ) {
    return false;
  }

  if (message.kind === "user-text") return true;
  if (message.kind === "agent-reply") {
    return isConversationProvider(message.provider)
      && (message.state === "completed" || message.state === "error");
  }
  if (message.kind === "computer-use-request") {
    return isBoundedConversationText(message.toolCallId)
      && isConversationBodyText(message.command)
      && isBoundedConversationText(message.route);
  }
  if (message.kind === "approval") {
    return isBoundedConversationText(message.toolCallId)
      && (
        message.decision === "required"
        || message.decision === "approved"
        || message.decision === "denied"
        || message.decision === "bypassed"
      )
      && (message.reason === undefined || isConversationBodyText(message.reason));
  }
  if (message.kind === "result") {
    return isBoundedConversationText(message.toolCallId)
      && (
        message.status === "completed"
        || message.status === "denied"
        || message.status === "blocked"
        || message.status === "failed"
        || message.status === "cancelled"
      )
      && isConversationBodyText(message.summary);
  }
  if (message.kind === "stopped") {
    return isConversationBodyText(message.reason);
  }
  return false;
}

function isConversationRetryResult(value: unknown): value is ConversationRetryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<ConversationRetryResult>;
  return (
    result.status === "completed"
    || result.status === "provider-failed"
    || result.status === "cancelled"
    || result.status === "computer-use-blocked"
    || result.status === "unsafe-retry-blocked"
    || result.status === "not-found"
    || result.status === "retry-in-progress"
    || result.status === "storage-error"
  )
    && isConversationBodyText(result.message)
    && isConversationHistorySnapshot(result.snapshot);
}

function isBoundedConversationText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function isBoundedConversationTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 120;
}

function isConversationBodyText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 20_000;
}

function isConversationTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function requireConversationHistorySnapshot(value: unknown): ConversationHistorySnapshot {
  if (!isConversationHistorySnapshot(value)) {
    throw new Error("Conversation history payload is invalid.");
  }
  return value;
}

function readBoundedConversationText(value: unknown): string {
  return isBoundedConversationText(value) ? value.trim() : "";
}

function readBoundedConversationTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const title = value.trim().replace(/\s+/gu, " ");
  return title.length > 0 && title.length <= 120 ? title : "";
}

function createEmptyConversationHistorySnapshot(): ConversationHistorySnapshot {
  return {
    schemaVersion: 1,
    lastActiveSessionId: null,
    sessions: []
  };
}

function createConversationStorageErrorResult(): ConversationRetryResult {
  return {
    status: "storage-error",
    message: "Conversation history is unavailable.",
    snapshot: createEmptyConversationHistorySnapshot()
  };
}

const api: DesktopApi = {
  async runCommand(command, options) {
    await ipcRenderer.invoke("skfiy:run-command", command, options);
  },
  async approveTask(input) {
    const decision = requireTaskApprovalDecisionInput(input);
    await ipcRenderer.invoke("skfiy:approve-task", decision);
  },
  async denyTask(input) {
    const decision = requireTaskApprovalDecisionInput(input);
    await ipcRenderer.invoke("skfiy:deny-task", decision);
  },
  async takeScreenshot() {
    await ipcRenderer.invoke("skfiy:take-screenshot");
  },
  async stopTask() {
    await ipcRenderer.invoke("skfiy:stop-task");
  },
  async getPermissions() {
    const payload = await ipcRenderer.invoke("skfiy:get-permissions");
    return isPermissionSummary(payload) ? payload : createUnknownPermissionSummary();
  },
  async getPermissionDiagnostics() {
    const payload = await ipcRenderer.invoke("skfiy:get-permission-diagnostics");
    return isPermissionDiagnostics(payload)
      ? payload
      : createUnknownPermissionDiagnostics();
  },
  async getDesktopSessionDiagnostics() {
    const payload = await ipcRenderer.invoke("skfiy:get-desktop-session-diagnostics");
    return isDesktopSessionDiagnostics(payload)
      ? payload
      : createUnknownDesktopSessionDiagnostics();
  },
  async getDiagnosticReport() {
    const payload = await ipcRenderer.invoke("skfiy:get-diagnostic-report");
    return isDiagnosticReport(payload)
      ? payload
      : createUnknownDiagnosticReport();
  },
  async getChromeCompatibility() {
    const payload = await ipcRenderer.invoke("skfiy:get-chrome-compatibility");
    if (
      payload
      && typeof payload === "object"
      && !Array.isArray(payload)
      && "schemaVersion" in payload
      && payload.schemaVersion === 1
      && "compatibility" in payload
    ) {
      return payload as ChromeCompatibilityHealth;
    }
    return {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      appVersion: "unknown",
      nativeHost: { state: "unknown", installedSkfiyVersion: null, reason: "Compatibility data unavailable." },
      extension: { state: "unknown", version: null, source: "unknown" },
      compatibility: {
        state: "unknown",
        appVersion: "unknown",
        extensionVersion: null,
        minVersion: "0.0.16",
        maxTestedVersion: "0.0.17",
        reason: "Compatibility data unavailable."
      },
      staleness: { nativeHostStale: false, extensionStale: false, cliStale: false, helperStale: false }
    };
  },
  async openPermissionSettings(permission) {
    if (!isPermissionSettingsTarget(permission)) {
      return;
    }

    await ipcRenderer.invoke("skfiy:open-permission-settings", permission);
  },
  async getStartupWarnings() {
    const payload = await ipcRenderer.invoke("skfiy:get-startup-warnings");
    return Array.isArray(payload) ? payload.filter(isStartupWarning) : [];
  },
  async getAppPolicySettings() {
    const payload = await ipcRenderer.invoke("skfiy:get-app-policy-settings");
    return isAppPolicySettings(payload) ? payload : createDefaultAppPolicySettings();
  },
  async setAppPolicy(update) {
    const payload = await ipcRenderer.invoke("skfiy:set-app-policy", {
      bundleId: typeof update.bundleId === "string" ? update.bundleId : undefined,
      policy: isAppPolicy(update.policy) ? update.policy : undefined
    });
    return isAppPolicySettings(payload) ? payload : createDefaultAppPolicySettings();
  },
  async getAssistantAgentSettings() {
    const payload = await ipcRenderer.invoke("skfiy:get-assistant-agent-settings");
    return isAssistantAgentSettingsResponse(payload)
      ? payload
      : createDefaultAssistantAgentSettingsResponse();
  },
  async setAssistantAgentSettings(update) {
    const mode =
      update && typeof update === "object" && "mode" in update
        ? update.mode
        : undefined;
    const providerRuntime =
      update && typeof update === "object" && "providerRuntime" in update
        ? update.providerRuntime
        : undefined;
    const payload = await ipcRenderer.invoke("skfiy:set-assistant-agent-settings", {
      mode: isAssistantAgentMode(mode) ? mode : undefined,
      providerRuntime: isAssistantAgentProviderRuntimeUpdate(providerRuntime)
        ? providerRuntime
        : undefined
    });
    return isAssistantAgentSettingsResponse(payload)
      ? payload
      : createDefaultAssistantAgentSettingsResponse();
  },
  async testAssistantAgentProvider(input) {
    const mode =
      input && typeof input === "object" && "mode" in input
        ? input.mode
        : undefined;
    if (!isAssistantAgentMode(mode)) {
      throw new Error("Assistant agent provider test requires a valid mode.");
    }
    const payload = await ipcRenderer.invoke("skfiy:test-assistant-agent-provider", {
      mode
    });
    if (isAssistantAgentProviderState(payload)) {
      return payload;
    }
    throw new Error("Assistant agent provider test returned an invalid payload.");
  },
  async getFirstRunReadiness() {
    const payload = await ipcRenderer.invoke("skfiy:get-first-run-readiness");
    return isFirstRunReadinessSnapshot(payload)
      ? payload
      : createUnknownFirstRunReadinessSnapshot();
  },
  async testBackgroundAgent() {
    const payload = await ipcRenderer.invoke("skfiy:test-background-agent");
    return isFirstRunReadinessSnapshot(payload)
      ? payload
      : createUnknownFirstRunReadinessSnapshot();
  },
  async testFinderAutomation() {
    const payload = await ipcRenderer.invoke("skfiy:test-finder-automation");
    return isFirstRunReadinessSnapshot(payload)
      ? payload
      : createUnknownFirstRunReadinessSnapshot();
  },
  async getPlannerProviderSettings() {
    const payload = await ipcRenderer.invoke("skfiy:get-planner-provider-settings");
    return isPlannerProviderSettings(payload)
      ? payload
      : createDefaultPlannerProviderSettings();
  },
  async setPlannerProviderSettings(update) {
    const mode =
      update && typeof update === "object" && "mode" in update
        ? update.mode
        : undefined;
    const payload = await ipcRenderer.invoke("skfiy:set-planner-provider-settings", {
      mode: isPlannerProviderMode(mode) ? mode : undefined
    });
    return isPlannerProviderSettings(payload)
      ? payload
      : createDefaultPlannerProviderSettings();
  },
  async getConversationHistory() {
    const payload = await ipcRenderer.invoke("skfiy:get-conversation-history");
    return requireConversationHistorySnapshot(payload);
  },
  async startConversationSession() {
    const payload = await ipcRenderer.invoke("skfiy:start-conversation-session");
    return requireConversationHistorySnapshot(payload);
  },
  async switchConversationSession(sessionId) {
    const payload = await ipcRenderer.invoke(
      "skfiy:switch-conversation-session",
      readBoundedConversationText(sessionId)
    );
    return requireConversationHistorySnapshot(payload);
  },
  async renameConversationSession(input) {
    const payload = await ipcRenderer.invoke("skfiy:rename-conversation-session", {
      sessionId: readBoundedConversationText(input.sessionId),
      title: readBoundedConversationTitle(input.title)
    });
    return requireConversationHistorySnapshot(payload);
  },
  async archiveConversationSession(sessionId) {
    const payload = await ipcRenderer.invoke(
      "skfiy:archive-conversation-session",
      readBoundedConversationText(sessionId)
    );
    return requireConversationHistorySnapshot(payload);
  },
  async deleteConversationSession(sessionId) {
    const payload = await ipcRenderer.invoke(
      "skfiy:delete-conversation-session",
      readBoundedConversationText(sessionId)
    );
    return requireConversationHistorySnapshot(payload);
  },
  async restoreConversationSession(sessionId) {
    const payload = await ipcRenderer.invoke(
      "skfiy:restore-conversation-session",
      readBoundedConversationText(sessionId)
    );
    return requireConversationHistorySnapshot(payload);
  },
  async retryConversationTurn(input) {
    const payload = await ipcRenderer.invoke("skfiy:retry-conversation-turn", {
      sessionId: readBoundedConversationText(input.sessionId),
      turnId: readBoundedConversationText(input.turnId),
      requestId: readBoundedConversationText(input.requestId)
    });
    return isConversationRetryResult(payload)
      ? payload
      : createConversationStorageErrorResult();
  },
  async getTaskControl() {
    const payload = await ipcRenderer.invoke("skfiy:get-task-control");
    return isTaskControlSnapshot(payload) ? cloneTaskControlSnapshot(payload) : null;
  },
  async prepareTaskRecovery(input) {
    const request = requireTaskControlRecoveryRequest(input);
    const payload = await ipcRenderer.invoke("skfiy:prepare-task-recovery", request);
    return isTaskControlRecoveryPreparationResult(payload)
      && (
        payload.state === "rejected"
        || taskControlRecoveryRequestMatchesDescriptor(request, payload.descriptor)
      )
      ? cloneTaskControlRecoveryPreparationResult(payload)
      : {
          state: "rejected",
          code: "recovery-invalid-response",
          message: "Task recovery returned an invalid response and was not prepared."
        };
  },
  async dispatchTaskRecovery(input) {
    const request = requireTaskControlRecoveryRequest(input);
    const payload = await ipcRenderer.invoke("skfiy:dispatch-task-recovery", request);
    return isTaskControlRecoveryDispatchResult(payload)
      && (
        payload.state === "rejected"
        || taskControlRecoveryRequestMatchesDescriptor(request, payload.descriptor)
      )
      ? cloneTaskControlRecoveryDispatchResult(payload)
      : {
          state: "rejected",
          code: "recovery-dispatch-invalid-response",
          message: "Task recovery dispatch returned an invalid response and was not accepted."
        };
  },
  async getTurnReplay() {
    const payload = await ipcRenderer.invoke("skfiy:get-turn-replay");
    return isTurnReplay(payload) ? cloneTurnReplayTaskControls(payload) : null;
  },
  async getAutomationMonitors() {
    const payload = await ipcRenderer.invoke("skfiy:get-automation-monitors");
    return isAutomationMonitorSnapshot(payload)
      ? payload
      : createDefaultAutomationMonitorSnapshot();
  },
  async upsertTmuxMonitor(input) {
    const payload = await ipcRenderer.invoke("skfiy:upsert-tmux-monitor", {
      monitorId: typeof input.monitorId === "string" ? input.monitorId : undefined,
      sessionName: typeof input.sessionName === "string" ? input.sessionName : "",
      label: typeof input.label === "string" ? input.label : undefined,
      intervalMs: typeof input.intervalMs === "number" && Number.isFinite(input.intervalMs)
        ? input.intervalMs
        : 300_000,
      timeoutMs: typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? input.timeoutMs
        : undefined,
      triggerMode: input.triggerMode === "manual"
        || input.triggerMode === "scheduled"
        || input.triggerMode === "local-state"
        ? input.triggerMode
        : undefined,
      enabled: typeof input.enabled === "boolean" ? input.enabled : undefined
    });
    return isAutomationMonitorSnapshot(payload)
      ? payload
      : createDefaultAutomationMonitorSnapshot();
  },
  async duplicateAutomationMonitor(id) {
    const payload = await ipcRenderer.invoke(
      "skfiy:duplicate-automation-monitor",
      typeof id === "string" ? id : ""
    );
    return isAutomationMonitorSnapshot(payload)
      ? payload
      : createDefaultAutomationMonitorSnapshot();
  },
  async runAutomationMonitorNow(id) {
    const payload = await ipcRenderer.invoke(
      "skfiy:run-automation-monitor-now",
      typeof id === "string" ? id : ""
    );
    return isAutomationMonitorSnapshot(payload)
      ? payload
      : createDefaultAutomationMonitorSnapshot();
  },
  async setAutomationMonitorEnabled(id, enabled) {
    const payload = await ipcRenderer.invoke(
      "skfiy:set-automation-monitor-enabled",
      typeof id === "string" ? id : "",
      enabled === true
    );
    return isAutomationMonitorSnapshot(payload)
      ? payload
      : createDefaultAutomationMonitorSnapshot();
  },
  async deleteAutomationMonitor(id) {
    const payload = await ipcRenderer.invoke(
      "skfiy:delete-automation-monitor",
      typeof id === "string" ? id : ""
    );
    return isAutomationMonitorSnapshot(payload)
      ? payload
      : createDefaultAutomationMonitorSnapshot();
  },
  async previewTmuxAutomation(input) {
    const payload = await ipcRenderer.invoke("skfiy:preview-tmux-automation", {
      sessionName: typeof input.sessionName === "string" ? input.sessionName : "",
      timeoutMs: typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? input.timeoutMs
        : undefined,
      triggerMode: input.triggerMode === "manual"
        || input.triggerMode === "scheduled"
        || input.triggerMode === "local-state"
        ? input.triggerMode
        : undefined
    });
    return isAutomationMonitorDefinitionPreview(payload)
      ? payload
      : null;
  },
  async getAutomationRuns() {
    const payload = await ipcRenderer.invoke("skfiy:get-automation-runs");
    return isAutomationRunSnapshot(payload)
      ? payload
      : createDefaultAutomationRunSnapshot();
  },
  async stopAutomationRun(runId) {
    const payload = await ipcRenderer.invoke(
      "skfiy:stop-automation-run",
      typeof runId === "string" ? runId : ""
    );
    return isAutomationRunSnapshot(payload)
      ? payload
      : createDefaultAutomationRunSnapshot();
  },
  async getRuntimeStatus() {
    const payload = await ipcRenderer.invoke("skfiy:get-runtime-status");
    return isRuntimeStatus(payload)
      ? payload
      : {
        stopTurnHotkey: {
          accelerator: "",
          label: "",
          registered: false
        }
      };
  },
  async getPetSkin() {
    const payload = await ipcRenderer.invoke("skfiy:get-pet-skin");
    return isPetSkinManifest(payload) ? payload : null;
  },
  async importPetSkin() {
    const payload = await ipcRenderer.invoke("skfiy:import-pet-skin");
    return isPetSkinManifest(payload) ? payload : null;
  },
  async resetPetSkin() {
    await ipcRenderer.invoke("skfiy:reset-pet-skin");
  },
  async getWindowBounds() {
    const payload = await ipcRenderer.invoke("skfiy:get-window-bounds");
    return isWindowBounds(payload) ? payload : null;
  },
  moveWindowBy(deltaX, deltaY, visibleRect) {
    ipcRenderer.send("skfiy:move-window-by", deltaX, deltaY, readVisiblePetRect(visibleRect));
  },
  setWindowMode(mode) {
    ipcRenderer.send("skfiy:set-window-mode", mode);
  },
  onStopTurnHotkey(callback) {
    const listener = () => callback();

    ipcRenderer.on("skfiy:stop-turn-hotkey", listener);
    return () => ipcRenderer.removeListener("skfiy:stop-turn-hotkey", listener);
  },
  onTaskEvent(callback) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => {
      if (isTaskEvent(payload)) {
        callback(cloneTaskEventTaskControl(payload));
      }
    };

    ipcRenderer.on("skfiy:task-event", listener);
    return () => ipcRenderer.removeListener("skfiy:task-event", listener);
  },
  onConversationHistoryChanged(callback) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => {
      if (isConversationHistorySnapshot(payload)) {
        callback(payload);
      }
    };

    ipcRenderer.on("skfiy:conversation-history-changed", listener);
    return () => ipcRenderer.removeListener("skfiy:conversation-history-changed", listener);
  },
  async getPersonalMemory() {
    const payload = await ipcRenderer.invoke("skfiy:get-personal-memory");
    return isPersonalMemoryDashboardSnapshot(payload)
      ? payload
      : createDefaultPersonalMemoryDashboardSnapshot();
  },
  async setPersonalMemorySettings(update) {
    const payload = await ipcRenderer.invoke("skfiy:set-personal-memory-settings", {
      postTurnLearningEnabled: typeof update?.postTurnLearningEnabled === "boolean"
        ? update.postTurnLearningEnabled
        : undefined,
      writeApprovalEnabled: typeof update?.writeApprovalEnabled === "boolean"
        ? update.writeApprovalEnabled
        : undefined
    });
    return isPersonalMemorySettings(payload)
      ? payload
      : createDefaultPersonalMemorySettings();
  },
  async forgetPersonalMemory(input) {
    const payload = await ipcRenderer.invoke("skfiy:forget-personal-memory", {
      target: input.target === "user" || input.target === "agent" ? input.target : undefined,
      content: typeof input.content === "string" ? input.content : undefined
    });
    return isPersonalMemoryForgetResult(payload)
      ? payload
      : {
        result: "not-found",
        snapshot: createDefaultPersonalMemoryDashboardSnapshot()
      };
  },
  async approvePendingMemory(pendingId) {
    const payload = await ipcRenderer.invoke("skfiy:approve-pending-memory", {
      pendingId: typeof pendingId === "string" ? pendingId : undefined
    });
    return isPersonalMemoryPendingApprovalResult(payload)
      ? payload
      : {
        result: "not-found",
        snapshot: createDefaultPersonalMemoryDashboardSnapshot()
      };
  },
  async rejectPendingMemory(pendingId) {
    const payload = await ipcRenderer.invoke("skfiy:reject-pending-memory", {
      pendingId: typeof pendingId === "string" ? pendingId : undefined
    });
    return isPersonalMemoryPendingRejectResult(payload)
      ? payload
      : {
        result: "not-found",
        snapshot: createDefaultPersonalMemoryDashboardSnapshot()
      };
  },
  onPersonalMemoryChanged(callback) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => {
      if (isPersonalMemoryDashboardSnapshot(payload)) {
        callback(payload);
      }
    };

    ipcRenderer.on("skfiy:personal-memory-changed", listener);
    return () => ipcRenderer.removeListener("skfiy:personal-memory-changed", listener);
  },
  async getBrowserContextSource() {
    const payload = await ipcRenderer.invoke("skfiy:get-browser-context-source");
    return isBrowserContextSourceSnapshot(payload)
      ? payload
      : createUnknownBrowserContextSourceSnapshot();
  },
  async discoverBrowserTabs() {
    const payload = await ipcRenderer.invoke("skfiy:discover-browser-tabs");
    return isBrowserContextTabDiscoveryResult(payload)
      ? payload
      : { result: "blocked" as const, reason: "Tab discovery is unavailable.", tabs: [] };
  },
  async selectBrowserTab(input) {
    const payload = await ipcRenderer.invoke("skfiy:select-browser-tab", {
      tabId: typeof input?.tabId === "number" ? input.tabId : undefined
    });
    return isBrowserContextSourceSnapshot(payload)
      ? payload
      : createUnknownBrowserContextSourceSnapshot();
  },
  async refreshBrowserContext() {
    const payload = await ipcRenderer.invoke("skfiy:refresh-browser-context");
    return isBrowserContextSourceSnapshot(payload)
      ? payload
      : createUnknownBrowserContextSourceSnapshot();
  },
  async pauseBrowserContext() {
    const payload = await ipcRenderer.invoke("skfiy:pause-browser-context");
    return isBrowserContextSourceSnapshot(payload)
      ? payload
      : createUnknownBrowserContextSourceSnapshot();
  },
  async disconnectBrowserContext() {
    const payload = await ipcRenderer.invoke("skfiy:disconnect-browser-context");
    return isBrowserContextSourceSnapshot(payload)
      ? payload
      : createUnknownBrowserContextSourceSnapshot();
  },
  async clearBrowserContext() {
    const payload = await ipcRenderer.invoke("skfiy:clear-browser-context");
    return isBrowserContextSourceSnapshot(payload)
      ? payload
      : createUnknownBrowserContextSourceSnapshot();
  },
  onBrowserContextChanged(callback) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => {
      if (isBrowserContextSourceSnapshot(payload)) {
        callback(payload);
      }
    };

    ipcRenderer.on("skfiy:browser-context-changed", listener);
    return () => ipcRenderer.removeListener("skfiy:browser-context-changed", listener);
  },
  async getProfiles() {
    const payload = await ipcRenderer.invoke("skfiy:get-profiles");
    return isProfileRuntimeSnapshot(payload)
      ? payload
      : createDefaultProfileRuntimeSnapshot();
  },
  async switchProfile(input) {
    const payload = await ipcRenderer.invoke("skfiy:switch-profile", {
      profileId: typeof input?.profileId === "string" ? input.profileId : undefined,
      confirm: input?.confirm === true
    });
    return isProfileSwitchResult(payload)
      ? payload
      : {
          status: "blocked",
          profileId: typeof input?.profileId === "string" ? input.profileId : "",
          reason: "Profile switch is unavailable in this renderer environment."
        };
  },
  async createProfile(input) {
    const payload = await ipcRenderer.invoke("skfiy:create-profile", {
      name: typeof input?.name === "string" ? input.name : undefined,
      memoryScope: input?.memoryScope,
      cloneFromActive: input?.cloneFromActive === true,
      ...(input?.defaultManualMode !== undefined
        ? { defaultManualMode: input.defaultManualMode }
        : {})
    });
    return isProfileRuntimeSnapshot(payload)
      ? payload
      : createDefaultProfileRuntimeSnapshot();
  },
  async updateProfile(input) {
    const payload = await ipcRenderer.invoke("skfiy:update-profile", {
      profileId: typeof input?.profileId === "string" ? input.profileId : undefined,
      ...(typeof input?.name === "string" ? { name: input.name } : {})
    });
    return isProfileRuntimeSnapshot(payload)
      ? payload
      : createDefaultProfileRuntimeSnapshot();
  },
  async deleteProfile(profileId) {
    const payload = await ipcRenderer.invoke("skfiy:delete-profile", {
      profileId: typeof profileId === "string" ? profileId : undefined
    });
    return isProfileRuntimeSnapshot(payload)
      ? payload
      : createDefaultProfileRuntimeSnapshot();
  },
  async exportProfile(input) {
    const payload = await ipcRenderer.invoke("skfiy:export-profile", {
      profileId: typeof input?.profileId === "string" ? input.profileId : undefined,
      includeMemory: input?.includeMemory === true
    });
    if (!isProfileExportBundle(payload)) {
      throw new Error("Profile export is unavailable in this renderer environment.");
    }
    return payload;
  },
  async importProfile(bundle) {
    const payload = await ipcRenderer.invoke("skfiy:import-profile", bundle);
    return isProfileRuntimeSnapshot(payload)
      ? payload
      : createDefaultProfileRuntimeSnapshot();
  },
  onProfileChanged(callback) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => {
      if (isProfileRuntimeSnapshot(payload)) {
        callback(payload);
      }
    };

    ipcRenderer.on("skfiy:profile-changed", listener);
    return () => ipcRenderer.removeListener("skfiy:profile-changed", listener);
  },
  async exportData(input) {
    const payload = await ipcRenderer.invoke("skfiy:export-data", {
      domains: Array.isArray(input?.domains) ? input.domains : undefined
    });
    if (!isDataExportBundle(payload)) {
      throw new Error("Data export is unavailable in this renderer environment.");
    }
    return payload;
  },
  async previewRestoreData(bundle) {
    const payload = await ipcRenderer.invoke("skfiy:preview-restore-data", bundle);
    if (!isDataRestorePreview(payload)) {
      throw new Error("Restore preview is unavailable in this renderer environment.");
    }
    return payload;
  },
  async restoreData(preview) {
    const payload = await ipcRenderer.invoke("skfiy:restore-data", preview);
    if (!isDataRestoreResult(payload)) {
      throw new Error("Data restore is unavailable in this renderer environment.");
    }
    return payload;
  },
  async resetDataDomain(input) {
    const payload = await ipcRenderer.invoke("skfiy:reset-data-domain", {
      domain: typeof input?.domain === "string" ? input.domain : undefined,
      confirm: input?.confirm === true
    });
    if (!isDataDomainResetResult(payload)) {
      throw new Error("Data domain reset is unavailable in this renderer environment.");
    }
    return payload;
  },
  async getStorageHealth() {
    const payload = await ipcRenderer.invoke("skfiy:get-storage-health");
    if (!isStorageHealthSummary(payload)) {
      throw new Error("Storage health is unavailable in this renderer environment.");
    }
    return payload;
  },
  async getRetention() {
    const payload = await ipcRenderer.invoke("skfiy:get-retention");
    if (!isRetentionSettings(payload)) {
      throw new Error("Retention settings are unavailable in this renderer environment.");
    }
    return payload;
  },
  async setRetention(update) {
    const payload = await ipcRenderer.invoke("skfiy:set-retention", update);
    if (!isRetentionSettings(payload)) {
      throw new Error("Retention settings are unavailable in this renderer environment.");
    }
    return payload;
  },
  async applyRetention() {
    const payload = await ipcRenderer.invoke("skfiy:apply-retention");
    if (!isApplyRetentionResult(payload)) {
      throw new Error("Retention enforcement is unavailable in this renderer environment.");
    }
    return payload;
  },
  onDataRestored(callback) {
    const listener = () => {
      callback();
    };
    ipcRenderer.on("skfiy:data-restored", listener);
    return () => ipcRenderer.removeListener("skfiy:data-restored", listener);
  }
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const browserContextBlockerCategories = new Set<BrowserContextBlockerCategory>([
  "internal-page",
  "file-page",
  "host-policy",
  "site-access",
  "content-script",
  "screenshot",
  "unsupported-scheme"
]);

function createUnknownBrowserContextSourceSnapshot(): BrowserContextSourceSnapshot {
  return {
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
}

function isBrowserContextBlocker(value: unknown): value is BrowserContextBlocker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.category === "string"
    && browserContextBlockerCategories.has(record.category as BrowserContextBlockerCategory)
    && typeof record.label === "string"
    && (record.detail === undefined || typeof record.detail === "string")
    && (record.nextAction === undefined || typeof record.nextAction === "string");
}

function isBrowserContextTabSummary(value: unknown): value is BrowserContextTabSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.tabId === "number"
    && Number.isInteger(record.tabId)
    && typeof record.eligible === "boolean"
    && (record.windowId === undefined || typeof record.windowId === "number")
    && (record.active === undefined || typeof record.active === "boolean")
    && (record.title === undefined || typeof record.title === "string")
    && (record.url === undefined || typeof record.url === "string")
    && (record.host === undefined || typeof record.host === "string")
    && (record.scheme === undefined || typeof record.scheme === "string")
    && (record.blocker === undefined || typeof record.blocker === "string")
    && (record.blockerCategory === undefined
      || (typeof record.blockerCategory === "string"
        && browserContextBlockerCategories.has(record.blockerCategory as BrowserContextBlockerCategory)))
    && (record.nextAction === undefined || typeof record.nextAction === "string");
}

function isBrowserContextTabDiscoveryResult(
  value: unknown
): value is BrowserContextTabDiscoveryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (record.result === "passed" || record.result === "blocked")
    && Array.isArray(record.tabs)
    && record.tabs.every(isBrowserContextTabSummary)
    && (record.reason === undefined || typeof record.reason === "string")
    && (record.observedAt === undefined || typeof record.observedAt === "string");
}

function isBrowserContextSourceSnapshot(
  value: unknown
): value is BrowserContextSourceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || typeof record.contextState !== "string"
    || typeof record.paused !== "boolean"
    || typeof record.disconnected !== "boolean"
    || typeof record.clearedForTurn !== "boolean"
    || typeof record.eligibleTabCount !== "number"
    || typeof record.generatedAt !== "string"
    || !Array.isArray(record.blockers)
    || !record.blockers.every(isBrowserContextBlocker)
  ) {
    return false;
  }

  if (
    record.discoveryState !== "passed"
    && record.discoveryState !== "blocked"
    && record.discoveryState !== "not-probed"
  ) {
    return false;
  }

  if (record.selectedTab === null) {
    return true;
  }

  return isBrowserContextSelectedTab(record.selectedTab);
}

function isBrowserContextSelectedTab(value: unknown): value is BrowserContextSelectedTab {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.tabId === "number"
    && Number.isInteger(record.tabId)
    && (record.title === undefined || typeof record.title === "string")
    && (record.host === undefined || typeof record.host === "string")
    && (record.url === undefined || typeof record.url === "string")
    && (record.scheme === undefined || typeof record.scheme === "string")
    && (record.active === undefined || typeof record.active === "boolean")
    && (record.observedAt === undefined || typeof record.observedAt === "string")
    && (record.freshnessSeconds === undefined || typeof record.freshnessSeconds === "number")
    && (record.blocker === undefined || typeof record.blocker === "string")
    && (record.blockerCategory === undefined
      || (typeof record.blockerCategory === "string"
        && browserContextBlockerCategories.has(record.blockerCategory as BrowserContextBlockerCategory)))
    && (record.nextAction === undefined || typeof record.nextAction === "string");
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isWindowBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== "object") {
    return false;
  }

  const bounds = value as Partial<WindowBounds>;
  return (
    typeof bounds.x === "number"
    && Number.isFinite(bounds.x)
    && typeof bounds.y === "number"
    && Number.isFinite(bounds.y)
    && typeof bounds.width === "number"
    && Number.isFinite(bounds.width)
    && typeof bounds.height === "number"
    && Number.isFinite(bounds.height)
  );
}

function readVisiblePetRect(value: unknown): VisiblePetRect | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const rect = value as Partial<VisiblePetRect>;

  if (
    typeof rect.x !== "number"
    || !Number.isFinite(rect.x)
    || typeof rect.y !== "number"
    || !Number.isFinite(rect.y)
    || typeof rect.width !== "number"
    || !Number.isFinite(rect.width)
    || rect.width <= 0
    || typeof rect.height !== "number"
    || !Number.isFinite(rect.height)
    || rect.height <= 0
  ) {
    return undefined;
  }

  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  };
}

function isAppPolicySettings(value: unknown): value is AppPolicySettings {
  if (!value || typeof value !== "object") {
    return false;
  }

  const settings = value as Partial<AppPolicySettings>;
  return Array.isArray(settings.apps) && settings.apps.every(isControlledAppPolicyEntry);
}

function isControlledAppPolicyEntry(value: unknown): value is ControlledAppPolicyEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<ControlledAppPolicyEntry>;
  return (
    typeof entry.name === "string"
    && typeof entry.bundleId === "string"
    && isAppPolicy(entry.policy)
  );
}

function isAppPolicy(value: unknown): value is AppPolicy {
  return value === "allow" || value === "ask" || value === "deny";
}

function isAssistantAgentSettingsResponse(value: unknown): value is AssistantAgentSettingsResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const response = value as Partial<AssistantAgentSettingsResponse>;
  return isAssistantAgentSettings(response.settings)
    && Array.isArray(response.providers)
    && response.providers.every(isAssistantAgentProviderState)
    && (
      response.fallback === undefined
      || isAssistantAgentProviderFallback(response.fallback)
    );
}

function isAssistantAgentSettings(value: unknown): value is AssistantAgentSettings {
  if (!value || typeof value !== "object") {
    return false;
  }

  const settings = value as Partial<AssistantAgentSettings>;
  return (
    isAssistantAgentMode(settings.mode)
    && typeof settings.codexBinary === "string"
    && isAssistantAgentCliBinarySource(settings.codexBinarySource)
    && typeof settings.claudeCodeBinary === "string"
    && isAssistantAgentCliBinarySource(settings.claudeCodeBinarySource)
    && typeof settings.hermesBinary === "string"
    && isAssistantAgentCliBinarySource(settings.hermesBinarySource)
    && typeof settings.cwd === "string"
    && typeof settings.timeoutMs === "number"
    && Number.isFinite(settings.timeoutMs)
    && settings.timeoutMs > 0
    && (
      settings.providerRuntime === undefined
      || isAssistantAgentProviderRuntimeUpdate(settings.providerRuntime)
    )
  );
}

function isAssistantAgentProviderRuntimeUpdate(
  value: unknown
): value is Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.entries(value as Record<string, unknown>).every(([mode, runtime]) => {
    if (!isAssistantAgentMode(mode) || !runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
      return false;
    }
    const candidate = runtime as Record<string, unknown>;
    return (
      (candidate.cwd === undefined || typeof candidate.cwd === "string")
      && (
        candidate.timeoutMs === undefined
        || (
          typeof candidate.timeoutMs === "number"
          && Number.isFinite(candidate.timeoutMs)
          && candidate.timeoutMs > 0
        )
      )
    );
  });
}

function isAssistantAgentProviderFallback(
  value: unknown
): value is AssistantAgentProviderFallback {
  if (!value || typeof value !== "object") {
    return false;
  }

  const fallback = value as Partial<AssistantAgentProviderFallback>;
  if (fallback.kind === "fallback") {
    return isAssistantAgentMode(fallback.requestedMode)
      && isAssistantAgentMode(fallback.activeMode)
      && typeof fallback.reason === "string";
  }
  if (fallback.kind === "offline") {
    return isAssistantAgentMode(fallback.requestedMode)
      && typeof fallback.reason === "string";
  }
  return false;
}

function isAssistantAgentProviderState(value: unknown): value is AssistantAgentProviderState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<AssistantAgentProviderState>;
  return (
    state.provider === "assistant"
    && isAssistantAgentMode(state.id)
    && isAssistantAgentProviderLabel(state.label)
    && typeof state.selected === "boolean"
    && typeof state.configured === "boolean"
    && (
      state.executablePath === undefined
      || typeof state.executablePath === "string"
    )
    && isAssistantAgentExecutableSource(state.executableSource)
    && (
      state.resolvedExecutablePath === undefined
      || typeof state.resolvedExecutablePath === "string"
    )
    && isAssistantAgentProviderReadiness(state.readiness)
    && (
      state.readinessDetail === undefined
      || typeof state.readinessDetail === "string"
    )
    && (
      state.version === undefined
      || typeof state.version === "string"
    )
    && (
      state.lastError === undefined
      || typeof state.lastError === "string"
    )
  );
}

function isAssistantAgentProviderLabel(value: unknown): value is AssistantAgentProviderLabel {
  return value === "Codex" || value === "Claude Code" || value === "Hermes";
}

function isAssistantAgentMode(value: unknown): value is AssistantAgentMode {
  return value === "codex" || value === "claude-code" || value === "hermes";
}

function isAssistantAgentCliBinarySource(value: unknown): value is "default" | "env" {
  return value === "default" || value === "env";
}

function isAssistantAgentExecutableSource(value: unknown): value is AssistantAgentExecutableSource {
  return isAssistantAgentCliBinarySource(value);
}

function isAssistantAgentProviderReadiness(value: unknown): value is AssistantAgentProviderReadiness {
  return value === "chat-ready"
    || value === "version-ok"
    || value === "binary-found"
    || value === "binary-configured"
    || value === "auth-or-permission-blocked"
    || value === "unconfigured"
    || value === "unavailable";
}

function isFirstRunReadinessSnapshot(value: unknown): value is FirstRunReadinessSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Partial<FirstRunReadinessSnapshot>;
  return snapshot.schemaVersion === 1
    && typeof snapshot.chatReady === "boolean"
    && typeof snapshot.computerUseReady === "boolean"
    && Array.isArray(snapshot.readyWorkflows)
    && snapshot.readyWorkflows.every(isFirstRunReadyWorkflow)
    && (snapshot.resumeStepId === null || isFirstRunReadinessStepId(snapshot.resumeStepId))
    && Array.isArray(snapshot.steps)
    && snapshot.steps.length === 5
    && snapshot.steps.every(isFirstRunReadinessStep);
}

function isFirstRunReadinessStep(value: unknown): value is FirstRunReadinessStep {
  if (!value || typeof value !== "object") {
    return false;
  }

  const step = value as Partial<FirstRunReadinessStep>;
  const readyShape = step.state === "ready"
    ? step.reason === undefined && step.nextAction === undefined
    : typeof step.reason === "string" && typeof step.nextAction === "string";

  return isFirstRunReadinessStepId(step.id)
    && isFirstRunReadinessRequirement(step.requirement)
    && isFirstRunReadinessState(step.state)
    && readyShape;
}

function isFirstRunReadinessStepId(value: unknown): value is FirstRunReadinessStepId {
  return value === "background-agent"
    || value === "screen-recording"
    || value === "accessibility"
    || value === "finder-automation"
    || value === "browser-context";
}

function isFirstRunReadinessRequirement(value: unknown): value is FirstRunReadinessRequirement {
  return value === "required-for-chat" || value === "computer-use" || value === "optional";
}

function isFirstRunReadinessState(value: unknown): value is FirstRunReadinessState {
  return value === "ready"
    || value === "action-required"
    || value === "blocked"
    || value === "unknown";
}

function isFirstRunReadyWorkflow(value: unknown): value is FirstRunReadyWorkflow {
  return value === "chat"
    || value === "computer-use"
    || value === "finder"
    || value === "browser-context";
}

function isPlannerProviderSettings(value: unknown): value is PlannerProviderSettings {
  if (!value || typeof value !== "object") {
    return false;
  }

  const settings = value as Partial<PlannerProviderSettings>;
  return (
    isPlannerProviderMode(settings.mode)
    && typeof settings.externalProviderLabel === "string"
    && (
      settings.externalEndpoint === undefined
      || typeof settings.externalEndpoint === "string"
    )
    && typeof settings.externalApiKeyConfigured === "boolean"
  );
}

function isPlannerProviderMode(value: unknown): value is PlannerProviderMode {
  return (
    value === "local-deterministic"
    || value === "external-cua"
    || value === "disabled"
  );
}

function isTurnReplay(value: unknown): value is TurnReplay {
  if (!value || typeof value !== "object") {
    return false;
  }

  const replay = value as Partial<TurnReplay>;
  return isTurnTranscript(replay.transcript) && Array.isArray(replay.timeline)
    && replay.timeline.every(isTurnReplayTimelineEvent)
    && (replay.routeOutcome === undefined || isRouteOutcome(replay.routeOutcome));
}

function isTurnTranscript(value: unknown): value is TurnTranscript {
  if (!value || typeof value !== "object") {
    return false;
  }

  const transcript = value as Partial<TurnTranscript>;
  return (
    (transcript.command === undefined || typeof transcript.command === "string")
    && (transcript.risk === undefined || isRiskDecision(transcript.risk))
    && (transcript.planner === undefined || isTurnTranscriptPlanner(transcript.planner))
    && typeof transcript.approvalRequired === "boolean"
    && Array.isArray(transcript.apps)
    && transcript.apps.every(isTurnTranscriptApp)
    && Array.isArray(transcript.screenshots)
    && transcript.screenshots.every(isTurnTranscriptScreenshot)
    && Array.isArray(transcript.actions)
    && transcript.actions.every(isTurnTranscriptAction)
    && isTurnTranscriptOutcome(transcript.outcome)
  );
}

function isTurnTranscriptPlanner(value: unknown): value is NonNullable<TurnTranscript["planner"]> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const planner = value as NonNullable<TurnTranscript["planner"]>;
  return (
    typeof planner.providerLabel === "string"
    && typeof planner.input === "string"
    && typeof planner.command === "string"
    && (planner.rationale === undefined || typeof planner.rationale === "string")
  );
}

function isRiskDecision(value: unknown): value is TurnTranscript["risk"] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const risk = value as NonNullable<TurnTranscript["risk"]>;
  return (
    isRiskLevel(risk.level)
    && typeof risk.reason === "string"
    && typeof risk.requiresApproval === "boolean"
  );
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "blocked";
}

function isTurnTranscriptApp(value: unknown): value is TurnTranscript["apps"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const app = value as TurnTranscript["apps"][number];
  return (
    typeof app.name === "string"
    && (app.bundleId === undefined || typeof app.bundleId === "string")
    && (app.pid === undefined || typeof app.pid === "number")
  );
}

function isTurnTranscriptScreenshot(
  value: unknown
): value is TurnTranscript["screenshots"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const screenshot = value as TurnTranscript["screenshots"][number];
  return (
    (screenshot.stage === "before" || screenshot.stage === "after")
    && typeof screenshot.path === "string"
    && typeof screenshot.bundleId === "string"
    && (screenshot.pid === undefined || typeof screenshot.pid === "number")
    && (
      screenshot.accessibilityTrusted === undefined
      || typeof screenshot.accessibilityTrusted === "boolean"
    )
    && (
      screenshot.grounding === undefined
      || isTurnTranscriptGrounding(screenshot.grounding)
    )
  );
}

function isTurnTranscriptGrounding(
  value: unknown
): value is NonNullable<TurnTranscript["screenshots"][number]["grounding"]> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const grounding = value as NonNullable<TurnTranscript["screenshots"][number]["grounding"]>;
  return (
    typeof grounding.recommendation === "string"
    && Array.isArray(grounding.sources)
    && grounding.sources.every(isTurnTranscriptGroundingSource)
  );
}

function isTurnTranscriptGroundingSource(
  value: unknown
): value is NonNullable<TurnTranscript["screenshots"][number]["grounding"]>["sources"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const source =
    value as NonNullable<TurnTranscript["screenshots"][number]["grounding"]>["sources"][number];
  return (
    typeof source.source === "string"
    && typeof source.status === "string"
    && typeof source.observedElementCount === "number"
    && typeof source.labelCount === "number"
    && (source.notes === undefined
      || (Array.isArray(source.notes) && source.notes.every((note) => typeof note === "string")))
  );
}

function isTurnTranscriptAction(value: unknown): value is TurnTranscript["actions"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const action = value as TurnTranscript["actions"][number];
  return (
    typeof action.type === "string"
    && (action.appName === undefined || typeof action.appName === "string")
    && (action.bundleId === undefined || typeof action.bundleId === "string")
    && (action.pid === undefined || typeof action.pid === "number")
    && (action.turnId === undefined || typeof action.turnId === "string")
    && (action.toolCallId === undefined || typeof action.toolCallId === "string")
    && (action.route === undefined || typeof action.route === "string")
    && (action.text === undefined || typeof action.text === "string")
    && (action.key === undefined || typeof action.key === "string")
    && (action.action === undefined || typeof action.action === "string")
    && (action.actionType === undefined || typeof action.actionType === "string")
    && (action.status === undefined || typeof action.status === "string")
    && (action.stage === undefined || typeof action.stage === "string")
    && (action.message === undefined || typeof action.message === "string")
    && (action.reason === undefined || typeof action.reason === "string")
    && (action.decision === undefined || typeof action.decision === "string")
    && (action.summary === undefined || typeof action.summary === "string")
    && (action.evidenceSummary === undefined || typeof action.evidenceSummary === "string")
    && (action.artifactCount === undefined || typeof action.artifactCount === "number")
    && (action.providerLabel === undefined || typeof action.providerLabel === "string")
    && (action.command === undefined || typeof action.command === "string")
    && (action.rationale === undefined || typeof action.rationale === "string")
    && (action.from === undefined || typeof action.from === "string")
    && (action.to === undefined || typeof action.to === "string")
    && (action.source === undefined || typeof action.source === "string")
    && (action.frontmostBundleId === undefined || typeof action.frontmostBundleId === "string")
    && (action.targetPath === undefined || typeof action.targetPath === "string")
    && (action.selectedCount === undefined || typeof action.selectedCount === "number")
    && (action.rootPath === undefined || typeof action.rootPath === "string")
    && (action.operationCount === undefined || typeof action.operationCount === "number")
    && (action.destructiveOperationCount === undefined || typeof action.destructiveOperationCount === "number")
    && (action.createFolderCount === undefined || typeof action.createFolderCount === "number")
    && (action.moveFileCount === undefined || typeof action.moveFileCount === "number")
    && (action.copyFileCount === undefined || typeof action.copyFileCount === "number")
  );
}

function isTurnTranscriptOutcome(value: unknown): value is TurnTranscriptOutcome {
  return (
    value === "completed"
    || value === "approval_required"
    || value === "needs_confirmation"
    || value === "needs_clarification"
    || value === "verification_failed"
    || value === "denied"
    || value === "blocked"
    || value === "cancelled"
    || value === "failed"
    || value === "running"
  );
}

function isRouteOutcome(value: unknown): value is RouteOutcome {
  if (!value || typeof value !== "object") {
    return false;
  }

  const outcome = value as Partial<RouteOutcome>;
  return (
    isRouteOutcomeKind(outcome.kind)
    && typeof outcome.title === "string"
    && typeof outcome.value === "string"
    && typeof outcome.detail === "string"
    && isRouteOutcomeTone(outcome.tone)
    && typeof outcome.source === "string"
    && typeof outcome.routeLabel === "string"
    && typeof outcome.state === "string"
    && (outcome.denialKind === undefined || typeof outcome.denialKind === "string")
    && (outcome.policyKind === undefined || typeof outcome.policyKind === "string")
  );
}

function isRouteOutcomeKind(value: unknown): value is RouteOutcomeKind {
  return typeof value === "string" && routeOutcomeKinds.has(value as RouteOutcomeKind);
}

function isRouteOutcomeTone(value: unknown): value is RouteOutcomeTone {
  return typeof value === "string" && routeOutcomeTones.has(value as RouteOutcomeTone);
}

function isTaskEventStopTurnBehavior(value: unknown): value is TaskEventStopTurnBehavior {
  if (!value || typeof value !== "object") {
    return false;
  }

  const behavior = value as Partial<TaskEventStopTurnBehavior>;
  return (
    (behavior.result === undefined || typeof behavior.result === "string")
    && (behavior.source === undefined || typeof behavior.source === "string")
    && (behavior.command === undefined || typeof behavior.command === "string")
    && (behavior.beforeStatus === undefined || typeof behavior.beforeStatus === "string")
    && (behavior.beforeMessage === undefined || typeof behavior.beforeMessage === "string")
    && (behavior.afterStatus === undefined || typeof behavior.afterStatus === "string")
    && (behavior.afterMessage === undefined || typeof behavior.afterMessage === "string")
  );
}

function isTurnReplayTimelineEvent(
  value: unknown
): value is TurnReplay["timeline"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const event = value as TurnReplay["timeline"][number];
  return (
    isTaskStatus(event.status)
    && (event.message === undefined || typeof event.message === "string")
    && (event.command === undefined || typeof event.command === "string")
    && (event.route === undefined || typeof event.route === "string")
    && (event.routeReason === undefined || typeof event.routeReason === "string")
    && (event.denialKind === undefined || typeof event.denialKind === "string")
    && (event.policyKind === undefined || typeof event.policyKind === "string")
    && (event.routeOutcome === undefined || isRouteOutcome(event.routeOutcome))
    && (
      event.taskControl === undefined
      || isTaskControlSnapshot(event.taskControl)
    )
    && (
      event.stopTurnBehavior === undefined
      || isTaskEventStopTurnBehavior(event.stopTurnBehavior)
    )
  );
}

function isTaskControlSnapshot(value: unknown): value is TaskControlSnapshot {
  const snapshot = readTaskControlRecord(value);
  if (!snapshot || !hasStrictTaskControlKeys(
    snapshot,
    taskControlSnapshotKeys,
    [
      "schemaVersion",
      "executionId",
      "phase",
      "status",
      "message",
      "plan",
      "sideEffectState",
      "replayAvailable",
      "recoveryActions"
    ]
  )) {
    return false;
  }

  if (
    snapshot.schemaVersion !== 1
    || !isTaskControlIdentifier(snapshot.executionId)
    || typeof snapshot.phase !== "string"
    || !taskControlPhases.has(snapshot.phase)
    || typeof snapshot.status !== "string"
    || !isTaskControlStatus(snapshot.status)
    || !isTaskControlText(snapshot.message, 2_000)
    || !isComputerUsePlanPreview(snapshot.plan)
    || typeof snapshot.sideEffectState !== "string"
    || !taskControlSideEffectStates.has(snapshot.sideEffectState)
    || typeof snapshot.replayAvailable !== "boolean"
    || !isTaskControlRecoveryActionList(snapshot.recoveryActions)
  ) {
    return false;
  }

  const plan = readTaskControlRecord(snapshot.plan)!;
  const executionPlanId = snapshot.executionPlanId;
  if (
    executionPlanId !== undefined
    && (
      !isTaskControlIdentifier(executionPlanId)
      || !isTaskControlExecutionPlanId(executionPlanId, plan)
    )
  ) {
    return false;
  }
  if (
    snapshot.failureStage !== undefined
    && !isTaskControlFailureStage(snapshot.failureStage)
  ) {
    return false;
  }
  if (
    snapshot.recoveryDescriptors !== undefined
    && !isTaskControlRecoveryDescriptorList(snapshot.recoveryDescriptors)
  ) {
    return false;
  }

  if (snapshot.phase === "terminal") {
    if (
      typeof snapshot.outcome !== "string"
      || !taskControlOutcomes.has(snapshot.outcome)
      || snapshot.status !== snapshot.outcome
      || snapshot.approval !== undefined
    ) {
      return false;
    }
    const descriptors = snapshot.recoveryDescriptors;
    if (descriptors === undefined) return true;
    if (!isTaskControlIdentifier(executionPlanId)) return false;
    if (snapshot.outcome === "completed") {
      return descriptors.length === 0
        && (snapshot.recoveryActions as unknown[]).length === 0
        && snapshot.failureStage === undefined;
    }
    if (!isTaskControlFailureStage(snapshot.failureStage) || descriptors.length === 0) {
      return false;
    }
    const actions = snapshot.recoveryActions as string[];
    return descriptors.length === actions.length
      && descriptors.every((descriptor, index) =>
        descriptor.action === actions[index]
        && descriptor.executionId === snapshot.executionId
        && descriptor.planId === executionPlanId
        && descriptor.route === plan.route
        && descriptor.outcome === snapshot.outcome
        && descriptor.failureStage === snapshot.failureStage
        && isTaskControlRecoveryActionAllowed(
          descriptor.action,
          descriptor.failureStage,
          descriptor.outcome,
          snapshot.sideEffectState as string
        )
      );
  }

  const approvalIsValid = snapshot.phase === "approval"
    ? isTaskControlApproval(snapshot.approval, snapshot.plan)
    : snapshot.approval === undefined;

  return approvalIsValid
    && snapshot.outcome === undefined
    && snapshot.failureStage === undefined
    && snapshot.status === taskControlActiveStatusByPhase[
      snapshot.phase as keyof typeof taskControlActiveStatusByPhase
    ]
    && snapshot.recoveryActions.length === 0
    && (
      snapshot.recoveryDescriptors === undefined
      || snapshot.recoveryDescriptors.length === 0
    )
    && (
      executionPlanId === undefined
      || snapshot.phase !== "approval"
      || executionPlanId === readTaskControlRecord(snapshot.approval)?.planId
    );
}

function isTaskControlApproval(value: unknown, planValue: unknown): boolean {
  const approval = readTaskControlRecord(value);
  const plan = readTaskControlRecord(planValue);
  if (!approval || !plan || !hasStrictTaskControlKeys(
    approval,
    taskControlApprovalKeys,
    ["gate", "planId"]
  )) {
    return false;
  }
  if (
    (
      approval.gate !== "action-plan"
      && approval.gate !== "finder-plan"
      && approval.gate !== "chrome-submit"
    )
    || !isTaskControlIdentifier(approval.planId)
    || !isTaskControlIdentifier(plan.planId)
  ) {
    return false;
  }

  if (approval.gate === "action-plan") {
    return approval.planId === plan.planId
      && approval.finderPlanPreview === undefined
      && approval.chromeSubmitBinding === undefined;
  }

  if (approval.gate === "chrome-submit") {
    return plan.route === "chrome"
      && approval.planId.startsWith(`${plan.planId}:`)
      && approval.finderPlanPreview === undefined
      && isTaskControlChromeSubmitBinding(approval.chromeSubmitBinding);
  }

  return approval.planId.startsWith(`${plan.planId}:`)
    && isTaskControlFinderPlanPreview(approval.finderPlanPreview)
    && approval.chromeSubmitBinding === undefined;
}

function isTaskControlChromeSubmitBinding(value: unknown): boolean {
  const binding = readTaskControlRecord(value);
  return Boolean(binding)
    && hasStrictTaskControlKeys(
      binding!,
      taskControlChromeSubmitBindingKeys,
      ["schemaVersion", "url", "fieldSelectors", "submitSelector"]
    )
    && binding!.schemaVersion === 1
    && isTaskControlText(binding!.url, 2_000)
    && isTaskControlTextList(binding!.fieldSelectors)
    && (binding!.fieldSelectors as unknown[]).length > 0
    && isTaskControlText(binding!.submitSelector, 2_000);
}

function isTaskControlFinderPlanPreview(value: unknown): boolean {
  const preview = readTaskControlRecord(value);
  if (!preview || !hasStrictTaskControlKeys(
    preview,
    taskControlFinderPreviewKeys,
    taskControlFinderPreviewRequiredKeys
  )) {
    return false;
  }

  return isTaskControlText(preview.rootPath, 2_000)
    && isTaskControlBoundedCount(preview.operationCount)
    && isTaskControlBoundedCount(preview.destructiveOperationCount)
    && (preview.destructiveOperationCount as number) <= (preview.operationCount as number)
    && isTaskControlTextList(preview.createFolders)
    && Array.isArray(preview.moveFiles)
    && preview.moveFiles.length <= 2_000
    && preview.moveFiles.every(isTaskControlFinderMove)
    && (preview.copyFiles === undefined || (
      Array.isArray(preview.copyFiles)
      && preview.copyFiles.length <= 2_000
      && preview.copyFiles.every(isTaskControlFinderMove)
    ));
}

function isTaskControlFinderMove(value: unknown): boolean {
  const move = readTaskControlRecord(value);
  return Boolean(move)
    && hasStrictTaskControlKeys(
      move!,
      taskControlFinderMoveKeys,
      [...taskControlFinderMoveKeys]
    )
    && isTaskControlText(move!.from, 2_000)
    && isTaskControlText(move!.to, 2_000);
}

function isTaskControlTextList(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= 2_000
    && value.every((entry) => isTaskControlText(entry, 2_000));
}

function isTaskControlBoundedCount(value: unknown): boolean {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= 2_000;
}

function isComputerUsePlanPreview(value: unknown): boolean {
  const plan = readTaskControlRecord(value);
  if (!plan || !hasStrictTaskControlKeys(
    plan,
    taskControlPlanKeys,
    [...taskControlPlanKeys]
  )) {
    return false;
  }

  const risk = readTaskControlRecord(plan.risk);
  if (!risk || !hasStrictTaskControlKeys(
    risk,
    taskControlRiskKeys,
    [...taskControlRiskKeys]
  )) {
    return false;
  }

  return isTaskControlIdentifier(plan.planId)
    && typeof plan.route === "string"
    && taskControlRoutes.has(plan.route)
    && isTaskControlText(plan.appName, 160)
    && isTaskControlText(plan.target, 2_000)
    && typeof risk.level === "string"
    && taskControlRiskLevels.has(risk.level)
    && isTaskControlText(risk.reason, 2_000)
    && typeof risk.requiresApproval === "boolean"
    && typeof plan.approvalRequired === "boolean"
    && isTaskControlText(plan.expectedVerification, 2_000)
    && typeof plan.mutating === "boolean"
    && (
      risk.level !== "blocked"
      || (plan.approvalRequired === false && plan.mutating === false)
    );
}

function isTaskControlStatus(value: string): boolean {
  return value === "waiting"
    || value === "approval_required"
    || value === "executing"
    || value === "verifying"
    || taskControlOutcomes.has(value);
}

function isTaskControlRecoveryActionList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > taskControlRecoveryActions.size) {
    return false;
  }

  const unique = new Set(value);
  return unique.size === value.length
    && value.every((action) => typeof action === "string" && taskControlRecoveryActions.has(action));
}

function isTaskControlFailureStage(value: unknown): value is TaskControlRecoveryDescriptor["failureStage"] {
  return typeof value === "string" && taskControlFailureStages.has(value);
}

function isTaskControlRecoveryDescriptor(
  value: unknown
): value is TaskControlRecoveryDescriptor {
  const descriptor = readTaskControlRecord(value);
  if (!descriptor || !hasStrictTaskControlKeys(
    descriptor,
    taskControlRecoveryDescriptorKeys,
    [...taskControlRecoveryDescriptorKeys]
  )) {
    return false;
  }
  return isTaskControlIdentifier(descriptor.recoveryId)
    && typeof descriptor.action === "string"
    && taskControlRecoveryActions.has(descriptor.action)
    && typeof descriptor.mode === "string"
    && taskControlRecoveryModes.has(descriptor.mode)
    && isTaskControlRecoveryModeForAction(descriptor.mode, descriptor.action)
    && isTaskControlIdentifier(descriptor.executionId)
    && isTaskControlIdentifier(descriptor.planId)
    && typeof descriptor.route === "string"
    && taskControlRoutes.has(descriptor.route)
    && typeof descriptor.outcome === "string"
    && descriptor.outcome !== "completed"
    && taskControlOutcomes.has(descriptor.outcome)
    && isTaskControlFailureStage(descriptor.failureStage);
}

function isTaskControlRecoveryDescriptorList(
  value: unknown
): value is TaskControlRecoveryDescriptor[] {
  if (!Array.isArray(value) || value.length > taskControlRecoveryActions.size) return false;
  const ids = new Set<string>();
  const actions = new Set<string>();
  for (const descriptor of value) {
    if (
      !isTaskControlRecoveryDescriptor(descriptor)
      || ids.has(descriptor.recoveryId)
      || actions.has(descriptor.action)
    ) {
      return false;
    }
    ids.add(descriptor.recoveryId);
    actions.add(descriptor.action);
  }
  return true;
}

function isTaskControlRecoveryModeForAction(mode: string, action: string): boolean {
  if (action === "open_readiness") return mode === "navigation";
  if (action === "revise_plan") return mode === "draft_only";
  return mode === "prepare_only";
}

function isTaskControlExecutionPlanId(
  executionPlanId: string,
  plan: Record<string, unknown>
): boolean {
  return executionPlanId === plan.planId
    || (
      plan.route === "finder"
      && typeof plan.planId === "string"
      && executionPlanId.startsWith(`${plan.planId}:`)
    );
}

function isTaskControlRecoveryActionAllowed(
  action: string,
  failureStage: string,
  outcome: string,
  sideEffectState: string
): boolean {
  if (outcome === "user_denied") {
    return failureStage === "approval" && action === "revise_plan";
  }
  if (outcome === "cancelled") return action === "revise_plan";
  if (outcome === "app_policy_denied" || outcome === "blocked") {
    return failureStage === "preflight"
      && (action === "revise_plan" || action === "open_readiness");
  }
  if (outcome === "confirmation_required") {
    return failureStage === "verification"
      && (
        action === "retry_observation"
        || action === "retry_verification"
        || action === "revise_plan"
      );
  }
  if (outcome !== "failed") return false;
  if (failureStage === "preflight") {
    return action === "revise_plan" || action === "open_readiness";
  }
  if (failureStage === "approval") return action === "revise_plan";
  if (failureStage === "observation") {
    return action === "retry_observation"
      || action === "revise_plan"
      || action === "open_readiness";
  }
  if (failureStage === "execution") {
    return action === "revise_plan"
      || (sideEffectState !== "none" && action === "retry_verification");
  }
  return failureStage === "verification"
    && (
      action === "retry_observation"
      || action === "retry_verification"
      || action === "revise_plan"
    );
}

function requireTaskControlRecoveryRequest(value: unknown): TaskControlRecoveryRequest {
  const request = readTaskControlRecord(value);
  if (!request || !hasStrictTaskControlKeys(
    request,
    taskControlRecoveryRequestKeys,
    [...taskControlRecoveryRequestKeys]
  )) {
    throw new Error("Task recovery request must include an exact bounded binding.");
  }
  const recoveryId = request.recoveryId;
  const action = request.action;
  const executionId = request.executionId;
  const planId = request.planId;
  const route = request.route;
  const outcome = request.outcome;
  const failureStage = request.failureStage;
  if (
    !isTaskControlIdentifier(recoveryId)
    || typeof action !== "string"
    || !taskControlRecoveryActions.has(action)
    || !isTaskControlIdentifier(executionId)
    || !isTaskControlIdentifier(planId)
    || typeof route !== "string"
    || !taskControlRoutes.has(route)
    || typeof outcome !== "string"
    || outcome === "completed"
    || !taskControlOutcomes.has(outcome)
    || !isTaskControlFailureStage(failureStage)
  ) {
    throw new Error("Task recovery request must match a known execution-bound descriptor.");
  }

  return {
    recoveryId: recoveryId as TaskControlRecoveryRequest["recoveryId"],
    action: action as TaskControlRecoveryRequest["action"],
    executionId: executionId as TaskControlRecoveryRequest["executionId"],
    planId: planId as TaskControlRecoveryRequest["planId"],
    route: route as TaskControlRecoveryRequest["route"],
    outcome: outcome as TaskControlRecoveryRequest["outcome"],
    failureStage
  };
}

function isTaskControlRecoveryPreparationResult(
  value: unknown
): value is TaskControlRecoveryPreparationResult {
  const result = readTaskControlRecord(value);
  if (!result || !hasStrictTaskControlKeys(
    result,
    taskControlRecoveryResultKeys,
    ["state", "code", "message"]
  ) || !isTaskControlText(result.message, 2_000)) {
    return false;
  }

  if (result.state === "prepared") {
    if (
      result.code !== "recovery-prepared"
      || !isTaskControlRecoveryDescriptor(result.descriptor)
    ) {
      return false;
    }
    return result.descriptor.mode === "draft_only"
      ? isTaskControlText(result.draft, 2_000)
      : result.draft === undefined;
  }

  return result.state === "rejected"
    && typeof result.code === "string"
    && result.code !== "recovery-prepared"
    && taskControlRecoveryResultCodes.has(result.code)
    && result.descriptor === undefined
    && result.draft === undefined;
}

function isTaskControlRecoveryDispatchResult(
  value: unknown
): value is TaskControlRecoveryDispatchResult {
  const result = readTaskControlRecord(value);
  if (!result || !hasStrictTaskControlKeys(
    result,
    taskControlRecoveryDispatchResultKeys,
    ["state", "code", "message"]
  ) || !isTaskControlText(result.message, 2_000)) {
    return false;
  }

  if (result.state === "dispatched") {
    return result.code === "recovery-dispatched"
      && isTaskControlRecoveryDescriptor(result.descriptor)
      && result.descriptor.mode === "prepare_only"
      && isTaskControlIdentifier(result.recoveryExecutionId);
  }

  return result.state === "rejected"
    && typeof result.code === "string"
    && result.code !== "recovery-dispatched"
    && taskControlRecoveryDispatchResultCodes.has(result.code)
    && result.descriptor === undefined
    && result.recoveryExecutionId === undefined;
}

function taskControlRecoveryRequestMatchesDescriptor(
  request: TaskControlRecoveryRequest,
  descriptor: TaskControlRecoveryDescriptor
): boolean {
  return request.recoveryId === descriptor.recoveryId
    && request.action === descriptor.action
    && request.executionId === descriptor.executionId
    && request.planId === descriptor.planId
    && request.route === descriptor.route
    && request.outcome === descriptor.outcome
    && request.failureStage === descriptor.failureStage;
}

function cloneTaskControlRecoveryDescriptor(
  descriptor: TaskControlRecoveryDescriptor
): TaskControlRecoveryDescriptor {
  return { ...descriptor };
}

function cloneTaskControlRecoveryPreparationResult(
  result: TaskControlRecoveryPreparationResult
): TaskControlRecoveryPreparationResult {
  return result.state === "prepared"
    ? {
        ...result,
        descriptor: { ...result.descriptor }
      }
    : { ...result };
}

function cloneTaskControlRecoveryDispatchResult(
  result: TaskControlRecoveryDispatchResult
): TaskControlRecoveryDispatchResult {
  return result.state === "dispatched"
    ? {
        ...result,
        descriptor: { ...result.descriptor }
      }
    : { ...result };
}

function isTaskControlIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function requireTaskApprovalDecisionInput(value: unknown): TaskApprovalDecisionInput {
  const input = readTaskControlRecord(value);
  if (!input || !hasStrictTaskControlKeys(
    input,
    taskApprovalDecisionKeys,
    [...taskApprovalDecisionKeys]
  ) || !isTaskControlIdentifier(input.executionId) || !isTaskControlIdentifier(input.planId)) {
    throw new Error("Task approval decision must be bound to a valid execution and plan.");
  }

  return {
    executionId: input.executionId,
    planId: input.planId
  };
}

function isTaskControlText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function readTaskControlRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasStrictTaskControlKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function cloneTaskControlSnapshot(snapshot: TaskControlSnapshot): TaskControlSnapshot {
  return {
    ...snapshot,
    plan: {
      ...snapshot.plan,
      risk: { ...snapshot.plan.risk }
    },
    recoveryActions: [...snapshot.recoveryActions],
    ...(snapshot.recoveryDescriptors ? {
      recoveryDescriptors: snapshot.recoveryDescriptors.map(cloneTaskControlRecoveryDescriptor)
    } : {}),
    ...(snapshot.approval ? { approval: cloneTaskControlApproval(snapshot.approval) } : {})
  };
}

function cloneTaskControlApproval(
  approval: NonNullable<TaskControlSnapshot["approval"]>
): NonNullable<TaskControlSnapshot["approval"]> {
  return {
    ...approval,
    ...(approval.finderPlanPreview ? {
      finderPlanPreview: {
        ...approval.finderPlanPreview,
        createFolders: [...approval.finderPlanPreview.createFolders],
        moveFiles: approval.finderPlanPreview.moveFiles.map((move) => ({ ...move })),
        ...(approval.finderPlanPreview.copyFiles ? {
          copyFiles: approval.finderPlanPreview.copyFiles.map((copy) => ({ ...copy }))
        } : {})
      }
    } : {}),
    ...(approval.chromeSubmitBinding ? {
      chromeSubmitBinding: {
        ...approval.chromeSubmitBinding,
        fieldSelectors: [...approval.chromeSubmitBinding.fieldSelectors]
      }
    } : {})
  };
}

function cloneTaskEventTaskControl(event: TaskEvent): TaskEvent {
  return event.taskControl
    ? { ...event, taskControl: cloneTaskControlSnapshot(event.taskControl) }
    : { ...event };
}

function cloneTurnReplayTaskControls(replay: TurnReplay): TurnReplay {
  return {
    ...replay,
    timeline: replay.timeline.map((event) => event.taskControl
      ? { ...event, taskControl: cloneTaskControlSnapshot(event.taskControl) }
      : { ...event })
  };
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && taskStatuses.has(value as TaskStatus);
}

function isPermissionSummary(value: unknown): value is PermissionSummary {
  if (!value || typeof value !== "object") {
    return false;
  }

  const summary = value as Partial<PermissionSummary>;
  return (
    isPermissionStatus(summary.screenRecording)
    && isPermissionStatus(summary.accessibility)
  );
}

function isPermissionDiagnostics(value: unknown): value is PermissionDiagnostics {
  if (!value || typeof value !== "object") {
    return false;
  }

  const diagnostics = value as Partial<PermissionDiagnostics>;
  return (
    isPermissionSummary(diagnostics.active)
    && isPermissionSummary(diagnostics.appProcess)
    && isPermissionSummary(diagnostics.helperProcess)
    && Array.isArray(diagnostics.mismatches)
    && diagnostics.mismatches.every(isPermissionMismatch)
    && isPermissionDiagnosticsIdentity(diagnostics.identity)
  );
}

function isPermissionMismatch(value: unknown): value is PermissionDiagnostics["mismatches"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const mismatch = value as Partial<PermissionDiagnostics["mismatches"][number]>;
  return (
    isPermissionDiagnosticsKey(mismatch.permission)
    && isPermissionState(mismatch.appProcess)
    && isPermissionState(mismatch.helperProcess)
  );
}

function isPermissionDiagnosticsKey(value: unknown): value is keyof PermissionSummary {
  return (
    value === "screenRecording"
    || value === "accessibility"
  );
}

function isPermissionDiagnosticsIdentity(
  value: unknown
): value is PermissionDiagnostics["identity"] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const identity = value as Partial<PermissionDiagnostics["identity"]>;
  return (
    typeof identity.appPath === "string"
    && typeof identity.executablePath === "string"
    && typeof identity.helperPath === "string"
    && typeof identity.resourcesPath === "string"
    && typeof identity.isPackaged === "boolean"
  );
}

function isDesktopSessionDiagnostics(value: unknown): value is DesktopSessionDiagnostics {
  if (!value || typeof value !== "object") {
    return false;
  }

  const diagnostics = value as Partial<DesktopSessionDiagnostics>;
  return (
    isDesktopSessionDiagnosticState(diagnostics.state)
    && (diagnostics.status === null || isDesktopSessionStatus(diagnostics.status))
    && typeof diagnostics.reason === "string"
  );
}

const DIAGNOSTIC_REPORT_BLOCKER_TYPES = new Set<string>([
  "desktop-session-locked",
  "desktop-session-asleep",
  "desktop-session-not-controllable",
  "desktop-session-unknown",
  "screen-recording-denied",
  "screen-recording-not-determined",
  "screen-recording-unknown",
  "accessibility-denied",
  "accessibility-not-determined",
  "accessibility-unknown",
  "permission-mismatch",
  "provider-unconfigured",
  "provider-unavailable",
  "provider-auth-blocked",
  "provider-not-proven",
  "provider-unknown",
  "chrome-native-host-missing",
  "chrome-native-host-mismatched",
  "chrome-native-host-cli-missing",
  "chrome-native-host-invalid",
  "chrome-host-policy-invalid",
  "chrome-extension-disconnected",
  "chrome-extension-stale",
  "chrome-extension-invalid",
  "browser-context-blocked",
  "browser-context-partial",
  "browser-context-not-probed",
  "browser-context-unknown",
  "finder-automation-denied",
  "finder-automation-not-tested",
  "finder-automation-test-failed"
]);

const DIAGNOSTIC_REPORT_SECTION_IDS = new Set<string>([
  "desktop-session",
  "permissions",
  "provider",
  "chrome",
  "browser-context",
  "finder-automation",
  "startup"
]);

const DIAGNOSTIC_COMPONENT_NAMES = new Set<string>([
  "app",
  "cli",
  "helper",
  "provider",
  "chrome-extension",
  "native-host"
]);

function isDiagnosticReportState(value: unknown): value is DiagnosticReportState {
  return value === "ready"
    || value === "action-required"
    || value === "blocked"
    || value === "unknown";
}

function isDiagnosticReportBlockerSeverity(
  value: unknown
): value is DiagnosticReportBlockerSeverity {
  return value === "blocked"
    || value === "action-required"
    || value === "unknown";
}

function isDiagnosticReportBlockerType(
  value: unknown
): value is DiagnosticReportBlockerType {
  return typeof value === "string" && DIAGNOSTIC_REPORT_BLOCKER_TYPES.has(value);
}

function isDiagnosticReportSectionId(
  value: unknown
): value is DiagnosticReportSectionId {
  return typeof value === "string" && DIAGNOSTIC_REPORT_SECTION_IDS.has(value);
}

function isDiagnosticComponentName(value: unknown): value is DiagnosticComponentName {
  return typeof value === "string" && DIAGNOSTIC_COMPONENT_NAMES.has(value);
}

function isDiagnosticComponentState(value: unknown): value is DiagnosticComponentState {
  return value === "available" || value === "missing" || value === "unknown";
}

function isDiagnosticReportBlocker(value: unknown): value is DiagnosticReportBlocker {
  if (!value || typeof value !== "object") {
    return false;
  }

  const blocker = value as Partial<DiagnosticReportBlocker>;
  return (
    typeof blocker.id === "string"
    && isDiagnosticReportBlockerType(blocker.type)
    && isDiagnosticReportBlockerSeverity(blocker.severity)
    && typeof blocker.title === "string"
    && typeof blocker.detail === "string"
    && typeof blocker.nextAction === "string"
    && typeof blocker.copyable === "string"
  );
}

function isDiagnosticReportSection(value: unknown): value is DiagnosticReportSection {
  if (!value || typeof value !== "object") {
    return false;
  }

  const section = value as Partial<DiagnosticReportSection>;
  return (
    isDiagnosticReportSectionId(section.id)
    && isDiagnosticReportState(section.state)
    && typeof section.summary === "string"
    && Array.isArray(section.blockers)
    && section.blockers.every(isDiagnosticReportBlocker)
  );
}

function isDiagnosticComponentVersion(
  value: unknown
): value is DiagnosticReport["componentVersions"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const component = value as Partial<DiagnosticReport["componentVersions"][number]>;
  return (
    isDiagnosticComponentName(component.component)
    && (component.version === null || typeof component.version === "string")
    && typeof component.source === "string"
    && isDiagnosticComponentState(component.state)
    && (component.detail === undefined || typeof component.detail === "string")
  );
}

function isDiagnosticReportRedaction(
  value: unknown
): value is DiagnosticReportRedaction {
  if (!value || typeof value !== "object") {
    return false;
  }

  const redaction = value as Partial<DiagnosticReportRedaction>;
  return (
    typeof redaction.rule === "string"
    && typeof redaction.count === "number"
  );
}

function isDiagnosticReport(value: unknown): value is DiagnosticReport {
  if (!value || typeof value !== "object") {
    return false;
  }

  const report = value as Partial<DiagnosticReport>;
  return (
    report.schemaVersion === 1
    && typeof report.generatedAt === "string"
    && isDiagnosticReportState(report.overallState)
    && Array.isArray(report.sections)
    && report.sections.every(isDiagnosticReportSection)
    && Array.isArray(report.blockers)
    && report.blockers.every(isDiagnosticReportBlocker)
    && Array.isArray(report.componentVersions)
    && report.componentVersions.every(isDiagnosticComponentVersion)
    && Array.isArray(report.redactionSummary)
    && report.redactionSummary.every(isDiagnosticReportRedaction)
    && typeof report.exportPreview === "string"
  );
}

function isDesktopSessionStatus(value: unknown): value is DesktopSessionStatus {
  if (!value || typeof value !== "object") {
    return false;
  }

  const status = value as Partial<DesktopSessionStatus>;
  return (
    typeof status.controllable === "boolean"
    && (
      status.frontmostBundleId === undefined
      || typeof status.frontmostBundleId === "string"
    )
    && (
      status.frontmostLocalizedName === undefined
      || typeof status.frontmostLocalizedName === "string"
    )
    && (
      status.frontmostProcessIdentifier === undefined
      || typeof status.frontmostProcessIdentifier === "number"
    )
  );
}

function isDesktopSessionDiagnosticState(
  value: unknown
): value is DesktopSessionDiagnosticState {
  return value === "controllable" || value === "blocked" || value === "unknown";
}

function isPermissionStatus(value: unknown): value is { state: PermissionState } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const state = (value as { state?: unknown }).state;
  return isPermissionState(state);
}

function isPermissionState(value: unknown): value is PermissionState {
  return (
    value === "granted"
    || value === "denied"
    || value === "not-determined"
    || value === "unknown"
  );
}

function isPermissionSettingsTarget(value: unknown): value is PermissionSettingsTarget {
  return (
    value === "screen-recording"
    || value === "accessibility"
    || value === "automation-finder"
  );
}

function isStartupWarning(value: unknown): value is StartupWarning {
  if (!value || typeof value !== "object") {
    return false;
  }

  const warning = value as Partial<StartupWarning>;
  return (
    isStartupWarningId(warning.id)
    && typeof warning.title === "string"
    && typeof warning.message === "string"
  );
}

function isStartupWarningId(value: unknown): value is StartupWarningId {
  return value === "tmux-launch" || value === "dev-server" || value === "unbundled-electron";
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (!value || typeof value !== "object") {
    return false;
  }

  const status = value as Partial<RuntimeStatus>;
  const stopTurnHotkey = status.stopTurnHotkey;
  return (
    Boolean(stopTurnHotkey)
    && typeof stopTurnHotkey === "object"
    && typeof stopTurnHotkey.accelerator === "string"
    && typeof stopTurnHotkey.label === "string"
    && typeof stopTurnHotkey.registered === "boolean"
  );
}

function isAutomationMonitorSnapshot(value: unknown): value is AutomationMonitorSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Partial<AutomationMonitorSnapshot>;
  return (
    snapshot.schemaVersion === 1
    && typeof snapshot.generatedAt === "string"
    && typeof snapshot.activeCount === "number"
    && Number.isFinite(snapshot.activeCount)
    && typeof snapshot.attentionCount === "number"
    && Number.isFinite(snapshot.attentionCount)
    && typeof snapshot.schedulerInactiveCount === "number"
    && Number.isFinite(snapshot.schedulerInactiveCount)
    && isAutomationMonitorSchedulerStatus(snapshot.scheduler)
    && Array.isArray(snapshot.monitors)
    && snapshot.monitors.every(isAutomationMonitorRuntime)
  );
}

function isAutomationMonitorSchedulerStatus(value: unknown): value is AutomationMonitorSchedulerStatus {
  if (!value || typeof value !== "object") {
    return false;
  }

  const scheduler = value as Partial<AutomationMonitorSchedulerStatus>;
  return (
    (scheduler.state === "active" || scheduler.state === "inactive")
    && scheduler.scope === "app-process"
    && scheduler.owner === "skfiy"
    && typeof scheduler.activeTimerCount === "number"
    && Number.isFinite(scheduler.activeTimerCount)
    && scheduler.mutatesSession === false
    && (
      scheduler.startedAt === undefined
      || typeof scheduler.startedAt === "string"
    )
    && (
      scheduler.reason === undefined
      || typeof scheduler.reason === "string"
    )
  );
}

function isAutomationMonitorRuntime(value: unknown): value is AutomationMonitorRuntime {
  if (!value || typeof value !== "object") {
    return false;
  }

  const monitor = value as Partial<AutomationMonitorRuntime>;
  return (
    typeof monitor.id === "string"
    && monitor.kind === "tmux-session"
    && typeof monitor.label === "string"
    && typeof monitor.enabled === "boolean"
    && typeof monitor.intervalMs === "number"
    && Number.isFinite(monitor.intervalMs)
    && typeof monitor.timeoutMs === "number"
    && Number.isFinite(monitor.timeoutMs)
    && (
      monitor.triggerMode === "manual"
      || monitor.triggerMode === "scheduled"
      || monitor.triggerMode === "local-state"
    )
    && typeof monitor.sessionName === "string"
    && isAutomationMonitorDefinitionPreview(monitor.preview)
    && isAutomationMonitorStatus(monitor.status)
    && typeof monitor.checkCount === "number"
    && Number.isFinite(monitor.checkCount)
    && (
      monitor.lastCheckedAt === undefined
      || typeof monitor.lastCheckedAt === "string"
    )
    && (
      monitor.nextCheckAt === undefined
      || typeof monitor.nextCheckAt === "string"
    )
    && (
      monitor.lastChangedAt === undefined
      || typeof monitor.lastChangedAt === "string"
    )
    && (
      monitor.lastSummary === undefined
      || typeof monitor.lastSummary === "string"
    )
    && (
      monitor.lastError === undefined
      || typeof monitor.lastError === "string"
    )
    && (
      monitor.lastResult === undefined
      || isAutomationMonitorLastResult(monitor.lastResult)
    )
    && (
      monitor.lastResultAt === undefined
      || typeof monitor.lastResultAt === "string"
    )
    && (
      monitor.observedSession === undefined
      || typeof monitor.observedSession === "string"
    )
    && (
      monitor.schedulerState === undefined
      || monitor.schedulerState === "active"
      || monitor.schedulerState === "inactive"
    )
    && (
      monitor.schedulerScope === undefined
      || monitor.schedulerScope === "app-process"
    )
    && (
      monitor.mutatesSession === undefined
      || monitor.mutatesSession === false
    )
  );
}

function isAutomationMonitorDefinitionPreview(
  value: unknown
): value is AutomationMonitorDefinitionPreview {
  if (!value || typeof value !== "object") {
    return false;
  }

  const preview = value as Partial<AutomationMonitorDefinitionPreview>;
  return preview.adapter === "tmux-supervision"
    && Array.isArray(preview.triggerModes)
    && preview.triggerModes.length === 2
    && preview.triggerModes[0] === "manual"
    && preview.triggerModes[1] === "scheduled"
    && Boolean(preview.target)
    && preview.target?.kind === "tmux-session"
    && typeof preview.target.sessionName === "string"
    && Array.isArray(preview.requiredPermissions)
    && preview.requiredPermissions.length === 0
    && preview.readWriteBehavior === "read-only"
    && preview.approvalMode === "not-required"
    && typeof preview.timeoutMs === "number"
    && Number.isFinite(preview.timeoutMs)
    && typeof preview.verification === "string"
    && preview.mutatesSession === false;
}

function isAutomationMonitorStatus(value: unknown): value is AutomationMonitorStatus {
  return (
    value === "observing"
    || value === "needs_attention"
    || value === "blocked"
    || value === "idle"
    || value === "disabled"
    || value === "error"
    || value === "scheduler_inactive"
  );
}

function isAutomationMonitorLastResult(value: unknown): value is AutomationMonitorLastResult {
  return (
    value === "observing"
    || value === "needs_attention"
    || value === "blocked"
    || value === "error"
  );
}

function isAutomationRunState(value: unknown): value is AutomationRunState {
  return (
    value === "queued"
    || value === "running"
    || value === "waiting"
    || value === "attention"
    || value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "expired"
  );
}

function isAutomationRunRecord(value: unknown): value is AutomationRunRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<AutomationRunRecord>;
  return (
    record.schemaVersion === 1
    && typeof record.runId === "string"
    && typeof record.monitorId === "string"
    && (
      record.trigger === "manual"
      || record.trigger === "scheduled"
      || record.trigger === "local-state"
      || record.trigger === "cli"
      || record.trigger === "mcp"
    )
    && isAutomationRunState(record.state)
    && typeof record.createdAt === "string"
    && typeof record.updatedAt === "string"
    && typeof record.currentStep === "string"
    && typeof record.attempt === "number"
    && Number.isFinite(record.attempt)
    && typeof record.maxAttempts === "number"
    && Number.isFinite(record.maxAttempts)
    && Array.isArray(record.timeline)
    && record.timeline.every(isAutomationRunTimelineEntry)
    && isAutomationRunConfig(record.config)
    && (record.startedAt === undefined || typeof record.startedAt === "string")
    && (record.finishedAt === undefined || typeof record.finishedAt === "string")
    && (record.deadlineAt === undefined || typeof record.deadlineAt === "string")
    && (record.retryAvailableAt === undefined || typeof record.retryAvailableAt === "string")
    && (record.nextAction === undefined || typeof record.nextAction === "string")
    && (record.error === undefined || typeof record.error === "string")
    && (record.terminalReason === undefined || typeof record.terminalReason === "string")
    && (
      record.latestVerification === undefined
      || isAutomationRunVerification(record.latestVerification)
    )
    && (
      record.cancellation === undefined
      || isAutomationRunCancellation(record.cancellation)
    )
  );
}

function isAutomationRunTimelineEntry(value: unknown): value is AutomationRunTimelineEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<AutomationRunTimelineEntry>;
  return (
    typeof entry.at === "string"
    && typeof entry.step === "string"
    && (entry.detail === undefined || typeof entry.detail === "string")
  );
}

function isAutomationRunVerification(value: unknown): value is AutomationRunVerification {
  if (!value || typeof value !== "object") {
    return false;
  }
  const verification = value as Partial<AutomationRunVerification>;
  return (
    typeof verification.at === "string"
    && (
      verification.kind === "tmux-observation"
      || verification.kind === "manual"
      || verification.kind === "none"
    )
    && (
      verification.status === "observing"
      || verification.status === "needs_attention"
      || verification.status === "blocked"
      || verification.status === "error"
    )
    && typeof verification.summary === "string"
    && (
      verification.recoveryProposals === undefined
      || (
        Array.isArray(verification.recoveryProposals)
        && verification.recoveryProposals.every(isAutomationRunRecoveryProposal)
      )
    )
  );
}

function isAutomationRunRecoveryProposal(value: unknown): value is AutomationRunRecoveryProposal {
  if (!value || typeof value !== "object") {
    return false;
  }
  const proposal = value as Partial<AutomationRunRecoveryProposal>;
  return (
    typeof proposal.proposalId === "string"
    && (
      proposal.actionKind === "send_input"
      || proposal.actionKind === "restart_step"
      || proposal.actionKind === "collect_summary"
    )
    && typeof proposal.reason === "string"
    && (
      proposal.risk === "low"
      || proposal.risk === "medium"
      || proposal.risk === "high"
      || proposal.risk === "blocked"
    )
    && typeof proposal.mutatesSession === "boolean"
  );
}

function isAutomationRunCancellation(value: unknown): value is AutomationRunCancellation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const cancellation = value as Partial<AutomationRunCancellation>;
  return (
    (
      cancellation.requestedBy === "pet"
      || cancellation.requestedBy === "dashboard"
      || cancellation.requestedBy === "cli"
      || cancellation.requestedBy === "mcp"
    )
    && typeof cancellation.at === "string"
  );
}

function isAutomationRunConfig(value: unknown): value is AutomationRunConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const config = value as Partial<AutomationRunConfig>;
  return (
    typeof config.sessionName === "string"
    && typeof config.timeoutMs === "number"
    && Number.isFinite(config.timeoutMs)
    && typeof config.maxAttempts === "number"
    && Number.isFinite(config.maxAttempts)
    && typeof config.backoffMs === "number"
    && Number.isFinite(config.backoffMs)
    && typeof config.backoffMultiplier === "number"
    && Number.isFinite(config.backoffMultiplier)
    && typeof config.maxBackoffMs === "number"
    && Number.isFinite(config.maxBackoffMs)
    && typeof config.runTtlMs === "number"
    && Number.isFinite(config.runTtlMs)
    && (
      config.concurrencyPolicy === "skip"
      || config.concurrencyPolicy === "queue"
      || config.concurrencyPolicy === "allow"
    )
    && typeof config.maxConcurrency === "number"
    && Number.isFinite(config.maxConcurrency)
  );
}

function isAutomationRunSnapshot(value: unknown): value is AutomationRunSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Partial<AutomationRunSnapshot>;
  return (
    snapshot.schemaVersion === 1
    && typeof snapshot.generatedAt === "string"
    && Array.isArray(snapshot.runs)
    && snapshot.runs.every(isAutomationRunRecord)
  );
}

function isPetSkinManifest(value: unknown): value is PetSkinManifest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const manifest = value as Partial<PetSkinManifest>;
  const states = manifest.states;
  const rendering = manifest.rendering;
  const layout = manifest.layout;
  return (
    typeof manifest.displayName === "string"
    && typeof manifest.slug === "string"
    && typeof manifest.asset === "string"
    && isPositiveInteger(manifest.frameWidth)
    && isPositiveInteger(manifest.frameHeight)
    && isPositiveInteger(manifest.columns)
    && isPositiveInteger(manifest.rows)
    && (
      rendering === undefined
      || (
        typeof rendering === "object"
        && rendering !== null
        && (rendering.mode === "sprite-atlas" || rendering.mode === "animated-raster")
        && (rendering.ambientMotion === undefined || typeof rendering.ambientMotion === "boolean")
        && (rendering.failureShake === undefined || typeof rendering.failureShake === "boolean")
      )
    )
    && (
      layout === undefined
      || (
        typeof layout === "object"
        && layout !== null
        && isPositiveInteger(layout.hitboxWidth)
        && isPositiveInteger(layout.hitboxHeight)
        && (layout.visualScale === undefined || isPositiveNumber(layout.visualScale))
      )
    )
    && Boolean(states)
    && typeof states === "object"
    && [
      "idle",
      "running-right",
      "running-left",
      "waving",
      "jumping",
      "failed",
      "waiting",
      "running",
      "review"
    ].every((state) => isPetAnimationState((states as Record<string, unknown>)[state]))
  );
}

function isPetAnimationState(value: unknown): value is PetAnimationState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<PetAnimationState>;
  return (
    Number.isInteger(state.row)
    && Number(state.row) >= 0
    && isPositiveInteger(state.frames)
    && isPositiveInteger(state.frameMs)
  );
}

function createUnknownPermissionSummary(): PermissionSummary {
  return {
    screenRecording: { state: "unknown" },
    accessibility: { state: "unknown" }
  };
}

function createUnknownPermissionDiagnostics(): PermissionDiagnostics {
  const unknown = createUnknownPermissionSummary();

  return {
    active: unknown,
    appProcess: unknown,
    helperProcess: unknown,
    mismatches: [],
    identity: {
      appPath: "",
      executablePath: "",
      helperPath: "",
      resourcesPath: "",
      isPackaged: false
    }
  };
}

function createUnknownDesktopSessionDiagnostics(): DesktopSessionDiagnostics {
  return {
    state: "unknown",
    status: null,
    reason: "Desktop session status is unknown."
  };
}

function createDefaultAppPolicySettings(): AppPolicySettings {
  return {
    apps: [
      { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" },
      { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" },
      { name: "Finder", bundleId: "com.apple.finder", policy: "ask" }
    ]
  };
}

function createDefaultPlannerProviderSettings(): PlannerProviderSettings {
  return {
    mode: "local-deterministic",
    externalProviderLabel: "External CUA",
    externalEndpoint: undefined,
    externalApiKeyConfigured: false
  };
}

function createDefaultAutomationMonitorSnapshot(): AutomationMonitorSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    activeCount: 0,
    attentionCount: 0,
    schedulerInactiveCount: 0,
    scheduler: {
      state: "inactive",
      scope: "app-process",
      owner: "skfiy",
      activeTimerCount: 0,
      mutatesSession: false,
      reason: "Open skfiy to resume interval checks."
    },
    monitors: []
  };
}

function createDefaultAutomationRunSnapshot(): AutomationRunSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    runs: []
  };
}

function createDefaultAutomationMonitorDefinitionPreview(): AutomationMonitorDefinitionPreview {
  return {
    adapter: "tmux-supervision",
    triggerModes: ["manual", "scheduled"],
    target: {
      kind: "tmux-session",
      sessionName: ""
    },
    requiredPermissions: [],
    readWriteBehavior: "read-only",
    approvalMode: "not-required",
    timeoutMs: 30_000,
    verification: "tmux session, window, pane, and bounded recent pane-output observation",
    mutatesSession: false
  };
}

function createDefaultAssistantAgentSettingsResponse(): AssistantAgentSettingsResponse {
  const settings: AssistantAgentSettings = {
    mode: "codex",
    codexBinary: "codex",
    codexBinarySource: "default",
    claudeCodeBinary: "claude",
    claudeCodeBinarySource: "default",
    hermesBinary: "hermes",
    hermesBinarySource: "default",
    cwd: "",
    timeoutMs: 45_000
  };

  return {
    settings,
    providers: [
      {
        provider: "assistant",
        id: "codex",
        label: "Codex",
        selected: true,
        configured: true,
        executablePath: "codex",
        executableSource: "default",
        readiness: "unavailable"
      },
      {
        provider: "assistant",
        id: "claude-code",
        label: "Claude Code",
        selected: false,
        configured: true,
        executablePath: "claude",
        executableSource: "default",
        readiness: "unavailable"
      },
      {
        provider: "assistant",
        id: "hermes",
        label: "Hermes",
        selected: false,
        configured: true,
        executablePath: "hermes",
        executableSource: "default",
        readiness: "unavailable"
      }
    ]
  };
}

function createUnknownFirstRunReadinessSnapshot(): FirstRunReadinessSnapshot {
  return {
    schemaVersion: 1,
    chatReady: false,
    computerUseReady: false,
    readyWorkflows: [],
    resumeStepId: "background-agent",
    steps: [
      createUnknownFirstRunReadinessStep("background-agent", "required-for-chat"),
      createUnknownFirstRunReadinessStep("screen-recording", "computer-use"),
      createUnknownFirstRunReadinessStep("accessibility", "computer-use"),
      createUnknownFirstRunReadinessStep("finder-automation", "optional"),
      createUnknownFirstRunReadinessStep("browser-context", "optional")
    ]
  };
}

function createUnknownFirstRunReadinessStep(
  id: FirstRunReadinessStepId,
  requirement: FirstRunReadinessRequirement
): FirstRunReadinessStep {
  return {
    id,
    requirement,
    state: "unknown",
    reason: "Readiness status could not be read.",
    nextAction: "Refresh first-run readiness."
  };
}

function isPersonalMemorySettings(value: unknown): value is PersonalMemorySettings {
  if (!value || typeof value !== "object") {
    return false;
  }

  const settings = value as Partial<PersonalMemorySettings>;
  return typeof settings.postTurnLearningEnabled === "boolean"
    && typeof settings.writeApprovalEnabled === "boolean";
}

function isPersonalMemoryUsageBucket(value: unknown): value is PersonalMemoryUsageBucket {
  if (!value || typeof value !== "object") {
    return false;
  }

  const bucket = value as Partial<PersonalMemoryUsageBucket>;
  return typeof bucket.usedChars === "number"
    && Number.isFinite(bucket.usedChars)
    && typeof bucket.limitChars === "number"
    && Number.isFinite(bucket.limitChars)
    && typeof bucket.percent === "number"
    && Number.isFinite(bucket.percent);
}

function isPendingPersonalMemoryWrite(value: unknown): value is PendingPersonalMemoryWrite {
  if (!value || typeof value !== "object") {
    return false;
  }

  const write = value as Partial<PendingPersonalMemoryWrite>;
  return typeof write.id === "string"
    && typeof write.createdAt === "string"
    && typeof write.source === "string"
    && isPersonalMemoryAction(write.action)
    && isPersonalMemoryTarget(write.target)
    && typeof write.content === "string"
    && (write.previousContent === undefined || typeof write.previousContent === "string");
}

function isPersonalMemoryJournalEntry(value: unknown): value is PersonalMemoryJournalEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<PersonalMemoryJournalEntry>;
  return typeof entry.id === "string"
    && typeof entry.createdAt === "string"
    && typeof entry.source === "string"
    && (entry.stage === "durable" || entry.stage === "pending")
    && typeof entry.turnId === "string"
    && typeof entry.providerLabel === "string"
    && typeof entry.userInput === "string"
    && isPersonalMemoryAction(entry.action)
    && isPersonalMemoryTarget(entry.target)
    && typeof entry.content === "string"
    && (entry.previousContent === undefined || typeof entry.previousContent === "string");
}

function isPersonalMemoryAction(value: unknown): value is "add" | "replace" | "remove" {
  return value === "add" || value === "replace" || value === "remove";
}

function isPersonalMemoryTarget(value: unknown): value is "user" | "agent" {
  return value === "user" || value === "agent";
}

function isPersonalMemoryDashboardSnapshot(
  value: unknown
): value is PersonalMemoryDashboardSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Partial<PersonalMemoryDashboardSnapshot>;
  return snapshot.schemaVersion === 1
    && Array.isArray(snapshot.userEntries)
    && snapshot.userEntries.every((entry) => typeof entry === "string")
    && Array.isArray(snapshot.agentEntries)
    && snapshot.agentEntries.every((entry) => typeof entry === "string")
    && Boolean(snapshot.usage)
    && isPersonalMemoryUsageBucket(snapshot.usage?.user)
    && isPersonalMemoryUsageBucket(snapshot.usage?.agent)
    && Array.isArray(snapshot.pendingWrites)
    && snapshot.pendingWrites.every(isPendingPersonalMemoryWrite)
    && Array.isArray(snapshot.journal)
    && snapshot.journal.every(isPersonalMemoryJournalEntry)
    && typeof snapshot.sessionCount === "number"
    && Number.isFinite(snapshot.sessionCount)
    && (snapshot.latestUpdatedAt === undefined
      || typeof snapshot.latestUpdatedAt === "string")
    && isPersonalMemorySettings(snapshot.settings);
}

function isPersonalMemoryForgetResult(value: unknown): value is PersonalMemoryForgetResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Partial<PersonalMemoryForgetResult>;
  return (result.result === "forgotten" || result.result === "not-found")
    && isPersonalMemoryDashboardSnapshot(result.snapshot);
}

function isPersonalMemoryPendingApprovalResult(
  value: unknown
): value is PersonalMemoryPendingApprovalResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Partial<PersonalMemoryPendingApprovalResult>;
  if (result.result === "not-found") {
    return isPersonalMemoryDashboardSnapshot(result.snapshot);
  }
  if (result.result !== "approved") {
    return false;
  }

  return typeof result.applied === "number"
    && typeof result.ignored === "number"
    && typeof result.blocked === "number"
    && isPersonalMemoryDashboardSnapshot(result.snapshot);
}

function isPersonalMemoryPendingRejectResult(
  value: unknown
): value is PersonalMemoryPendingRejectResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Partial<PersonalMemoryPendingRejectResult>;
  return (result.result === "rejected" || result.result === "not-found")
    && isPersonalMemoryDashboardSnapshot(result.snapshot);
}

function createDefaultPersonalMemorySettings(): PersonalMemorySettings {
  return {
    postTurnLearningEnabled: true,
    writeApprovalEnabled: false
  };
}

function createDefaultPersonalMemoryDashboardSnapshot(): PersonalMemoryDashboardSnapshot {
  return {
    schemaVersion: 1,
    userEntries: [],
    agentEntries: [],
    usage: {
      user: { usedChars: 0, limitChars: 1375, percent: 0 },
      agent: { usedChars: 0, limitChars: 2200, percent: 0 }
    },
    pendingWrites: [],
    journal: [],
    sessionCount: 0,
    settings: createDefaultPersonalMemorySettings()
  };
}

function isProfileMemoryScopeValue(value: unknown): value is ProfileMemoryScope {
  return value === "isolated" || value === "shared";
}

function isProfileAppPolicyValue(value: unknown): value is "allow" | "ask" | "deny" {
  return value === "allow" || value === "ask" || value === "deny";
}

function isProfileSummary(value: unknown): value is ProfileSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const summary = value as Partial<ProfileSummary>;
  return typeof summary.id === "string"
    && typeof summary.name === "string"
    && typeof summary.createdAt === "string"
    && typeof summary.updatedAt === "string"
    && isProfileMemoryScopeValue(summary.memoryScope)
    && isProfileWorkflowDefaults(summary.workflowDefaults)
    && typeof summary.isDefault === "boolean"
    && typeof summary.isActive === "boolean";
}

function isProfileWorkflowDefaults(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const defaults = value as Record<string, unknown>;
  return (defaults.defaultManualMode === "active" || defaults.defaultManualMode === "quiet")
    && typeof defaults.postTurnLearningEnabled === "boolean"
    && typeof defaults.writeApprovalEnabled === "boolean";
}

function isPolicyBroadening(value: unknown): value is PolicyBroadening {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const broadening = value as Partial<PolicyBroadening>;
  return broadening.kind === "app-policy"
    && typeof broadening.target === "string"
    && (broadening.targetName === undefined || typeof broadening.targetName === "string")
    && isProfileAppPolicyValue(broadening.from)
    && isProfileAppPolicyValue(broadening.to);
}

function isProfileRuntimeSnapshot(value: unknown): value is ProfileRuntimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const snapshot = value as Partial<ProfileRuntimeSnapshot>;
  return snapshot.schemaVersion === 1
    && (snapshot.activeProfileId === null || typeof snapshot.activeProfileId === "string")
    && (snapshot.activeProfile === null || isProfileSummary(snapshot.activeProfile))
    && Array.isArray(snapshot.profiles)
    && snapshot.profiles.every(isProfileSummary)
    && (snapshot.memoryBaseDirScope === "shared" || snapshot.memoryBaseDirScope === "isolated");
}

function isProfileSwitchResult(value: unknown): value is ProfileSwitchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const result = value as Partial<ProfileSwitchResult>;
  if (result.status === "switched") {
    return isProfileSummary(result.profile)
      && (result.previousProfileId === null || typeof result.previousProfileId === "string");
  }
  if (result.status === "confirmation-required") {
    return typeof result.profileId === "string"
      && Array.isArray(result.broadenings)
      && result.broadenings.every(isPolicyBroadening);
  }
  if (result.status === "not-found") {
    return typeof result.profileId === "string";
  }
  if (result.status === "blocked") {
    return typeof result.profileId === "string" && typeof result.reason === "string";
  }
  return false;
}

function isProfileExportBundle(value: unknown): value is ProfileExportBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const bundle = value as Partial<ProfileExportBundle>;
  if (bundle.schemaVersion !== 1 || typeof bundle.exportedAt !== "string") {
    return false;
  }
  if (!bundle.profile || typeof bundle.profile !== "object" || Array.isArray(bundle.profile)) {
    return false;
  }

  const profile = bundle.profile as unknown as Record<string, unknown>;
  if (
    typeof profile.id !== "string"
    || typeof profile.name !== "string"
    || typeof profile.createdAt !== "string"
    || typeof profile.updatedAt !== "string"
    || !isProfileMemoryScopeValue(profile.memoryScope)
  ) {
    return false;
  }

  if (bundle.memory !== undefined) {
    if (!bundle.memory || typeof bundle.memory !== "object" || Array.isArray(bundle.memory)) {
      return false;
    }
    const memory = bundle.memory as Record<string, unknown>;
    if (
      !Array.isArray(memory.userEntries)
      || !memory.userEntries.every((entry) => typeof entry === "string")
      || !Array.isArray(memory.agentEntries)
      || !memory.agentEntries.every((entry) => typeof entry === "string")
    ) {
      return false;
    }
  }

  return true;
}

function isDataRestorePreview(value: unknown): value is DataRestorePreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const preview = value as Partial<DataRestorePreview>;
  return Array.isArray(preview.domains)
    && preview.domains.every(isDataRestorePreviewEntry)
    && typeof preview.requiresConfirmation === "boolean"
    && isBackupPlan(preview.backupPlan)
    && isDataExportBundle(preview.bundle);
}

function isDataRestorePreviewEntry(value: unknown): value is DataRestorePreviewEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<DataRestorePreviewEntry>;
  return isDataDomain(entry.domain)
    && (entry.action === "replace" || entry.action === "merge" || entry.action === "skip")
    && typeof entry.currentSummary === "string"
    && typeof entry.incomingSummary === "string"
    && Array.isArray(entry.conflicts)
    && entry.conflicts.every((conflict) => typeof conflict === "string")
    && Array.isArray(entry.warnings)
    && entry.warnings.every((warning) => typeof warning === "string");
}

function isBackupPlan(value: unknown): value is { path: string; createdAt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const plan = value as Record<string, unknown>;
  return typeof plan.path === "string" && typeof plan.createdAt === "string";
}

function isDataRestoreResult(value: unknown): value is DataRestoreResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<DataRestoreResult>;
  return Array.isArray(result.appliedDomains)
    && result.appliedDomains.every(isDataDomain)
    && Array.isArray(result.skipped)
    && result.skipped.every(
      (entry) => isDataDomain(entry?.domain) && typeof entry?.reason === "string"
    )
    && typeof result.backupPath === "string"
    && typeof result.restoredAt === "string";
}

function isDataDomainResetResult(value: unknown): value is DataDomainResetResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<DataDomainResetResult>;
  return isDataDomain(result.domain)
    && typeof result.resetImpact === "string"
    && Array.isArray(result.cleared)
    && result.cleared.every((entry) => typeof entry === "string");
}

function isStorageHealthSummary(value: unknown): value is StorageHealthSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const summary = value as Partial<StorageHealthSummary>;
  return (summary.status === "ok"
    || summary.status === "corrupt"
    || summary.status === "future-schema")
    && Array.isArray(summary.files)
    && summary.files.every(isStorageFileHealth)
    && isStorageHealthCounts(summary.counts)
    && (summary.recoveryHint === undefined || typeof summary.recoveryHint === "string");
}

function isStorageFileHealth(value: unknown): value is StorageFileHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const file = value as Partial<StorageFileHealth>;
  return isDataDomain(file.domain)
    && typeof file.relativePath === "string"
    && (file.status === "ok"
      || file.status === "missing"
      || file.status === "corrupt"
      || file.status === "future-schema");
}

function isStorageHealthCounts(
  value: unknown
): value is StorageHealthSummary["counts"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const counts = value as Record<string, unknown>;
  return typeof counts.total === "number"
    && typeof counts.ok === "number"
    && typeof counts.missing === "number"
    && typeof counts.corrupt === "number"
    && typeof counts.futureSchema === "number";
}

function isApplyRetentionResult(value: unknown): value is ApplyRetentionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<ApplyRetentionResult>;
  return isRetentionPhase(result.replay, ["applied", "disabled", "noop"])
    && isRetentionPhase(result.screenshots, ["applied", "disabled"])
    && isRetentionPhase(result.runHistory, ["applied", "disabled"]);
}

function isRetentionPhase(
  value: unknown,
  statuses: readonly string[]
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const phase = value as Record<string, unknown>;
  return typeof phase.status === "string"
    && statuses.includes(phase.status);
}

function createDefaultProfileRuntimeSnapshot(): ProfileRuntimeSnapshot {
  const defaultSummary: ProfileSummary = {
    id: "default",
    name: "Default",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    memoryScope: "shared",
    workflowDefaults: {
      defaultManualMode: "active",
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    },
    isDefault: true,
    isActive: true
  };
  return {
    schemaVersion: 1,
    activeProfileId: "default",
    activeProfile: defaultSummary,
    profiles: [defaultSummary],
    memoryBaseDirScope: "shared"
  };
}

contextBridge.exposeInMainWorld("skfiy", api);
