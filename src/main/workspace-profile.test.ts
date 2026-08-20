import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createProfileRuntime } from "./profile-runtime";
import { createProfileStore, type ProfileStoreIo } from "./profile-store";
import { registerProfileIpc } from "./main-profile-wiring";
import { createMemoryStores } from "./memory-stores";
import {
  createAppPolicySettingsStore,
  readInitialAppPolicySettings
} from "./app-policy-settings";
import { createAssistantAgentSettingsStore } from "./assistant-agent-settings";
import {
  createPlannerProviderSettingsStore,
  readInitialPlannerProviderSettings
} from "./planner-provider-settings";
import {
  DEFAULT_PROFILE_ID,
  type Profile,
  type ProfileSettings
} from "../shared/profile";

/**
 * End-to-end acceptance for the Workspace and Preference Profiles feature.
 * Exercises the full path: store seeding, profile CRUD, guarded switching,
 * capture-back into the existing settings stores, memory-scope rebuilds,
 * export/import, and the IPC wiring surface.
 */

function createSeedSettings(): ProfileSettings {
  return {
    assistantAgent: { mode: "codex" },
    plannerProvider: { mode: "local-deterministic" },
    appPolicy: {
      apps: readInitialAppPolicySettings().apps.map((app) => ({ ...app }))
    },
    workflowDefaults: {
      defaultManualMode: "active",
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    }
  };
}

function createMemoryIo(initial: Record<string, string> = {}): ProfileStoreIo & {
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    exists: (targetPath) => Object.prototype.hasOwnProperty.call(files, targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => {
      const content = files[targetPath];
      if (content === undefined) {
        throw new Error(`Missing ${targetPath}`);
      }
      return content;
    },
    writeFile: (targetPath, content) => {
      files[targetPath] = content;
    }
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createHarness() {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "skfiy-profiles-"));
  tempDirs.push(baseDir);
  const io = createMemoryIo();
  const seed = createSeedSettings();
  const appPolicySettingsStore = createAppPolicySettingsStore(seed.appPolicy);
  const assistantAgentSettingsStore = createAssistantAgentSettingsStore({
    mode: "codex",
    codexBinary: "codex",
    codexBinarySource: "default",
    claudeCodeBinary: "claude",
    claudeCodeBinarySource: "default",
    hermesBinary: "hermes",
    hermesBinarySource: "default",
    cwd: "",
    timeoutMs: 45_000
  });
  const plannerProviderSettingsStore = createPlannerProviderSettingsStore(
    readInitialPlannerProviderSettings({})
  );
  let memoryStores = createMemoryStores(baseDir);
  const store = createProfileStore({
    baseDir,
    io,
    seed
  });
  const rebuiltBaseDirs: string[] = [];
  const removedDirectories: string[] = [];
  const hostPolicy = { allowedHosts: ["example.com"], blockedHosts: [] };
  const emitted: string[] = [];
  const runtime = createProfileRuntime({
    store,
    liveSettings: {
      assistantAgent: assistantAgentSettingsStore,
      plannerProvider: plannerProviderSettingsStore,
      appPolicy: appPolicySettingsStore,
      personalMemory: {
        read: () => memoryStores.personalMemorySettings.read(),
        update: (update) => memoryStores.personalMemorySettings.update(update)
      }
    },
    sharedMemoryBaseDir: baseDir,
    isolatedMemoryBaseDir: (profileId) => path.join(baseDir, "profiles", profileId),
    rebuildMemoryStores: (nextBaseDir) => {
      rebuiltBaseDirs.push(nextBaseDir);
      memoryStores = createMemoryStores(nextBaseDir);
    },
    readHostPolicy: () => hostPolicy,
    removeProfileDirectory: (profileId) => {
      removedDirectories.push(profileId);
    },
    emitChanged: () => {
      emitted.push("changed");
    },
    idFactory: (() => {
      let counter = 0;
      return () => `profile-${(counter += 1)}`;
    })()
  });

  return {
    baseDir,
    io,
    store,
    runtime,
    appPolicySettingsStore,
    assistantAgentSettingsStore,
    plannerProviderSettingsStore,
    memoryStores: () => memoryStores,
    rebuiltBaseDirs,
    removedDirectories,
    hostPolicy,
    emitted
  };
}

