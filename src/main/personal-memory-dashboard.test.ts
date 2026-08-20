import { describe, expect, it } from "vitest";
import {
  approvePendingPersonalMemoryWrite,
  forgetPersonalMemoryEntry,
  readPersonalMemoryDashboardSnapshot,
  readPersonalMemoryForgetRequest,
  readPendingMemoryActionRequest,
  rejectPendingPersonalMemoryWrite,
  type PersonalMemoryDashboardIo
} from "./personal-memory-dashboard";
import { createPersonalMemoryStore } from "./personal-memory";
import { createPendingPersonalMemoryStore } from "./personal-memory-pending";
import { createPersonalMemoryJournalStore } from "./personal-memory-journal";
import { createSessionMemoryStore } from "./session-memory";
import { createPersonalMemorySettingsStore } from "./personal-memory-settings";

const BASE_DIR = "/tmp/skfiy";

describe("personal memory dashboard snapshot", () => {
  it("assembles entries, usage, sessions, journal, pending writes, and settings", () => {
    const files = new Map<string, string>();
    const io = createDashboardIo(files);
    const memoryStore = createPersonalMemoryStore({ baseDir: BASE_DIR, io });
    memoryStore.applyOperations([
      { action: "add", target: "user", content: "User prefers concise Chinese progress updates." },
      { action: "add", target: "agent", content: "Verify packaged app smoke evidence." }
    ]);
    const sessionStore = createSessionMemoryStore({ baseDir: BASE_DIR, io });
    sessionStore.append({
      turnId: "turn-1",
      createdAt: "2026-08-20T09:00:00.000Z",
      userInput: "以后进度短一点",
      assistantReply: "好的。",
      providerLabel: "Codex"
    });
    const pendingStore = createPendingPersonalMemoryStore({
      baseDir: BASE_DIR,
      io,
      now: () => new Date("2026-08-20T09:05:00.000Z")
    });
    pendingStore.stageOperations([
      { action: "add", target: "user", content: "User prefers dense dashboard surfaces." }
    ]);
    const journalStore = createPersonalMemoryJournalStore({
      baseDir: BASE_DIR,
      io,
      now: () => new Date("2026-08-20T09:06:00.000Z")
    });
    journalStore.appendOperations([
      { action: "add", target: "user", content: "User prefers concise Chinese progress updates." }
    ], {
      providerLabel: "Codex",
      source: "post-turn-review",
      stage: "durable",
      turnId: "turn-1",
      userInput: "以后进度短一点"
    });

    const snapshot = readPersonalMemoryDashboardSnapshot({ baseDir: BASE_DIR, io });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.userEntries).toEqual(["User prefers concise Chinese progress updates."]);
    expect(snapshot.agentEntries).toEqual(["Verify packaged app smoke evidence."]);
    expect(snapshot.usage.user).toMatchObject({ usedChars: 46, limitChars: 1375 });
    expect(snapshot.usage.agent).toMatchObject({ usedChars: 35, limitChars: 2200 });
    expect(snapshot.sessionCount).toBe(1);
    expect(snapshot.pendingWrites).toEqual([
      expect.objectContaining({
        action: "add",
        target: "user",
        content: "User prefers dense dashboard surfaces.",
        source: "post-turn-review"
      })
    ]);
    expect(snapshot.journal).toEqual([
      expect.objectContaining({
        action: "add",
        target: "user",
        stage: "durable",
        turnId: "turn-1",
        providerLabel: "Codex"
      })
    ]);
    expect(snapshot.settings).toEqual({
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    });
    expect(snapshot.latestUpdatedAt).toBe("2026-08-20T09:00:00.000Z");
  });

  it("returns newest journal entries and pending writes first and caps the trail", () => {
    const files = new Map<string, string>();
    const io = createDashboardIo(files);
    const pendingStore = createPendingPersonalMemoryStore({
      baseDir: BASE_DIR,
      io,
      now: () => new Date("2026-08-20T09:00:00.000Z")
    });
    pendingStore.stageOperations(
      Array.from({ length: 25 }, (_unused, index) => ({
        action: "add" as const,
        target: "user" as const,
        content: `Pending preference number ${index + 1}.`
      }))
    );
    const journalStore = createPersonalMemoryJournalStore({
      baseDir: BASE_DIR,
      io,
      now: () => new Date("2026-08-20T09:05:00.000Z")
    });
    journalStore.appendOperations(
      Array.from({ length: 25 }, (_unused, index) => ({
        action: "add" as const,
        target: "user" as const,
        content: `Journal preference number ${index + 1}.`
      })),
      {
        providerLabel: "Codex",
        source: "post-turn-review",
        stage: "durable",
        turnId: "turn-1",
        userInput: "learn"
      }
    );

    const snapshot = readPersonalMemoryDashboardSnapshot({ baseDir: BASE_DIR, io });

    expect(snapshot.pendingWrites).toHaveLength(20);
    expect(snapshot.pendingWrites[0].content).toBe("Pending preference number 25.");
    expect(snapshot.journal).toHaveLength(20);
    expect(snapshot.journal[0].content).toBe("Journal preference number 25.");
  });

  it("reflects persisted settings including the env-forced write approval flag", () => {
    const files = new Map<string, string>();
    const io = createDashboardIo(files);
    const settingsStore = createPersonalMemorySettingsStore({ baseDir: BASE_DIR, io });
    settingsStore.update({ postTurnLearningEnabled: false, writeApprovalEnabled: true });

    expect(readPersonalMemoryDashboardSnapshot({ baseDir: BASE_DIR, io }).settings).toEqual({
      postTurnLearningEnabled: false,
      writeApprovalEnabled: true
    });
    expect(readPersonalMemoryDashboardSnapshot({
      baseDir: BASE_DIR,
      io,
      env: { SKFIY_PERSONAL_MEMORY_WRITE_APPROVAL: "1" }
    }).settings).toEqual({
      postTurnLearningEnabled: false,
      writeApprovalEnabled: true
    });
  });
});

