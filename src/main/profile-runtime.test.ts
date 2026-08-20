import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createProfileRuntime } from "./profile-runtime";
import { createProfileStore, type ProfileStoreIo } from "./profile-store";
import type { ProfileSettings } from "../shared/profile";

function createSeedSettings(overrides: Partial<ProfileSettings> = {}): ProfileSettings {
  return {
    assistantAgent: { mode: "codex" },
    plannerProvider: { mode: "local-deterministic" },
    appPolicy: {
      apps: [
        { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" },
        { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" },
        { name: "Finder", bundleId: "com.apple.finder", policy: "ask" }
      ]
    },
    workflowDefaults: {
      defaultManualMode: "active",
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    },
    ...overrides
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

function createLiveSettingsStores(initial: ProfileSettings) {
  let assistantAgent = {
    mode: initial.assistantAgent.mode,
    providerRuntime: initial.assistantAgent.providerRuntime
  };
  let plannerProvider = { mode: initial.plannerProvider.mode };
  let appPolicy = {
    apps: initial.appPolicy.apps.map((app) => ({ ...app }))
  };
  let personalMemory = { ...initial.workflowDefaults.postTurnLearningEnabled
    ? { postTurnLearningEnabled: true, writeApprovalEnabled: false }
    : { postTurnLearningEnabled: false, writeApprovalEnabled: false }
  };
  personalMemory = {
    postTurnLearningEnabled: initial.workflowDefaults.postTurnLearningEnabled,
    writeApprovalEnabled: initial.workflowDefaults.writeApprovalEnabled
  };

  return {
    values: {
      get assistantMode() {
        return assistantAgent.mode;
      },
      get plannerMode() {
        return plannerProvider.mode;
      },
      get appPolicy() {
        return appPolicy;
      },
      get personalMemory() {
        return personalMemory;
      }
    },
    assistantAgent: {
      get: () => ({ ...assistantAgent }),
      set: vi.fn((update: { mode?: unknown; providerRuntime?: unknown }) => {
        if (update.mode === "codex" || update.mode === "claude-code" || update.mode === "hermes") {
          assistantAgent = {
            mode: update.mode,
            providerRuntime: update.providerRuntime !== undefined
              ? update.providerRuntime as typeof assistantAgent.providerRuntime
              : assistantAgent.providerRuntime
          };
        }
        return assistantAgent;
      })
    },
    plannerProvider: {
      get: () => ({ ...plannerProvider }),
      set: vi.fn((update: { mode?: unknown }) => {
        if (
          update.mode === "local-deterministic"
          || update.mode === "external-cua"
          || update.mode === "disabled"
        ) {
          plannerProvider = { mode: update.mode };
        }
        return plannerProvider;
      })
    },
    appPolicy: {
      get: () => appPolicy,
      set: vi.fn((update: { bundleId?: unknown; policy?: unknown }) => {
        const policy = update.policy;
        if (
          typeof update.bundleId === "string"
          && (policy === "allow" || policy === "ask" || policy === "deny")
        ) {
          appPolicy = {
            apps: appPolicy.apps.map((app) =>
              app.bundleId === update.bundleId ? { ...app, policy } : app
            )
          };
        }
        return appPolicy;
      })
    },
    personalMemory: {
      read: () => ({ ...personalMemory }),
      update: vi.fn((update: {
        postTurnLearningEnabled?: boolean;
        writeApprovalEnabled?: boolean;
      }) => {
        personalMemory = {
          postTurnLearningEnabled: update.postTurnLearningEnabled ?? personalMemory.postTurnLearningEnabled,
          writeApprovalEnabled: update.writeApprovalEnabled ?? personalMemory.writeApprovalEnabled
        };
        return personalMemory;
      })
    }
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTestRuntime({
  seed,
  profiles,
  hostPolicy = { allowedHosts: [], blockedHosts: [] }
}: {
  seed?: ProfileSettings;
  profiles?: Record<string, string>;
  hostPolicy?: { allowedHosts: string[]; blockedHosts: string[] };
} = {}) {
  const seedSettings = seed ?? createSeedSettings();
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "skfiy-profile-runtime-"));
  tempDirs.push(baseDir);
  const io = createMemoryIo(profiles);
  const store = createProfileStore({
    baseDir,
    io,
    seed: seedSettings
  });
  const live = createLiveSettingsStores(seedSettings);
  const rebuiltBaseDirs: string[] = [];
  const removedDirectories: string[] = [];
  const emitted: ReturnType<typeof store.snapshot>[] = [];
  const runtime = createProfileRuntime({
    store,
    liveSettings: {
      assistantAgent: live.assistantAgent,
      plannerProvider: live.plannerProvider,
      appPolicy: live.appPolicy,
      personalMemory: live.personalMemory
    },
    sharedMemoryBaseDir: baseDir,
    isolatedMemoryBaseDir: (profileId) => path.join(baseDir, "profiles", profileId),
    rebuildMemoryStores: (nextBaseDir) => {
      rebuiltBaseDirs.push(nextBaseDir);
    },
    readHostPolicy: () => hostPolicy,
    removeProfileDirectory: (profileId) => {
      removedDirectories.push(profileId);
    },
    emitChanged: (snapshot) => {
      emitted.push(snapshot);
    },
    idFactory: (() => {
      let counter = 0;
      return () => `profile-${(counter += 1)}`;
    })()
  });

  return {
    baseDir,
    runtime,
    store,
    io,
    live,
    rebuiltBaseDirs,
    removedDirectories,
    emitted,
    seedSettings
  };
}

describe("profile runtime", () => {
  it("starts with the seeded Default profile active", () => {
    const { runtime } = createTestRuntime();

    const snapshot = runtime.snapshot();
    expect(snapshot.activeProfileId).toBe("default");
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.memoryBaseDirScope).toBe("shared");
  });

  it("creates isolated profiles from defaults without switching", () => {
    const { runtime, store } = createTestRuntime();

    const snapshot = runtime.createProfile({ name: "Writing" });

    expect(snapshot.profiles).toHaveLength(2);
    expect(store.getActiveId()).toBe("default");
    const created = store.get(snapshot.profiles[1].id);
    expect(created?.memoryScope).toBe("isolated");
    expect(created?.assistantAgent.mode).toBe("codex");
  });

  it("clones a new profile from the current live settings", () => {
    const { runtime, store, live } = createTestRuntime();
    live.plannerProvider.set({ mode: "external-cua" });
    live.appPolicy.set({ bundleId: "com.google.Chrome", policy: "deny" });

    runtime.createProfile({ name: "Clone", cloneFromActive: true });

    const created = store.list().find((profile) => profile.name === "Clone");
    expect(created?.plannerProvider.mode).toBe("external-cua");
    expect(
      created?.appPolicy.apps.find((app) => app.bundleId === "com.google.Chrome")?.policy
    ).toBe("deny");
  });

  it("switches a narrowing profile immediately and rebuilds isolated memory stores", async () => {
    const { runtime, store, live, rebuiltBaseDirs, baseDir } = createTestRuntime();
    const created = store.create({
      name: "Locked down",
      settings: createSeedSettings({
        appPolicy: {
          apps: [
            { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "deny" },
            { name: "Chrome", bundleId: "com.google.Chrome", policy: "deny" },
            { name: "Finder", bundleId: "com.apple.finder", policy: "deny" }
          ]
        }
      }),
      memoryScope: "isolated"
    });

    const result = await runtime.switchProfile({ profileId: created.id });

    expect(result.status).toBe("switched");
    expect(store.getActiveId()).toBe(created.id);
    expect(live.values.appPolicy.apps.every((app) => app.policy === "deny")).toBe(true);
    expect(rebuiltBaseDirs).toEqual([path.join(baseDir, "profiles", created.id)]);
    expect(runtime.snapshot().memoryBaseDirScope).toBe("isolated");
  });

  it("requires explicit confirmation when a switch broadens app policy", async () => {
    const { runtime, store, live } = createTestRuntime({
      seed: createSeedSettings({
        appPolicy: {
          apps: [
            { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" },
            { name: "Chrome", bundleId: "com.google.Chrome", policy: "deny" },
            { name: "Finder", bundleId: "com.apple.finder", policy: "deny" }
          ]
        }
      })
    });
    const broadening = store.create({
      name: "Broad",
      settings: createSeedSettings({
        appPolicy: {
          apps: [
            { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" },
            { name: "Chrome", bundleId: "com.google.Chrome", policy: "allow" },
            { name: "Finder", bundleId: "com.apple.finder", policy: "ask" }
          ]
        }
      }),
      memoryScope: "shared"
    });

    const denied = await runtime.switchProfile({ profileId: broadening.id });
    expect(denied.status).toBe("confirmation-required");
    if (denied.status !== "confirmation-required") {
      throw new Error("expected confirmation-required");
    }
    expect(denied.broadenings).toHaveLength(2);
    expect(store.getActiveId()).toBe("default");
    expect(live.values.assistantMode).toBe("codex");

    const confirmed = await runtime.switchProfile({
      profileId: broadening.id,
      confirm: true
    });
    expect(confirmed.status).toBe("switched");
    expect(store.getActiveId()).toBe(broadening.id);
    expect(
      live.values.appPolicy.apps.find((app) => app.bundleId === "com.google.Chrome")?.policy
    ).toBe("allow");
  });

  it("returns not-found for an unknown profile", async () => {
    const { runtime } = createTestRuntime();

    const result = await runtime.switchProfile({ profileId: "missing" });

    expect(result).toEqual({ status: "not-found", profileId: "missing" });
  });

  it("captures live settings back into the active profile and emits a change", () => {
    const { runtime, store, live, emitted } = createTestRuntime();
    live.assistantAgent.set({ mode: "hermes" });
    live.personalMemory.update({ writeApprovalEnabled: true });

    const snapshot = runtime.captureActiveProfile();

    const active = store.get("default");
    expect(active?.assistantAgent.mode).toBe("hermes");
    expect(active?.workflowDefaults.writeApprovalEnabled).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(snapshot.activeProfile?.updatedAt).toBe(active?.updatedAt);
  });

  it("refuses to delete the active or default profile", () => {
    const { runtime, store } = createTestRuntime();
    const created = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });

    expect(() => runtime.deleteProfile({ profileId: "default" })).toThrow(/default/i);
    expect(() => runtime.deleteProfile({ profileId: created.id })).not.toThrow();
  });

  it("removes the isolated memory directory when deleting an isolated profile", () => {
    const { runtime, store, removedDirectories } = createTestRuntime();
    const created = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });

    runtime.deleteProfile({ profileId: created.id });

    expect(removedDirectories).toEqual([created.id]);
  });

  it("refuses to rename to a duplicate name", () => {
    const { runtime, store } = createTestRuntime();
    const created = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });

    expect(() => runtime.updateProfile({ profileId: created.id, name: "Default" })).toThrow(
      /already exists/i
    );
  });

  it("exports a profile with memory and sessions from its scoped memory dir", () => {
    const { runtime, store } = createTestRuntime();
    const created = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });

    const bundle = runtime.exportProfile({ profileId: created.id, includeMemory: true });

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.profile.id).toBe(created.id);
    expect(bundle.memory).toEqual({ userEntries: [], agentEntries: [] });
    expect(bundle.sessions ?? []).toEqual([]);
  });

  it("imports a validated bundle as an inactive isolated profile with app policy stripped to defaults", () => {
    const { runtime, store } = createTestRuntime();
    const snapshot = runtime.importProfile({
      schemaVersion: 1,
      exportedAt: "2026-08-01T00:00:00.000Z",
      profile: {
        id: "foreign",
        name: "Foreign",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        memoryScope: "shared",
        assistantAgent: { mode: "claude-code" },
        plannerProvider: { mode: "external-cua" },
        appPolicy: {
          apps: [
            { name: "Chrome", bundleId: "com.google.Chrome", policy: "allow" }
          ]
        },
        workflowDefaults: {
          defaultManualMode: "quiet",
          postTurnLearningEnabled: false,
          writeApprovalEnabled: true
        }
      },
      memory: {
        userEntries: ["User prefers dark mode."],
        agentEntries: []
      }
    });

    expect(snapshot.profiles).toHaveLength(2);
    expect(store.getActiveId()).toBe("default");
    const imported = store.list().find((profile) => profile.name === "Foreign");
    expect(imported).toBeDefined();
    expect(imported?.memoryScope).toBe("isolated");
    // App policy is stripped to defaults, so the smuggled allow never lands.
    expect(
      imported?.appPolicy.apps.find((app) => app.bundleId === "com.google.Chrome")?.policy
    ).toBe("ask");
    expect(imported?.assistantAgent.mode).toBe("claude-code");
  });

  it("rejects a malformed import bundle", () => {
    const { runtime } = createTestRuntime();

    expect(() => runtime.importProfile({ schemaVersion: 2 })).toThrow();
    expect(() => runtime.importProfile("nope")).toThrow();
  });

  it("deduplicates imported profile names", () => {
    const { runtime, store } = createTestRuntime();

    runtime.importProfile({
      schemaVersion: 1,
      exportedAt: "2026-08-01T00:00:00.000Z",
      profile: {
        id: "foreign-1",
        name: "Default",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        memoryScope: "isolated",
        ...createSeedSettings()
      }
    });

    const names = store.list().map((profile) => profile.name);
    expect(names).toContain("Default");
    expect(names.some((name) => name.startsWith("Default (2)"))).toBe(true);
  });
});
