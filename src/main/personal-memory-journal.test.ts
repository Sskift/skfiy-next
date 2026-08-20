import { describe, expect, it } from "vitest";
import {
  createPersonalMemoryJournalStore,
  readPersonalMemoryJournalEntries,
  type PersonalMemoryJournalIo
} from "./personal-memory-journal";

describe("personal memory journal", () => {
  it("records durable and pending memory learning receipts as append-only JSONL", () => {
    const files = new Map<string, string>();
    const store = createPersonalMemoryJournalStore({
      baseDir: "/tmp/skfiy",
      io: createJournalIo(files),
      now: () => new Date("2026-06-24T10:00:00.000Z")
    });

    store.appendOperations([
      {
        action: "add",
        target: "user",
        content: "User prefers concise Chinese progress updates."
      }
    ], {
      providerLabel: "Hermes",
      source: "post-turn-review",
      stage: "durable",
      turnId: "turn-1",
      userInput: "以后进度短一点"
    });
    store.appendOperations([
      {
        action: "replace",
        target: "user",
        previousContent: "User prefers concise Chinese progress updates.",
        content: "User prefers concise Chinese-first progress updates with verification evidence."
      }
    ], {
      providerLabel: "Claude Code",
      source: "post-turn-review",
      stage: "pending",
      turnId: "turn-2",
      userInput: "以后带验证证据"
    });

    expect(store.read()).toEqual([
      expect.objectContaining({
        id: "pmj-20260624T100000000Z-1",
        action: "add",
        target: "user",
        content: "User prefers concise Chinese progress updates.",
        providerLabel: "Hermes",
        source: "post-turn-review",
        stage: "durable",
        turnId: "turn-1",
        userInput: "以后进度短一点"
      }),
      expect.objectContaining({
        id: "pmj-20260624T100000000Z-2",
        action: "replace",
        target: "user",
        previousContent: "User prefers concise Chinese progress updates.",
        content: "User prefers concise Chinese-first progress updates with verification evidence.",
        providerLabel: "Claude Code",
        stage: "pending",
        turnId: "turn-2"
      })
    ]);
    expect(readPersonalMemoryJournalEntries({
      baseDir: "/tmp/skfiy",
      io: createJournalIo(files)
    })).toHaveLength(2);
  });
});

function createJournalIo(files: Map<string, string>): PersonalMemoryJournalIo {
  return {
    exists: (targetPath) => files.has(targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => files.get(targetPath) ?? "",
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    }
  };
}
