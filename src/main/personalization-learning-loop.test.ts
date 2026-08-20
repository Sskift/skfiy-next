import { describe, expect, it, vi } from "vitest";
import type { AssistantAgentTurnResult } from "./assistant-agent";
import {
  createPersonalMemoryStore,
  type PersonalMemoryIo
} from "./personal-memory";
import {
  createPersonalMemoryJournalStore,
  type PersonalMemoryJournalIo
} from "./personal-memory-journal";
import {
  createPendingPersonalMemoryStore,
  type PendingPersonalMemoryIo
} from "./personal-memory-pending";
import {
  recordCompletedAssistantTurnForPersonalization
} from "./personalization-learning-loop";
import {
  createSessionMemoryStore,
  type SessionMemoryIo
} from "./session-memory";

describe("personalization learning loop", () => {
  it("records the visible agent turn, reviews it, and writes durable user memory", async () => {
    const files = new Map<string, string>();
    const memoryStore = createPersonalMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createMemoryIo(files)
    });
    const sessionStore = createSessionMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createSessionIo(files)
    });
    const memoryJournalStore = createPersonalMemoryJournalStore({
      baseDir: "/tmp/skfiy",
      io: createJournalIo(files),
      now: () => new Date("2026-06-24T07:05:00.000Z")
    });
    const runReviewTurn = vi.fn().mockResolvedValue(createCompletedTurn(
      "memory-review",
      "Hermes",
      `{"operations":[{"action":"add","target":"user","content":"User prefers dense Obsidian-like dashboard surfaces."}]}`
    ));

    await recordCompletedAssistantTurnForPersonalization({
      userInput: "以后 dashboard 要有 Obsidian 那种视觉冲击。",
      turn: createCompletedTurn("turn-1", "Codex", "我会记下这个偏好。"),
      browserPageContext: {
        state: "ready",
        url: "https://example.test/dashboard",
        title: "Dashboard brief"
      },
      memoryStore,
      memoryJournalStore,
      sessionMemoryStore: sessionStore,
      runReviewTurn
    });

    expect(sessionStore.readAll()).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        userInput: "以后 dashboard 要有 Obsidian 那种视觉冲击。",
        assistantReply: "我会记下这个偏好。",
        providerLabel: "Codex",
        browserContext: {
          url: "https://example.test/dashboard",
          title: "Dashboard brief"
        }
      })
    ]);
    expect(runReviewTurn).toHaveBeenCalledWith(
      expect.stringContaining("Review this skfiy conversation for durable user preferences"),
      expect.objectContaining({
        personalMemory: expect.objectContaining({
          userEntries: []
        })
      })
    );
    expect(memoryStore.read().userEntries).toEqual([
      "User prefers dense Obsidian-like dashboard surfaces."
    ]);
    expect(memoryJournalStore.read()).toEqual([
      expect.objectContaining({
        action: "add",
        content: "User prefers dense Obsidian-like dashboard surfaces.",
        providerLabel: "Codex",
        source: "post-turn-review",
        stage: "durable",
        turnId: "turn-1",
        userInput: "以后 dashboard 要有 Obsidian 那种视觉冲击。"
      })
    ]);
  });

  it("uses the local fallback when provider review returns no durable operation", async () => {
    const files = new Map<string, string>();
    const memoryStore = createPersonalMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createMemoryIo(files)
    });
    const sessionStore = createSessionMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createSessionIo(files)
    });
    const memoryJournalStore = createPersonalMemoryJournalStore({
      baseDir: "/tmp/skfiy",
      io: createJournalIo(files),
      now: () => new Date("2026-06-24T07:10:00.000Z")
    });

    await recordCompletedAssistantTurnForPersonalization({
      userInput: "以后进度更新短一点，中文就好",
      turn: createCompletedTurn("turn-1", "Hermes", "好的，我会更简洁。"),
      browserPageContext: { state: "blocked", reason: "no browser context" },
      memoryStore,
      memoryJournalStore,
      sessionMemoryStore: sessionStore,
      runReviewTurn: async () => createCompletedTurn("memory-review", "Hermes", `{"operations":[]}`)
    });

    expect(memoryStore.read().userEntries).toEqual([
      "User prefers concise Chinese progress updates."
    ]);
    expect(memoryJournalStore.read()).toEqual([
      expect.objectContaining({
        action: "add",
        content: "User prefers concise Chinese progress updates.",
        providerLabel: "Hermes",
        source: "local-fallback",
        stage: "durable",
        turnId: "turn-1"
      })
    ]);
  });

  it("stages post-turn memory writes when approval review is enabled", async () => {
    const files = new Map<string, string>();
    const memoryStore = createPersonalMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createMemoryIo(files)
    });
    const pendingMemoryStore = createPendingPersonalMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createPendingIo(files),
      now: () => new Date("2026-06-24T07:30:00.000Z")
    });
    const memoryJournalStore = createPersonalMemoryJournalStore({
      baseDir: "/tmp/skfiy",
      io: createJournalIo(files),
      now: () => new Date("2026-06-24T07:31:00.000Z")
    });
    const sessionStore = createSessionMemoryStore({
      baseDir: "/tmp/skfiy",
      io: createSessionIo(files)
    });

    await recordCompletedAssistantTurnForPersonalization({
      userInput: "以后 dashboard 默认做 Obsidian 那种密集知识图谱。",
      turn: createCompletedTurn("turn-1", "Claude Code", "我会记下这个方向。"),
      browserPageContext: { state: "unavailable" },
      memoryStore,
      memoryJournalStore,
      pendingMemoryStore,
      sessionMemoryStore: sessionStore,
      memoryWriteApprovalEnabled: true,
      runReviewTurn: async () => createCompletedTurn(
        "memory-review",
        "Claude Code",
        `{"operations":[{"action":"add","target":"user","content":"User prefers dense Obsidian-like knowledge surfaces for dashboard work."}]}`
      )
    });

    expect(memoryStore.read().userEntries).toEqual([]);
    expect(pendingMemoryStore.read()).toEqual([
      expect.objectContaining({
        id: "pmw-20260624T073000000Z-1",
        source: "post-turn-review",
        action: "add",
        target: "user",
        content: "User prefers dense Obsidian-like knowledge surfaces for dashboard work."
      })
    ]);
    expect(memoryJournalStore.read()).toEqual([
      expect.objectContaining({
        action: "add",
        content: "User prefers dense Obsidian-like knowledge surfaces for dashboard work.",
        providerLabel: "Claude Code",
        source: "post-turn-review",
        stage: "pending",
        turnId: "turn-1"
      })
    ]);
  });
});

function createCompletedTurn(
  id: string,
  providerLabel: AssistantAgentTurnResult["providerLabel"],
  message: string
): AssistantAgentTurnResult {
  return {
    id,
    createdAt: "2026-06-24T07:00:00.000Z",
    status: "completed",
    providerLabel,
    message,
    route: {
      kind: "chat",
      reason: "Conversational prompt should be answered by the assistant instead of typed into Ghostty."
    },
    toolCalls: [],
    cancellation: { requested: false }
  };
}

function createMemoryIo(files: Map<string, string>): PersonalMemoryIo {
  return {
    exists: (targetPath) => files.has(targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => files.get(targetPath) ?? "",
    stat: (targetPath) => ({ mtimeMs: files.has(targetPath) ? Date.parse("2026-06-24T07:00:00.000Z") : 0 }),
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    }
  };
}

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

function createSessionIo(files: Map<string, string>): SessionMemoryIo {
  return {
    exists: (targetPath) => files.has(targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => files.get(targetPath) ?? "",
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    }
  };
}
