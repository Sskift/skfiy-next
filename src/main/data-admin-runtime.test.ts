import { describe, expect, it } from "vitest";

import { createDataAdminRuntime, type DataAdminRuntimeDeps } from "./data-admin-runtime";
import { createProfileStore, type ProfileStore } from "./profile-store";
import type { ProfileRuntime } from "./profile-runtime";
import type { AutomationMonitorManager } from "./automation-monitor";
import type { AutomationRunStore, AutomationRunStoreSnapshot } from "./automation-run";
import type { DataDomainResetIo } from "./data-domain-reset";
import type { Profile } from "../shared/profile";

const BASE_DIR = "/app-support/skfiy";
const HOME_DIR = "/Users/tester";
const NOW = new Date("2026-08-20T12:00:00.000Z");

function createMemoryIo(initial: Record<string, string> = {}): DataDomainResetIo & {
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
    },
    rename: (fromPath, toPath) => {
      files[toPath] = files[fromPath] ?? "";
      delete files[fromPath];
    }
  };
}

function createSeedSettings() {
  return {
    assistantAgent: { mode: "codex" as const },
    plannerProvider: { mode: "local-deterministic" as const },
    appPolicy: { apps: [] },
    workflowDefaults: {
      defaultManualMode: "active" as const,
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    }
  };
}

function createProfile(id: string, name: string): Profile {
  return {
    ...createSeedSettings(),
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryScope: "shared"
  };
}

function createFakeProfileRuntime(store: ProfileStore): ProfileRuntime {
  return {
    snapshot: () => store.snapshot(),
    switchProfile: async ({ profileId }) => {
      store.setActiveId(profileId);
      return {
        status: "switched" as const,
        profile: {
          id: profileId,
          name: "Imported",
          createdAt: "",
          updatedAt: "",
          memoryScope: "isolated" as const,
          workflowDefaults: {
            defaultManualMode: "active" as const,
            postTurnLearningEnabled: true,
            writeApprovalEnabled: false
          },
          isDefault: false,
          isActive: true
        },
        previousProfileId: "default"
      };
    },
    createProfile: () => store.snapshot(),
    updateProfile: () => store.snapshot(),
    deleteProfile: () => store.snapshot(),
    captureActiveProfile: () => store.snapshot(),
    exportProfile: () => {
      throw new Error("not used");
    },
    importProfile: () => store.snapshot()
  };
}

function createFakeAutomationManager(): AutomationMonitorManager & { deleted: string[] } {
  const state = { deleted: [] as string[], monitorIds: [] as string[] };
  return {
    get deleted() {
      return state.deleted;
    },
    upsertTmuxSessionMonitor: (input) => ({
      id: `tmux-session:${input.sessionName}`,
      kind: "tmux-session",
      label: input.label ?? input.sessionName,
      enabled: input.enabled ?? true,
      intervalMs: input.intervalMs,
      timeoutMs: input.timeoutMs ?? 30_000,
      triggerMode: input.triggerMode ?? "manual",
      sessionName: input.sessionName,
      preview: {
        adapter: "tmux-supervision",
        triggerModes: ["manual", "scheduled"],
        target: { kind: "tmux-session", sessionName: input.sessionName },
        requiredPermissions: [],
        readWriteBehavior: "read-only",
        approvalMode: "not-required",
        timeoutMs: input.timeoutMs ?? 30_000,
        verification: "tmux session, window, pane, and bounded recent pane-output observation",
        mutatesSession: false
      },
      concurrencyPolicy: input.concurrencyPolicy ?? "skip",
      maxConcurrency: input.maxConcurrency ?? 1,
      maxAttempts: input.maxAttempts ?? 3,
      backoffMs: input.backoffMs ?? 30_000,
      backoffMultiplier: input.backoffMultiplier ?? 2,
      maxBackoffMs: input.maxBackoffMs ?? 300_000,
      runTtlMs: input.runTtlMs ?? 900_000,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }),
    duplicateMonitor: () => {
      throw new Error("not used");
    },
    setMonitorEnabled: () => {
      throw new Error("not used");
    },
    deleteMonitor: (id: string) => {
      state.deleted.push(id);
      state.monitorIds = state.monitorIds.filter((existing) => existing !== id);
      return true;
    },
    start: () => undefined,
    stop: () => undefined,
    runMonitorNow: async () => {
      throw new Error("not used");
    },
    readSnapshot: () => ({
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      activeCount: 0,
      attentionCount: 0,
      schedulerInactiveCount: 0,
      scheduler: {
        state: "inactive",
        scope: "app-process",
        owner: "skfiy",
        activeTimerCount: 0,
        mutatesSession: false
      },
      monitors: []
    })
  };
}

function createFakeRunStore(): AutomationRunStore & { writes: AutomationRunStoreSnapshot[] } {
  const writes: AutomationRunStoreSnapshot[] = [];
  return {
    writes,
    read: () => ({ schemaVersion: 1, sequences: {}, runs: [] }),
    write: (snapshot) => {
      writes.push(snapshot);
    }
  };
}

