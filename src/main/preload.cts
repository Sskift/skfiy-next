import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type ManualMode = "active" | "quiet";
type PetWindowMode = "compact" | "expanded";
type TaskStatus =
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
type PermissionState = "granted" | "denied" | "not-determined" | "unknown";
type DesktopSessionDiagnosticState = "controllable" | "blocked" | "unknown";
type PermissionSettingsTarget =
  | "screen-recording"
  | "accessibility";
type StartupWarningId = "tmux-launch" | "dev-server" | "unbundled-electron";
type AppPolicy = "allow" | "ask" | "deny";
type AssistantAgentMode = "codex" | "claude-code" | "hermes";
type AssistantAgentProviderId = AssistantAgentMode;
type AssistantAgentProviderReadiness =
  | "chat-ready"
  | "version-ok"
  | "binary-found"
  | "binary-configured"
  | "auth-or-permission-blocked"
  | "unconfigured"
  | "unavailable";
type AssistantAgentExecutableSource = "default" | "env";
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

interface TaskEvent {
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
}

interface AssistantAgentProviderState {
  provider: "assistant";
  id: AssistantAgentProviderId;
  label: "Codex" | "Claude Code" | "Hermes";
  selected: boolean;
  configured: boolean;
  executablePath?: string;
  executableSource: AssistantAgentExecutableSource;
  resolvedExecutablePath?: string;
  readiness: AssistantAgentProviderReadiness;
  readinessDetail?: string;
  lastError?: string;
}

interface AssistantAgentSettingsResponse {
  settings: AssistantAgentSettings;
  providers: AssistantAgentProviderState[];
}

interface PlannerProviderSettings {
  mode: PlannerProviderMode;
  externalProviderLabel: string;
  externalEndpoint?: string;
  externalApiKeyConfigured: boolean;
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

interface AutomationMonitorSchedulerStatus {
  state: AutomationSchedulerState;
  scope: "app-process";
  owner: "skfiy";
  activeTimerCount: number;
  mutatesSession: false;
  startedAt?: string;
  reason?: string;
}

interface AutomationMonitorRuntime {
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

interface AutomationMonitorSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  activeCount: number;
  attentionCount: number;
  schedulerInactiveCount: number;
  scheduler: AutomationMonitorSchedulerStatus;
  monitors: AutomationMonitorRuntime[];
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
  getPetSkin: () => Promise<PetSkinManifest | null>;
  getWindowBounds: () => Promise<WindowBounds | null>;
  moveWindowBy: (deltaX: number, deltaY: number, visibleRect?: VisiblePetRect) => void;
  setWindowMode: (mode: PetWindowMode) => void;
  onStopTurnHotkey: (callback: () => void) => () => void;
  onTaskEvent: (callback: (event: TaskEvent) => void) => () => void;
}

const taskStatuses = new Set<TaskStatus>([
  "idle",
  "planned",
  "observing",
  "executing",
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
  return (
    typeof candidate.status === "string"
    && taskStatuses.has(candidate.status)
    && (candidate.message === undefined || typeof candidate.message === "string")
    && (candidate.command === undefined || typeof candidate.command === "string")
    && (candidate.route === undefined || typeof candidate.route === "string")
    && (candidate.routeReason === undefined || typeof candidate.routeReason === "string")
    && (candidate.denialKind === undefined || typeof candidate.denialKind === "string")
    && (candidate.policyKind === undefined || typeof candidate.policyKind === "string")
    && (candidate.routeOutcome === undefined || isRouteOutcome(candidate.routeOutcome))
    && (
      candidate.stopTurnBehavior === undefined
      || isTaskEventStopTurnBehavior(candidate.stopTurnBehavior)
    )
  );
}

const api: DesktopApi = {
  async runCommand(command, options) {
    await ipcRenderer.invoke("skfiy:run-command", command, options);
  },
  async approveTask() {
    await ipcRenderer.invoke("skfiy:approve-task");
  },
  async denyTask() {
    await ipcRenderer.invoke("skfiy:deny-task");
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
    const payload = await ipcRenderer.invoke("skfiy:set-assistant-agent-settings", {
      mode: isAssistantAgentMode(mode) ? mode : undefined
    });
    return isAssistantAgentSettingsResponse(payload)
      ? payload
      : createDefaultAssistantAgentSettingsResponse();
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
  async getTurnReplay() {
    const payload = await ipcRenderer.invoke("skfiy:get-turn-replay");
    return isTurnReplay(payload) ? payload : null;
  },
  async getAutomationMonitors() {
    const payload = await ipcRenderer.invoke("skfiy:get-automation-monitors");
    return isAutomationMonitorSnapshot(payload)
      ? payload
      : createDefaultAutomationMonitorSnapshot();
  },
  async upsertTmuxMonitor(input) {
    const payload = await ipcRenderer.invoke("skfiy:upsert-tmux-monitor", {
      sessionName: typeof input.sessionName === "string" ? input.sessionName : "",
      label: typeof input.label === "string" ? input.label : undefined,
      intervalMs: typeof input.intervalMs === "number" && Number.isFinite(input.intervalMs)
        ? input.intervalMs
        : 300_000,
      enabled: typeof input.enabled === "boolean" ? input.enabled : undefined
    });
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
        callback(payload);
      }
    };

    ipcRenderer.on("skfiy:task-event", listener);
    return () => ipcRenderer.removeListener("skfiy:task-event", listener);
  }
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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
    && response.providers.every(isAssistantAgentProviderState);
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
  );
}

function isAssistantAgentProviderState(value: unknown): value is AssistantAgentProviderState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<AssistantAgentProviderState>;
  return (
    state.provider === "assistant"
    && isAssistantAgentMode(state.id)
    && (state.label === "Codex" || state.label === "Claude Code" || state.label === "Hermes")
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
      state.lastError === undefined
      || typeof state.lastError === "string"
    )
  );
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
  return value === "ready"
    || value === "chat-ready"
    || value === "binary-found"
    || value === "unconfigured"
    || value === "unavailable";
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
      event.stopTurnBehavior === undefined
      || isTaskEventStopTurnBehavior(event.stopTurnBehavior)
    )
  );
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
    && typeof monitor.sessionName === "string"
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

contextBridge.exposeInMainWorld("skfiy", api);
