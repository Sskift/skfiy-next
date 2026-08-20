import { describe, expect, it } from "vitest";
import {
  createPendingPersonalMemoryStore,
  createPendingPersonalMemoryWritePath,
  type PendingPersonalMemoryIo
} from "./personal-memory-pending";
import {
  createPersonalMemoryStore,
  type PersonalMemoryIo
} from "./personal-memory";

describe("pending personal memory writes", () => {
  it("stages memory operations without changing durable memory until approval", () => {
    const files = new Map<string, string>();
    const pendingStore = createPendingPersonalMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createPendingIo(files),
      now: () => new Date("2026-06-24T05:00:00.000Z")
    });
    const memoryStore = createPersonalMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createMemoryIo(files)
    });

    const staged = pendingStore.stageOperations([
      { action: "add", target: "user", content: "User prefers concise Chinese updates." }
    ], {
      source: "post-turn-review"
    });

    expect(staged).toMatchObject({
      staged: 1,
      blocked: 0
    });
    expect(memoryStore.read().userEntries).toEqual([]);
    expect(pendingStore.read()).toEqual([
      expect.objectContaining({
        id: "pmw-20260624T050000000Z-1",
        action: "add",
        target: "user",
        content: "User prefers concise Chinese updates.",
        source: "post-turn-review"
      })
    ]);

    const approved = pendingStore.approve("pmw-20260624T050000000Z-1", memoryStore);

    expect(approved).toMatchObject({
      result: "approved",
      applied: 1
    });
    expect(memoryStore.read().userEntries).toEqual(["User prefers concise Chinese updates."]);
    expect(pendingStore.read()).toEqual([]);
  });

  it("rejects staged memory writes without mutating durable memory", () => {
    const files = new Map<string, string>();
    const pendingStore = createPendingPersonalMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createPendingIo(files),
      now: () => new Date("2026-06-24T05:00:00.000Z")
    });
    const memoryStore = createPersonalMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createMemoryIo(files)
    });

    pendingStore.stageOperations([
      { action: "add", target: "agent", content: "Prefer Obsidian-style dashboard evidence." }
    ]);
    const rejected = pendingStore.reject("pmw-20260624T050000000Z-1");

    expect(rejected).toEqual({ result: "rejected" });
    expect(memoryStore.read().agentEntries).toEqual([]);
    expect(pendingStore.read()).toEqual([]);
  });

  it("blocks secret-like pending writes before they can be displayed for review", () => {
    const files = new Map<string, string>();
    const pendingStore = createPendingPersonalMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createPendingIo(files)
    });

    const result = pendingStore.stageOperations([
      { action: "add", target: "user", content: "User token=secret-value should never be staged." }
    ]);

    expect(result).toMatchObject({
      staged: 0,
      blocked: 1
    });
    expect(files.get(createPendingPersonalMemoryWritePath("/tmp/skfiy"))).toBeUndefined();
  });
});

function createPendingIo(files: Map<string, string>): PendingPersonalMemoryIo {
  return {
    exists: (targetPath) => files.has(targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => files.get(targetPath) ?? "",
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    }
  };
}

function createMemoryIo(files: Map<string, string>): PersonalMemoryIo {
  return {
    exists: (targetPath) => files.has(targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => files.get(targetPath) ?? "",
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    }
  };
}