function createHarness(): {
  runtime: ReturnType<typeof createDataAdminRuntime>;
  profileStore: ProfileStore;
  io: DataDomainResetIo & { files: Record<string, string> };
} {
  const io = createMemoryIo();
  const profileStore = createProfileStore({
    baseDir: BASE_DIR,
    io,
    seed: createSeedSettings(),
    idFactory: (() => {
      let counter = 0;
      return () => `profile-id-${counter++}`;
    })()
  });
  const manager = createFakeAutomationManager();
  const runStore = createFakeRunStore();
  const monitorStore = {
    read: () => ({ schemaVersion: 1 as const, monitors: [], runtimes: [] }),
    write: () => undefined
  };
  const deps: DataAdminRuntimeDeps = {
    baseDir: BASE_DIR,
    homeDir: HOME_DIR,
    appVersion: "0.1.0",
    io,
    now: () => NOW,
    idFactory: (() => {
      let counter = 100;
      return () => `imported-${counter++}`;
    })(),
    profileStore,
    profileRuntime: createFakeProfileRuntime(profileStore),
    resolveMemoryBaseDir: () => BASE_DIR,
    conversationStore: () => null,
    conversationStoreBaseDir: BASE_DIR,
    automationMonitorManager: manager,
    automationMonitorStore: monitorStore,
    automationRunStore: runStore,
    stopMonitorRuns: () => undefined
  };
  return { runtime: createDataAdminRuntime(deps), profileStore, io };
}

describe("data admin runtime", () => {
  it("round-trips export → preview → restore across all domains", async () => {
    const harness = createHarness();
    const profile = createProfile("p1", "Work");
    harness.profileStore.upsert(profile);
    harness.io.files[`${BASE_DIR}/memory/USER.md`] = "user preference";
    harness.io.files[`${BASE_DIR}/memory/AGENT.md`] = "agent note";

    const bundle = harness.runtime.exportData();

    expect(bundle.domains).toHaveLength(5);
    expect(bundle.profiles?.profiles.some((p) => p.name === "Work")).toBe(true);
    expect(bundle.personalMemory?.userEntries).toContain("user preference");

    const preview = harness.runtime.previewRestore(bundle);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.domains).toHaveLength(5);

    const result = await harness.runtime.restoreData(preview);
    expect(result.appliedDomains).toContain("profiles");
    expect(result.backupPath).toContain("pre-restore-");
    // The backup captured the pre-restore profiles file.
    expect(harness.io.files[`${result.backupPath}/profiles/profiles.json`]).toBeDefined();
  });

  it("exports only requested domains", () => {
    const harness = createHarness();

    const bundle = harness.runtime.exportData(["profiles"]);

    expect(bundle.domains).toEqual(["profiles"]);
    expect(bundle.personalMemory).toBeUndefined();
  });

  it("resetDomain delegates to the domain reset", () => {
    const harness = createHarness();
    harness.profileStore.upsert(createProfile("p1", "Work"));

    const result = harness.runtime.resetDomain("profiles");

    expect(result.domain).toBe("profiles");
    expect(harness.profileStore.list()).toHaveLength(1);
    expect(harness.profileStore.list()[0].id).toBe("default");
  });

  it("readHealth aggregates per-file health", () => {
    const harness = createHarness();
    harness.io.files[`${BASE_DIR}/profiles/profiles.json`] = JSON.stringify({
      schemaVersion: 1,
      activeProfileId: "default",
      profiles: []
    });

    const health = harness.runtime.readHealth();

    expect(health.status).toBe("ok");
    expect(health.counts.total).toBe(13);
    const profiles = health.files.find((f) => f.relativePath === "profiles/profiles.json");
    expect(profiles?.status).toBe("ok");
  });

  it("readHealth flags corrupt files", () => {
    const harness = createHarness();
    harness.io.files[`${BASE_DIR}/profiles/profiles.json`] = "not json";

    const health = harness.runtime.readHealth();

    expect(health.status).toBe("corrupt");
    expect(health.recoveryHint).toContain("backups");
  });

  it("reads and writes retention settings through the runtime", () => {
    const harness = createHarness();

    const defaults = harness.runtime.getRetention();
    expect(defaults.runHistory.perMonitorCap).toBe(20);

    const updated = harness.runtime.setRetention({
      runHistory: { perMonitorCap: 5 }
    });
    expect(updated.runHistory.perMonitorCap).toBe(5);
    expect(harness.runtime.getRetention().runHistory.perMonitorCap).toBe(5);

    const reset = harness.runtime.resetRetention();
    expect(reset.runHistory.perMonitorCap).toBe(20);
  });

  it("rejects invalid retention updates", () => {
    const harness = createHarness();

    const updated = harness.runtime.setRetention({ runHistory: { perMonitorCap: -5 } });
    expect(updated.runHistory.perMonitorCap).toBeGreaterThan(0);
  });
});