describe("personal memory dashboard actions", () => {
  it("forgets an exact durable entry and reports not-found for unknown content", () => {
    const files = new Map<string, string>();
    const io = createDashboardIo(files);
    const memoryStore = createPersonalMemoryStore({ baseDir: BASE_DIR, io });
    memoryStore.applyOperations([
      { action: "add", target: "user", content: "User prefers concise Chinese progress updates." }
    ]);

    const forgotten = forgetPersonalMemoryEntry({
      baseDir: BASE_DIR,
      io,
      target: "user",
      content: "User prefers concise Chinese progress updates."
    });
    expect(forgotten.result).toBe("forgotten");
    expect(forgotten.snapshot.userEntries).toEqual([]);

    const missing = forgetPersonalMemoryEntry({
      baseDir: BASE_DIR,
      io,
      target: "user",
      content: "User prefers concise Chinese progress updates."
    });
    expect(missing.result).toBe("not-found");
  });

  it("approves a staged write into durable memory and clears the pending queue", () => {
    const files = new Map<string, string>();
    const io = createDashboardIo(files);
    const pendingStore = createPendingPersonalMemoryStore({
      baseDir: BASE_DIR,
      io,
      now: () => new Date("2026-08-20T09:00:00.000Z")
    });
    pendingStore.stageOperations([
      { action: "add", target: "agent", content: "Prefer Obsidian-style dashboard evidence." }
    ]);
    const pendingId = pendingStore.read()[0]?.id ?? "";

    const approved = approvePendingPersonalMemoryWrite({
      baseDir: BASE_DIR,
      io,
      pendingId
    });

    expect(approved.result).toBe("approved");
    expect(approved).toMatchObject({ applied: 1, ignored: 0, blocked: 0 });
    expect(approved.snapshot.agentEntries).toEqual(["Prefer Obsidian-style dashboard evidence."]);
    expect(approved.snapshot.pendingWrites).toEqual([]);
  });

  it("reports not-found when approving an unknown pending id", () => {
    const files = new Map<string, string>();
    const io = createDashboardIo(files);

    const approved = approvePendingPersonalMemoryWrite({
      baseDir: BASE_DIR,
      io,
      pendingId: "pmw-does-not-exist"
    });

    expect(approved.result).toBe("not-found");
    expect(approved.snapshot.pendingWrites).toEqual([]);
  });

  it("rejects a staged write without touching durable memory", () => {
    const files = new Map<string, string>();
    const io = createDashboardIo(files);
    const pendingStore = createPendingPersonalMemoryStore({
      baseDir: BASE_DIR,
      io,
      now: () => new Date("2026-08-20T09:00:00.000Z")
    });
    pendingStore.stageOperations([
      { action: "add", target: "user", content: "User prefers dense dashboard surfaces." }
    ]);
    const pendingId = pendingStore.read()[0]?.id ?? "";

    const rejected = rejectPendingPersonalMemoryWrite({
      baseDir: BASE_DIR,
      io,
      pendingId
    });

    expect(rejected.result).toBe("rejected");
    expect(rejected.snapshot.pendingWrites).toEqual([]);
    expect(rejected.snapshot.userEntries).toEqual([]);
  });

  it("validates action request payloads", () => {
    expect(readPersonalMemoryForgetRequest({ target: "user", content: "note" })).toEqual({
      target: "user",
      content: "note"
    });
    expect(readPersonalMemoryForgetRequest({ target: "system", content: "note" })).toBeUndefined();
    expect(readPersonalMemoryForgetRequest({ target: "user", content: "  " })).toBeUndefined();
    expect(readPersonalMemoryForgetRequest("nope")).toBeUndefined();
    expect(readPendingMemoryActionRequest({ pendingId: "pmw-1" })).toEqual({
      pendingId: "pmw-1"
    });
    expect(readPendingMemoryActionRequest({ pendingId: " " })).toBeUndefined();
    expect(readPendingMemoryActionRequest(null)).toBeUndefined();
  });
});

function createDashboardIo(files: Map<string, string>): PersonalMemoryDashboardIo {
  return {
    exists: (targetPath) => files.has(targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => files.get(targetPath) ?? "",
    stat: (targetPath) => ({
      mtimeMs: files.has(targetPath) ? Date.parse("2026-08-20T09:00:00.000Z") : 0
    }),
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    }
  };
}
