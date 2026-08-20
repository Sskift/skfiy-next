import { describe, expect, it } from "vitest";

import { resetDataDomain, type DataDomainResetIo } from "./data-domain-reset";
import { createProfileStore, type ProfileStore } from "./profile-store";
import {
  createConversationSessionStore,
  type ConversationSessionStore
} from "./conversation-session-store";
import type { AutomationMonitorManager } from "./automation-monitor";
import type { AutomationRunStore, AutomationRunStoreSnapshot } from "./automation-run";
import type { Profile } from "../shared/profile";
import type { ConversationHistorySnapshot } from "../shared/conversation-history";

const BASE_DIR = "/app-support/skfiy";
const HOME_DIR = "/Users/tester";

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

function createProfileStoreForTest(io: DataDomainResetIo, profiles: Profile[] = []): ProfileStore {
  const store = createProfileStore({
    baseDir: BASE_DIR,
    io,
    seed: createSeedSettings(),
    idFactory: (() => {
      let counter = 0;
      return () => `profile-id-${counter++}`;
    })()
  });
  for (const profile of profiles) {
    store.upsert(profile);
  }
  return store;
}

function createIsolatedProfile(id: string, name: string): Profile {
  return {
    ...createSeedSettings(),
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryScope: "isolated"
  };
}