describe("workspace and preference profiles", () => {
  it("seeds the shared Default profile on first run with no behavior change", () => {
    const { runtime, store } = createHarness();

    const snapshot = runtime.snapshot();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.activeProfileId).toBe(DEFAULT_PROFILE_ID);
    expect(snapshot.memoryBaseDirScope).toBe("shared");
    expect(snapshot.profiles).toHaveLength(1);
    expect(store.get(DEFAULT_PROFILE_ID)?.memoryScope).toBe("shared");
  });

  it("creates an isolated profile cloned from the current live settings", () => {
    const { runtime, store, assistantAgentSettingsStore, plannerProviderSettingsStore } =
      createHarness();
    assistantAgentSettingsStore.set({ mode: "claude-code" });
    plannerProviderSettingsStore.set({ mode: "external-cua" });

    const snapshot = runtime.createProfile({
      name: "Writing",
      memoryScope: "isolated",
      cloneFromActive: true
    });

    const created = store.get(snapshot.profiles[1].id);
    expect(created?.assistantAgent.mode).toBe("claude-code");
    expect(created?.plannerProvider.mode).toBe("external-cua");
    expect(created?.memoryScope).toBe("isolated");
    // Creation never switches implicitly.
    expect(store.getActiveId()).toBe(DEFAULT_PROFILE_ID);
  });

  it("switches profiles through the existing settings stores and rebuilds isolated memory", async () => {
    const harness = createHarness();
    const { runtime, store } = harness;
    const created = store.create({
      name: "Writing",
      settings: {
        ...createSeedSettings(),
        assistantAgent: { mode: "hermes" },
        plannerProvider: { mode: "disabled" }
      },
      memoryScope: "isolated"
    });

    const result = await runtime.switchProfile({ profileId: created.id });

    expect(result.status).toBe("switched");
    expect(harness.assistantAgentSettingsStore.get().mode).toBe("hermes");
    expect(harness.plannerProviderSettingsStore.get().mode).toBe("disabled");
    expect(harness.memoryStores().baseDir).toBe(
      path.join(harness.baseDir, "profiles", created.id)
    );
    expect(harness.rebuiltBaseDirs).toEqual([
      path.join(harness.baseDir, "profiles", created.id)
    ]);
    expect(runtime.snapshot().memoryBaseDirScope).toBe("isolated");
  });

  it("blocks a broadening switch until the user explicitly confirms", async () => {
    const harness = createHarness();
    const { runtime, store, appPolicySettingsStore } = harness;
    appPolicySettingsStore.set({ bundleId: "com.google.Chrome", policy: "deny" });
    const broadening = store.create({
      name: "Broad",
      settings: {
        ...createSeedSettings(),
        appPolicy: {
          apps: readInitialAppPolicySettings().apps.map((app) =>
            app.bundleId === "com.google.Chrome" ? { ...app, policy: "allow" } : app
          )
        }
      },
      memoryScope: "shared"
    });

    const blocked = await runtime.switchProfile({ profileId: broadening.id });
    expect(blocked.status).toBe("confirmation-required");
    if (blocked.status !== "confirmation-required") {
      throw new Error("expected confirmation-required");
    }
    expect(blocked.broadenings).toEqual([
      {
        kind: "app-policy",
        target: "com.google.Chrome",
        targetName: "Chrome",
        from: "deny",
        to: "allow"
      }
    ]);
    // Nothing changed yet.
    expect(store.getActiveId()).toBe(DEFAULT_PROFILE_ID);
    expect(
      appPolicySettingsStore.get().apps.find((app) => app.bundleId === "com.google.Chrome")
        ?.policy
    ).toBe("deny");

    const confirmed = await runtime.switchProfile({
      profileId: broadening.id,
      confirm: true
    });
    expect(confirmed.status).toBe("switched");
    expect(
      appPolicySettingsStore.get().apps.find((app) => app.bundleId === "com.google.Chrome")
        ?.policy
    ).toBe("allow");
  });

  it("captures live settings edits back into the active profile (wrap, don't fork)", () => {
    const harness = createHarness();
    const { runtime, store, appPolicySettingsStore } = harness;

    appPolicySettingsStore.set({ bundleId: "com.google.Chrome", policy: "deny" });
    runtime.captureActiveProfile();

    const active = store.get(DEFAULT_PROFILE_ID);
    expect(
      active?.appPolicy.apps.find((app) => app.bundleId === "com.google.Chrome")?.policy
    ).toBe("deny");
    expect(harness.emitted.length).toBeGreaterThan(0);
  });

  it("refuses to delete the active or default profile", () => {
    const { runtime, store } = createHarness();
    const created = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });

    expect(() => runtime.deleteProfile({ profileId: DEFAULT_PROFILE_ID })).toThrow();
    expect(() => runtime.deleteProfile({ profileId: created.id })).not.toThrow();
  });

  it("exports and imports a profile without smuggling broadened policy", () => {
    const harness = createHarness();
    const { runtime, store } = harness;
    const created = store.create({
      name: "Writing",
      settings: {
        ...createSeedSettings(),
        assistantAgent: { mode: "claude-code" }
      },
      memoryScope: "isolated"
    });

    const bundle = runtime.exportProfile({
      profileId: created.id,
      includeMemory: true
    });
    expect(bundle.profile.id).toBe(created.id);
    expect(bundle.memory).toEqual({ userEntries: [], agentEntries: [] });

    const snapshot = runtime.importProfile({
      ...bundle,
      profile: {
        ...bundle.profile,
        id: "foreign",
        name: "Foreign",
        memoryScope: "shared",
        appPolicy: {
          apps: [
            { name: "Chrome", bundleId: "com.google.Chrome", policy: "allow" }
          ]
        }
      }
    });

    expect(snapshot.profiles).toHaveLength(3);
    const imported = store
      .list()
      .find((profile) => profile.name === "Foreign") as Profile | undefined;
    expect(imported).toBeDefined();
    expect(imported?.memoryScope).toBe("isolated");
    expect(store.getActiveId()).toBe(DEFAULT_PROFILE_ID);
    // The smuggled allow never lands: app policy is stripped to defaults.
    expect(
      imported?.appPolicy.apps.find((app) => app.bundleId === "com.google.Chrome")?.policy
    ).toBe("ask");
    // The non-policy preferences survive.
    expect(imported?.assistantAgent.mode).toBe("claude-code");
  });

  it("provably never broadens Chrome host policy during a switch", async () => {
    const harness = createHarness();
    const { runtime, store, hostPolicy } = harness;
    const created = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });

    const before = { ...hostPolicy, allowedHosts: [...hostPolicy.allowedHosts] };
    await runtime.switchProfile({ profileId: created.id });
    const after = { ...hostPolicy, allowedHosts: [...hostPolicy.allowedHosts] };

    expect(after.allowedHosts).toEqual(before.allowedHosts);
  });

  it("exposes the full IPC surface through registerProfileIpc", async () => {
    const { runtime } = createHarness();
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) {
        handlers.set(channel, handler);
      }
    };
    registerProfileIpc({ ipcMain, runtime });

    const snapshot = (await handlers.get("skfiy:get-profiles")?.(undefined)) as {
      activeProfileId: string;
    };
    expect(snapshot.activeProfileId).toBe(DEFAULT_PROFILE_ID);

    const created = (await handlers.get("skfiy:create-profile")?.(undefined, {
      name: "Writing",
      cloneFromActive: false
    })) as { profiles: Array<{ id: string }> };
    expect(created.profiles).toHaveLength(2);

    const switched = (await handlers.get("skfiy:switch-profile")?.(undefined, {
      profileId: created.profiles[1].id
    })) as { status: string };
    expect(switched.status).toBe("switched");

    const switchedBack = (await handlers.get("skfiy:switch-profile")?.(undefined, {
      profileId: DEFAULT_PROFILE_ID
    })) as { status: string };
    expect(switchedBack.status).toBe("switched");

    const exported = (await handlers.get("skfiy:export-profile")?.(undefined, {
      profileId: created.profiles[1].id,
      includeMemory: false
    })) as { schemaVersion: number };
    expect(exported.schemaVersion).toBe(1);

    const deleted = (await handlers.get("skfiy:delete-profile")?.(undefined, {
      profileId: created.profiles[1].id
    })) as { profiles: unknown[] };
    expect(deleted.profiles).toHaveLength(1);
  });

  it("persists the registry across restarts", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "skfiy-profiles-restart-"));
    tempDirs.push(baseDir);
    const io = createMemoryIo();
    const seed = createSeedSettings();
    const first = createProfileStore({ baseDir, io, seed });
    const created = first.create({
      name: "Writing",
      settings: seed,
      memoryScope: "isolated"
    });
    first.setActiveId(created.id);

    const second = createProfileStore({ baseDir, io, seed });

    expect(second.getActiveId()).toBe(created.id);
    expect(second.list()).toHaveLength(2);
    expect(second.snapshot().memoryBaseDirScope).toBe("isolated");
  });
});
