import {
  getPetStateForTask,
  type PetAtlasState
} from "./pet-atlas";
import {
  isRouteOutcomeKind,
  isRouteOutcomeTone,
  readExplicitRouteOutcome,
  readRouteOutcome,
  type RouteOutcome
} from "../shared/route-outcome.js";
import type { AssistantAgentProviderReadiness } from "./app-types";

export type PermissionKey = "screenRecording" | "accessibility";
export type PermissionState = "granted" | "denied" | "not-determined" | "unknown";
export type DesktopSessionDiagnosticState = "controllable" | "blocked" | "unknown";
export type PermissionSettingsTarget = "screen-recording" | "accessibility";
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
export type Tone = "success" | "warning" | "danger" | "neutral";
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
export type RiskLevel = "low" | "medium" | "high" | "blocked";
export type PetRouteOutcome = RouteOutcome;

export interface PetStopTurnBehavior {
  result?: string;
  source?: string;
  command?: string;
  beforeStatus?: string;
  beforeMessage?: string;
  afterStatus?: string;
  afterMessage?: string;
}

export interface PetRouteOutcomeSignal {
  label: string;
  detail: string;
  tone: Tone;
}

export const STATUS_COPY: Record<TaskStatus, { label: string; message: string; pulse: string }> = {
  idle: {
    label: "Idle",
    message: "待命中.",
    pulse: "Tucked"
  },
  planned: {
    label: "Planned",
    message: "已规划，等待执行.",
    pulse: "Review"
  },
  observing: {
    label: "Observing",
    message: "正在看桌面.",
    pulse: "Review"
  },
  executing: {
    label: "Executing",
    message: "正在执行.",
    pulse: "Running"
  },
  running: {
    label: "Running",
    message: "正在运行.",
    pulse: "Running"
  },
  approval_required: {
    label: "Approval required",
    message: "需要确认.",
    pulse: "Waiting"
  },
  needs_confirmation: {
    label: "Needs confirmation",
    message: "需要人工确认.",
    pulse: "Waiting"
  },
  needs_clarification: {
    label: "Needs clarification",
    message: "需要澄清目标应用和动作.",
    pulse: "Waiting"
  },
  completed: {
    label: "Completed",
    message: "完成了.",
    pulse: "Waving"
  },
  denied: {
    label: "Denied",
    message: "请求已拒绝，未执行动作.",
    pulse: "Review"
  },
  blocked: {
    label: "Blocked",
    message: "环境阻塞，无法继续执行.",
    pulse: "Blocked"
  },
  failed: {
    label: "Failed",
    message: "执行失败.",
    pulse: "Fault"
  },
  cancelled: {
    label: "Cancelled",
    message: "任务已停止.",
    pulse: "Stopped"
  }
};

export interface PermissionRow {
  key: PermissionKey;
  settingsTarget: PermissionSettingsTarget;
  label: string;
}

export interface PermissionDisplayRow extends PermissionRow {
  state: PermissionState;
  stateLabel: string;
}

export const PERMISSION_ROWS: PermissionRow[] = [
  { key: "screenRecording", settingsTarget: "screen-recording", label: "屏幕录制" },
  { key: "accessibility", settingsTarget: "accessibility", label: "辅助功能" }
];

export const PERMISSION_STATE_COPY: Record<PermissionState, string> = {
  granted: "已授权",
  denied: "未授权",
  "not-determined": "待授权",
  unknown: "未知"
};

export const DESKTOP_SESSION_STATE_COPY: Record<DesktopSessionDiagnosticState, string> = {
  controllable: "可控",
  blocked: "不可控",
  unknown: "未知"
};

const BLOCKING_PERMISSION_STATES: readonly PermissionState[] = ["denied", "not-determined"];

export function readExternalCuaStatusLabel(settings: {
  externalEndpoint?: string;
  externalApiKeyConfigured: boolean;
}): string {
  const endpointConfigured = Boolean(settings.externalEndpoint?.trim());

  if (endpointConfigured && settings.externalApiKeyConfigured) {
    return "External CUA 已配置";
  }

  if (endpointConfigured) {
    return "External CUA 缺少 API Key";
  }

  if (settings.externalApiKeyConfigured) {
    return "External CUA 缺少 Endpoint";
  }

  return "External CUA 未配置";
}

export function readAssistantAgentReadinessLabel(
  readiness: AssistantAgentProviderReadiness
): string {
  if (readiness === "chat-ready") {
    return "chat ready";
  }
  if (readiness === "version-ok") {
    return "version ok";
  }
  if (readiness === "binary-found") {
    return "binary found";
  }
  if (readiness === "binary-configured") {
    return "binary configured";
  }
  if (readiness === "auth-or-permission-blocked") {
    return "auth blocked";
  }
  if (readiness === "unconfigured") {
    return "unconfigured";
  }

  return "unavailable";
}

