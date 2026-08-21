import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import {
  UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS,
  UNKNOWN_PERMISSIONS,
  createPermissionOnboardingRefreshTransition,
  createUnknownPermissionRefreshState
} from "./app-permission-state";
import {
  DEFAULT_APP_POLICY_SETTINGS,
  DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
  DEFAULT_PLANNER_PROVIDER_SETTINGS
} from "./app-settings-state";
import {
  createTaskActionFailureView,
  createTaskStatusView,
  type TaskView
} from "./app-task-state";
import type { PanelStateAction } from "./app-panel-state";
import type {
  AppPolicy,
  AppPolicySettings,
  AssistantAgentMode,
  AssistantAgentProviderRuntime,
  AssistantAgentSettingsResponse,
  DesktopApi,
  DesktopSessionDiagnostics,
  PermissionSettingsTarget,
  PermissionSummary,
  PlannerProviderMode,
  PlannerProviderSettings,
  StartupWarning
} from "./app-types";

// The preload surface already accepts "automation-finder"; the renderer
// PermissionSettingsTarget union is widened locally until app-types.ts syncs.
export type FirstRunPermissionTarget = PermissionSettingsTarget | "automation-finder";

export interface SettingsStateDeps {
  detailsOpen: boolean;
  permissionOnboardingOpen: boolean;
  transitionPanelState: (action: PanelStateAction) => void;
  preserveActiveTaskView: (current: TaskView, next: TaskView) => TaskView;
  setTask: Dispatch<SetStateAction<TaskView>>;
  refreshFirstRunReadiness: () => Promise<void>;
  refreshTurnReplay: () => Promise<void>;
}

export function useSettingsState(api: DesktopApi, deps: SettingsStateDeps) {
  const {
    detailsOpen,
    permissionOnboardingOpen,
    transitionPanelState,
    preserveActiveTaskView,
    setTask,
    refreshFirstRunReadiness,
    refreshTurnReplay
  } = deps;

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
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [testingAssistantAgentProvider, setTestingAssistantAgentProvider] =
    useState<AssistantAgentMode | null>(null);

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

  async function testAssistantAgentProviderHandler(mode: AssistantAgentMode) {
    setTestingAssistantAgentProvider(mode);
    try {
      const state = await api.testAssistantAgentProvider({ mode });
      setAssistantAgentSettings((current) => ({
        ...current,
        providers: current.providers.map((provider) =>
          provider.id === mode ? { ...state, selected: provider.id === current.settings.mode } : provider
        )
      }));
      return state;
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskStatusView("failed", "Background Agent 安全测试失败，请重试.")
      ));
      throw new Error("Assistant agent provider test failed.");
    } finally {
      setTestingAssistantAgentProvider(null);
    }
  }

  async function updateAssistantAgentProviderRuntime(
    mode: AssistantAgentMode,
    runtime: AssistantAgentProviderRuntime
  ) {
    try {
      setAssistantAgentSettings(
        await api.setAssistantAgentSettings({
          providerRuntime: { [mode]: runtime }
        })
      );
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskActionFailureView("set-assistant-agent")
      ));
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

  return {
    permissions,
    desktopSessionDiagnostics,
    permissionsLoading,
    startupWarnings,
    appPolicySettings,
    setAppPolicySettings,
    assistantAgentSettings,
    setAssistantAgentSettings,
    plannerProviderSettings,
    setPlannerProviderSettings,
    advancedSettingsOpen,
    setAdvancedSettingsOpen,
    testingAssistantAgentProvider,
    refreshAssistantAgentSettings,
    refreshPermissions,
    openPermissionSettings,
    refreshPermissionOnboarding,
    selectAppPolicy,
    selectAssistantAgentMode,
    testAssistantAgentProviderHandler,
    updateAssistantAgentProviderRuntime,
    selectPlannerProviderMode
  };
}
