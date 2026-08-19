import {
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
  TaskReplay,
  UserDashboardPanel
} from "./app-components";
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
  DesktopSessionDiagnostics,
  ObserveAppReplayRecord,
  PermissionSettingsTarget,
  PermissionSummary,
  PlannerProviderMode,
  PlannerProviderSettings,
  StartupWarning,
  TaskEvent,
  TurnReplay
} from "./app-types";

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

export default function App() {
  const api = useMemo(getDesktopApi, []);
  const [petAtlas, setPetAtlas] = useState<PetAtlas>(() => getConfiguredPetAtlas());
  const [panelState, setPanelState] = useState(INITIAL_PANEL_STATE);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantInputSubmitting, setAssistantInputSubmitting] = useState(false);
  const [assistantConversation, setAssistantConversation] = useState<AssistantConversationMessage[]>([]);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
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
  const [replayRecords, setReplayRecords] = useState<ObserveAppReplayRecord[]>([]);
  const assistantInputRef = useRef<HTMLTextAreaElement | null>(null);
  const petDragRef = useRef<PetDragState | null>(null);
  const pendingAssistantPromptRef = useRef<string | null>(null);
  const suppressNextPetClickRef = useRef(false);
  const { assistantPanelOpen, detailsOpen, permissionOnboardingOpen } = panelState;

  const transitionPanelState = useCallback((action: PanelStateAction) => {
    setPanelState((state) => reducePanelState(state, action));
  }, []);

  useEffect(() => {
    return api.onTaskEvent((event) => {
      const transition = createTaskEventUiTransition(event, pendingAssistantPromptRef.current);

      setTask(transition.task);
      setReplayRecords((records) => updateReplayRecordsForTaskEvent(records, event));

      if (transition.clearPendingAssistantPrompt) pendingAssistantPromptRef.current = null;

      if (transition.conversationAction !== "none") {
        setAssistantConversation((messages) =>
          updateAssistantConversationForTaskEvent(messages, event, transition.conversationAction)
        );
      }

      if (transition.finishAssistantInputSubmitting) setAssistantInputSubmitting(false);

      if (transition.panelAction) {
        transitionPanelState({ type: transition.panelAction });
      }
    });
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

  const refreshTurnReplay = useCallback(async () => {
    try {
      setTurnReplay(await api.getTurnReplay());
    } catch {
      setTurnReplay(null);
    }
  }, [api]);

  const refreshDashboardStatus = useCallback(() => {
    void refreshAssistantAgentSettings();
    void refreshPermissions();
    void refreshTurnReplay();
  }, [refreshAssistantAgentSettings, refreshPermissions, refreshTurnReplay]);

  useEffect(() => {
    if (assistantPanelOpen) {
      assistantInputRef.current?.focus();
    }
  }, [assistantPanelOpen]);

  useEffect(() => {
    if (detailsOpen) {
      void refreshAssistantAgentSettings();
      void refreshPermissions();
      void refreshTurnReplay();
    } else {
      setAdvancedSettingsOpen(false);
    }
  }, [detailsOpen, refreshAssistantAgentSettings, refreshPermissions, refreshTurnReplay]);

  const stopCurrentTurn = useCallback(async () => {
    const transition = createStopTurnUiTransition(task.status);
    if (!transition) {
      return;
    }

    transitionPanelState({ type: transition.panelAction });
    setTask(transition.task);

    try {
      await api.stopTask();
    } catch {
      setTask(createTaskActionFailureView("stop-current-turn"));
    }
  }, [api, task.status, transitionPanelState]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldStopCurrentTurnFromKeyboard({ key: event.key })) {
        return;
      }

      event.preventDefault();
      void stopCurrentTurn();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stopCurrentTurn]);

  useEffect(() => {
    return api.onStopTurnHotkey(() => {
      void stopCurrentTurn();
    });
  }, [api, stopCurrentTurn]);

  async function approveTask() {
    transitionPanelState({ type: "close-details" });

    try {
      await api.approveTask();
    } catch {
      setTask(createTaskActionFailureView("approve-task"));
    }
  }

  async function denyTask() {
    transitionPanelState({ type: "close-details" });

    try {
      await api.denyTask();
    } catch {
      setTask(createTaskActionFailureView("deny-task"));
    }
  }

  async function openPermissionSettings(permission: PermissionSettingsTarget) {
    try {
      await api.openPermissionSettings(permission);
      const nextPermissions = await refreshPermissions();
      const transition = createPermissionOnboardingRefreshTransition({
        announceReady: false,
        permissionOnboardingOpen,
        permissions: nextPermissions
      });

      if (transition.closePermissionOnboarding) {
        transitionPanelState({ type: "close-permission-onboarding" });
      }
    } catch {
      setTask(createTaskActionFailureView("open-permission-settings"));
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
      setTask(createTaskStatusView("idle", transition.readyTaskMessage));
    }
  }

  async function selectAppPolicy(bundleId: string, policy: AppPolicy) {
    try {
      setAppPolicySettings(await api.setAppPolicy({ bundleId, policy }));
    } catch {
      setTask(createTaskActionFailureView("set-app-policy"));
    }
  }

  async function selectAssistantAgentMode(mode: AssistantAgentMode) {
    try {
      setAssistantAgentSettings(await api.setAssistantAgentSettings({ mode }));
    } catch {
      setTask(createTaskActionFailureView("set-assistant-agent"));
    }
  }

  async function selectPlannerProviderMode(mode: PlannerProviderMode) {
    try {
      setPlannerProviderSettings(await api.setPlannerProviderSettings({ mode }));
    } catch {
      setTask(createTaskActionFailureView("set-planner-provider"));
    }
  }

  async function submitAssistantInput(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const transition = createAssistantInputSubmissionTransition(
      assistantInput,
      assistantInputSubmitting
    );

    if (transition.type === "blocked") {
      assistantInputRef.current?.focus();
      return;
    }

    pendingAssistantPromptRef.current = transition.command;
    setAssistantConversation((messages) => appendAssistantConversationSubmission(messages, transition.command));
    setAssistantInputSubmitting(true);
    transitionPanelState({ type: transition.panelAction });
    setTask(transition.task);
    setAssistantInput("");

    try {
      await api.runCommand(transition.command, { mode: "active" });
    } catch {
      pendingAssistantPromptRef.current = null;
      setAssistantConversation(appendAssistantConversationSubmissionFailure);
      setTask(createAssistantSubmissionFailureTaskView());
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
      if (dragTransition.resetTaskBubble) setTask(createTaskStatusView("idle"));
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

    if (transition.resetTaskBubble) setTask(createTaskStatusView("idle"));
    if (transition.clearReplayRecords) setReplayRecords([]);
    if (transition.panelAction) transitionPanelState(transition.panelAction);
  }

  function toggleDetailsFromPet(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    transitionPanelState({ type: "toggle-details" });
  }

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
    assistantInputSubmitting,
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
              <UserDashboardPanel
                appPolicySettings={appPolicySettings}
                desktopSessionDiagnostics={desktopSessionDiagnostics}
                onApprove={() => void approveTask()}
                onDeny={() => void denyTask()}
                onRefresh={refreshDashboardStatus}
                onStop={() => void stopCurrentTurn()}
                permissions={permissions}
                permissionsLoading={permissionsLoading}
                plannerProviderSettings={plannerProviderSettings}
                task={task}
                turnReplay={turnReplay}
              />
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
            <form
              className="assistant-input-panel"
              aria-label="skfiy assistant input"
              onSubmit={(event) => void submitAssistantInput(event)}
            >
              <div className="agent-status" aria-label="skfiy agent status">
                <strong>agent</strong>
                <span>{selectedAssistantAgentProvider.label}</span>
              </div>
              {assistantConversation.length > 0 ? (
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
              <textarea
                ref={assistantInputRef}
                aria-label="Ask skfiy"
                value={assistantInput}
                placeholder="Ask skfiy..."
                rows={3}
                disabled={assistantInputSubmitting}
                onChange={(event) => setAssistantInput(event.currentTarget.value)}
                onKeyDown={submitAssistantInputFromKeyboard}
              />
              <div className="assistant-input-actions">
                <span>{assistantInputPanel.statusLabel}</span>
                <button
                  type="submit"
                  aria-label="发送给 skfiy"
                  disabled={assistantInputPanel.submitDisabled}
                >
                  <Play size={13} aria-hidden="true" />
                  <span>{assistantInputPanel.submitLabel}</span>
                </button>
              </div>
            </form>
          ) : task.status === "approval_required" ? (
            <>
              <p>{task.message}</p>
              {task.finderPlanPreview ? (
                <FinderPlanPreviewSummary preview={task.finderPlanPreview} />
              ) : null}
              <div className="approval-actions">
                <button type="button" aria-label="确认" onClick={approveTask}>
                  <Play size={14} aria-hidden="true" />
                  <span>确认</span>
                </button>
                <button type="button" aria-label="拒绝" onClick={denyTask}>
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
