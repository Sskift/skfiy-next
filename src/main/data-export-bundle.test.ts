import { describe, expect, it } from "vitest";

import {
  buildDataExportBundle,
  parseDataExportBundle,
  DATA_DOMAIN_DESCRIPTORS,
  type DataExportBundleDeps
} from "./data-export-bundle";
import { DATA_EXPORT_SCHEMA_VERSION, type DataDomain } from "../shared/data-export";
import type { Profile } from "../shared/profile";
import type { ConversationSession } from "../shared/conversation-history";
import type { DataExportAutomationMonitor } from "../shared/data-export";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function createProfile(id: string, name: string): Profile {
  return {
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryScope: "shared",
    assistantAgent: { mode: "codex" },
    plannerProvider: { mode: "local-deterministic" },
    appPolicy: { apps: [] },
    workflowDefaults: {
      defaultManualMode: "active",
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    }
  };
}

function createConversation(id: string, text: string): ConversationSession {
  return {
    id,
    title: `Conversation ${id}`,
    titleSource: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    turns: [
      {
        id: `turn-${id}`,
        submissionId: `sub-${id}`,
        attempt: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        provider: { id: "codex", label: "Codex" },
        computerUseState: "none",
        messages: [
          { id: `m-${id}`, turnId: `turn-${id}`, createdAt: "2026-01-01T00:00:00.000Z", kind: "user-text", text }
        ]
      }
    ]
  };
}

