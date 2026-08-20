import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AppPolicySettings,
  AssistantAgentMode,
  DesktopApi,
  PlannerProviderMode,
  PolicyBroadening,
  ProfileExportBundle,
  ProfileRuntimeSnapshot,
  ProfileSwitchResult
} from "./app-types";
import { getDesktopApi } from "./app-desktop-api";

const DEFAULT_PROFILE_SUMMARY = {
  id: "default",
  name: "Default",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  memoryScope: "shared" as const,
  workflowDefaults: {
    defaultManualMode: "active" as const,
    postTurnLearningEnabled: true,
    writeApprovalEnabled: false
  },
  isDefault: true,
  isActive: true
};

export const DEFAULT_PROFILE_RUNTIME_SNAPSHOT: ProfileRuntimeSnapshot = {
  schemaVersion: 1,
  activeProfileId: "default",
  activeProfile: DEFAULT_PROFILE_SUMMARY,
  profiles: [DEFAULT_PROFILE_SUMMARY],
  memoryBaseDirScope: "shared"
};

export interface ProfileSwitchRequest {
  profileId: string;
  profileName: string;
  broadenings: PolicyBroadening[];
}

export interface ProfileSwitchBanner {
  profileName: string;
  lines: string[];
  at: number;
}

export interface ProfileState {
  snapshot: ProfileRuntimeSnapshot;
  loading: boolean;
  error: string;
  actionPending: boolean;
  switchRequest: ProfileSwitchRequest | null;
  banner: ProfileSwitchBanner | null;
  refresh: () => Promise<void>;
  switchTo: (profileId: string) => Promise<ProfileSwitchResult | null>;
  confirmSwitch: () => Promise<ProfileSwitchResult | null>;
  cancelSwitch: () => void;
  createProfile: (input: {
    name: string;
    memoryScope?: "isolated" | "shared";
    cloneFromActive?: boolean;
    defaultManualMode?: "active" | "quiet";
  }) => Promise<boolean>;
  renameProfile: (profileId: string, name: string) => Promise<boolean>;
  deleteProfile: (profileId: string) => Promise<boolean>;
  exportProfile: (
    profileId: string,
    includeMemory: boolean
  ) => Promise<ProfileExportBundle | null>;
  importProfile: (bundle: ProfileExportBundle) => Promise<boolean>;
  showBanner: (banner: ProfileSwitchBanner) => void;
  dismissBanner: () => void;
}