function createFakeAutomationManager(): AutomationMonitorManager & {
  deleted: string[];
  stopped: number;
  started: number;
  monitorIds: string[];
} {
  const state = {
    deleted: [] as string[],
    stopped: 0,
    started: 0,
    monitorIds: ["tmux-session:work", "tmux-session:side"] as string[]
  };
  const manager = {
    get deleted() {
      return state.deleted;
    },
    get stopped() {
      return state.stopped;
    },
    get started() {
      return state.started;
    },
    get monitorIds() {
      return state.monitorIds;
    },
    upsertTmuxSessionMonitor: () => {
      throw new Error("not used in reset tests");
    },
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
      schemaVersion: 1 as const,
      generatedAt: "2026-01-01T00:00:00.000Z",
      activeCount: state.monitorIds.length,
      attentionCount: 0,
      schedulerInactiveCount: 0,
      scheduler: {
        state: "inactive" as const,
        scope: "app-process" as const,
        owner: "skfiy" as const,
        activeTimerCount: 0,
        mutatesSession: false as const
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
          verification: "tmux session, window, pane, and bounded recent pane-output observation" as const,
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
  return manager;
}

function createFakeAutomationStore() {
  const writes: unknown[] = [];
  return {
    writes,
    read: () => ({ schemaVersion: 1 as const, monitors: [], runtimes: [] }),
    write: (snapshot: unknown) => {
      writes.push(snapshot);
    }
  };
}

function createFakeRunStore() {
  const writes: AutomationRunStoreSnapshot[] = [];
  return {
    writes,
    read: (): AutomationRunStoreSnapshot => ({ schemaVersion: 1, sequences: {}, runs: [] }),
    write: (snapshot: AutomationRunStoreSnapshot) => {
      writes.push(snapshot);
    }
  };
}

type MemoryIo = DataDomainResetIo & { files: Record<string, string> };

function createDeps(overrides: {
  io?: MemoryIo;
  profileStore?: ProfileStore;
  activeProfile?: () => Profile | undefined;
  resolveMemoryBaseDir?: () => string;
  conversationStore?: () => ConversationSessionStore | null;
  conversationStoreBaseDir?: string;
  manager?: ReturnType<typeof createFakeAutomationManager>;
  monitorStore?: ReturnType<typeof createFakeAutomationStore>;
  runStore?: ReturnType<typeof createFakeRunStore>;
  stopMonitorRuns?: (id: string) => void;
} = {}) {
  const io: MemoryIo = overrides.io ?? createMemoryIo();
  const profileStore = overrides.profileStore ?? createProfileStoreForTest(io);
  const manager = overrides.manager ?? createFakeAutomationManager();
  const monitorStore = overrides.monitorStore ?? createFakeAutomationStore();
  const runStore = overrides.runStore ?? createFakeRunStore();
  const stoppedRuns: string[] = [];
  return {
    deps: {
      baseDir: BASE_DIR,
      homeDir: HOME_DIR,
      io,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      profileStore,
      resolveMemoryBaseDir: overrides.resolveMemoryBaseDir ?? (() => BASE_DIR),
      activeProfile: overrides.activeProfile ?? (() => profileStore.get(profileStore.getActiveId() ?? "")),
      automationMonitorManager: manager,
      automationMonitorStore: monitorStore,
      automationRunStore: runStore,
      stopMonitorRuns: overrides.stopMonitorRuns ?? ((id: string) => { stoppedRuns.push(id); }),
      conversationStore: overrides.conversationStore ?? (() => null),
      conversationStoreBaseDir: overrides.conversationStoreBaseDir ?? BASE_DIR
    },
    io,
    profileStore,
    manager,
    monitorStore,
    runStore,
    stoppedRuns
  };
}

describe("data domain reset", () => {
  it("resets profiles: removes non-default profiles, keeps default and active", () => {
    const io = createMemoryIo();
    const extra = createIsolatedProfile("profile-1", "Work");
    const profileStore = createProfileStoreForTest(io, [extra]);
    const { deps } = createDeps({ io, profileStore });

    const result = resetDataDomain("profiles", deps);

    expect(result.domain).toBe("profiles");
    expect(result.cleared.join(" ")).toContain("Removed 1");
    const remaining = profileStore.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("default");
    expect(remaining[0].name).toBe("Default");
  });

  it("keeps the active profile when it is a shared non-default profile", () => {
    const io = createMemoryIo();
    const active: Profile = {
      ...createSeedSettings(),
      id: "profile-active",
      name: "Active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      memoryScope: "shared"
    };
    const other = createIsolatedProfile("profile-other", "Other");
    const profileStore = createProfileStoreForTest(io, [active, other]);
    profileStore.setActiveId("profile-active");
    const { deps } = createDeps({ io, profileStore });

    resetDataDomain("profiles", deps);

    const remaining = profileStore.list().map((p) => p.id).sort();
    expect(remaining).toEqual(["default", "profile-active"]);
    expect(profileStore.getActiveId()).toBe("profile-active");
  });

  it("refuses to reset profiles while an isolated profile is active", () => {
    const io = createMemoryIo();
    const isolated = createIsolatedProfile("profile-iso", "Iso");
    const profileStore = createProfileStoreForTest(io, [isolated]);
    profileStore.setActiveId("profile-iso");
    const { deps } = createDeps({ io, profileStore });

    expect(() => resetDataDomain("profiles", deps)).toThrow(/isolated profile is active/);
    expect(profileStore.list()).toHaveLength(2);
  });

  it("resets personal-memory: clears entries, journal, pending writes, settings, skills", () => {
    const io = createMemoryIo({
      [`${BASE_DIR}/memory/USER.md`]: "remember this\n---\nand that",
      [`${BASE_DIR}/memory/AGENT.md`]: "agent note",
      [`${BASE_DIR}/memory/settings.json`]: JSON.stringify({
        postTurnLearningEnabled: false,
        writeApprovalEnabled: true
      }),
      [`${BASE_DIR}/memory/memory-journal.jsonl`]: '{"id":"j1"}\n',
      [`${BASE_DIR}/memory/pending-memory-writes.json`]: JSON.stringify({
        schemaVersion: 1,
        writes: [{ id: "w1" }]
      }),
      [`${BASE_DIR}/memory/personal-skills.json`]: JSON.stringify({
        disabledSkillIds: ["communication-style"]
      })
    });
    const { deps, io: spyIo } = createDeps({ io });

    const result = resetDataDomain("personal-memory", deps);

    expect(result.domain).toBe("personal-memory");
    expect(spyIo.files[`${BASE_DIR}/memory/USER.md`].trim()).toBe("");
    expect(spyIo.files[`${BASE_DIR}/memory/AGENT.md`].trim()).toBe("");
    expect(spyIo.files[`${BASE_DIR}/memory/memory-journal.jsonl`]).toBe("");
    const pending = JSON.parse(spyIo.files[`${BASE_DIR}/memory/pending-memory-writes.json`]);
    expect(pending.writes).toEqual([]);
    const skills = JSON.parse(spyIo.files[`${BASE_DIR}/memory/personal-skills.json`]);
    expect(skills.disabledSkillIds).toEqual([]);
    const settings = JSON.parse(spyIo.files[`${BASE_DIR}/memory/settings.json`]);
    expect(settings.postTurnLearningEnabled).toBe(true);
    expect(settings.writeApprovalEnabled).toBe(false);
  });

  it("resets sessions through the live conversation store when base dirs match", () => {
    const io = createMemoryIo();
    const conversationStore = createConversationSessionStore({ baseDir: BASE_DIR, io });
    conversationStore.startSession();
    const { deps } = createDeps({
      io,
      conversationStore: () => conversationStore,
      conversationStoreBaseDir: BASE_DIR
    });

    const result = resetDataDomain("sessions", deps);

    expect(result.domain).toBe("sessions");
    expect(conversationStore.read().sessions).toHaveLength(0);
    expect(io.files[`${BASE_DIR}/memory/sessions.jsonl`]).toBe("");
  });

  it("resets sessions by writing the file directly for an isolated profile base dir", () => {
    const io = createMemoryIo();
    const isolatedDir = `${BASE_DIR}/profiles/profile-iso`;
    const { deps, io: spyIo } = createDeps({
      io,
      resolveMemoryBaseDir: () => isolatedDir,
      conversationStore: () => null
    });

    resetDataDomain("sessions", deps);

    const snapshot = JSON.parse(spyIo.files[`${isolatedDir}/memory/conversation-sessions.json`]);
    expect(snapshot.sessions).toEqual([]);
    expect(spyIo.files[`${isolatedDir}/memory/sessions.jsonl`]).toBe("");
  });

  it("resets automation: stops monitors and runs, clears both files", () => {
    const { deps, manager, monitorStore, runStore, stoppedRuns } = createDeps();

    const result = resetDataDomain("automation", deps);

    expect(result.domain).toBe("automation");
    expect(stoppedRuns).toContain("tmux-session:work");
    expect(stoppedRuns).toContain("tmux-session:side");
    expect(manager.deleted).toContain("tmux-session:work");
    expect(manager.stopped).toBe(1);
    expect(manager.started).toBe(1);
    expect(monitorStore.writes.at(-1)).toEqual({ schemaVersion: 1, monitors: [] });
    expect(runStore.writes.at(-1)).toEqual({ schemaVersion: 1, sequences: {}, runs: [] });
  });

  it("resets runtime: writes idle snapshot and marker", () => {
    const io = createMemoryIo();
    const { deps, io: spyIo } = createDeps({ io });

    const result = resetDataDomain("runtime", deps);

    expect(result.domain).toBe("runtime");
    const snapshot = JSON.parse(spyIo.files[`${HOME_DIR}/Library/Application Support/skfiy/runtime-snapshot.json`]);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.currentTurn.state).toBe("idle");
    expect(snapshot.replay.state).toBe("empty");
    const marker = JSON.parse(spyIo.files[`${HOME_DIR}/Library/Application Support/skfiy/runtime-turn-marker.json`]);
    expect(marker.schemaVersion).toBe(1);
  });

  it("is scoped: resetting sessions does not touch profiles or automation files", () => {
    const profileIo = createMemoryIo();
    const profileStore = createProfileStoreForTest(profileIo, [createIsolatedProfile("p1", "P1")]);
    const io = createMemoryIo();
    const { deps } = createDeps({ io, profileStore });

    resetDataDomain("sessions", deps);

    expect(profileStore.list()).toHaveLength(2);
    const registry = JSON.parse(profileIo.files[`${BASE_DIR}/profiles/profiles.json`]);
    expect(registry.profiles).toHaveLength(2);
  });
});
