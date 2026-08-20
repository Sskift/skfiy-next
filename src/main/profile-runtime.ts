import path from "node:path";
import {
  DEFAULT_PROFILE_ID,
  PROFILE_SCHEMA_VERSION,
  isProfileManualMode,
  isProfileMemoryScope,
  normalizeProfileName,
  type PolicyBroadening,
  type Profile,
  type ProfileExportBundle,
  type ProfileMemoryScope,
  type ProfileRuntimeSnapshot,
  type ProfileSettings,
  type ProfileSwitchResult
} from "../shared/profile.js";
import type { ProfileStore } from "./profile-store.js";
import {
  assertNoHostPolicyBroadening,
  diffAppPolicyBroadening,
  type HostPolicySnapshot
} from "./profile-policy-guard.js";
import {
  captureProfileSettings,
  createDefaultProfileSettings,
  type LiveProfileSettings
} from "./profile-settings.js";
import {
  buildProfileExportBundle,
  parseProfileExportBundle
} from "./profile-export.js";
import { createPersonalMemoryStore } from "./personal-memory.js";
import { readSessionMemoryRecords, createSessionMemoryStore } from "./session-memory.js";
import { readInitialAppPolicySettings } from "./app-policy-settings.js";

export interface ProfileLiveSettingsStores {
  assistantAgent: {
    get(): Pick<LiveProfileSettings["assistantAgent"], "mode" | "providerRuntime">;
    set(update: { mode?: unknown; providerRuntime?: unknown }): unknown;
  };
  plannerProvider: {
    get(): Pick<LiveProfileSettings["plannerProvider"], "mode">;
    set(update: { mode?: unknown }): unknown;
  };
  appPolicy: {
    get(): LiveProfileSettings["appPolicy"];
    set(update: { bundleId?: unknown; policy?: unknown }): unknown;
  };
  personalMemory: {
    read(): LiveProfileSettings["personalMemory"];
    update(update: {
      postTurnLearningEnabled?: boolean;
      writeApprovalEnabled?: boolean;
    }): unknown;
  };
}

export interface ProfileRuntimeDeps {
  store: ProfileStore;
  liveSettings: ProfileLiveSettingsStores;
  sharedMemoryBaseDir: string;
  isolatedMemoryBaseDir: (profileId: string) => string;
  rebuildMemoryStores: (baseDir: string) => void;
  readHostPolicy: () => HostPolicySnapshot | Promise<HostPolicySnapshot>;
  removeProfileDirectory?: (profileId: string) => void;
  emitChanged: (snapshot: ProfileRuntimeSnapshot) => void;
  now?: () => Date;
  idFactory?: () => string;
}

export interface ProfileRuntime {
  snapshot(): ProfileRuntimeSnapshot;
  switchProfile(input: { profileId: string; confirm?: boolean }): Promise<ProfileSwitchResult>;
  createProfile(input: {
    name: string;
    memoryScope?: unknown;
    cloneFromActive?: boolean;
    defaultManualMode?: unknown;
  }): ProfileRuntimeSnapshot;
  updateProfile(input: { profileId: string; name?: string }): ProfileRuntimeSnapshot;
  deleteProfile(input: { profileId: string }): ProfileRuntimeSnapshot;
  captureActiveProfile(): ProfileRuntimeSnapshot;
  exportProfile(input: { profileId: string; includeMemory?: boolean }): ProfileExportBundle;
  importProfile(bundle: unknown): ProfileRuntimeSnapshot;
}