export function readAssistantAgentProviderDetail(
  response: { settings: { cwd: string; timeoutMs: number } },
  provider: {
    label: string;
    executablePath?: string;
    readiness: AssistantAgentProviderReadiness;
    readinessDetail?: string;
  }
): string {
  const executable = provider.executablePath ?? "not configured";
  return [
    `${provider.label} · ${readAssistantAgentReadinessLabel(provider.readiness)}`,
    ...(provider.readinessDetail ? [provider.readinessDetail] : []),
    `binary ${executable}`,
    `cwd ${response.settings.cwd || "default"}`,
    `timeout ${Math.round(response.settings.timeoutMs / 1000)}s`
  ].join(" · ");
}

export function getAssistantInputPanelViewModel({
  input,
  provider,
  submitting
}: {
  input: string;
  provider: {
    label: string;
    readiness: AssistantAgentProviderReadiness;
  };
  submitting: boolean;
}): {
  statusLabel: string;
  submitDisabled: boolean;
  submitLabel: string;
} {
  return {
    statusLabel: submitting
      ? "等待回复"
      : `${provider.label} · ${readAssistantAgentReadinessLabel(provider.readiness)}`,
    submitDisabled: submitting || input.trim().length === 0,
    submitLabel: submitting ? "发送中" : "发送"
  };
}

export function readSelectedAssistantAgentProvider<TProvider extends {
  id: string;
  selected?: boolean;
}>(
  providers: TProvider[],
  mode: string,
  fallbackProvider: TProvider
): TProvider {
  return providers.find((provider) => provider.selected)
    ?? providers.find((provider) => provider.id === mode)
    ?? fallbackProvider;
}

export function formatFinderPreviewMove(
  move: { from: string; to: string },
  rootPath: string
): string {
  return `${readPathPreview(move.from, rootPath)} -> ${readPathPreview(move.to, rootPath)}`;
}

export function getFinderPlanPreviewSummaryViewModel(preview: {
  rootPath: string;
  operationCount: number;
  destructiveOperationCount: number;
  moveFiles: Array<{ from: string; to: string }>;
}): {
  destructiveOperationCount: number;
  moveCount: number;
  moveItems: Array<{ key: string; label: string }>;
  operationCount: number;
} {
  return {
    destructiveOperationCount: preview.destructiveOperationCount,
    moveCount: preview.moveFiles.length,
    moveItems: preview.moveFiles.slice(0, 3).map((move) => ({
      key: `${move.from}->${move.to}`,
      label: formatFinderPreviewMove(move, preview.rootPath)
    })),
    operationCount: preview.operationCount
  };
}