function createMonitor(sessionName: string): DataExportAutomationMonitor {
  return {
    id: `tmux-session:${sessionName}`,
    kind: "tmux-session",
    label: `Monitor ${sessionName}`,
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 30_000,
    triggerMode: "manual",
    sessionName,
    preview: {
      adapter: "tmux-supervision",
      triggerModes: ["manual", "scheduled"],
      target: { kind: "tmux-session", sessionName },
      requiredPermissions: [],
      readWriteBehavior: "read-only",
      approvalMode: "not-required",
      timeoutMs: 30_000,
      verification: "tmux session observation",
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
  };
}

function createDeps(overrides: Partial<DataExportBundleDeps> = {}): DataExportBundleDeps {
  return {
    appVersion: "0.1.0",
    now: () => NOW,
    readProfiles: () => ({
      activeProfileId: "default",
      profiles: [createProfile("default", "Default")]
    }),
    readPersonalMemory: () => ({
      scope: "shared",
      userEntries: ["user preference"],
      agentEntries: ["agent note"],
      settings: { postTurnLearningEnabled: true, writeApprovalEnabled: false },
      skills: { disabledSkillIds: [] }
    }),
    readSessions: () => ({ conversations: [createConversation("s1", "hello")] }),
    readAutomation: () => ({ monitors: [createMonitor("work")] }),
    readRuntime: () => ({
      snapshot: {
        schemaVersion: 1,
        observedAt: "2026-01-01T00:00:00.000Z",
        currentTurn: { state: "idle" },
        routeOutcome: {
          kind: "idle",
          title: "Idle",
          value: "idle",
          detail: "No active turn.",
          tone: "neutral",
          source: "runtime-snapshot",
          routeLabel: "idle",
          state: "idle"
        },
        replay: { state: "empty" }
      }
    }),
    ...overrides
  };
}

describe("data export bundle", () => {
  it("builds a bundle with all five domains, schema version, and timestamp", () => {
    const bundle = buildDataExportBundle(
      ["profiles", "personal-memory", "sessions", "automation", "runtime"],
      createDeps()
    );

    expect(bundle.schemaVersion).toBe(DATA_EXPORT_SCHEMA_VERSION);
    expect(bundle.exportedAt).toBe(NOW.toISOString());
    expect(bundle.exporter).toEqual({ app: "skfiy", version: "0.1.0" });
    expect(bundle.domains).toEqual([
      "profiles",
      "personal-memory",
      "sessions",
      "automation",
      "runtime"
    ]);
    expect(bundle.profiles?.profiles).toHaveLength(1);
    expect(bundle.personalMemory?.userEntries).toEqual(["user preference"]);
    expect(bundle.sessions?.conversations).toHaveLength(1);
    expect(bundle.automation?.monitors).toHaveLength(1);
    expect(bundle.runtime?.snapshot?.schemaVersion).toBe(1);
    expect(bundle.redaction.patterns.length).toBeGreaterThan(0);
    expect(bundle.redaction.entriesRedacted).toBe(0);
  });

  it("only includes the requested domains", () => {
    const bundle = buildDataExportBundle(["profiles"], createDeps());

    expect(bundle.domains).toEqual(["profiles"]);
    expect(bundle.profiles).toBeDefined();
    expect(bundle.personalMemory).toBeUndefined();
    expect(bundle.sessions).toBeUndefined();
    expect(bundle.automation).toBeUndefined();
    expect(bundle.runtime).toBeUndefined();
  });

  it("produces a token-free bundle and reports redactions", () => {
    const deps = createDeps({
      readPersonalMemory: () => ({
        scope: "shared",
        userEntries: [
          "Bearer abc123def456ghi789jkl",
          "sk-test-1234567890abcdef",
          "password=hunter2secret",
          "token abcdefghijklmnop"
        ],
        agentEntries: ["api_key=abc123"]
      }),
      readSessions: () => ({
        conversations: [createConversation("s1", "the token is Bearer zzz999yyy888xxx777")]
      }),
      readAutomation: () => ({
        monitors: [{ ...createMonitor("work"), label: "secret=topsecret" }]
      })
    });

    const bundle = buildDataExportBundle(
      ["personal-memory", "sessions", "automation"],
      deps
    );
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain("abc123def456ghi789jkl");
    expect(serialized).not.toContain("sk-test-1234567890abcdef");
    expect(serialized).not.toContain("hunter2secret");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("zzz999yyy888xxx777");
    expect(serialized).not.toContain("topsecret");
    expect(serialized).toContain("[redacted]");
    expect(bundle.redaction.entriesRedacted).toBeGreaterThan(0);
  });

  it("caps memory entries, conversations, and monitors", () => {
    const deps = createDeps({
      readPersonalMemory: () => ({
        scope: "shared",
        userEntries: Array.from({ length: 200 }, (_, i) => `user entry ${i}`),
        agentEntries: []
      }),
      readSessions: () => ({
        conversations: Array.from({ length: 100 }, (_, i) => createConversation(`s${i}`, "hi"))
      }),
      readAutomation: () => ({
        monitors: Array.from({ length: 80 }, (_, i) => createMonitor(`session-${i}`))
      })
    });

    const bundle = buildDataExportBundle(
      ["personal-memory", "sessions", "automation"],
      deps
    );

    expect(bundle.personalMemory?.userEntries).toHaveLength(100);
    expect(bundle.sessions?.conversations).toHaveLength(50);
    expect(bundle.automation?.monitors).toHaveLength(50);
  });

  it("dedupes memory entries", () => {
    const deps = createDeps({
      readPersonalMemory: () => ({
        scope: "shared",
        userEntries: ["same", "same", "same"],
        agentEntries: []
      })
    });

    const bundle = buildDataExportBundle(["personal-memory"], deps);

    expect(bundle.personalMemory?.userEntries).toEqual(["same"]);
  });

  it("round-trips through JSON and parse", () => {
    const bundle = buildDataExportBundle(
      ["profiles", "personal-memory", "sessions", "automation", "runtime"],
      createDeps()
    );

    const parsed = parseDataExportBundle(JSON.parse(JSON.stringify(bundle)));

    expect(parsed).toEqual(bundle);
  });

  it("rejects a non-object bundle", () => {
    expect(() => parseDataExportBundle("nope")).toThrow(/object/);
    expect(() => parseDataExportBundle(null)).toThrow(/object/);
    expect(() => parseDataExportBundle([])).toThrow(/object/);
  });

  it("rejects the wrong schema version", () => {
    const bundle = buildDataExportBundle(["profiles"], createDeps());
    expect(() => parseDataExportBundle({ ...bundle, schemaVersion: 99 })).toThrow(/schema version/);
  });

  it("rejects a missing exportedAt timestamp", () => {
    const bundle = buildDataExportBundle(["profiles"], createDeps());
    const { exportedAt: _unused, ...withoutTimestamp } = bundle;
    expect(() => parseDataExportBundle(withoutTimestamp)).toThrow(/exportedAt/);
  });

  it("rejects a malformed profile", () => {
    const bundle = buildDataExportBundle(["profiles"], createDeps());
    const malformed = {
      ...bundle,
      profiles: { activeProfileId: "default", profiles: [{ id: "p1" }] }
    };
    expect(() => parseDataExportBundle(malformed)).toThrow(/profile/);
  });

  it("rejects non-array memory entries", () => {
    const bundle = buildDataExportBundle(["personal-memory"], createDeps());
    const malformed = {
      ...bundle,
      personalMemory: { scope: "shared", userEntries: "nope", agentEntries: [] }
    };
    expect(() => parseDataExportBundle(malformed)).toThrow(/userEntries/);
  });

  it("rejects a payload for an undeclared domain", () => {
    const bundle = buildDataExportBundle(["profiles"], createDeps());
    const withUndeclared = {
      ...bundle,
      sessions: { conversations: [] }
    };
    expect(() => parseDataExportBundle(withUndeclared)).toThrow(/undeclared/);
  });

  it("rejects duplicate domains", () => {
    const bundle = buildDataExportBundle(["profiles"], createDeps());
    const duplicated = { ...bundle, domains: ["profiles", "profiles"] };
    expect(() => parseDataExportBundle(duplicated)).toThrow(/more than once/);
  });

  it("exports automation definitions only, never runtimes or run records", () => {
    const bundle = buildDataExportBundle(["automation"], createDeps());

    expect(bundle.automation?.monitors).toHaveLength(1);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("runtimes");
    expect(serialized).not.toContain("runId");
    expect(serialized).not.toContain("timeline");
  });

  it("describes every domain's files and reset impact", () => {
    const domains: DataDomain[] = [
      "profiles",
      "personal-memory",
      "sessions",
      "automation",
      "runtime"
    ];
    for (const domain of domains) {
      const descriptor = DATA_DOMAIN_DESCRIPTORS[domain];
      expect(descriptor.domain).toBe(domain);
      expect(descriptor.files.length).toBeGreaterThan(0);
      expect(descriptor.resetImpact.length).toBeGreaterThan(0);
    }
  });
});