export function createProfileRuntime(deps: ProfileRuntimeDeps): ProfileRuntime {
  const now = deps.now ?? (() => new Date());
  const idFactory = deps.idFactory ?? (() => cryptoRandomProfileId());

  function snapshot(): ProfileRuntimeSnapshot {
    return deps.store.snapshot();
  }

  function emitChanged(): void {
    deps.emitChanged(snapshot());
  }

  function captureLiveSettings(): ProfileSettings {
    const active = deps.store.get(deps.store.getActiveId() ?? "");
    return captureProfileSettings({
      assistantAgent: deps.liveSettings.assistantAgent.get(),
      plannerProvider: deps.liveSettings.plannerProvider.get(),
      appPolicy: deps.liveSettings.appPolicy.get(),
      personalMemory: deps.liveSettings.personalMemory.read(),
      defaultManualMode: active?.workflowDefaults.defaultManualMode ?? "active"
    });
  }

  async function switchProfile(input: {
    profileId: string;
    confirm?: boolean;
  }): Promise<ProfileSwitchResult> {
    const profile = deps.store.get(input.profileId);
    if (!profile) {
      return { status: "not-found", profileId: input.profileId };
    }

    const previousProfileId = deps.store.getActiveId();
    if (previousProfileId === profile.id) {
      return { status: "switched", profile: summaryOf(profile), previousProfileId };
    }

    const broadenings: PolicyBroadening[] = diffAppPolicyBroadening(
      deps.liveSettings.appPolicy.get(),
      profile.appPolicy
    );
    if (broadenings.length > 0 && input.confirm !== true) {
      return { status: "confirmation-required", profileId: profile.id, broadenings };
    }

    const hostBefore = await deps.readHostPolicy();

    deps.liveSettings.assistantAgent.set({
      mode: profile.assistantAgent.mode,
      ...(profile.assistantAgent.providerRuntime
        ? { providerRuntime: profile.assistantAgent.providerRuntime }
        : {})
    });
    deps.liveSettings.plannerProvider.set({ mode: profile.plannerProvider.mode });
    for (const app of profile.appPolicy.apps) {
      deps.liveSettings.appPolicy.set({ bundleId: app.bundleId, policy: app.policy });
    }

    const memoryBaseDir = profile.memoryScope === "isolated"
      ? deps.isolatedMemoryBaseDir(profile.id)
      : deps.sharedMemoryBaseDir;
    deps.rebuildMemoryStores(memoryBaseDir);
    deps.liveSettings.personalMemory.update({
      postTurnLearningEnabled: profile.workflowDefaults.postTurnLearningEnabled,
      writeApprovalEnabled: profile.workflowDefaults.writeApprovalEnabled
    });

    deps.store.setActiveId(profile.id);

    // Profiles never carry host policy, so a switch provably cannot broaden
    // it. Snapshot before and after to keep that invariant enforced.
    const hostAfter = await deps.readHostPolicy();
    assertNoHostPolicyBroadening(hostBefore, hostAfter);

    emitChanged();
    return { status: "switched", profile: summaryOf(profile), previousProfileId };
  }

  function createProfile(input: {
    name: string;
    memoryScope?: unknown;
    cloneFromActive?: boolean;
    defaultManualMode?: unknown;
  }): ProfileRuntimeSnapshot {
    const name = normalizeProfileName(input.name);
    if (name.length === 0) {
      throw new Error("Profile name must be 1 to 60 characters.");
    }

    const memoryScope: ProfileMemoryScope = isProfileMemoryScope(input.memoryScope)
      ? input.memoryScope
      : "isolated";
    const settings = input.cloneFromActive
      ? captureLiveSettings()
      : createDefaultProfileSettings();
    if (isProfileManualMode(input.defaultManualMode)) {
      settings.workflowDefaults.defaultManualMode = input.defaultManualMode;
    }

    deps.store.create({ name, settings, memoryScope });
    emitChanged();
    return snapshot();
  }

  function updateProfile(input: { profileId: string; name?: string }): ProfileRuntimeSnapshot {
    const profile = deps.store.get(input.profileId);
    if (!profile) {
      throw new Error(`Profile ${input.profileId} not found.`);
    }

    if (input.name !== undefined) {
      const name = normalizeProfileName(input.name);
      if (name.length === 0) {
        throw new Error("Profile name must be 1 to 60 characters.");
      }
      deps.store.rename(input.profileId, name);
    }

    emitChanged();
    return snapshot();
  }

  function deleteProfile(input: { profileId: string }): ProfileRuntimeSnapshot {
    const profile = deps.store.get(input.profileId);
    if (!profile) {
      throw new Error(`Profile ${input.profileId} not found.`);
    }
    if (input.profileId === DEFAULT_PROFILE_ID) {
      throw new Error("The default profile cannot be deleted.");
    }
    if (deps.store.getActiveId() === input.profileId) {
      throw new Error("The active profile cannot be deleted. Switch profiles first.");
    }

    deps.store.delete(input.profileId);
    if (profile.memoryScope === "isolated") {
      deps.removeProfileDirectory?.(input.profileId);
    }
    emitChanged();
    return snapshot();
  }

  function captureActiveProfile(): ProfileRuntimeSnapshot {
    const activeId = deps.store.getActiveId();
    if (!activeId) {
      return snapshot();
    }

    deps.store.captureActive(captureLiveSettings());
    emitChanged();
    return snapshot();
  }

  function exportProfile(input: {
    profileId: string;
    includeMemory?: boolean;
  }): ProfileExportBundle {
    const profile = deps.store.get(input.profileId);
    if (!profile) {
      throw new Error(`Profile ${input.profileId} not found.`);
    }

    if (input.includeMemory !== true) {
      return buildProfileExportBundle({ profile }, { now });
    }

    const memoryBaseDir = profile.memoryScope === "isolated"
      ? deps.isolatedMemoryBaseDir(profile.id)
      : deps.sharedMemoryBaseDir;
    return buildProfileExportBundle(
      {
        profile,
        memory: {
          userEntries: readPersonalMemorySnapshotSafe(memoryBaseDir).userEntries,
          agentEntries: readPersonalMemorySnapshotSafe(memoryBaseDir).agentEntries
        },
        sessions: readSessionMemoryRecordsSafe(memoryBaseDir)
      },
      { now }
    );
  }

  function importProfile(bundle: unknown): ProfileRuntimeSnapshot {
    const parsed = parseProfileExportBundle(bundle);

    // Imported profiles always start isolated and inactive, and app policy is
    // stripped to defaults, so an imported profile can never smuggle in
    // broadened policy or touch the global memory store.
    const timestamp = now().toISOString();
    const imported: Profile = {
      ...parsed.profile,
      id: idFactory(),
      name: uniqueImportedName(parsed.profile.name),
      createdAt: timestamp,
      updatedAt: timestamp,
      memoryScope: "isolated",
      appPolicy: {
        apps: readInitialAppPolicySettings().apps.map((entry) => ({ ...entry }))
      }
    };

    const stored = deps.store.upsert(imported);

    if (parsed.memory) {
      const memoryStore = createPersonalMemoryStore({
        baseDir: deps.isolatedMemoryBaseDir(stored.id)
      });
      for (const entry of parsed.memory.userEntries) {
        memoryStore.applyOperations([{ action: "add", target: "user", content: entry }]);
      }
      for (const entry of parsed.memory.agentEntries) {
        memoryStore.applyOperations([{ action: "add", target: "agent", content: entry }]);
      }
    }

    if (parsed.sessions && parsed.sessions.length > 0) {
      const sessionStore = createSessionMemoryStore({
        baseDir: deps.isolatedMemoryBaseDir(stored.id)
      });
      for (const session of parsed.sessions) {
        sessionStore.append({
          turnId: session.turnId,
          createdAt: session.createdAt,
          userInput: session.userInput,
          assistantReply: session.assistantReply,
          providerLabel: session.providerLabel,
          ...(session.browserContext ? { browserContext: session.browserContext } : {})
        });
      }
    }

    emitChanged();
    return snapshot();
  }

  function uniqueImportedName(name: string): string {
    const existing = new Set(
      deps.store.list().map((profile) => profile.name.trim().toLocaleLowerCase())
    );
    if (!existing.has(name.trim().toLocaleLowerCase())) {
      return name;
    }
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${name} (${suffix})`;
      if (!existing.has(candidate.trim().toLocaleLowerCase())) {
        return candidate;
      }
    }
    return `${name} (${Date.now()})`;
  }

  function summaryOf(profile: Profile) {
    const activeId = deps.store.getActiveId();
    return {
      id: profile.id,
      name: profile.name,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      memoryScope: profile.memoryScope,
      workflowDefaults: { ...profile.workflowDefaults },
      isDefault: profile.id === DEFAULT_PROFILE_ID,
      isActive: profile.id === activeId
    };
  }

  return {
    snapshot,
    switchProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    captureActiveProfile,
    exportProfile,
    importProfile
  };
}

function readPersonalMemorySnapshotSafe(baseDir: string) {
  try {
    return createPersonalMemoryStore({ baseDir }).read();
  } catch {
    return { userEntries: [] as string[], agentEntries: [] as string[] };
  }
}

function readSessionMemoryRecordsSafe(baseDir: string) {
  try {
    return readSessionMemoryRecords({ baseDir });
  } catch {
    return [];
  }
}

function cryptoRandomProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createIsolatedProfileMemoryBaseDir(
  sharedBaseDir: string,
  profileId: string
): string {
  return path.join(sharedBaseDir, "profiles", profileId);
}

export { PROFILE_SCHEMA_VERSION };
