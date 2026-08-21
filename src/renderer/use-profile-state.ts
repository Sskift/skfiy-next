import {
  useCallback,
  type Dispatch,
  type SetStateAction
} from "react";
import {
  createProfileSwitchBanner,
  useProfileState as useProfileRuntimeState
} from "./app-profile-state";
import type {
  AppPolicySettings,
  AssistantAgentMode,
  AssistantAgentSettingsResponse,
  DesktopApi,
  PlannerProviderMode,
  PlannerProviderSettings,
  ProfileSwitchResult
} from "./app-types";

export interface ProfileStateDeps {
  appPolicySettings: AppPolicySettings;
  assistantAgentSettings: AssistantAgentSettingsResponse;
  plannerProviderSettings: PlannerProviderSettings;
  setAppPolicySettings: Dispatch<SetStateAction<AppPolicySettings>>;
  setAssistantAgentSettings: Dispatch<SetStateAction<AssistantAgentSettingsResponse>>;
  setPlannerProviderSettings: Dispatch<SetStateAction<PlannerProviderSettings>>;
  refreshPersonalMemory: () => Promise<void>;
}

export function useProfileState(api: DesktopApi, deps: ProfileStateDeps) {
  const {
    appPolicySettings,
    assistantAgentSettings,
    plannerProviderSettings,
    setAppPolicySettings,
    setAssistantAgentSettings,
    setPlannerProviderSettings,
    refreshPersonalMemory
  } = deps;

  const profileState = useProfileRuntimeState(api);
  const {
    switchTo: switchProfile,
    confirmSwitch: confirmProfileSwitch,
    showBanner: showProfileBanner
  } = profileState;

  const refreshProfileScopedSettings = useCallback(async () => {
    const [nextAppPolicy, nextAssistant, nextPlanner] = await Promise.all([
      api.getAppPolicySettings(),
      api.getAssistantAgentSettings(),
      api.getPlannerProviderSettings()
    ]);
    setAppPolicySettings(nextAppPolicy);
    setAssistantAgentSettings(nextAssistant);
    setPlannerProviderSettings(nextPlanner);
    void refreshPersonalMemory();
    return {
      appPolicy: nextAppPolicy,
      assistant: nextAssistant,
      planner: nextPlanner
    };
  }, [
    api,
    setAppPolicySettings,
    setAssistantAgentSettings,
    setPlannerProviderSettings,
    refreshPersonalMemory
  ]);

  const applyProfileSwitchResult = useCallback(
    async (
      result: ProfileSwitchResult | null,
      before: {
        assistantMode: AssistantAgentMode;
        plannerMode: PlannerProviderMode;
        appPolicy: AppPolicySettings;
        memoryScope: "shared" | "isolated";
      }
    ) => {
      if (result?.status !== "switched") {
        return;
      }

      const after = await refreshProfileScopedSettings();
      showProfileBanner(createProfileSwitchBanner({
        profileName: result.profile.name,
        before,
        after: {
          assistantMode: after.assistant.settings.mode,
          plannerMode: after.planner.mode,
          appPolicy: after.appPolicy,
          memoryScope: result.profile.memoryScope
        }
      }));
    },
    [refreshProfileScopedSettings, showProfileBanner]
  );

  async function handleSwitchProfile(profileId: string) {
    const before = {
      assistantMode: assistantAgentSettings.settings.mode,
      plannerMode: plannerProviderSettings.mode,
      appPolicy: appPolicySettings,
      memoryScope: profileState.snapshot.memoryBaseDirScope
    };
    const result = await switchProfile(profileId);
    await applyProfileSwitchResult(result, before);
  }

  async function handleConfirmProfileSwitch() {
    const before = {
      assistantMode: assistantAgentSettings.settings.mode,
      plannerMode: plannerProviderSettings.mode,
      appPolicy: appPolicySettings,
      memoryScope: profileState.snapshot.memoryBaseDirScope
    };
    const result = await confirmProfileSwitch();
    await applyProfileSwitchResult(result, before);
  }

  return {
    profileState,
    handleSwitchProfile,
    handleConfirmProfileSwitch
  };
}
