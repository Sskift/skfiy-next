import { describe, expect, it } from "vitest";

import { readStorageHealth, type StorageHealthIo } from "./storage-health";

const BASE_DIR = "/app-support/skfiy";

function createMemoryIo(initial: Record<string, string> = {}): StorageHealthIo & {
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    exists: (targetPath) => Object.prototype.hasOwnProperty.call(files, targetPath),
    readFile: (targetPath) => {
      const content = files[targetPath];
      if (content === undefined) {
        throw new Error(`Missing ${targetPath}`);
      }
      return content;
    }
  };
}

function seedAllValid(io: StorageHealthIo & { files: Record<string, string> }): void {
  io.files[`${BASE_DIR}/profiles/profiles.json`] = JSON.stringify({
    schemaVersion: 1,
    activeProfileId: "default",
    profiles: []
  });
  io.files[`${BASE_DIR}/memory/USER.md`] = "user notes";
  io.files[`${BASE_DIR}/memory/AGENT.md`] = "agent notes";
  io.files[`${BASE_DIR}/memory/settings.json`] = JSON.stringify({
    postTurnLearningEnabled: true,
    writeApprovalEnabled: false
  });
  io.files[`${BASE_DIR}/memory/memory-journal.jsonl`] = '{"id":"j1"}\n{"id":"j2"}\n';
  io.files[`${BASE_DIR}/memory/pending-memory-writes.json`] = JSON.stringify({
    schemaVersion: 1,
    writes: []
  });
  io.files[`${BASE_DIR}/memory/personal-skills.json`] = JSON.stringify({
    disabledSkillIds: []
  });
  io.files[`${BASE_DIR}/memory/conversation-sessions.json`] = JSON.stringify({
    schemaVersion: 1,
    lastActiveSessionId: null,
    sessions: []
  });
  io.files[`${BASE_DIR}/memory/sessions.jsonl`] = "";
  io.files[`${BASE_DIR}/automation-monitors.json`] = JSON.stringify({
    schemaVersion: 1,
    monitors: []
  });
  io.files[`${BASE_DIR}/automation-runs.json`] = JSON.stringify({
    schemaVersion: 1,
    sequences: {},
    runs: []
  });
  io.files[`${BASE_DIR}/runtime-snapshot.json`] = JSON.stringify({
    schemaVersion: 1,
    observedAt: "2026-01-01T00:00:00.000Z",
    currentTurn: {},
    routeOutcome: {},
    replay: {}
  });
  io.files[`${BASE_DIR}/runtime-turn-marker.json`] = JSON.stringify({
    schemaVersion: 1,
    observedAt: "2026-01-01T00:00:00.000Z",
    currentTurn: {}
  });
}

describe("storage health", () => {
  it("reports ok with correct schema versions when every file is present and valid", () => {
    const io = createMemoryIo();
    seedAllValid(io);

    const health = readStorageHealth({ baseDir: BASE_DIR, io });

    expect(health.status).toBe("ok");
    expect(health.counts.total).toBe(13);
    expect(health.counts.ok).toBe(13);
    expect(health.counts.missing).toBe(0);
    expect(health.counts.corrupt).toBe(0);
    expect(health.counts.futureSchema).toBe(0);
    expect(health.recoveryHint).toBeUndefined();
    const profiles = health.files.find((f) => f.relativePath === "profiles/profiles.json");
    expect(profiles?.status).toBe("ok");
    expect(profiles?.schemaVersion).toBe(1);
    expect(profiles?.expectedSchemaVersion).toBe(1);
  });

  it("reports missing files without failing the summary", () => {
    const io = createMemoryIo();
    seedAllValid(io);
    delete io.files[`${BASE_DIR}/automation-runs.json`];

    const health = readStorageHealth({ baseDir: BASE_DIR, io });

    expect(health.status).toBe("ok");
    expect(health.counts.missing).toBe(1);
    const runs = health.files.find((f) => f.relativePath === "automation-runs.json");
    expect(runs?.status).toBe("missing");
  });

  it("reports corrupt JSON with an error message", () => {
    const io = createMemoryIo();
    seedAllValid(io);
    io.files[`${BASE_DIR}/profiles/profiles.json`] = "{ not json";

    const health = readStorageHealth({ baseDir: BASE_DIR, io });

    expect(health.status).toBe("corrupt");
    expect(health.counts.corrupt).toBe(1);
    const profiles = health.files.find((f) => f.relativePath === "profiles/profiles.json");
    expect(profiles?.status).toBe("corrupt");
    expect(profiles?.error).toBeTruthy();
    expect(health.recoveryHint).toContain("backups");
  });

  it("reports a corrupt JSONL line", () => {
    const io = createMemoryIo();
    seedAllValid(io);
    io.files[`${BASE_DIR}/memory/memory-journal.jsonl`] = '{"id":"ok"}\nnot-json\n';

    const health = readStorageHealth({ baseDir: BASE_DIR, io });

    expect(health.status).toBe("corrupt");
    const journal = health.files.find((f) => f.relativePath === "memory/memory-journal.jsonl");
    expect(journal?.status).toBe("corrupt");
  });

  it("reports future schema versions and never suggests downgrading", () => {
    const io = createMemoryIo();
    seedAllValid(io);
    io.files[`${BASE_DIR}/memory/conversation-sessions.json`] = JSON.stringify({
      schemaVersion: 7,
      sessions: []
    });

    const health = readStorageHealth({ baseDir: BASE_DIR, io });

    expect(health.status).toBe("future-schema");
    expect(health.counts.futureSchema).toBe(1);
    const sessions = health.files.find(
      (f) => f.relativePath === "memory/conversation-sessions.json"
    );
    expect(sessions?.status).toBe("future-schema");
    expect(sessions?.schemaVersion).toBe(7);
    expect(health.recoveryHint).toContain("backups");
  });

  it("reports a missing schemaVersion as corrupt", () => {
    const io = createMemoryIo();
    seedAllValid(io);
    io.files[`${BASE_DIR}/runtime-snapshot.json`] = JSON.stringify({ observedAt: "x" });

    const health = readStorageHealth({ baseDir: BASE_DIR, io });

    const snapshot = health.files.find((f) => f.relativePath === "runtime-snapshot.json");
    expect(snapshot?.status).toBe("corrupt");
  });

  it("treats text files as ok when they exist", () => {
    const io = createMemoryIo();
    seedAllValid(io);

    const health = readStorageHealth({ baseDir: BASE_DIR, io });

    const userMd = health.files.find((f) => f.relativePath === "memory/USER.md");
    expect(userMd?.status).toBe("ok");
    expect(userMd?.expectedSchemaVersion).toBeUndefined();
  });
});
