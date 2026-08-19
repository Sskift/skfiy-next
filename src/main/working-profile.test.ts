import { describe, expect, it } from "vitest";
import {
  createWorkingProfile,
  createWorkingProfilePromptBlock
} from "./working-profile";

describe("working profile", () => {
  it("derives a portable user working profile from memory, sessions, and personal skills", () => {
    const profile = createWorkingProfile({
      memory: {
        userEntries: [
          "User prefers concise Chinese updates.",
          "User prefers dense Obsidian-like knowledge surfaces for dashboard work.",
          "User token=secret should never be shown."
        ],
        agentEntries: [
          "For product-facing work, verify with focused tests, build output, and smoke evidence."
        ]
      },
      sessions: [
        {
          turnId: "turn-1",
          createdAt: "2026-06-24T08:00:00.000Z",
          userInput: "以后 dashboard 做得像 Obsidian，有知识图谱和双链",
          assistantReply: "我会做成本地知识画布。",
          providerLabel: "Hermes"
        },
        {
          turnId: "turn-2",
          createdAt: "2026-06-24T08:05:00.000Z",
          userInput: "进度更新短一点，中文就好",
          assistantReply: "好的。",
          providerLabel: "Codex"
        }
      ],
      personalSkills: [
        {
          id: "communication-style",
          kind: "communication",
          label: "Concise Chinese progress updates",
          description: "User prefers short Chinese progress updates.",
          promptHint: "Use concise Chinese progress updates.",
          evidenceCount: 2,
          evidence: ["User prefers concise Chinese updates."]
        },
        {
          id: "dashboard-knowledge-surface",
          kind: "dashboard",
          label: "Obsidian-style knowledge dashboard",
          description: "User wants dashboard work to feel like a linked local knowledge surface.",
          promptHint: "Favor linked memory, sessions, skills, and graph/canvas evidence.",
          evidenceCount: 2,
          evidence: ["User prefers dense Obsidian-like knowledge surfaces for dashboard work."]
        }
      ]
    });

    expect(profile).toBeDefined();
    if (!profile) {
      throw new Error("Expected working profile.");
    }
    expect(profile).toMatchObject({
      label: "Working profile",
      source: "derived-local-memory",
      portability: "plain-text",
      memoryEntryCount: 4,
      sessionCount: 2,
      skillCount: 2
    });
    expect(profile.summary).toContain("Concise Chinese progress updates");
    expect(profile.summary).toContain("Obsidian-style knowledge dashboard");
    expect(profile.habits).toEqual(expect.arrayContaining([
      "Use concise Chinese progress updates.",
      "Favor linked memory, sessions, skills, and graph/canvas evidence."
    ]));
    expect(profile.evidence).toEqual(expect.arrayContaining([
      "User prefers dense Obsidian-like knowledge surfaces for dashboard work."
    ]));
    expect(JSON.stringify(profile)).not.toContain("token=secret");
  });

  it("omits the profile when no personalization signal exists", () => {
    expect(createWorkingProfile({
      memory: {
        userEntries: [],
        agentEntries: []
      },
      sessions: [],
      personalSkills: []
    })).toBeUndefined();
  });

  it("formats a prompt-safe working profile block for backend provider turns", () => {
    const profile = createWorkingProfile({
      memory: {
        userEntries: ["User prefers concise Chinese updates."],
        agentEntries: ["Verify product-facing work with smoke evidence."]
      },
      personalSkills: [
        {
          id: "communication-style",
          kind: "communication",
          label: "Concise Chinese progress updates",
          description: "User prefers short Chinese progress updates.",
          promptHint: "Use concise Chinese progress updates.",
          evidenceCount: 1,
          evidence: ["User prefers concise Chinese updates."]
        }
      ]
    });

    expect(profile).toBeDefined();
    if (!profile) {
      throw new Error("Expected working profile.");
    }

    const block = createWorkingProfilePromptBlock(profile);

    expect(block).toContain("<skfiy-working-profile>");
    expect(block).toContain("Portable skfiy working profile");
    expect(block).toContain("Use concise Chinese progress updates.");
    expect(block).toContain("Treat this profile as local personalization context");
    expect(block).not.toContain("token");
    expect(block).toContain("</skfiy-working-profile>");
  });
});
