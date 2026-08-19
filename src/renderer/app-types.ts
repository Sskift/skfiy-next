import type { PetAtlasManifest } from "./pet-atlas";
import type {
  RouteOutcome,
  RouteOutcomeKind,
  RouteOutcomeTone
} from "../shared/route-outcome.js";

export type {
  RouteOutcome,
  RouteOutcomeKind,
  RouteOutcomeTone
};

export type TaskStatus =
  | "idle"
  | "planned"
  | "observing"
  | "executing"
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
export type AssistantAgentProviderReadiness =
  | "chat-ready"
  | "version-ok"
  | "binary-found"
  | "binary-configured"
  | "auth-or-permission-blocked"
  | "unconfigured"
  | "unavailable";
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
}

export interface AssistantAgentProviderState {
  provider: "assistant";
  id: AssistantAgentMode;
  label: "Codex" | "Claude Code" | "Hermes";
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
  }>;
  outcome: TurnTranscriptOutcome;
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

export interface AutomationMonitorSchedulerStatus {
  state: AutomationSchedulerState;
  scope: "app-process";
  owner: "skfiy";
  activeTimerCount: number;
  mutatesSession: false;
  startedAt?: string;
  reason?: string;
}

export interface AutomationMonitorRuntime {
  id: string;
  kind: "tmux-session";
  label: string;
  enabled: boolean;
  intervalMs: number;
  sessionName: string;
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
  stopTurnBehavior?: TaskEventStopTurnBehavior;
  replayReset?: boolean;
  replayRecord?: ObserveAppReplayRecord;
  finderSelection?: FinderSelectionResult;
  finderPlanPreview?: FinderPlanPreview;
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

export interface DesktopApi {
  runCommand: (command: string, options: { mode: ManualMode }) => Promise<void>;
  approveTask: () => Promise<void>;
  denyTask: () => Promise<void>;
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
    update: Partial<Pick<AssistantAgentSettings, "mode">>
  ) => Promise<AssistantAgentSettingsResponse>;
  getPlannerProviderSettings: () => Promise<PlannerProviderSettings>;
  setPlannerProviderSettings: (
    update: Partial<Pick<PlannerProviderSettings, "mode">>
  ) => Promise<PlannerProviderSettings>;
  getTurnReplay: () => Promise<TurnReplay | null>;
  getAutomationMonitors: () => Promise<AutomationMonitorSnapshot>;
  upsertTmuxMonitor: (
    input: { sessionName: string; label?: string; intervalMs: number; enabled?: boolean }
  ) => Promise<AutomationMonitorSnapshot>;
  runAutomationMonitorNow: (id: string) => Promise<AutomationMonitorSnapshot>;
  getRuntimeStatus: () => Promise<RuntimeStatus>;
  getPetSkin: () => Promise<PetAtlasManifest | null>;
  getWindowBounds: () => Promise<WindowBounds | null>;
  moveWindowBy: (deltaX: number, deltaY: number, visibleRect?: VisiblePetRect) => void;
  setWindowMode: (mode: PetWindowMode) => void;
  onStopTurnHotkey: (callback: () => void) => () => void;
  onTaskEvent: (callback: (event: TaskEvent) => void) => () => void;
}