export function useProfileState(
  api: DesktopApi = getDesktopApi()
): ProfileState {
  const [snapshot, setSnapshot] = useState<ProfileRuntimeSnapshot>(
    DEFAULT_PROFILE_RUNTIME_SNAPSHOT
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [switchRequest, setSwitchRequest] = useState<ProfileSwitchRequest | null>(null);
  const [banner, setBanner] = useState<ProfileSwitchBanner | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  const applySnapshot = useCallback((next: ProfileRuntimeSnapshot) => {
    setSnapshot(next);
    setError("");
  }, []);

  const refresh = useCallback(async () => {
    try {
      applySnapshot(await apiRef.current.getProfiles());
    } catch (refreshError) {
      setError(readErrorMessage(refreshError));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await apiRef.current.getProfiles();
        if (!cancelled) {
          applySnapshot(next);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(readErrorMessage(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    const unsubscribe = apiRef.current.onProfileChanged((next) => {
      applySnapshot(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applySnapshot]);

  const switchTo = useCallback(
    async (profileId: string): Promise<ProfileSwitchResult | null> => {
      setActionPending(true);
      try {
        const result = await apiRef.current.switchProfile({ profileId });
        if (result.status === "confirmation-required") {
          const profile = snapshot.profiles.find(
            (entry) => entry.id === result.profileId
          );
          setSwitchRequest({
            profileId: result.profileId,
            profileName: profile?.name ?? result.profileId,
            broadenings: result.broadenings
          });
        } else if (result.status === "switched") {
          setSwitchRequest(null);
          applySnapshot(await apiRef.current.getProfiles());
        } else if (result.status === "blocked") {
          setError(result.reason);
        } else if (result.status === "not-found") {
          setError(`Profile ${result.profileId} was not found.`);
        }
        return result;
      } catch (switchError) {
        setError(readErrorMessage(switchError));
        return null;
      } finally {
        setActionPending(false);
      }
    },
    [applySnapshot, snapshot.profiles]
  );

  const confirmSwitch = useCallback(async (): Promise<ProfileSwitchResult | null> => {
    const request = switchRequest;
    if (!request) {
      return null;
    }

    setActionPending(true);
    try {
      const result = await apiRef.current.switchProfile({
        profileId: request.profileId,
        confirm: true
      });
      if (result.status === "switched") {
        setSwitchRequest(null);
        applySnapshot(await apiRef.current.getProfiles());
      } else if (result.status === "confirmation-required") {
        setSwitchRequest({
          profileId: result.profileId,
          profileName: request.profileName,
          broadenings: result.broadenings
        });
      } else if (result.status === "blocked") {
        setError(result.reason);
        setSwitchRequest(null);
      } else if (result.status === "not-found") {
        setError(`Profile ${result.profileId} was not found.`);
        setSwitchRequest(null);
      }
      return result;
    } catch (switchError) {
      setError(readErrorMessage(switchError));
      return null;
    } finally {
      setActionPending(false);
    }
  }, [applySnapshot, switchRequest]);

  const cancelSwitch = useCallback(() => {
    setSwitchRequest(null);
  }, []);

  const createProfile = useCallback(
    async (input: {
      name: string;
      memoryScope?: "isolated" | "shared";
      cloneFromActive?: boolean;
      defaultManualMode?: "active" | "quiet";
    }): Promise<boolean> => {
      setActionPending(true);
      try {
        applySnapshot(await apiRef.current.createProfile(input));
        return true;
      } catch (createError) {
        setError(readErrorMessage(createError));
        return false;
      } finally {
        setActionPending(false);
      }
    },
    [applySnapshot]
  );

  const renameProfile = useCallback(
    async (profileId: string, name: string): Promise<boolean> => {
      setActionPending(true);
      try {
        applySnapshot(await apiRef.current.updateProfile({ profileId, name }));
        return true;
      } catch (renameError) {
        setError(readErrorMessage(renameError));
        return false;
      } finally {
        setActionPending(false);
      }
    },
    [applySnapshot]
  );

  const deleteProfile = useCallback(
    async (profileId: string): Promise<boolean> => {
      setActionPending(true);
      try {
        applySnapshot(await apiRef.current.deleteProfile(profileId));
        return true;
      } catch (deleteError) {
        setError(readErrorMessage(deleteError));
        return false;
      } finally {
        setActionPending(false);
      }
    },
    [applySnapshot]
  );

  const exportProfile = useCallback(
    async (profileId: string, includeMemory: boolean): Promise<ProfileExportBundle | null> => {
      setActionPending(true);
      try {
        return await apiRef.current.exportProfile({ profileId, includeMemory });
      } catch (exportError) {
        setError(readErrorMessage(exportError));
        return null;
      } finally {
        setActionPending(false);
      }
    },
    []
  );

  const importProfile = useCallback(
    async (bundle: ProfileExportBundle): Promise<boolean> => {
      setActionPending(true);
      try {
        applySnapshot(await apiRef.current.importProfile(bundle));
        return true;
      } catch (importError) {
        setError(readErrorMessage(importError));
        return false;
      } finally {
        setActionPending(false);
      }
    },
    [applySnapshot]
  );

  const showBanner = useCallback((next: ProfileSwitchBanner) => {
    setBanner(next);
  }, []);

  const dismissBanner = useCallback(() => {
    setBanner(null);
  }, []);

  return {
    snapshot,
    loading,
    error,
    actionPending,
    switchRequest,
    banner,
    refresh,
    switchTo,
    confirmSwitch,
    cancelSwitch,
    createProfile,
    renameProfile,
    deleteProfile,
    exportProfile,
    importProfile,
    showBanner,
    dismissBanner
  };
}

export function createProfileSwitchBanner(input: {
  profileName: string;
  before: {
    assistantMode: AssistantAgentMode;
    plannerMode: PlannerProviderMode;
    appPolicy: AppPolicySettings;
    memoryScope: "shared" | "isolated";
  };
  after: {
    assistantMode: AssistantAgentMode;
    plannerMode: PlannerProviderMode;
    appPolicy: AppPolicySettings;
    memoryScope: "shared" | "isolated";
  };
}): ProfileSwitchBanner {
  const lines: string[] = [];

  if (input.before.assistantMode !== input.after.assistantMode) {
    lines.push(
      `Background Agent: ${input.before.assistantMode} → ${input.after.assistantMode}`
    );
  }
  if (input.before.plannerMode !== input.after.plannerMode) {
    lines.push(`Planner: ${input.before.plannerMode} → ${input.after.plannerMode}`);
  }
  for (const afterApp of input.after.appPolicy.apps) {
    const beforeApp = input.before.appPolicy.apps.find(
      (entry) => entry.bundleId === afterApp.bundleId
    );
    if (beforeApp && beforeApp.policy !== afterApp.policy) {
      lines.push(`${afterApp.name}: ${beforeApp.policy} → ${afterApp.policy}`);
    }
  }
  if (input.before.memoryScope !== input.after.memoryScope) {
    lines.push(`Memory: ${input.before.memoryScope} → ${input.after.memoryScope}`);
  }

  return {
    profileName: input.profileName,
    lines,
    at: Date.now()
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
