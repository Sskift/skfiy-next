import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  ExternalLink,
  Play,
  RefreshCw,
  SlidersHorizontal
} from "lucide-react";
import {
  useCallback,
  useEffect,
  type FormEvent,
  useMemo,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  getConfiguredPetAtlas,
  isPetAtlasManifest,
  resolvePetAtlas,
  type PetAtlas
} from "./pet-atlas";
import {
  getAppShellViewModel,
  readAssistantAgentProviderDetail,
  readAssistantAgentReadinessLabel,
  readExternalCuaStatusLabel
} from "./app-view-model";
import {
  DesktopPet,
  FinderPlanPreviewSummary,
  LocalReplayViewer,
  TaskControlCard,
  TaskReplay,
  UserDashboardPanel
} from "./app-components";
import {
  ConversationAssistantHeader,
  ConversationSessionNavigator,
  ConversationTranscript,
  type ConversationActionState
} from "./app-conversation-components";
import {
  createConversationRetryRequest,
  createEmptyConversationHistorySnapshot,
  readActiveConversationSession
} from "./app-conversation-state";
import {
  createFirstRunReadinessSnapshot,
  type FirstRunReadinessSnapshot,
  type FirstRunReadinessStepId
} from "../shared/first-run-readiness";
import { getDesktopApi } from "./app-desktop-api";
import {
  appendAssistantConversationSubmission,
  appendAssistantConversationSubmissionFailure,
  createAssistantInputSubmissionTransition,
  createInitialTaskView,
  createAssistantSubmissionFailureTaskView,
  createTaskActionFailureView,
  createTaskEventUiTransition,
  createStopTurnUiTransition,
  createTaskStatusView,
  updateAssistantConversationForTaskEvent,
  updateReplayRecordsForTaskEvent,
  shouldStopCurrentTurnFromKeyboard,
  shouldSubmitAssistantInputFromKeyboard,
  type AssistantConversationMessage,
  type TaskView
} from "./app-task-state";
import {
  INITIAL_PANEL_STATE,
  createPetClickPanelTransition,
  reducePanelState,
  type PanelStateAction
} from "./app-panel-state";
import {
  UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS,
  UNKNOWN_PERMISSIONS,
  createPermissionOnboardingRefreshTransition,
  createUnknownPermissionRefreshState,
} from "./app-permission-state";
import {
  createPetDragState,
  createPetDragMoveTransition,
  isMatchingPetDragPointer,
  readVisiblePetRect,
  shouldStartPetDrag,
  shouldSuppressPetClickAfterDrag,
  type PetDragState
} from "./app-pet-drag-state";
import {
  APP_POLICY_OPTIONS,
  ASSISTANT_AGENT_OPTIONS,
  DEFAULT_APP_POLICY_SETTINGS,
  DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
  DEFAULT_PLANNER_PROVIDER_SETTINGS,
  PLANNER_PROVIDER_OPTIONS
} from "./app-settings-state";
import type {
  AppPolicy,
  AppPolicySettings,
  AssistantAgentMode,
  AssistantAgentSettingsResponse,
  ConversationHistorySnapshot,
  ConversationRetryResult,
  DesktopSessionDiagnostics,
  ObserveAppReplayRecord,
  PermissionSettingsTarget,
  PermissionSummary,
  PlannerProviderMode,
  PlannerProviderSettings,
  StartupWarning,
  TaskApprovalDecisionInput,
  TaskEvent,
  TaskStatus,
  TurnReplay
} from "./app-types";
import type {
  TaskControlRecoveryAction,
  TaskControlSnapshot,
  TaskControlStatus
} from "../shared/task-control";

export type {
  AppPolicy,
  AppPolicySettings,
  AssistantAgentMode,
  AssistantAgentProviderReadiness,
  AssistantAgentProviderState,
  AssistantAgentSettings,
  AssistantAgentSettingsResponse,
  ControlledAppPolicyEntry,
  DesktopApi,
  DesktopSessionDiagnosticState,
  DesktopSessionDiagnostics,
  DesktopSessionStatus,
  FinderPlanPreview,
  FinderSelectionResult,
  ManualMode,
  ObserveAppReplayRecord,
  PermissionDiagnostics,
  PermissionSettingsTarget,
  PermissionState,
  PermissionSummary,
  PetWindowMode,
  PlannerProviderMode,
  PlannerProviderSettings,
  RiskLevel,
  RuntimeStatus,
  StartupWarning,
  StartupWarningId,
  TaskEvent,
  TaskStatus,
  TurnReplay,
  TurnTranscript,
  TurnTranscriptOutcome,
  VisiblePetRect,
  WindowBounds
} from "./app-types";

// The preload surface already accepts "automation-finder"; the renderer
// PermissionSettingsTarget union is widened locally until app-types.ts syncs.
type FirstRunPermissionTarget = PermissionSettingsTarget | "automation-finder";

const FIRST_RUN_STEP_COPY: Record<FirstRunReadinessStepId, string> = {
  "background-agent": "Background Agent",
  "screen-recording": "屏幕录制",
  accessibility: "辅助功能",
  "finder-automation": "Finder Automation",
  "browser-context": "Browser Context"
};

const FIRST_RUN_REQUIREMENT_COPY = {
  "required-for-chat": "聊天必需",
  "computer-use": "Computer Use",
  optional: "可选增强"
} as const;

const FIRST_RUN_STATE_COPY = {
  ready: "已就绪",
  "action-required": "需操作",
  blocked: "受阻",
  unknown: "未知"
} as const;

