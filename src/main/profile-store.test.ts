import { describe, expect, it } from "vitest";

import {
  createProfileStore,
  type ProfileStoreIo
} from "./profile-store";
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  type ProfileSettings
} from "../shared/profile";

function createSeedSettings(): ProfileSettings {
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

function createStore(io: ProfileStoreIo = createMemoryIo()) {
  return createProfileStore({
    baseDir: "/app-support/skfiy",
    io,
    seed: createSeedSettings()
  });
}

describe("profile store", () => {
  it("seeds an undeletable shared Default profile on first run", () => {
    const store = createStore();

    const snapshot = store.snapshot();
    expect(snapshot.activeProfileId).toBe(DEFAULT_PROFILE_ID);
    expect(snapshot.memoryBaseDirScope).toBe("shared");
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.profiles[0]).toMatchObject({
      id: DEFAULT_PROFILE_ID,
      name: DEFAULT_PROFILE_NAME,
      memoryScope: "shared",
      isDefault: true,
      isActive: true
    });

    expect(() => store.delete(DEFAULT_PROFILE_ID)).toThrow(/default/i);
  });

  it("persists the registry and reloads it with the active profile intact", () => {
    const io = createMemoryIo();
    const store = createProfileStore({
      baseDir: "/app-support/skfiy",
      io,
      seed: createSeedSettings()
    });
    const created = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });
    store.setActiveId(created.id);

    const reloaded = createProfileStore({
      baseDir: "/app-support/skfiy",
      io,
      seed: createSeedSettings()
    });

    expect(reloaded.getActiveId()).toBe(created.id);
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.snapshot().memoryBaseDirScope).toBe("isolated");
  });

  it("creates profiles inactive so creation never switches implicitly", () => {
    const store = createStore();
    const created = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });

    expect(store.getActiveId()).toBe(DEFAULT_PROFILE_ID);
    expect(created.id).not.toBe(DEFAULT_PROFILE_ID);
    expect(store.snapshot().profiles.find((profile) => profile.id === created.id)?.isActive)
      .toBe(false);
  });

  it("refuses to rename to a duplicate name", () => {
    const store = createStore();
    const first = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });
    store.create({
      name: "Research",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });

    expect(() => store.rename(first.id, "research")).toThrow(/already exists/i);
    expect(() => store.rename(first.id, "  RESEARCH  ")).toThrow(/already exists/i);
    // Renaming to the same name (case-insensitive) is not a duplicate.
    expect(() => store.rename(first.id, "WRITING")).not.toThrow();
  });

  it("refuses to delete the active profile", () => {
    const store = createStore();
    const created = store.create({
      name: "Writing",
      settings: createSeedSettings(),
      memoryScope: "isolated"
    });
    store.setActiveId(created.id);

    expect(() => store.delete(created.id)).toThrow(/active/i);
  });

  it("captures live settings back into the active profile", () => {
    const store = createStore();
    const nextSettings: ProfileSettings = {
      ...createSeedSettings(),
      assistantAgent: { mode: "hermes" },
      workflowDefaults: {
        defaultManualMode: "quiet",
        postTurnLearningEnabled: false,
        writeApprovalEnabled: true
      }
    };

    const updated = store.captureActive(nextSettings);

    expect(updated?.assistantAgent.mode).toBe("hermes");
    expect(updated?.workflowDefaults.defaultManualMode).toBe("quiet");
    expect(store.get(DEFAULT_PROFILE_ID)?.assistantAgent.mode).toBe("hermes");
  });

  it("upserts imported profiles without changing the active profile", () => {
    const store = createStore();
    const imported = store.upsert({
      id: "imported-1",
      name: "Imported",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      memoryScope: "isolated",
      ...createSeedSettings()
    });

    expect(imported.id).toBe("imported-1");
    expect(store.getActiveId()).toBe(DEFAULT_PROFILE_ID);
    expect(store.list()).toHaveLength(2);
  });

  it("falls back to a seeded registry when profiles.json is corrupt", () => {
    const io = createMemoryIo({
      "/app-support/skfiy/profiles/profiles.json": "{not json"
    });

    const store = createProfileStore({
      baseDir: "/app-support/skfiy",
      io,
      seed: createSeedSettings()
    });

    expect(store.list()).toHaveLength(1);
    expect(store.getActiveId()).toBe(DEFAULT_PROFILE_ID);
  });

  it("drops invalid profile entries when normalizing a persisted registry", () => {
    const io = createMemoryIo({
      "/app-support/skfiy/profiles/profiles.json": JSON.stringify({
        schemaVersion: 1,
        activeProfileId: "default",
        profiles: [
          {
            id: "default",
            name: "Default",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            memoryScope: "shared",
            ...createSeedSettings()
          },
          { id: "broken", name: "Broken" }
        ]
      })
    });

    const store = createProfileStore({
      baseDir: "/app-support/skfiy",
      io,
      seed: createSeedSettings()
    });

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].id).toBe("default");
  });
});
