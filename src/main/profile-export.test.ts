import { describe, expect, it } from "vitest";

import {
  buildProfileExportBundle,
  parseProfileExportBundle
} from "./profile-export";
import type { Profile } from "../shared/profile";

function createProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "profile-1",
    name: "Writing",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    memoryScope: "isolated",
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
    },
    ...overrides
  };
}

describe("profile export", () => {
  it("builds a schema-versioned bundle without memory by default", () => {
    const bundle = buildProfileExportBundle({ profile: createProfile() });

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.exportedAt).toBeTypeOf("string");
    expect(bundle.profile.id).toBe("profile-1");
    expect(bundle.memory).toBeUndefined();
    expect(bundle.sessions).toBeUndefined();
  });

  it("includes capped, deduplicated memory entries and bounded sessions when requested", () => {
    const bundle = buildProfileExportBundle({
      profile: createProfile(),
      memory: {
        userEntries: ["one", "one", "two", "three"],
        agentEntries: ["agent note"]
      },
      sessions: [
        {
          turnId: "turn-1",
          createdAt: "2026-08-01T00:00:00.000Z",
          userInput: "hello",
          assistantReply: "hi",
          providerLabel: "Codex"
        }
      ]
    });

    expect(bundle.memory).toEqual({
      userEntries: ["one", "two", "three"],
      agentEntries: ["agent note"]
    });
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.sessions?.[0].turnId).toBe("turn-1");
  });

  it("round-trips a bundle through parse", () => {
    const bundle = buildProfileExportBundle({
      profile: createProfile(),
      memory: { userEntries: ["pref"], agentEntries: [] },
      sessions: [
        {
          turnId: "turn-1",
          createdAt: "2026-08-01T00:00:00.000Z",
          userInput: "hello",
          assistantReply: "hi",
          providerLabel: "Codex",
          browserContext: { url: "https://example.com", title: "Example" }
        }
      ]
    });

    const parsed = parseProfileExportBundle(bundle);

    expect(parsed.profile).toEqual(bundle.profile);
    expect(parsed.memory).toEqual(bundle.memory);
    expect(parsed.sessions).toEqual(bundle.sessions);
  });

  it("rejects bundles with the wrong schema version", () => {
    expect(() =>
      parseProfileExportBundle({
        schemaVersion: 2,
        exportedAt: "2026-08-01T00:00:00.000Z",
        profile: createProfile()
      })
    ).toThrow(/schema version/i);
  });

  it("rejects bundles whose app policy entries are invalid or duplicated", () => {
    expect(() =>
      parseProfileExportBundle({
        schemaVersion: 1,
        exportedAt: "2026-08-01T00:00:00.000Z",
        profile: createProfile({
          appPolicy: {
            apps: [
              { name: "Chrome", bundleId: "com.google.Chrome", policy: "maybe" as never }
            ]
          }
        })
      })
    ).toThrow(/app policy/i);

    expect(() =>
      parseProfileExportBundle({
        schemaVersion: 1,
        exportedAt: "2026-08-01T00:00:00.000Z",
        profile: createProfile({
          appPolicy: {
            apps: [
              { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" },
              { name: "Chrome 2", bundleId: "com.google.Chrome", policy: "allow" }
            ]
          }
        })
      })
    ).toThrow(/more than once/i);
  });

  it("rejects bundles with invalid workflow defaults or memory shape", () => {
    expect(() =>
      parseProfileExportBundle({
        schemaVersion: 1,
        exportedAt: "2026-08-01T00:00:00.000Z",
        profile: createProfile({
          workflowDefaults: {
            defaultManualMode: "active",
            postTurnLearningEnabled: "yes" as never,
            writeApprovalEnabled: false
          }
        })
      })
    ).toThrow(/workflowDefaults/i);

    expect(() =>
      parseProfileExportBundle({
        schemaVersion: 1,
        exportedAt: "2026-08-01T00:00:00.000Z",
        profile: createProfile(),
        memory: { userEntries: "nope" }
      })
    ).toThrow(/memory/i);
  });

  it("drops malformed session records while keeping valid ones", () => {
    const parsed = parseProfileExportBundle({
      schemaVersion: 1,
      exportedAt: "2026-08-01T00:00:00.000Z",
      profile: createProfile(),
      sessions: [
        {
          turnId: "turn-1",
          createdAt: "2026-08-01T00:00:00.000Z",
          userInput: "hello",
          assistantReply: "hi",
          providerLabel: "Codex"
        },
        { turnId: "broken" }
      ]
    });

    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions?.[0].turnId).toBe("turn-1");
  });
});