function FirstRunReadinessPanel({
  actionStepId,
  loading,
  onOpenPermissionSettings,
  onRefresh,
  onTestBackgroundAgent,
  onTestFinderAutomation,
  snapshot
}: {
  actionStepId: FirstRunReadinessStepId | null;
  loading: boolean;
  onOpenPermissionSettings: (target: FirstRunPermissionTarget) => void;
  onRefresh: () => void;
  onTestBackgroundAgent: () => void;
  onTestFinderAutomation: () => void;
  snapshot: FirstRunReadinessSnapshot;
}) {
  return (
    <section
      className="first-run-readiness"
      aria-label="首次运行就绪检查"
      data-resume-step={snapshot.resumeStepId ?? "complete"}
    >
      <div className="first-run-heading">
        <div>
          <strong>首次运行</strong>
          <span>{snapshot.chatReady ? "普通聊天可用" : "Background Agent 需要处理"}</span>
        </div>
        <button
          type="button"
          aria-label="刷新首次运行就绪状态"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>
      <p className="first-run-scope">
        {snapshot.computerUseReady ? "Computer Use 已就绪" : "Computer Use 可稍后设置"}
      </p>
      <div className="first-run-list">
        {snapshot.steps.map((step) => {
          const label = FIRST_RUN_STEP_COPY[step.id];
          const actionBusy = actionStepId === step.id;
          return (
            <div
              className="first-run-step"
              aria-current={snapshot.resumeStepId === step.id ? "step" : undefined}
              aria-label={`${label} 就绪项`}
              data-requirement={step.requirement}
              data-step-id={step.id}
              data-state={step.state}
              key={step.id}
            >
              <div className="first-run-step-heading">
                <span aria-hidden="true">
                  {step.state === "ready" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                </span>
                <strong>{label}</strong>
                <em>{FIRST_RUN_REQUIREMENT_COPY[step.requirement]}</em>
                <b>{FIRST_RUN_STATE_COPY[step.state]}</b>
              </div>
              {step.state !== "ready" ? (
                <div className="first-run-step-detail">
                  <p>{step.reason}</p>
                  <small>{step.nextAction}</small>
                  <div className="first-run-step-actions">
                    {step.id === "background-agent" ? (
                      <button
                        type="button"
                        aria-label="安全测试 Background Agent"
                        disabled={actionBusy}
                        onClick={onTestBackgroundAgent}
                      >
                        {actionBusy ? "测试中" : "安全测试"}
                      </button>
                    ) : null}
                    {step.id === "screen-recording" ? (
                      <button
                        type="button"
                        aria-label="打开屏幕录制设置"
                        disabled={actionBusy}
                        onClick={() => onOpenPermissionSettings("screen-recording")}
                      >
                        打开设置
                      </button>
                    ) : null}
                    {step.id === "accessibility" ? (
                      <button
                        type="button"
                        aria-label="打开辅助功能设置"
                        disabled={actionBusy}
                        onClick={() => onOpenPermissionSettings("accessibility")}
                      >
                        打开设置
                      </button>
                    ) : null}
                    {step.id === "finder-automation" ? (
                      <>
                        {step.state === "blocked" ? (
                          <button
                            type="button"
                            aria-label="打开 Finder Automation 设置"
                            disabled={actionBusy}
                            onClick={() => onOpenPermissionSettings("automation-finder")}
                          >
                            打开设置
                          </button>
                        ) : null}
                        <button
                          type="button"
                          aria-label="只读测试 Finder Automation"
                          disabled={actionBusy}
                          onClick={onTestFinderAutomation}
                        >
                          {actionBusy ? "测试中" : step.state === "blocked" ? "重新测试" : "只读测试"}
                        </button>
                      </>
                    ) : null}
                    {step.id === "browser-context" ? (
                      <button
                        type="button"
                        aria-label="刷新 Browser Context"
                        disabled={actionBusy || loading}
                        onClick={onRefresh}
                      >
                        刷新状态
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {step.state === "ready" && step.id === "finder-automation" ? (
                <div className="first-run-step-actions first-run-step-actions-ready">
                  <button
                    type="button"
                    aria-label="只读测试 Finder Automation"
                    disabled={actionBusy}
                    onClick={onTestFinderAutomation}
                  >
                    {actionBusy ? "测试中" : "重新测试"}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function readTaskStatusFromTaskControl(status: TaskControlStatus): TaskStatus {
  switch (status) {
    case "app_policy_denied":
    case "user_denied":
      return "denied";
    case "confirmation_required":
      return "needs_confirmation";
    default:
      return status;
  }
}

function createTaskViewFromTaskControl(snapshot: TaskControlSnapshot): TaskView {
  return {
    status: readTaskStatusFromTaskControl(snapshot.status),
    message: snapshot.message,
    route: snapshot.plan.route
  };
}

function createConversationRetryTaskView(
  result: Pick<ConversationRetryResult, "status" | "message">
): TaskView {
  switch (result.status) {
    case "completed":
      return createTaskStatusView("completed", result.message);
    case "cancelled":
      return createTaskStatusView("cancelled", result.message);
    case "computer-use-blocked":
    case "unsafe-retry-blocked":
    case "not-found":
    case "retry-in-progress":
      return createTaskStatusView("blocked", result.message);
    case "provider-failed":
    case "storage-error":
      return createTaskStatusView("failed", result.message);
  }
}

function sanitizeTaskControlText(value: string): string {
  return value
    .replace(/\b(token|password|secret|api[_-]?key)=([^\s&]+)/giu, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/(?:file:\/\/)?(?:\/Users\/|\/tmp\/|\/private\/tmp\/|\/var\/|\/repo\/)[^\s"')]+/gu, "[path]");
}

function createTaskControlRecoveryDraft(
  snapshot: TaskControlSnapshot,
  action: Exclude<TaskControlRecoveryAction, "open_readiness">
): string {
  const target = sanitizeTaskControlText(snapshot.plan.target);
  const app = sanitizeTaskControlText(snapshot.plan.appName);

  if (action === "retry_observation") {
    return `Retry observation only for ${app} (${target}). Do not repeat any mutation.`;
  }

  if (action === "retry_verification") {
    return `Retry verification only for ${app} (${target}). Do not repeat any mutation.`;
  }

  return `Revise the Computer Use plan for ${app} (${target}) before taking any action.`;
}

function createConversationRetryRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `conversation-retry-${globalThis.crypto.randomUUID()}`;
  }

  return `conversation-retry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const api = useMemo(getDesktopApi, []);
  const [petAtlas, setPetAtlas] = useState<PetAtlas>(() => getConfiguredPetAtlas());
  const [panelState, setPanelState] = useState(INITIAL_PANEL_STATE);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantInputSubmitting, setAssistantInputSubmitting] = useState(false);
  const [assistantConversation, setAssistantConversation] = useState<AssistantConversationMessage[]>([]);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistorySnapshot>(
    createEmptyConversationHistorySnapshot
  );
  const [conversationHistoryAvailable, setConversationHistoryAvailable] = useState(false);
  const [conversationHistoryLoading, setConversationHistoryLoading] = useState(true);
  const [conversationNavigatorOpen, setConversationNavigatorOpen] = useState(false);
  const [conversationAction, setConversationAction] = useState<ConversationActionState | null>(null);
  const [conversationFeedback, setConversationFeedback] = useState("");
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [firstRunReadiness, setFirstRunReadiness] = useState<FirstRunReadinessSnapshot>(() =>
    createFirstRunReadinessSnapshot({})
  );
  const [firstRunReadinessLoaded, setFirstRunReadinessLoaded] = useState(false);
  const [firstRunReadinessLoading, setFirstRunReadinessLoading] = useState(false);
  const [firstRunActionStepId, setFirstRunActionStepId] =
    useState<FirstRunReadinessStepId | null>(null);
  const [permissions, setPermissions] = useState<PermissionSummary>(UNKNOWN_PERMISSIONS);
  const [desktopSessionDiagnostics, setDesktopSessionDiagnostics] =
    useState<DesktopSessionDiagnostics>(UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [startupWarnings, setStartupWarnings] = useState<StartupWarning[]>([]);
  const [appPolicySettings, setAppPolicySettings] = useState<AppPolicySettings>(
    DEFAULT_APP_POLICY_SETTINGS
  );
  const [assistantAgentSettings, setAssistantAgentSettings] =
    useState<AssistantAgentSettingsResponse>(DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE);
  const [plannerProviderSettings, setPlannerProviderSettings] =
    useState<PlannerProviderSettings>(DEFAULT_PLANNER_PROVIDER_SETTINGS);
  const [turnReplay, setTurnReplay] = useState<TurnReplay | null>(null);
  const [task, setTask] = useState<TaskView>(() => createInitialTaskView());
  const [taskControl, setTaskControl] = useState<TaskControlSnapshot | null>(null);
  const [taskControlActionError, setTaskControlActionError] = useState("");
  const [taskControlDecisionPending, setTaskControlDecisionPending] = useState(false);
  const [taskStopPending, setTaskStopPending] = useState(false);
  const [replayRecords, setReplayRecords] = useState<ObserveAppReplayRecord[]>([]);
  const assistantInputRef = useRef<HTMLTextAreaElement | null>(null);
  const petDragRef = useRef<PetDragState | null>(null);
  const pendingAssistantPromptRef = useRef<string | null>(null);
  const conversationHistoryAvailableRef = useRef(false);
  const conversationHistoryEventReceivedRef = useRef(false);
  const taskControlEventReceivedRef = useRef(false);
  const taskControlRef = useRef<TaskControlSnapshot | null>(null);
  const pendingTaskControlDecisionRef = useRef<TaskApprovalDecisionInput | null>(null);
  const taskStopPendingRef = useRef(false);
  const suppressNextPetClickRef = useRef(false);
  const { assistantPanelOpen, detailsOpen, permissionOnboardingOpen } = panelState;
  const activeConversationSession = useMemo(
    () => readActiveConversationSession(conversationHistory),
    [conversationHistory]
  );
  const conversationRetrying = conversationAction?.action === "retry";

  const transitionPanelState = useCallback((action: PanelStateAction) => {
    setPanelState((state) => reducePanelState(state, action));
  }, []);

  // skfiy-next's panel state has no dedicated "open-details" action; toggling
  // while closed reaches the same details-open state.
  const openDetailsPanel = useCallback(() => {
    setPanelState((state) => (state.detailsOpen
      ? state
      : reducePanelState(state, { type: "toggle-details" })));
  }, []);

  const preserveActiveTaskView = useCallback((current: TaskView, next: TaskView): TaskView => {
    const active = taskControlRef.current;
    if (active && active.phase !== "terminal") {
      return current;
    }

    return next;
  }, []);

  const applyConversationHistorySnapshot = useCallback((snapshot: ConversationHistorySnapshot) => {
    setConversationHistory(snapshot);
    setConversationHistoryAvailable(true);
    setConversationHistoryLoading(false);
    setAssistantConversation([]);
  }, []);

  const refreshConversationHistory = useCallback(async () => {
    try {
      const snapshot = await api.getConversationHistory();
      applyConversationHistorySnapshot(snapshot);
      return snapshot;
    } catch {
      setConversationHistoryLoading(false);
      setConversationFeedback("本地会话历史不可用，已有历史不会被空数据覆盖。");
      return null;
    }
  }, [api, applyConversationHistorySnapshot]);

  useEffect(() => {
    conversationHistoryAvailableRef.current = conversationHistoryAvailable;
  }, [conversationHistoryAvailable]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.onConversationHistoryChanged((snapshot) => {
      if (!cancelled) {
        conversationHistoryEventReceivedRef.current = true;
        applyConversationHistorySnapshot(snapshot);
      }
    });

    void api.getConversationHistory().then((snapshot) => {
      if (!cancelled && !conversationHistoryEventReceivedRef.current) {
        applyConversationHistorySnapshot(snapshot);
      }
    }).catch(() => {
      if (!cancelled) {
        setConversationHistoryLoading(false);
        setConversationFeedback("本地会话历史不可用，已有历史不会被空数据覆盖。");
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, applyConversationHistorySnapshot]);

  useEffect(() => {
    return api.onTaskEvent((event) => {
      const transition = createTaskEventUiTransition(event, pendingAssistantPromptRef.current);
      const activeTaskControlSnapshot = taskControlRef.current;
      const preserveActiveTaskControl = Boolean(
        activeTaskControlSnapshot
        && activeTaskControlSnapshot.phase !== "terminal"
        && !event.taskControl
      );

      taskControlEventReceivedRef.current = true;
      if (event.taskControl) {
        taskControlRef.current = event.taskControl;
        setTaskControl(event.taskControl);
        setTaskControlActionError("");
        const pendingDecision = pendingTaskControlDecisionRef.current;
        const nextApproval = event.taskControl.approval;
        if (
          pendingDecision
          && (
            event.taskControl.phase !== "approval"
            || !nextApproval
            || event.taskControl.executionId !== pendingDecision.executionId
            || nextApproval.planId !== pendingDecision.planId
          )
        ) {
          pendingTaskControlDecisionRef.current = null;
          setTaskControlDecisionPending(false);
        }
        if (event.taskControl.phase === "terminal") {
          taskStopPendingRef.current = false;
          setTaskStopPending(false);
        }
      } else if (
        !preserveActiveTaskControl
        && (
          event.status === "completed"
          || event.status === "denied"
          || event.status === "blocked"
          || event.status === "failed"
          || event.status === "cancelled"
        )
      ) {
        taskControlRef.current = null;
        setTaskControl(null);
        pendingTaskControlDecisionRef.current = null;
        taskStopPendingRef.current = false;
        setTaskControlDecisionPending(false);
        setTaskStopPending(false);
      }

      setTask((current) => (preserveActiveTaskControl ? current : transition.task));
      setReplayRecords((records) => updateReplayRecordsForTaskEvent(records, event));

      if (transition.clearPendingAssistantPrompt) pendingAssistantPromptRef.current = null;

      if (
        transition.conversationAction !== "none"
        && !conversationHistoryAvailableRef.current
      ) {
        setAssistantConversation((messages) =>
          updateAssistantConversationForTaskEvent(messages, event, transition.conversationAction)
        );
      }

      if (transition.finishAssistantInputSubmitting) setAssistantInputSubmitting(false);

      if (transition.panelAction) {
        transitionPanelState({ type: transition.panelAction });
      }
    });
  }, [api, transitionPanelState, preserveActiveTaskView]);

  useEffect(() => {
    if (
      !assistantInputSubmitting
      && (!taskControl || taskControl.phase === "terminal")
    ) {
      taskStopPendingRef.current = false;
      setTaskStopPending(false);
    }
  }, [assistantInputSubmitting, taskControl]);

  useEffect(() => {
    let cancelled = false;

    void api.getTaskControl().then((snapshot) => {
      if (!cancelled && !taskControlEventReceivedRef.current && snapshot) {
        taskControlRef.current = snapshot;
        setTaskControl(snapshot);
        setTask(createTaskViewFromTaskControl(snapshot));
        transitionPanelState({ type: "non-idle-task-event" });
      }
    }).catch(() => {
      // Task Control hydration is optional for older main-process builds.
    });

    return () => {
      cancelled = true;
    };
  }, [api, transitionPanelState]);

  useEffect(() => {
    let cancelled = false;

    void api.getPetSkin().then((skin) => {
      if (!cancelled && isPetAtlasManifest(skin)) {
        setPetAtlas(resolvePetAtlas({
          selectedSkinId: skin.slug,
          customManifest: skin
        }));
      }
    }).catch(() => {
      // A missing local skin should quietly keep the bundled fallback.
    });

    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;

    void api.getStartupWarnings().then((warnings) => {
      if (!cancelled) {
        setStartupWarnings(warnings);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;

    void api.getAppPolicySettings().then((settings) => {
      if (!cancelled) {
        setAppPolicySettings(settings);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;

    void api.getPlannerProviderSettings().then((settings) => {
      if (!cancelled) {
        setPlannerProviderSettings(settings);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const refreshAssistantAgentSettings = useCallback(async () => {
    try {
      setAssistantAgentSettings(await api.getAssistantAgentSettings());
    } catch {
      setAssistantAgentSettings(DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE);
    }
  }, [api]);

  useEffect(() => {
    void refreshAssistantAgentSettings();
  }, [refreshAssistantAgentSettings]);

  const refreshPermissions = useCallback(async () => {
    setPermissionsLoading(true);

    try {
      const [nextPermissions, nextDesktopSessionDiagnostics] = await Promise.all([
        api.getPermissions(),
        api.getDesktopSessionDiagnostics()
      ]);
      setPermissions(nextPermissions);
      setDesktopSessionDiagnostics(nextDesktopSessionDiagnostics);
      return nextPermissions;
    } catch {
      const fallbackState = createUnknownPermissionRefreshState();
      setPermissions(fallbackState.permissions);
      setDesktopSessionDiagnostics(fallbackState.desktopSessionDiagnostics);
      return fallbackState.permissions;
    } finally {
      setPermissionsLoading(false);
    }
  }, [api]);

  const refreshFirstRunReadiness = useCallback(async () => {
    setFirstRunReadinessLoading(true);
    try {
      setFirstRunReadiness(await api.getFirstRunReadiness());
    } catch {
      setFirstRunReadiness(createFirstRunReadinessSnapshot({}));
    } finally {
      setFirstRunReadinessLoaded(true);
      setFirstRunReadinessLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refreshFirstRunReadiness();
  }, [refreshFirstRunReadiness]);

  const refreshTurnReplay = useCallback(async () => {
    try {
      setTurnReplay(await api.getTurnReplay());
    } catch {
      setTurnReplay(null);
    }
  }, [api]);

  const refreshDashboardStatus = useCallback(() => {
    void refreshAssistantAgentSettings();
    void refreshFirstRunReadiness();
    void refreshPermissions();
    void refreshTurnReplay();
  }, [
    refreshAssistantAgentSettings,
    refreshFirstRunReadiness,
    refreshPermissions,
    refreshTurnReplay
  ]);

  useEffect(() => {
    if (assistantPanelOpen && !conversationNavigatorOpen) {
      assistantInputRef.current?.focus();
    } else if (!assistantPanelOpen) {
      setConversationNavigatorOpen(false);
    }
  }, [assistantPanelOpen, conversationNavigatorOpen]);

  useEffect(() => {
    if (detailsOpen) {
      void refreshAssistantAgentSettings();
      void refreshFirstRunReadiness();
      void refreshPermissions();
      void refreshTurnReplay();
    } else {
      setAdvancedSettingsOpen(false);
    }
  }, [
    detailsOpen,
    refreshAssistantAgentSettings,
    refreshFirstRunReadiness,
    refreshPermissions,
    refreshTurnReplay
  ]);

  const stopCurrentTurn = useCallback(async () => {
    if (taskStopPendingRef.current) {
      return;
    }

    if (taskControl && taskControl.phase !== "terminal") {
      setTaskControlActionError("");
      taskStopPendingRef.current = true;
      setTaskStopPending(true);
      transitionPanelState({ type: "non-idle-task-event" });

      try {
        await api.stopTask();
      } catch {
        taskStopPendingRef.current = false;
        setTaskStopPending(false);
        setTaskControlActionError("Stop request failed. The task state has not changed.");
      }
      return;
    }

    if (assistantInputSubmitting || conversationRetrying) {
      taskStopPendingRef.current = true;
      setTaskStopPending(true);
      try {
        await api.stopTask();
      } catch {
        taskStopPendingRef.current = false;
        setTaskStopPending(false);
        setTask((current) => preserveActiveTaskView(
          current,
          createTaskActionFailureView("stop-current-turn")
        ));
      }
      return;
    }

    const transition = createStopTurnUiTransition(task.status);
    if (!transition) {
      return;
    }

    taskStopPendingRef.current = true;
    setTaskStopPending(true);
    transitionPanelState({ type: transition.panelAction });
    setTask((current) => preserveActiveTaskView(current, transition.task));

    try {
      await api.stopTask();
    } catch {
      taskStopPendingRef.current = false;
      setTaskStopPending(false);
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskActionFailureView("stop-current-turn")
      ));
    }
  }, [
    api,
    assistantInputSubmitting,
    conversationRetrying,
    preserveActiveTaskView,
    task.status,
    taskControl,
    transitionPanelState
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldStopCurrentTurnFromKeyboard({ key: event.key })) {
        return;
      }

      event.preventDefault();
      if (
        conversationNavigatorOpen
        && !assistantInputSubmitting
        && !conversationRetrying
        && !createStopTurnUiTransition(task.status)
      ) {
        setConversationNavigatorOpen(false);
        window.setTimeout(() => {
          document.querySelector<HTMLElement>('button[aria-label="打开会话导航"]')?.focus();
        }, 0);
        return;
      }
      void stopCurrentTurn();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    assistantInputSubmitting,
    conversationNavigatorOpen,
    conversationRetrying,
    stopCurrentTurn,
    task.status
  ]);

  useEffect(() => {
    if (conversationNavigatorOpen) {
      document.querySelector<HTMLElement>(
        '#skfiy-conversation-navigator [data-conversation-focus="true"]:not(:disabled)'
      )?.focus();
    }
  }, [conversationNavigatorOpen]);

  useEffect(() => {
    return api.onStopTurnHotkey(() => {
      void stopCurrentTurn();
    });
  }, [api, stopCurrentTurn]);

  async function approveTask(input: TaskApprovalDecisionInput) {
    await submitTaskControlDecision("approved", input);
  }

  async function denyTask(input: TaskApprovalDecisionInput) {
    await submitTaskControlDecision("denied", input);
  }

  async function submitTaskControlDecision(
    decision: "approved" | "denied",
    input: TaskApprovalDecisionInput
  ) {
    const snapshot = taskControlRef.current;
    if (
      !snapshot
      || snapshot.phase !== "approval"
      || !snapshot.approval
      || snapshot.executionId !== input.executionId
      || snapshot.approval.planId !== input.planId
    ) {
      setTaskControlActionError("This approval is stale and was not sent. Review the current plan.");
      return;
    }
    if (pendingTaskControlDecisionRef.current) {
      return;
    }

    pendingTaskControlDecisionRef.current = { ...input };
    setTaskControlDecisionPending(true);
    setTaskControlActionError("");

    try {
      if (decision === "approved") {
        await api.approveTask(input);
      } else {
        await api.denyTask(input);
      }
    } catch {
      const pending = pendingTaskControlDecisionRef.current;
      if (pending?.executionId === input.executionId && pending.planId === input.planId) {
        pendingTaskControlDecisionRef.current = null;
        setTaskControlDecisionPending(false);
        setTaskControlActionError(decision === "approved"
          ? "Approval request failed. The plan is still waiting for a decision."
          : "Denial request failed. The plan is still waiting for a decision.");
      }
    }
  }

  function rejectUnboundLegacyApproval() {
    setTask((current) => preserveActiveTaskView(
      current,
      createTaskStatusView(
        "failed",
        "审批请求缺少当前 Task Control 计划绑定，未发送审批决定."
      )
    ));
  }

  function recoverTaskControl(action: TaskControlRecoveryAction) {
    const snapshot = taskControl;
    if (!snapshot) {
      return;
    }

    if (action === "open_readiness") {
      setAdvancedSettingsOpen(false);
      openDetailsPanel();
      return;
    }

    setAssistantInput(createTaskControlRecoveryDraft(snapshot, action));
    transitionPanelState({ type: "open-assistant" });
  }

  function openTaskControlReplay() {
    setAdvancedSettingsOpen(true);
    openDetailsPanel();
    void refreshTurnReplay();
  }

  async function openPermissionSettings(permission: FirstRunPermissionTarget) {
    try {
      // The preload surface accepts "automation-finder" alongside the
      // renderer PermissionSettingsTarget union.
      await api.openPermissionSettings(permission as PermissionSettingsTarget);
      const nextPermissions = await refreshPermissions();
      const transition = createPermissionOnboardingRefreshTransition({
        announceReady: false,
        permissionOnboardingOpen,
        permissions: nextPermissions
      });

      if (transition.closePermissionOnboarding) {
        transitionPanelState({ type: "close-permission-onboarding" });
      }
      await refreshFirstRunReadiness();
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskActionFailureView("open-permission-settings")
      ));
    }
  }

  async function refreshPermissionOnboarding() {
    const nextPermissions = await refreshPermissions();
    const transition = createPermissionOnboardingRefreshTransition({
      announceReady: true,
      permissionOnboardingOpen: true,
      permissions: nextPermissions
    });

    if (transition.closePermissionOnboarding) {
      transitionPanelState({ type: "close-permission-onboarding" });
    }

    if (transition.readyTaskMessage) {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskStatusView("idle", transition.readyTaskMessage)
      ));
    }
  }

  async function selectAppPolicy(bundleId: string, policy: AppPolicy) {
    try {
      setAppPolicySettings(await api.setAppPolicy({ bundleId, policy }));
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskActionFailureView("set-app-policy")
      ));
    }
  }

  async function selectAssistantAgentMode(mode: AssistantAgentMode) {
    try {
      setAssistantAgentSettings(await api.setAssistantAgentSettings({ mode }));
      await refreshFirstRunReadiness();
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskActionFailureView("set-assistant-agent")
      ));
    }
  }

  async function testBackgroundAgentReadiness() {
    setFirstRunActionStepId("background-agent");
    try {
      setFirstRunReadiness(await api.testBackgroundAgent());
      setFirstRunReadinessLoaded(true);
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskStatusView("failed", "Background Agent 安全测试失败，请重试.")
      ));
    } finally {
      setFirstRunActionStepId(null);
    }
  }

  async function testFinderReadiness() {
    setFirstRunActionStepId("finder-automation");
    try {
      setFirstRunReadiness(await api.testFinderAutomation());
      setFirstRunReadinessLoaded(true);
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskStatusView("failed", "Finder Automation 只读测试失败，请重试.")
      ));
    } finally {
      setFirstRunActionStepId(null);
    }
  }

  async function openFirstRunPermissionSettings(permission: FirstRunPermissionTarget) {
    const stepId: FirstRunReadinessStepId = permission === "screen-recording"
      ? "screen-recording"
      : permission === "accessibility"
        ? "accessibility"
        : "finder-automation";
    setFirstRunActionStepId(stepId);
    try {
      await openPermissionSettings(permission);
    } finally {
      setFirstRunActionStepId(null);
    }
  }

  async function selectPlannerProviderMode(mode: PlannerProviderMode) {
    try {
      setPlannerProviderSettings(await api.setPlannerProviderSettings({ mode }));
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskActionFailureView("set-planner-provider")
      ));
    }
  }

  async function runConversationSnapshotAction(
    action: ConversationActionState,
    operation: () => Promise<ConversationHistorySnapshot>,
    options: { closeNavigator?: boolean } = {}
  ) {
    setConversationAction(action);
    setConversationFeedback("");
    try {
      applyConversationHistorySnapshot(await operation());
      if (options.closeNavigator) {
        setConversationNavigatorOpen(false);
      }
    } catch {
      setConversationFeedback("会话操作失败，请重试。");
    } finally {
      setConversationAction(null);
    }
  }

  async function startConversationSession() {
    await runConversationSnapshotAction(
      { action: "start" },
      () => api.startConversationSession(),
      { closeNavigator: true }
    );
  }

  async function switchConversationSession(sessionId: string) {
    await runConversationSnapshotAction(
      { action: "switch", sessionId },
      () => api.switchConversationSession(sessionId),
      { closeNavigator: true }
    );
  }

  async function renameConversationSession(sessionId: string, title: string) {
    await runConversationSnapshotAction(
      { action: "rename", sessionId },
      () => api.renameConversationSession({ sessionId, title })
    );
  }

  async function archiveConversationSession(sessionId: string) {
    await runConversationSnapshotAction(
      { action: "archive", sessionId },
      () => api.archiveConversationSession(sessionId)
    );
  }

  async function deleteConversationSession(sessionId: string) {
    await runConversationSnapshotAction(
      { action: "delete", sessionId },
      () => api.deleteConversationSession(sessionId)
    );
  }

  async function restoreConversationSession(sessionId: string) {
    await runConversationSnapshotAction(
      { action: "restore", sessionId },
      () => api.restoreConversationSession(sessionId)
    );
  }

  async function retryConversationTurn(
    session: Parameters<typeof createConversationRetryRequest>[0],
    turn: Parameters<typeof createConversationRetryRequest>[1]
  ) {
    const request = createConversationRetryRequest(
      session,
      turn,
      createConversationRetryRequestId
    );
    if (!request) {
      setConversationFeedback("此轮不能安全重试，避免重复 Computer Use。");
      return;
    }
    if (taskControlRef.current && taskControlRef.current.phase !== "terminal") {
      setConversationFeedback("先完成或停止当前 Computer Use，再安全重试 Background Agent。");
      return;
    }

    setConversationAction({ action: "retry", sessionId: session.id, turnId: turn.id });
    setConversationFeedback("");
    taskControlRef.current = null;
    setTaskControl(null);
    pendingTaskControlDecisionRef.current = null;
    setTaskControlDecisionPending(false);
    setTask(createTaskStatusView(
      "planned",
      "Retrying the Background Agent only. Computer Use remains disabled."
    ));
    try {
      const result = await api.retryConversationTurn(request);
      applyConversationHistorySnapshot(result.snapshot);
      setConversationFeedback(result.message);
      setTask(createConversationRetryTaskView(result));
    } catch {
      setConversationFeedback("安全重试失败，请稍后再试。");
      setTask(createTaskStatusView("failed", "Background Agent 安全重试失败。"));
    } finally {
      setConversationAction(null);
    }
  }

  async function submitAssistantInput(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const transition = createAssistantInputSubmissionTransition(
      assistantInput,
      assistantInputSubmitting
        || conversationAction?.action === "retry"
        || Boolean(taskControl && taskControl.phase !== "terminal")
    );

    if (transition.type === "blocked") {
      assistantInputRef.current?.focus();
      return;
    }

    pendingAssistantPromptRef.current = transition.command;
    if (!conversationHistoryAvailable) {
      setAssistantConversation((messages) => appendAssistantConversationSubmission(messages, transition.command));
    }
    setAssistantInputSubmitting(true);
    taskStopPendingRef.current = false;
    setTaskStopPending(false);
    transitionPanelState({ type: transition.panelAction });
    setTask((current) => preserveActiveTaskView(current, transition.task));
    setAssistantInput("");

    try {
      await api.runCommand(transition.command, { mode: "active" });
      if (conversationHistoryAvailable) {
        await refreshConversationHistory();
      }
    } catch {
      pendingAssistantPromptRef.current = null;
      if (!conversationHistoryAvailable) {
        setAssistantConversation(appendAssistantConversationSubmissionFailure);
      } else {
        await refreshConversationHistory();
      }
      setTask((current) => preserveActiveTaskView(
        current,
        createAssistantSubmissionFailureTaskView()
      ));
    } finally {
      setAssistantInputSubmitting(false);
    }
  }

  function submitAssistantInputFromKeyboard(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSubmitAssistantInputFromKeyboard({
      key: event.key,
      shiftKey: event.shiftKey
    })) {
      event.preventDefault();
      void submitAssistantInput();
    }
  }

  function startPetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!shouldStartPetDrag({ button: event.button })) {
      return;
    }

    petDragRef.current = createPetDragState({
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY
    }, readVisiblePetRect(event.currentTarget.getBoundingClientRect()));
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function movePetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = petDragRef.current;

    if (!isMatchingPetDragPointer(drag, event.pointerId)) {
      return;
    }

    const move = createPetDragMoveTransition({
      drag,
      taskStatus: task.status,
      visibleRectOnStart: drag.moved
        ? undefined
        : readVisiblePetRect(event.currentTarget.getBoundingClientRect()),
      pointer: {
        pointerId: event.pointerId,
        screenX: event.screenX,
        screenY: event.screenY
      }
    });

    if (!move) {
      return;
    }

    petDragRef.current = move.nextDrag;

    const dragTransition = move.panelTransition;

    if (dragTransition) {
      if (dragTransition.resetTaskBubble) {
        setTask((current) => preserveActiveTaskView(current, createTaskStatusView("idle")));
      }
      if (dragTransition.clearReplayRecords) setReplayRecords([]);
      transitionPanelState(dragTransition.panelAction);
    }

    api.moveWindowBy(move.deltaX, move.deltaY, move.nextDrag.visibleRect);
    if (dragTransition?.compactWindow) {
      api.setWindowMode("compact");
    }
  }

  function stopPetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = petDragRef.current;

    if (!isMatchingPetDragPointer(drag, event.pointerId)) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    petDragRef.current = null;

    if (shouldSuppressPetClickAfterDrag(drag)) {
      suppressNextPetClickRef.current = true;
    }
  }

  function openAssistantPanelFromPet() {
    const transition = createPetClickPanelTransition({
      suppressNextClick: suppressNextPetClickRef.current,
      taskStatus: task.status
    });

    suppressNextPetClickRef.current = transition.nextSuppressNextClick;

    if (transition.resetTaskBubble) {
      setTask((current) => preserveActiveTaskView(current, createTaskStatusView("idle")));
    }
    if (transition.clearReplayRecords) setReplayRecords([]);
    if (transition.panelAction) transitionPanelState(transition.panelAction);
  }

  function toggleDetailsFromPet(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    transitionPanelState({ type: "toggle-details" });
  }

  const activeTaskControl = Boolean(taskControl && taskControl.phase !== "terminal");
  const {
    assistantInputPanel,
    panelVisibility,
    permissionOnboardingDisplayRows,
    permissionPanelViewModel,
    petState,
    plannerProviderDisplay,
    selectedAssistantAgentProvider,
    startupWarning,
    status
  } = getAppShellViewModel({
    assistantAgentSettings,
    assistantInput,
    assistantInputSubmitting: assistantInputSubmitting || conversationRetrying,
    desktopSessionDiagnostics,
    fallbackAssistantAgentProvider: DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE.providers[0],
    panelState,
    permissions,
    permissionsLoading,
    plannerProviderSettings,
    startupWarnings,
    taskStatus: task.status
  });

  useEffect(() => {
    api.setWindowMode(panelVisibility.showPanel ? "expanded" : "compact");
  }, [api, panelVisibility.showPanel]);

  const taskControlCard = taskControl ? (
    <TaskControlCard
      actionError={taskControlActionError}
      approvalDecisionPending={taskControlDecisionPending}
      onApprove={(input) => void approveTask(input)}
      onDeny={(input) => void denyTask(input)}
      onOpenReplay={openTaskControlReplay}
      onRecover={recoverTaskControl}
      onStop={() => void stopCurrentTurn()}
      snapshot={taskControl}
      stopPending={taskStopPending}
    />
  ) : null;

  return (
    <main
      className={`pet-stage status-${task.status}${panelVisibility.showPanel ? " panel-open" : ""}`}
      aria-label="skfiy desktop pet"
    >
      <div className="status-orb" role="status" aria-label="Task status">
        <strong>{status.label}</strong>
        <span>{status.pulse}</span>
      </div>

      {panelVisibility.showPanel ? (
        <section
          className={`assistant-bubble${panelVisibility.settingsBubble ? " settings-bubble" : ""}`}
          aria-label={panelVisibility.bubbleAriaLabel}
        >
          {detailsOpen ? (
            <>
              {taskControlCard}
              <UserDashboardPanel
                appPolicySettings={appPolicySettings}
                desktopSessionDiagnostics={desktopSessionDiagnostics}
                onApprove={rejectUnboundLegacyApproval}
                onDeny={rejectUnboundLegacyApproval}
                onRefresh={refreshDashboardStatus}
                onStop={() => void stopCurrentTurn()}
                permissions={permissions}
                permissionsLoading={permissionsLoading}
                plannerProviderSettings={plannerProviderSettings}
                task={task}
                turnReplay={turnReplay}
              />
              {firstRunReadinessLoaded ? (
                <FirstRunReadinessPanel
                  actionStepId={firstRunActionStepId}
                  loading={firstRunReadinessLoading}
                  onOpenPermissionSettings={(permission) => {
                    void openFirstRunPermissionSettings(permission);
                  }}
                  onRefresh={() => void refreshFirstRunReadiness()}
                  onTestBackgroundAgent={() => void testBackgroundAgentReadiness()}
                  onTestFinderAutomation={() => void testFinderReadiness()}
                  snapshot={firstRunReadiness}
                />
              ) : (
                <div className="first-run-readiness-loading" role="status">
                  正在检查首次运行就绪状态
                </div>
              )}
              <div className="settings-layout">
                <div className="settings-section-heading">
                  <strong>日常设置</strong>
                  <span>Agent 与应用策略</span>
                </div>
                <div className="settings-grid">
                  <div className="app-policy-panel" aria-label="Background Agent 设置">
                    <div className="app-policy-heading">
                      <strong>Background Agent</strong>
                      <span>{selectedAssistantAgentProvider.label}</span>
                    </div>
                    <div className="provider-switch" role="group" aria-label="Background Agent provider">
                      {ASSISTANT_AGENT_OPTIONS.map((option) => (
                        <button
                          type="button"
                          key={option.mode}
                          aria-label={option.aria}
                          aria-pressed={assistantAgentSettings.settings.mode === option.mode}
                          onClick={() => void selectAssistantAgentMode(option.mode)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <div className="provider-status-card" aria-label="Background Agent 状态">
                      <strong>{readAssistantAgentReadinessLabel(selectedAssistantAgentProvider.readiness)}</strong>
                      <p>{readAssistantAgentProviderDetail(assistantAgentSettings, selectedAssistantAgentProvider)}</p>
                      {selectedAssistantAgentProvider.lastError ? (
                        <p>{selectedAssistantAgentProvider.lastError}</p>
                      ) : null}
                    </div>
                  </div>
                  <div className="app-policy-panel" aria-label="Computer Use 设置">
                    <div className="app-policy-heading">
                      <strong>应用策略</strong>
                      <span>Computer Use</span>
                    </div>
                    <div className="app-policy-list">
                      {appPolicySettings.apps.map((entry) => (
                        <div className="app-policy-row" key={entry.bundleId}>
                          <span>{entry.name}</span>
                          <div className="app-policy-switch" role="group" aria-label={`${entry.name} policy`}>
                            {APP_POLICY_OPTIONS.map((option) => (
                              <button
                                type="button"
                                key={option.policy}
                                aria-label={`${option.label} ${entry.name}`}
                                aria-pressed={entry.policy === option.policy}
                                onClick={() => void selectAppPolicy(entry.bundleId, option.policy)}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <details
                  className="advanced-panel"
                  aria-label="诊断/高级"
                  open={advancedSettingsOpen}
                  onToggle={(event) => setAdvancedSettingsOpen(event.currentTarget.open)}
                >
                  <summary>
                    <span>
                      <SlidersHorizontal size={13} aria-hidden="true" />
                      诊断/高级
                    </span>
                    <em>回放与 Computer Use Planner</em>
                  </summary>
                  {advancedSettingsOpen ? (
                    <div className="advanced-panel-body">
                    <div className="app-policy-panel" aria-label="Computer Use Planner">
                      <div className="app-policy-heading">
                        <strong>Computer Use Planner</strong>
                        <span>{plannerProviderDisplay.settingsHeading}</span>
                      </div>
                      <div className="provider-switch" role="group" aria-label="Computer Use planner">
                        {PLANNER_PROVIDER_OPTIONS.map((option) => (
                          <button
                            type="button"
                            key={option.mode}
                            aria-label={option.aria}
                            aria-pressed={plannerProviderSettings.mode === option.mode}
                            onClick={() => void selectPlannerProviderMode(option.mode)}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                      {plannerProviderDisplay.showExternalStatus ? (
                        <div className="provider-status-card" aria-label="External CUA 连接状态">
                          <strong>{readExternalCuaStatusLabel(plannerProviderSettings)}</strong>
                          <p>在 dashboard 中配置</p>
                        </div>
                      ) : null}
                    </div>
                      <LocalReplayViewer replay={turnReplay} />
                    </div>
                  ) : null}
                </details>
                <div className="permissions-panel" aria-label="权限">
                  <div className="permissions-heading">
                    <strong>权限</strong>
                    <button type="button" aria-label="刷新权限状态" onClick={() => void refreshPermissions()}>
                      <RefreshCw size={12} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="permissions-list">
                    <div className="permission-row desktop-session-row">
                      <span>桌面会话</span>
                      <strong data-state={permissionPanelViewModel.desktopSession.state}>
                        {permissionPanelViewModel.desktopSession.stateLabel}
                      </strong>
                    </div>
                    {permissionPanelViewModel.desktopSession.showReason ? (
                      <p className="permission-hint" aria-label="桌面会话阻塞原因">
                        {permissionPanelViewModel.desktopSession.reason}
                      </p>
                    ) : null}
                    {permissionPanelViewModel.permissionRows.map((permission) => (
                      <div className="permission-row" key={permission.key}>
                        <span>{permission.label}</span>
                        <strong data-state={permission.state}>{permission.stateLabel}</strong>
                        <button
                          type="button"
                          aria-label={`打开${permission.label}设置`}
                          onClick={() => void openPermissionSettings(permission.settingsTarget)}
                        >
                          <ExternalLink size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : permissionOnboardingOpen ? (
            <>
              {taskControlCard}
              <p>需要授权</p>
              <div className="permissions-panel" aria-label="缺失权限">
                <div className="permissions-heading">
                  <strong>权限</strong>
                  <button
                    type="button"
                    aria-label="刷新权限状态"
                    onClick={() => void refreshPermissionOnboarding()}
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                  </button>
                </div>
                <div className="permissions-list">
                  {permissionOnboardingDisplayRows.map((permission) => (
                    <div className="permission-row" key={permission.key}>
                      <span>{permission.label}</span>
                      <strong data-state={permission.state}>{permission.stateLabel}</strong>
                      <button
                        type="button"
                        aria-label={`打开${permission.label}设置`}
                        onClick={() => void openPermissionSettings(permission.settingsTarget)}
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : assistantPanelOpen ? (
            <div
              className="assistant-input-panel"
              aria-label="skfiy assistant input"
            >
              {taskControlCard}
              <ConversationAssistantHeader
                action={conversationAction}
                activeSession={activeConversationSession}
                historyAvailable={conversationHistoryAvailable}
                navigatorOpen={conversationNavigatorOpen}
                onStartSession={() => void startConversationSession()}
                onToggleNavigator={() => setConversationNavigatorOpen((open) => !open)}
                providerLabel={selectedAssistantAgentProvider.label}
                providerReadiness={selectedAssistantAgentProvider.readiness}
                providerReadinessLabel={readAssistantAgentReadinessLabel(
                  selectedAssistantAgentProvider.readiness
                )}
              />
              {conversationHistoryLoading && !conversationHistoryAvailable ? (
                <div className="conversation-history-loading" role="status">
                  正在载入本地会话
                </div>
              ) : null}
              {conversationNavigatorOpen && conversationHistoryAvailable ? (
                <ConversationSessionNavigator
                  action={conversationAction}
                  activeSessionId={activeConversationSession?.id}
                  onArchive={(sessionId) => void archiveConversationSession(sessionId)}
                  onDelete={(sessionId) => void deleteConversationSession(sessionId)}
                  onRename={(sessionId, title) => void renameConversationSession(sessionId, title)}
                  onRestore={(sessionId) => void restoreConversationSession(sessionId)}
                  onSwitch={(sessionId) => void switchConversationSession(sessionId)}
                  snapshot={conversationHistory}
                />
              ) : conversationHistoryAvailable ? (
                <ConversationTranscript
                  activeSession={activeConversationSession}
                  busyTurnId={conversationAction?.action === "retry"
                    ? conversationAction.turnId
                    : undefined}
                  onRetry={(session, turn) => void retryConversationTurn(session, turn)}
                />
              ) : assistantConversation.length > 0 ? (
                <div className="assistant-thread" aria-label="skfiy conversation">
                  {assistantConversation.map((message, index) => (
                    <div
                      className="assistant-message"
                      data-role={message.role}
                      data-state={message.state ?? "done"}
                      aria-label={message.role === "user" ? "你发送给 skfiy" : "skfiy 回复"}
                      key={`${message.role}-${index}-${message.text}`}
                    >
                      {message.text}
                    </div>
                  ))}
                </div>
              ) : null}
              <p
                className="conversation-feedback"
                aria-live="polite"
                data-visible={conversationFeedback ? "true" : "false"}
              >
                {conversationFeedback}
              </p>
              <textarea
                ref={assistantInputRef}
                aria-label="Ask skfiy"
                value={assistantInput}
                placeholder="Ask skfiy..."
                rows={3}
                disabled={assistantInputSubmitting || conversationRetrying || activeTaskControl}
                onChange={(event) => setAssistantInput(event.currentTarget.value)}
                onKeyDown={submitAssistantInputFromKeyboard}
              />
              <div className="assistant-input-actions">
                <span>{conversationRetrying ? "安全重试中" : assistantInputPanel.statusLabel}</span>
                {(assistantInputSubmitting || conversationRetrying) && !activeTaskControl ? (
                  <button
                    className="assistant-turn-stop"
                    type="button"
                    aria-label={taskStopPending
                      ? "Stopping Background Agent turn"
                      : "Stop Background Agent turn"}
                    disabled={taskStopPending}
                    onClick={() => void stopCurrentTurn()}
                  >
                    <CirclePause size={13} aria-hidden="true" />
                    <span>{taskStopPending ? "Stopping…" : "Stop"}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="发送给 skfiy"
                  disabled={assistantInputPanel.submitDisabled || activeTaskControl}
                  onClick={() => void submitAssistantInput()}
                >
                  <Play size={13} aria-hidden="true" />
                  <span>{conversationRetrying ? "重试中" : assistantInputPanel.submitLabel}</span>
                </button>
              </div>
            </div>
          ) : taskControl ? (
            taskControlCard
          ) : task.status === "approval_required" ? (
            <>
              <p>{task.message}</p>
              {task.finderPlanPreview ? (
                <FinderPlanPreviewSummary preview={task.finderPlanPreview} />
              ) : null}
              <div className="approval-actions">
                <button type="button" aria-label="确认" onClick={rejectUnboundLegacyApproval}>
                  <Play size={14} aria-hidden="true" />
                  <span>确认</span>
                </button>
                <button type="button" aria-label="拒绝" onClick={rejectUnboundLegacyApproval}>
                  <CirclePause size={14} aria-hidden="true" />
                  <span>拒绝</span>
                </button>
              </div>
            </>
          ) : panelVisibility.showStartupWarning && startupWarning ? (
            <div className="startup-warning" aria-label="启动警告">
              <strong>{startupWarning.title}</strong>
              <span>{startupWarning.message}</span>
            </div>
          ) : (
            <>
              <p>{task.message}</p>
              <TaskReplay records={replayRecords} />
            </>
          )}
        </section>
      ) : null}

      <DesktopPet
        state={petState}
        atlas={petAtlas}
        onClick={openAssistantPanelFromPet}
        onContextMenu={toggleDetailsFromPet}
        onPointerDown={startPetDrag}
        onPointerMove={movePetDrag}
        onPointerUp={stopPetDrag}
      />
    </main>
  );
}