export function readPathPreview(filePath: string, rootPath: string): string {
  const normalizedRoot = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return filePath.startsWith(normalizedRoot)
    ? filePath.slice(normalizedRoot.length)
    : filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

export function readMissingPermissionRows(
  permissions: Record<PermissionKey, { state: PermissionState }>
): PermissionRow[] {
  return PERMISSION_ROWS.filter((permission) =>
    BLOCKING_PERMISSION_STATES.includes(permissions[permission.key].state)
  );
}

export function readDesktopSessionPermissionState(
  diagnostics: { state: DesktopSessionDiagnosticState }
): PermissionState {
  if (diagnostics.state === "controllable") {
    return "granted";
  }

  if (diagnostics.state === "blocked") {
    return "denied";
  }

  return "unknown";
}

export function getPermissionDisplayRows({
  loading,
  permissions,
  rows = PERMISSION_ROWS
}: {
  loading: boolean;
  permissions: Record<PermissionKey, { state: PermissionState }>;
  rows?: PermissionRow[];
}): PermissionDisplayRow[] {
  return rows.map((row) => {
    const state = permissions[row.key].state;

    return {
      ...row,
      state,
      stateLabel: loading ? "检查中" : PERMISSION_STATE_COPY[state]
    };
  });
}

export function getPermissionsPanelViewModel({
  desktopSessionDiagnostics,
  permissions,
  permissionsLoading
}: {
  desktopSessionDiagnostics: { state: DesktopSessionDiagnosticState; reason: string };
  permissions: Record<PermissionKey, { state: PermissionState }>;
  permissionsLoading: boolean;
}): {
  desktopSession: {
    reason: string;
    showReason: boolean;
    state: PermissionState;
    stateLabel: string;
  };
  permissionRows: PermissionDisplayRow[];
} {
  return {
    desktopSession: {
      reason: desktopSessionDiagnostics.reason,
      showReason: desktopSessionDiagnostics.state === "blocked",
      state: readDesktopSessionPermissionState(desktopSessionDiagnostics),
      stateLabel: permissionsLoading
        ? "检查中"
        : DESKTOP_SESSION_STATE_COPY[desktopSessionDiagnostics.state]
    },
    permissionRows: getPermissionDisplayRows({
      loading: permissionsLoading,
      permissions
    })
  };
}

export function getPlannerProviderDisplayViewModel(settings: {
  externalProviderLabel: string;
  mode: string;
}): {
  runtimeLabel: string;
  settingsHeading: string;
  showExternalStatus: boolean;
} {
  return {
    runtimeLabel: settings.mode === "disabled" ? "规划已关闭" : "规划可用",
    settingsHeading: settings.mode === "external-cua"
      ? settings.externalProviderLabel
      : "Computer Use",
    showExternalStatus: settings.mode === "external-cua"
  };
}

export function canStopTurn(status: TaskStatus): boolean {
  return (
    status === "planned"
    || status === "running"
    || status === "observing"
    || status === "executing"
    || status === "approval_required"
    || status === "needs_confirmation"
  );
}

export function canDismissTaskBubble(status: TaskStatus): boolean {
  return (
    status === "completed"
    || status === "denied"
    || status === "blocked"
    || status === "needs_clarification"
    || status === "failed"
    || status === "cancelled"
  );
}

export function getDashboardStatusCopy(task: {
  status: TaskStatus;
  message: string;
}): { label: string; detail: string; tone: Tone } {
  switch (task.status) {
    case "planned":
      return { label: "任务已规划", detail: task.message, tone: "warning" };
    case "observing":
      return { label: "正在观察桌面", detail: task.message, tone: "warning" };
    case "executing":
    case "running":
      return { label: "正在执行任务", detail: task.message, tone: "warning" };
    case "approval_required":
      return { label: "等待审批", detail: task.message, tone: "warning" };
    case "needs_confirmation":
      return { label: "需要人工确认", detail: task.message, tone: "warning" };
    case "needs_clarification":
      return { label: "需要澄清目标", detail: task.message, tone: "warning" };
    case "completed":
      return { label: "任务已完成", detail: task.message, tone: "success" };
    case "denied":
      return { label: "请求已拒绝", detail: task.message, tone: "neutral" };
    case "blocked":
      return { label: "环境阻塞", detail: task.message, tone: "danger" };
    case "failed":
      return { label: "任务失败", detail: task.message, tone: "danger" };
    case "cancelled":
      return { label: "任务已停止", detail: task.message, tone: "neutral" };
    case "idle":
    default:
      return { label: "待命中", detail: task.message, tone: "neutral" };
  }
}

export function getRiskCopy(risk?: {
  level: RiskLevel;
  reason: string;
  requiresApproval: boolean;
}): { label: string; detail: string; tone: Tone } {
  if (!risk) {
    return {
      label: "未评估风险",
      detail: "下一次执行前会重新检查权限和动作风险",
      tone: "neutral"
    };
  }

  if (risk.level === "blocked") {
    return { label: "已阻止", detail: risk.reason, tone: "danger" };
  }

  if (risk.level === "high") {
    return { label: "高风险", detail: risk.reason, tone: "danger" };
  }

  if (risk.level === "medium") {
    return {
      label: risk.requiresApproval ? "中风险，需要审批" : "中风险",
      detail: risk.reason,
      tone: "warning"
    };
  }

  return { label: "低风险", detail: risk.reason, tone: "success" };
}

export function getPermissionHealthCopy(
  permissions: Record<PermissionKey, { state: PermissionState }>,
  diagnostics: { state: DesktopSessionDiagnosticState; reason: string }
): { label: string; detail: string; tone: Tone } {
  if (diagnostics.state === "blocked") {
    return {
      label: "桌面暂不可控",
      detail: diagnostics.reason,
      tone: "danger"
    };
  }

  const missingRows = readMissingPermissionRows(permissions);
  if (missingRows.length > 0) {
    return {
      label: `${missingRows.length} 项授权待处理`,
      detail: missingRows.map((row) => row.label).join("、"),
      tone: "warning"
    };
  }

  if (diagnostics.state === "controllable") {
    return {
      label: "授权已就绪",
      detail: "桌面会话可控",
      tone: "success"
    };
  }

  return {
    label: "授权待检查",
    detail: "刷新后确认屏幕录制和辅助功能状态",
    tone: "neutral"
  };
}

export function getPolicySummary(settings: {
  apps: Array<{ policy: "allow" | "ask" | "deny" }>;
}): string {
  const askCount = settings.apps.filter((entry) => entry.policy === "ask").length;
  const denyCount = settings.apps.filter((entry) => entry.policy === "deny").length;

  if (denyCount > 0) {
    return `${denyCount} 个应用已阻止，${askCount} 个应用执行前询问`;
  }

  if (askCount > 0) {
    return `${askCount} 个应用执行前询问`;
  }

  return "常用应用已允许";
}

export function getRecentExecutionCopy(replay: {
  transcript: {
    outcome: TurnTranscriptOutcome;
    command?: string;
  };
} | null): { label: string; detail: string; tone: Tone } {
  const transcript = replay?.transcript;
  if (!transcript) {
    return {
      label: "暂无最近执行",
      detail: "完成一次任务后会显示摘要",
      tone: "neutral"
    };
  }

  const outcomeCopy: Record<TurnTranscriptOutcome, string> = {
    completed: "已完成",
    approval_required: "等待审批",
    needs_confirmation: "需要确认",
    needs_clarification: "需要澄清",
    verification_failed: "需要确认",
    denied: "已拒绝",
    blocked: "环境阻塞",
    cancelled: "已停止",
    failed: "失败",
    running: "进行中"
  };
  const tone =
    transcript.outcome === "completed"
      ? "success"
      : transcript.outcome === "failed"
        || transcript.outcome === "verification_failed"
        || transcript.outcome === "blocked"
        ? "danger"
        : transcript.outcome === "denied" || transcript.outcome === "cancelled"
          ? "neutral"
          : "warning";

  return {
    label: outcomeCopy[transcript.outcome],
    detail: transcript.command ?? "最近任务未记录命令",
    tone
  };
}

export function readPetRouteOutcome({
  task,
  turnReplay
}: {
  task: {
    status: TaskStatus;
    message: string;
    command?: string;
    route?: string;
    routeReason?: string;
    denialKind?: string;
    policyKind?: string;
    routeOutcome?: PetRouteOutcome;
    stopTurnBehavior?: PetStopTurnBehavior;
  };
  turnReplay: {
    routeOutcome?: PetRouteOutcome;
    stopTurnBehavior?: PetStopTurnBehavior;
    transcript?: {
      command?: string;
      actions?: Array<{
        type: string;
        route?: string;
        status?: string;
        summary?: string;
        evidenceSummary?: string;
        command?: string;
      }>;
    };
    timeline?: Array<{
      status: TaskStatus;
      message?: string;
      command?: string;
      route?: string;
      routeReason?: string;
      denialKind?: string;
      policyKind?: string;
      stopTurnBehavior?: PetStopTurnBehavior;
    }>;
  } | null;
}): PetRouteOutcome {
  const explicitTaskRouteOutcome = readExplicitPetRouteOutcome(task.routeOutcome);
  if (explicitTaskRouteOutcome) {
    return explicitTaskRouteOutcome;
  }

  const explicitRouteOutcome = readExplicitPetRouteOutcome(turnReplay?.routeOutcome);
  if (explicitRouteOutcome && (task.status !== "idle" || explicitRouteOutcome.kind === "idle")) {
    return explicitRouteOutcome;
  }

  const latestTimelineEvent = turnReplay?.timeline?.at(-1);
  const latestToolAction = turnReplay?.transcript?.actions
    ?.filter((action) => action.type === "tool_call" || action.type === "tool_result")
    .at(-1);
  const command = task.command ?? latestTimelineEvent?.command ?? turnReplay?.transcript?.command;
  const route = task.route ?? latestToolAction?.route ?? latestTimelineEvent?.route;
  const routeReason = task.routeReason ?? latestTimelineEvent?.routeReason;
  const denialKind = task.denialKind ?? latestTimelineEvent?.denialKind;
  const policyKind = task.policyKind ?? latestTimelineEvent?.policyKind;
  const stopTurnBehavior = task.stopTurnBehavior
    ?? latestTimelineEvent?.stopTurnBehavior
    ?? turnReplay?.stopTurnBehavior;
  const latestMessage = task.message || latestTimelineEvent?.message;
  const currentTurn = {
    state: task.status,
    source: "pet-ui",
    ...(command ? { command } : {}),
    ...(route ? { route } : {}),
    ...(routeReason ? { routeReason } : {}),
    ...(denialKind ? { denialKind } : {}),
    ...(policyKind ? { policyKind } : {}),
    ...(stopTurnBehavior ? { stopTurnBehavior } : {}),
    ...(latestMessage ? { latestMessage } : {}),
    ...(latestToolAction ? { latestAction: summarizePetRouteToolAction(latestToolAction) } : {})
  };
  const replay = {
    source: "pet-ui-replay",
    ...(latestTimelineEvent?.message ? { latestMessage: latestTimelineEvent.message } : {}),
    ...(latestTimelineEvent?.routeReason ? { routeReason: latestTimelineEvent.routeReason } : {}),
    ...(stopTurnBehavior ? { stopTurnBehavior } : {}),
    ...(latestToolAction ? { latestToolCall: summarizePetRouteToolAction(latestToolAction) } : {})
  };

  return readRouteOutcome({
    currentTurn,
    replay,
    defaultSource: "pet-ui",
    includeCommandDetail: false,
    sanitizeString: sanitizePetRouteOutcomeString
  });
}

export function getUserDashboardPanelViewModel({
  desktopSessionDiagnostics,
  permissions,
  task,
  turnReplay
}: {
  desktopSessionDiagnostics: { state: DesktopSessionDiagnosticState; reason: string };
  permissions: Record<PermissionKey, { state: PermissionState }>;
  task: {
    status: TaskStatus;
    message: string;
    command?: string;
    route?: string;
    routeReason?: string;
    denialKind?: string;
    policyKind?: string;
    routeOutcome?: PetRouteOutcome;
    stopTurnBehavior?: PetStopTurnBehavior;
  };
  turnReplay: {
    routeOutcome?: PetRouteOutcome;
    stopTurnBehavior?: PetStopTurnBehavior;
    transcript: {
      outcome: TurnTranscriptOutcome;
      command?: string;
      risk?: {
        level: RiskLevel;
        reason: string;
        requiresApproval: boolean;
      };
    };
    timeline?: Array<{
      status: TaskStatus;
      message?: string;
      command?: string;
      route?: string;
      routeReason?: string;
      denialKind?: string;
      policyKind?: string;
      stopTurnBehavior?: PetStopTurnBehavior;
    }>;
  } | null;
}): {
  canApprove: boolean;
  canStop: boolean;
  permissionHealth: { label: string; detail: string; tone: Tone };
  recent: { label: string; detail: string; tone: Tone };
  risk: { label: string; detail: string; tone: Tone };
  routeOutcome: PetRouteOutcome;
  routeOutcomeSignal: PetRouteOutcomeSignal;
  status: { label: string; detail: string; tone: Tone };
} {
  const routeOutcome = readPetRouteOutcome({ task, turnReplay });

  return {
    canApprove: task.status === "approval_required",
    canStop: canStopTurn(task.status),
    permissionHealth: getPermissionHealthCopy(permissions, desktopSessionDiagnostics),
    recent: getRecentExecutionCopy(turnReplay),
    risk: getRiskCopy(turnReplay?.transcript.risk),
    routeOutcome,
    routeOutcomeSignal: getPetRouteOutcomeSignal(routeOutcome),
    status: getDashboardStatusCopy(task)
  };
}

export function getPetRouteOutcomeSignal(outcome: PetRouteOutcome): PetRouteOutcomeSignal {
  return {
    label: PET_ROUTE_OUTCOME_SIGNAL_LABELS[outcome.kind],
    detail: getPetRouteOutcomeSignalDetail(outcome),
    tone: outcome.tone
  };
}

const PET_ROUTE_OUTCOME_SIGNAL_LABELS: Record<PetRouteOutcome["kind"], string> = {
  idle: "路由待命",
  running: "路由运行中",
  approval_required: "路由待审批",
  needs_confirmation: "路由待确认",
  needs_clarification: "路由待澄清",
  app_policy_denied: "应用策略拒绝",
  chrome_host_policy_denied: "Chrome 站点策略拒绝",
  user_denied: "用户已拒绝",
  blocked: "路由阻塞",
  cancelled: "路由已取消",
  stopped: "路由已停止",
  failed: "路由失败",
  completed: "路由完成",
  unknown: "路由未知"
};

function getPetRouteOutcomeSignalDetail(outcome: PetRouteOutcome): string {
  const routePrefix = outcome.routeLabel && outcome.routeLabel !== "unknown"
    ? `${outcome.routeLabel} · `
    : "";
  const detail = outcome.detail.trim();
  const metadata = formatPetRouteOutcomeMetadata(outcome);

  if (outcome.kind === "idle" && !routePrefix) {
    return "暂无路由活动";
  }

  if (outcome.kind === "unknown" && !routePrefix && !detail) {
    return "状态待确认";
  }

  return `${routePrefix}${detail || outcome.value}${metadata}`;
}

function formatPetRouteOutcomeMetadata(outcome: PetRouteOutcome): string {
  const metadata = [
    outcome.denialKind ? `拒绝 ${outcome.denialKind}` : undefined,
    outcome.policyKind ? `策略 ${outcome.policyKind}` : undefined
  ].filter((value): value is string => Boolean(value));

  return metadata.length > 0 ? ` · ${metadata.join(" · ")}` : "";
}

function summarizePetRouteToolAction(action: {
  type: string;
  route?: string;
  status?: string;
  summary?: string;
  evidenceSummary?: string;
  command?: string;
}): Record<string, unknown> {
  return {
    type: action.type,
    ...(action.route ? { route: action.route } : {}),
    ...(action.status ? { status: action.status } : {}),
    ...(action.summary ? { summary: action.summary } : {}),
    ...(action.evidenceSummary ? { evidenceSummary: action.evidenceSummary } : {}),
    ...(action.command ? { command: action.command } : {})
  };
}

function readExplicitPetRouteOutcome(outcome?: Partial<PetRouteOutcome>): PetRouteOutcome | null {
  if (!outcome || !isRouteOutcomeKind(outcome.kind) || !isRouteOutcomeTone(outcome.tone)) {
    return null;
  }

  const title = readSanitizedPetRouteOutcomeField(outcome.title);
  const value = readSanitizedPetRouteOutcomeField(outcome.value);
  const detail = readSanitizedPetRouteOutcomeField(outcome.detail);
  const source = readSanitizedPetRouteOutcomeField(outcome.source);
  const routeLabel = readSanitizedPetRouteOutcomeField(outcome.routeLabel);
  const state = readSanitizedPetRouteOutcomeField(outcome.state);
  const denialKind = readSanitizedPetRouteOutcomeField(outcome.denialKind);
  const policyKind = readSanitizedPetRouteOutcomeField(outcome.policyKind);
  if (!title || !source || !state) {
    return null;
  }

  return readExplicitRouteOutcome({
    kind: outcome.kind,
    title,
    value: value || outcome.kind,
    detail: detail || "No route activity has been recorded yet.",
    tone: outcome.tone,
    source,
    routeLabel: routeLabel || "unknown",
    state,
    ...(denialKind ? { denialKind } : {}),
    ...(policyKind ? { policyKind } : {})
  }, {
    kind: outcome.kind,
    title,
    value: outcome.kind,
    detail: detail || "No route activity has been recorded yet.",
    tone: outcome.tone,
    source,
    routeLabel: routeLabel || "unknown",
    state,
    ...(denialKind ? { denialKind } : {}),
    ...(policyKind ? { policyKind } : {})
  }, {
    requireKind: true,
    sanitizeString: sanitizePetRouteOutcomeString
  }) ?? null;
}

function readSanitizedPetRouteOutcomeField(value: unknown): string | undefined {
  return typeof value === "string" ? sanitizePetRouteOutcomeString(value) : undefined;
}

function sanitizePetRouteOutcomeString(value: string): string {
  return value
    .replace(/\b(token|password|secret|api[_-]?key)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/(?:file:\/\/)?(?:\/Users\/|\/tmp\/|\/private\/tmp\/|\/var\/|\/repo\/)[^\s"')]+/g, "[path]");
}

export function getAppRootViewModel<
  TProvider extends { id: string; selected?: boolean },
  TStartupWarning
>({
  assistantAgentSettings,
  fallbackAssistantAgentProvider,
  panelState,
  permissions,
  startupWarnings,
  taskStatus
}: {
  assistantAgentSettings: {
    providers: TProvider[];
    settings: { mode: string };
  };
  fallbackAssistantAgentProvider: TProvider;
  panelState: {
    assistantPanelOpen: boolean;
    detailsOpen: boolean;
    permissionOnboardingOpen: boolean;
  };
  permissions: Record<PermissionKey, { state: PermissionState }>;
  startupWarnings: TStartupWarning[];
  taskStatus: TaskStatus;
}): {
  panelVisibility: ReturnType<typeof getPanelVisibilityState>;
  permissionOnboardingRows: PermissionRow[];
  petState: PetAtlasState;
  selectedAssistantAgentProvider: TProvider;
  startupWarning: TStartupWarning | undefined;
  status: { label: string; message: string; pulse: string };
} {
  const startupWarning = startupWarnings[0];

  return {
    panelVisibility: getPanelVisibilityState({
      assistantPanelOpen: panelState.assistantPanelOpen,
      detailsOpen: panelState.detailsOpen,
      hasStartupWarning: Boolean(startupWarning),
      permissionOnboardingOpen: panelState.permissionOnboardingOpen,
      taskStatus
    }),
    permissionOnboardingRows: readMissingPermissionRows(permissions),
    petState: getPetStateForTask(taskStatus),
    selectedAssistantAgentProvider: readSelectedAssistantAgentProvider(
      assistantAgentSettings.providers,
      assistantAgentSettings.settings.mode,
      fallbackAssistantAgentProvider
    ),
    startupWarning,
    status: STATUS_COPY[taskStatus]
  };
}

export function getAppShellViewModel<
  TProvider extends {
    id: string;
    label: string;
    readiness: AssistantAgentProviderReadiness;
    selected?: boolean;
  },
  TStartupWarning
>({
  assistantAgentSettings,
  assistantInput,
  assistantInputSubmitting,
  desktopSessionDiagnostics,
  fallbackAssistantAgentProvider,
  panelState,
  permissions,
  permissionsLoading,
  plannerProviderSettings,
  startupWarnings,
  taskStatus
}: {
  assistantAgentSettings: {
    providers: TProvider[];
    settings: { mode: string };
  };
  assistantInput: string;
  assistantInputSubmitting: boolean;
  desktopSessionDiagnostics: { state: DesktopSessionDiagnosticState; reason: string };
  fallbackAssistantAgentProvider: TProvider;
  panelState: {
    assistantPanelOpen: boolean;
    detailsOpen: boolean;
    permissionOnboardingOpen: boolean;
  };
  permissions: Record<PermissionKey, { state: PermissionState }>;
  permissionsLoading: boolean;
  plannerProviderSettings: {
    externalProviderLabel: string;
    mode: string;
  };
  startupWarnings: TStartupWarning[];
  taskStatus: TaskStatus;
}): ReturnType<typeof getAppRootViewModel<TProvider, TStartupWarning>> & {
  assistantInputPanel: ReturnType<typeof getAssistantInputPanelViewModel>;
  permissionOnboardingDisplayRows: PermissionDisplayRow[];
  permissionPanelViewModel: ReturnType<typeof getPermissionsPanelViewModel>;
  plannerProviderDisplay: ReturnType<typeof getPlannerProviderDisplayViewModel>;
} {
  const root = getAppRootViewModel({
    assistantAgentSettings,
    fallbackAssistantAgentProvider,
    panelState,
    permissions,
    startupWarnings,
    taskStatus
  });

  return {
    ...root,
    assistantInputPanel: getAssistantInputPanelViewModel({
      input: assistantInput,
      provider: root.selectedAssistantAgentProvider,
      submitting: assistantInputSubmitting
    }),
    permissionOnboardingDisplayRows: getPermissionDisplayRows({
      loading: permissionsLoading,
      permissions,
      rows: root.permissionOnboardingRows
    }),
    permissionPanelViewModel: getPermissionsPanelViewModel({
      desktopSessionDiagnostics,
      permissions,
      permissionsLoading
    }),
    plannerProviderDisplay: getPlannerProviderDisplayViewModel(plannerProviderSettings)
  };
}

export function getLocalReplayViewModel(replay: {
  transcript?: {
    outcome: TurnTranscriptOutcome;
    command?: string;
    risk?: { level: RiskLevel };
    planner?: {
      providerLabel: string;
      command: string;
      rationale?: string;
    };
    actions: Array<{
      type: string;
      appName?: string;
      bundleId?: string;
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
    screenshots: Array<{
      stage: string;
      path: string;
      grounding?: { recommendation: string };
    }>;
  };
  timeline?: Array<{
    status: TaskStatus;
    message?: string;
    command?: string;
  }>;
} | null): {
  actionItems: string[];
  command: string;
  hasTranscript: boolean;
  headingOutcome: string;
  plannerItems: string[];
  riskLevel: string;
  screenshotItems: string[];
  timelineItems: string[];
} {
  const transcript = replay?.transcript;

  if (!transcript) {
    return {
      actionItems: [],
      command: "未记录",
      hasTranscript: false,
      headingOutcome: "empty",
      plannerItems: [],
      riskLevel: "unknown",
      screenshotItems: [],
      timelineItems: []
    };
  }

  return {
    actionItems: transcript.actions.map(formatReplayAction),
    command: transcript.command ?? "未记录",
    hasTranscript: true,
    headingOutcome: transcript.outcome,
    plannerItems: transcript.planner ? [formatReplayPlanner(transcript.planner)] : [],
    riskLevel: transcript.risk?.level ?? "unknown",
    screenshotItems: transcript.screenshots.map((screenshot) =>
      `${screenshot.stage}: ${screenshot.path}`
        + (screenshot.grounding ? ` (${screenshot.grounding.recommendation})` : "")
    ),
    timelineItems: (replay?.timeline ?? []).map((event) =>
      `${event.status}: ${event.message ?? event.command ?? ""}`
    )
  };
}

export function getPanelVisibilityState({
  assistantPanelOpen,
  detailsOpen,
  hasStartupWarning,
  permissionOnboardingOpen,
  taskStatus
}: {
  assistantPanelOpen: boolean;
  detailsOpen: boolean;
  hasStartupWarning: boolean;
  permissionOnboardingOpen: boolean;
  taskStatus: TaskStatus;
}): {
  bubbleAriaLabel: string;
  settingsBubble: boolean;
  showPanel: boolean;
  showStartupWarning: boolean;
} {
  const showStartupWarning = hasStartupWarning
    && !detailsOpen
    && !permissionOnboardingOpen
    && taskStatus === "idle";
  const showPanel =
    assistantPanelOpen
    || detailsOpen
    || permissionOnboardingOpen
    || taskStatus !== "idle"
    || showStartupWarning;
  const bubbleAriaLabel = detailsOpen
    ? "skfiy settings"
    : permissionOnboardingOpen
      ? "权限引导"
      : assistantPanelOpen
        ? "skfiy assistant panel"
        : "skfiy task status";

  return {
    bubbleAriaLabel,
    settingsBubble: detailsOpen || permissionOnboardingOpen,
    showPanel,
    showStartupWarning
  };
}

export function getReplayAccessibilityLabel(record: { accessibilityTrusted?: boolean }): string {
  if (record.accessibilityTrusted === true) {
    return "AX ok";
  }

  if (record.accessibilityTrusted === false) {
    return "AX denied";
  }

  return "AX unknown";
}

export function getReplayOcrLabel(record: { ocrLabels?: unknown[] }): string | null {
  if (!record.ocrLabels) {
    return null;
  }

  return `OCR ${record.ocrLabels.length}`;
}

export function getTaskReplayRows(records: Array<{
  accessibilityTrusted?: boolean;
  ocrLabels?: unknown[];
  screenshotPath: string;
  stage: string;
}>): Array<{
  accessibilityLabel: string;
  accessibilityState: "denied" | "ok";
  key: string;
  ocrLabel: string | null;
  screenshotPath: string;
  stage: string;
}> {
  return records.map((record) => ({
    accessibilityLabel: getReplayAccessibilityLabel(record),
    accessibilityState: record.accessibilityTrusted === false ? "denied" : "ok",
    key: record.stage,
    ocrLabel: getReplayOcrLabel(record),
    screenshotPath: record.screenshotPath,
    stage: record.stage
  }));
}

export function formatReplayPlanner(planner: {
  providerLabel: string;
  command: string;
  rationale?: string;
}): string {
  return `${planner.providerLabel}: ${planner.command}`
    + (planner.rationale ? ` (${planner.rationale})` : "");
}

export function formatReplayAction(action: {
  type: string;
  appName?: string;
  bundleId?: string;
  text?: string;
  key?: string;
  action?: string;
  actionType?: string;
  status?: string;
  stage?: string;
  message?: string;
  reason?: string;
  route?: string;
  decision?: string;
  summary?: string;
  evidenceSummary?: string;
  artifactCount?: number;
  providerLabel?: string;
  command?: string;
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
}): string {
  if (action.type === "plan") {
    return `${action.type}: ${action.providerLabel ?? ""} ${action.command ?? ""}`.trim();
  }

  if (action.type === "tool_call") {
    return joinReplayActionParts([
      "tool_call:",
      action.route ?? "unknown",
      action.status ?? "unknown",
      sanitizePetRouteOutcomeString(action.command ?? "")
    ]);
  }

  if (action.type === "approval_decision") {
    return joinReplayActionParts([
      "approval_decision:",
      action.route ?? "unknown",
      action.decision ?? "unknown",
      sanitizePetRouteOutcomeString(action.reason ?? "")
    ]);
  }

  if (action.type === "tool_result") {
    const detail = sanitizePetRouteOutcomeString(action.summary ?? action.evidenceSummary ?? "");
    return joinReplayActionParts([
      "tool_result:",
      action.route ?? "unknown",
      action.status ?? "unknown",
      detail,
      typeof action.artifactCount === "number" && action.artifactCount > 0
        ? `${action.artifactCount} artifacts`
        : ""
    ]);
  }

  if (action.type === "type_text") {
    return `${action.type}: ${action.text ?? ""}`;
  }

  if (action.type === "press_key") {
    return `${action.type}: ${action.key ?? ""}`;
  }

  if (action.type === "activate_app" || action.type === "open_session") {
    return `${action.type}: ${action.appName ?? action.bundleId ?? ""}`;
  }

  if (action.type === "recover") {
    return `${action.type}: ${action.action ?? ""} ${action.stage ?? ""}`.trim();
  }

  if (action.type === "switch_control") {
    return joinReplayActionParts([
      "switch_control:",
      action.from ?? "unknown",
      "->",
      action.to ?? "unknown",
      action.stage ?? "",
      sanitizePetRouteOutcomeString(action.reason ?? "")
    ]);
  }

  if (action.type === "observe_finder_selection") {
    return joinReplayActionParts([
      "observe_finder_selection:",
      typeof action.selectedCount === "number" ? `${action.selectedCount} selected` : "",
      action.source ?? "",
      sanitizePetRouteOutcomeString(action.targetPath ?? action.frontmostBundleId ?? "")
    ]);
  }

  if (action.type === "preview_finder_plan") {
    return joinReplayActionParts([
      "preview_finder_plan:",
      typeof action.operationCount === "number" ? `${action.operationCount} ops` : "",
      typeof action.destructiveOperationCount === "number" ? `${action.destructiveOperationCount} destructive` : "",
      typeof action.createFolderCount === "number" ? `${action.createFolderCount} folders` : "",
      typeof action.moveFileCount === "number" ? `${action.moveFileCount} moves` : "",
      sanitizePetRouteOutcomeString(action.rootPath ?? "")
    ]);
  }

  if (action.type === "confirm_finder_plan") {
    return joinReplayActionParts([
      "confirm_finder_plan:",
      typeof action.operationCount === "number" ? `${action.operationCount} ops` : "",
      typeof action.destructiveOperationCount === "number" ? `${action.destructiveOperationCount} destructive` : "",
      sanitizePetRouteOutcomeString(action.reason ?? ""),
      sanitizePetRouteOutcomeString(action.rootPath ?? "")
    ]);
  }

  if (action.type === "verify") {
    const detail = sanitizePetRouteOutcomeString(action.reason ?? action.message ?? "");
    return `${action.type}: ${action.actionType ?? ""} ${action.status ?? ""} ${detail}`.trim();
  }

  return action.type;
}

function joinReplayActionParts(parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join(" ").trim();
}
