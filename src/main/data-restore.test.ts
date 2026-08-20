import { describe, expect, it } from "vitest";

import {
  applyDataRestore,
  previewDataRestore,
  type DataRestoreIo
} from "./data-restore";
import { buildDataExportBundle } from "./data-export-bundle";
import { createProfileStore, type ProfileStore } from "./profile-store";
import { readInitialAppPolicySettings } from "./app-policy-settings.js";
import type { ProfileRuntime } from "./profile-runtime";
import type { AutomationMonitorManager } from "./automation-monitor";
import type { AutomationRunStore, AutomationRunStoreSnapshot } from "./automation-run";
import type { Profile } from "../shared/profile";
import type { DataExportBundle } from "../shared/data-export";

const BASE_DIR = "/app-support/skfiy";
const HOME_DIR = "/Users/tester";
const NOW = new Date("2026-08-20T12:00:00.000Z");

function createMemoryIo(initial: Record<string, string> = {}): DataRestoreIo & {
  files: Record<string, string>;
  writes: string[];
} {
  const files: Record<string, string> = { ...initial };
  const writes: string[] = [];
  return {
    files,
    writes,
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
      writes.push(targetPath);
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

function createProfile(id: string, name: string, memoryScope: "shared" | "isolated" = "shared"): Profile {
  return {
    ...createSeedSettings(),
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryScope
  };
}

function createFakeProfileRuntime(store: ProfileStore): ProfileRuntime & {
  switchedTo: string[];
} {
  const switchedTo: string[] = [];
  return {
    switchedTo,
    snapshot: () => store.snapshot(),
    switchProfile: async ({ profileId }) => {
      switchedTo.push(profileId);
      store.setActiveId(profileId);
      const profile = store.get(profileId);
      return {
        status: "switched" as const,
        profile: profile
          ? {
              id: profile.id,
              name: profile.name,
              createdAt: profile.createdAt,
              updatedAt: profile.updatedAt,
              memoryScope: profile.memoryScope,
              workflowDefaults: { ...profile.workflowDefaults },
              isDefault: false,
              isActive: true
            }
          : {
              id: profileId,
              name: "?",
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

function createFakeAutomationManager() {
  const state = {
    monitorIds: [] as string[],
    upserts: [] as Record<string, unknown>[],
    stopped: 0,
    started: 0
  };
  const manager: AutomationMonitorManager = {
    upsertTmuxSessionMonitor: (input) => {
      state.upserts.push(input);
      const id = `tmux-session:${input.sessionName}`;
      if (!state.monitorIds.includes(id)) {
        state.monitorIds.push(id);
      }
      return {
        id,
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
      };
    },
    duplicateMonitor: () => {
      throw new Error("not used");
    },
    setMonitorEnabled: () => {
      throw new Error("not used");
    },
    deleteMonitor: (id: string) => {
      state.monitorIds = state.monitorIds.filter((existing) => existing !== id);
      return true;
    },
    start: () => {
      state.started += 1;
    },
    stop: () => {
      state.stopped += 1;
    },
    runMonitorNow: async () => {
      throw new Error("not used");
    },
    readSnapshot: () => ({
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      activeCount: state.monitorIds.length,
      attentionCount: 0,
      schedulerInactiveCount: 0,
      scheduler: {
        state: "inactive",
        scope: "app-process",
        owner: "skfiy",
        activeTimerCount: 0,
        mutatesSession: false
      },
      monitors: state.monitorIds.map((id) => ({
        id,
        kind: "tmux-session" as const,
        label: id,
        enabled: true,
        intervalMs: 60_000,
        timeoutMs: 30_000,
        triggerMode: "manual" as const,
        sessionName: id.replace("tmux-session:", ""),
        preview: {
          adapter: "tmux-supervision" as const,
          triggerModes: ["manual", "scheduled"] as ["manual", "scheduled"],
          target: { kind: "tmux-session" as const, sessionName: id },
          requiredPermissions: [] as [],
          readWriteBehavior: "read-only" as const,
          approvalMode: "not-required" as const,
          timeoutMs: 30_000,
          verification: "tmux session, window, pane, and bounded recent pane-output observation",
          mutatesSession: false as const
        },
        concurrencyPolicy: "skip" as const,
        maxConcurrency: 1,
        maxAttempts: 3,
        backoffMs: 30_000,
        backoffMultiplier: 2,
        maxBackoffMs: 300_000,
        runTtlMs: 900_000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "idle" as const,
        checkCount: 0,
        schedulerState: "inactive" as const,
        schedulerScope: "app-process" as const,
        mutatesSession: false as const
      }))
    })
  };
  return { manager, state };
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

function createFakeMonitorStore() {
  const writes: unknown[] = [];
  return {
    writes,
    read: () => ({ schemaVersion: 1 as const, monitors: [], runtimes: [] }),
    write: (snapshot: unknown) => {
      writes.push(snapshot);
    }
  };
}

type MemoryIo = DataRestoreIo & { files: Record<string, string>; writes: string[] };

function createHarness(overrides: {
  io?: MemoryIo;
  profileStore?: ProfileStore;
  existingProfiles?: Profile[];
} = {}) {
  const io: MemoryIo = overrides.io ?? createMemoryIo();
  const profileStore = overrides.profileStore ?? createProfileStore({
    baseDir: BASE_DIR,
    io,
    seed: createSeedSettings(),
    idFactory: (() => {
      let counter = 0;
      return () => `profile-id-${counter++}`;
    })()
  });
  for (const profile of overrides.existingProfiles ?? []) {
    profileStore.upsert(profile);
  }
  const profileRuntime = createFakeProfileRuntime(profileStore);
  const { manager, state: managerState } = createFakeAutomationManager();
  const monitorStore = createFakeMonitorStore();
  const runStore = createFakeRunStore();
  const deps = {
    baseDir: BASE_DIR,
    homeDir: HOME_DIR,
    io,
    now: () => NOW,
    idFactory: (() => {
      let counter = 100;
      return () => `imported-${counter++}`;
    })(),
    profileStore,
    profileRuntime,
    resolveMemoryBaseDir: () => BASE_DIR,
    conversationStore: () => null,
    conversationStoreBaseDir: BASE_DIR,
    automationMonitorManager: manager,
    automationMonitorStore: monitorStore,
    automationRunStore: runStore,
    emitRestored: () => undefined
  };
  return { deps, io, profileStore, profileRuntime, manager, managerState, monitorStore, runStore };
}

function createBundleWithProfiles(profiles: Profile[]): DataExportBundle {
  return buildDataExportBundle(["profiles"], {
    appVersion: "0.1.0",
    now: () => NOW,
    readProfiles: () => ({ activeProfileId: profiles[0]?.id ?? "default", profiles }),
    readPersonalMemory: () => ({ scope: "shared", userEntries: [], agentEntries: [] }),
    readSessions: () => ({ conversations: [] }),
    readAutomation: () => ({ monitors: [] }),
    readRuntime: () => ({})
  });
}

describe("data restore preview", () => {
  it("reports per-domain action and summaries without writing files", () => {
    const harness = createHarness();
    const bundle = buildDataExportBundle(
      ["profiles", "personal-memory", "sessions", "automation", "runtime"],
      {
        appVersion: "0.1.0",
        now: () => NOW,
        readProfiles: () => ({
          activeProfileId: "p1",
          profiles: [createProfile("p1", "Work")]
        }),
        readPersonalMemory: () => ({
          scope: "shared",
          userEntries: ["pref"],
          agentEntries: []
        }),
        readSessions: () => ({
          conversations: [
            {
              id: "s1",
              title: "T",
              titleSource: "user" as const,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              turns: []
            }
          ]
        }),
        readAutomation: () => ({ monitors: [] }),
        readRuntime: () => ({})
      }
    );

    const preview = previewDataRestore(bundle, harness.deps);

    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.backupPlan.path).toContain("pre-restore-");
    expect(preview.domains.map((d) => d.domain)).toEqual([
      "profiles",
      "personal-memory",
      "sessions",
      "automation",
      "runtime"
    ]);
    const profiles = preview.domains.find((d) => d.domain === "profiles");
    expect(profiles?.action).toBe("merge");
    expect(profiles?.incomingSummary).toContain("Work");
    const memory = preview.domains.find((d) => d.domain === "personal-memory");
    expect(memory?.action).toBe("replace");
    expect(memory?.currentSummary).toContain("0 user entries");
    expect(memory?.incomingSummary).toContain("1 user entries");
    // Preview writes nothing.
    expect(harness.io.writes).toEqual([]);
  });

  it("flags profile name conflicts", () => {
    const harness = createHarness({
      existingProfiles: [createProfile("existing", "Work")]
    });
    const bundle = createBundleWithProfiles([createProfile("incoming", "Work")]);

    const preview = previewDataRestore(bundle, harness.deps);

    const profiles = preview.domains.find((d) => d.domain === "profiles");
    expect(profiles?.conflicts.length).toBeGreaterThan(0);
    expect(profiles?.conflicts[0]).toContain("Work");
  });

  it("rejects a malformed bundle", () => {
    const harness = createHarness();
    expect(() => previewDataRestore({ schemaVersion: 99 }, harness.deps)).toThrow(/schema/);
  });
});

describe("data restore apply", () => {
  it("creates a backup of every affected domain file before writing", async () => {
    const harness = createHarness();
    harness.io.files[`${BASE_DIR}/profiles/profiles.json`] = JSON.stringify({
      schemaVersion: 1,
      activeProfileId: "default",
      profiles: [createProfile("default", "Default")]
    });
    const bundle = createBundleWithProfiles([createProfile("p1", "Work")]);
    const preview = previewDataRestore(bundle, harness.deps);

    const result = await applyDataRestore(preview, harness.deps);

    expect(result.appliedDomains).toContain("profiles");
    const backupPath = `${result.backupPath}/profiles/profiles.json`;
    expect(harness.io.files[backupPath]).toBeDefined();
    const backup = JSON.parse(harness.io.files[backupPath]);
    expect(backup.profiles).toHaveLength(1);
    expect(backup.profiles[0].id).toBe("default");
  });

  it("is per-domain: restoring only sessions does not touch profiles", async () => {
    const harness = createHarness();
    const originalProfiles = JSON.stringify({
      schemaVersion: 1,
      activeProfileId: "default",
      profiles: [createProfile("default", "Default")]
    });
    harness.io.files[`${BASE_DIR}/profiles/profiles.json`] = originalProfiles;
    const bundle = buildDataExportBundle(["sessions"], {
      appVersion: "0.1.0",
      now: () => NOW,
      readProfiles: () => ({ activeProfileId: "default", profiles: [] }),
      readPersonalMemory: () => ({ scope: "shared", userEntries: [], agentEntries: [] }),
      readSessions: () => ({
        conversations: [
          {
            id: "s1",
            title: "Restored",
            titleSource: "user" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            turns: []
          }
        ]
      }),
      readAutomation: () => ({ monitors: [] }),
      readRuntime: () => ({})
    });
    const preview = previewDataRestore(bundle, harness.deps);

    const result = await applyDataRestore(preview, harness.deps);

    expect(result.appliedDomains).toEqual(["sessions"]);
    expect(harness.io.files[`${BASE_DIR}/profiles/profiles.json`]).toBe(originalProfiles);
    const sessions = JSON.parse(harness.io.files[`${BASE_DIR}/memory/conversation-sessions.json`]);
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0].title).toBe("Restored");
  });

  it("strips appPolicy to defaults on profile restore", async () => {
    const harness = createHarness();
    const incoming = createProfile("p1", "Work");
    incoming.appPolicy = {
      apps: [{ name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" }]
    };
    const bundle = createBundleWithProfiles([incoming]);
    const preview = previewDataRestore(bundle, harness.deps);

    await applyDataRestore(preview, harness.deps);

    const restored = harness.profileStore.list().find((p) => p.name === "Work");
    expect(restored).toBeDefined();
    expect(restored?.appPolicy.apps).toEqual(readInitialAppPolicySettings().apps);
    expect(restored?.memoryScope).toBe("isolated");
  });

  it("switches to the imported active profile when the bundle specifies one", async () => {
    const harness = createHarness();
    const incoming = createProfile("p1", "Work");
    const bundle = createBundleWithProfiles([incoming]);
    const preview = previewDataRestore(bundle, harness.deps);

    await applyDataRestore(preview, harness.deps);

    expect(harness.profileRuntime.switchedTo).toHaveLength(1);
    const switchedId = harness.profileRuntime.switchedTo[0];
    const restored = harness.profileStore.get(switchedId);
    expect(restored?.name).toBe("Work");
  });

  it("restores personal memory with replace semantics", async () => {
    const harness = createHarness();
    harness.io.files[`${BASE_DIR}/memory/USER.md`] = "old entry";
    const bundle = buildDataExportBundle(["personal-memory"], {
      appVersion: "0.1.0",
      now: () => NOW,
      readProfiles: () => ({ activeProfileId: "default", profiles: [] }),
      readPersonalMemory: () => ({
        scope: "shared",
        userEntries: ["new preference"],
        agentEntries: ["new agent note"],
        settings: { postTurnLearningEnabled: false, writeApprovalEnabled: true },
        skills: { disabledSkillIds: [] }
      }),
      readSessions: () => ({ conversations: [] }),
      readAutomation: () => ({ monitors: [] }),
      readRuntime: () => ({})
    });
    const preview = previewDataRestore(bundle, harness.deps);

    await applyDataRestore(preview, harness.deps);

    expect(harness.io.files[`${BASE_DIR}/memory/USER.md`]).toContain("new preference");
    expect(harness.io.files[`${BASE_DIR}/memory/USER.md`]).not.toContain("old entry");
    expect(harness.io.files[`${BASE_DIR}/memory/AGENT.md`]).toContain("new agent note");
    const settings = JSON.parse(harness.io.files[`${BASE_DIR}/memory/settings.json`]);
    expect(settings.postTurnLearningEnabled).toBe(false);
    expect(settings.writeApprovalEnabled).toBe(true);
  });

  it("restores automation definitions and clears run history", async () => {
    const harness = createHarness();
    const bundle = buildDataExportBundle(["automation"], {
      appVersion: "0.1.0",
      now: () => NOW,
      readProfiles: () => ({ activeProfileId: "default", profiles: [] }),
      readPersonalMemory: () => ({ scope: "shared", userEntries: [], agentEntries: [] }),
      readSessions: () => ({ conversations: [] }),
      readAutomation: () => ({
        monitors: [
          {
            id: "tmux-session:work",
            kind: "tmux-session",
            label: "Work monitor",
            enabled: true,
            intervalMs: 60_000,
            timeoutMs: 30_000,
            triggerMode: "manual",
            sessionName: "work",
            preview: {
              adapter: "tmux-supervision",
              triggerModes: ["manual", "scheduled"],
              target: { kind: "tmux-session", sessionName: "work" },
              requiredPermissions: [],
              readWriteBehavior: "read-only",
              approvalMode: "not-required",
              timeoutMs: 30_000,
              verification: "tmux session, window, pane, and bounded recent pane-output observation",
              mutatesSession: false
            },
            concurrencyPolicy: "skip",
            maxConcurrency: 1,
            maxAttempts: 3,
            backoffMs: 30_000,
            backoffMultiplier: 2,
            maxBackoffMs: 300_000,
            runTtlMs: 900_000,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      }),
      readRuntime: () => ({})
    });
    const preview = previewDataRestore(bundle, harness.deps);

    const result = await applyDataRestore(preview, harness.deps);

    expect(result.appliedDomains).toContain("automation");
    expect(harness.managerState.upserts).toHaveLength(1);
    expect(harness.managerState.upserts[0].sessionName).toBe("work");
    expect(harness.runStore.writes.at(-1)).toEqual({
      schemaVersion: 1,
      sequences: {},
      runs: []
    });
    expect(harness.monitorStore.writes.at(-1)).toMatchObject({
      schemaVersion: 1,
      monitors: [expect.objectContaining({ sessionName: "work" })]
    });
  });

  it("preserves the backup and reports skipped domains when a domain fails", async () => {
    const harness = createHarness();
    harness.io.files[`${BASE_DIR}/profiles/profiles.json`] = JSON.stringify({
      schemaVersion: 1,
      activeProfileId: "default",
      profiles: [createProfile("default", "Default")]
    });
    const bundle = createBundleWithProfiles([createProfile("p1", "Work")]);
    const preview = previewDataRestore(bundle, harness.deps);
    // Force the profiles apply to fail by making upsert throw.
    harness.profileStore.upsert = () => {
      throw new Error("simulated write failure");
    };

    const result = await applyDataRestore(preview, harness.deps);

    expect(result.appliedDomains).not.toContain("profiles");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].domain).toBe("profiles");
    expect(result.skipped[0].reason).toContain("simulated write failure");
    expect(result.backupPath).toBeDefined();
    expect(harness.io.files[`${result.backupPath}/profiles/profiles.json`]).toBeDefined();
  });

  it("round-trips: export then restore produces equivalent data", async () => {
    const harness = createHarness();
    const original = createProfile("p1", "Work");
    original.appPolicy = {
      apps: [{ name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" }]
    };
    const exportBundle = buildDataExportBundle(["profiles"], {
      appVersion: "0.1.0",
      now: () => NOW,
      readProfiles: () => ({ activeProfileId: "p1", profiles: [original] }),
      readPersonalMemory: () => ({ scope: "shared", userEntries: [], agentEntries: [] }),
      readSessions: () => ({ conversations: [] }),
      readAutomation: () => ({ monitors: [] }),
      readRuntime: () => ({})
    });
    const preview = previewDataRestore(exportBundle, harness.deps);
    await applyDataRestore(preview, harness.deps);

    const reExport = buildDataExportBundle(["profiles"], {
      appVersion: "0.1.0",
      now: () => NOW,
      readProfiles: () => ({
        activeProfileId: harness.profileStore.getActiveId() ?? "default",
        profiles: harness.profileStore.list()
      }),
      readPersonalMemory: () => ({ scope: "shared", userEntries: [], agentEntries: [] }),
      readSessions: () => ({ conversations: [] }),
      readAutomation: () => ({ monitors: [] }),
      readRuntime: () => ({})
    });

    const restored = reExport.profiles?.profiles.find((p) => p.name === "Work");
    expect(restored).toBeDefined();
    expect(restored?.assistantAgent.mode).toBe(original.assistantAgent.mode);
    expect(restored?.plannerProvider.mode).toBe(original.plannerProvider.mode);
    expect(restored?.workflowDefaults).toEqual(original.workflowDefaults);
    // appPolicy is stripped to defaults on restore by design.
    expect(restored?.appPolicy.apps).toEqual(readInitialAppPolicySettings().apps);
  });
});
