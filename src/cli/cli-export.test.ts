import { describe, expect, it } from "vitest";
import {
  createCliExportBundleDeps,
  createDefaultCliExportDeps,
  parseExportDomains,
  runExportCommand,
  runRestorePreviewCommand,
  type CliExportDeps
} from "./cli-export.js";
import { buildDataExportBundle, parseDataExportBundle } from "../main/data-export-bundle.js";
import { DATA_EXPORT_SCHEMA_VERSION, type DataDomain } from "../shared/data-export.js";
import { CliExitCode, readExitCodeForError } from "./cli-contract.js";

function createFixtureDeps(files: Map<string, string>): CliExportDeps {
  const homeDir = "/tmp/skfiy-cli-export-test-home";
  return {
    homeDir,
    appSupportDir: `${homeDir}/Library/Application Support/skfiy`,
    appVersion: "0.1.0",
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    exists: (targetPath) => files.has(targetPath),
    readFile: (targetPath) => files.get(targetPath) ?? "",
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    },
    mkdir: () => undefined
  };
}

const VALID_PROFILES_FILE = JSON.stringify({
  schemaVersion: 1,
  activeProfileId: "Default",
  profiles: [
    {
      id: "Default",
      name: "Default",
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
    }
  ]
});

describe("CLI export", () => {
  it("produces a bundle that round-trips through parseDataExportBundle", () => {
    const files = new Map<string, string>([
      ["/tmp/skfiy-cli-export-test-home/Library/Application Support/skfiy/profiles/profiles.json", VALID_PROFILES_FILE]
    ]);
    const result = runExportCommand({
      domains: ["profiles"],
      deps: createFixtureDeps(files)
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.data as ReturnType<typeof buildDataExportBundle>;
    expect(bundle.schemaVersion).toBe(DATA_EXPORT_SCHEMA_VERSION);
    const reparsed = parseDataExportBundle(bundle);
    expect(reparsed.domains).toEqual(["profiles"]);
    expect(reparsed.profiles?.profiles).toHaveLength(1);
  });

  it("--domains profiles,sessions produces exactly those domains", () => {
    const parsed = parseExportDomains("profiles,sessions");
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(["profiles", "sessions"]);
  });

  it("exports redaction.patterns and entriesRedacted", () => {
    const files = new Map<string, string>([
      ["/tmp/skfiy-cli-export-test-home/Library/Application Support/skfiy/profiles/profiles.json", VALID_PROFILES_FILE]
    ]);
    const result = runExportCommand({
      domains: ["profiles"],
      deps: createFixtureDeps(files)
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.data as ReturnType<typeof buildDataExportBundle>;
    expect(Array.isArray(bundle.redaction.patterns)).toBe(true);
    expect(bundle.redaction.patterns.length).toBeGreaterThan(0);
    expect(typeof bundle.redaction.entriesRedacted).toBe("number");
  });

  it("restore preview with a v2-schema bundle returns schema-version-mismatch (exit 3)", () => {
    const files = new Map<string, string>();
    const v2Bundle = {
      schemaVersion: 2,
      exportedAt: "2026-08-20T00:00:00.000Z",
      exporter: { app: "skfiy", version: "99.0.0" },
      domains: ["profiles"],
      redaction: { patterns: [], entriesRedacted: 0 },
      profiles: { activeProfileId: "Default", profiles: [] }
    };
    files.set("/tmp/skfiy-export-v2.json", JSON.stringify(v2Bundle));

    const result = runRestorePreviewCommand({
      inputPath: "/tmp/skfiy-export-v2.json",
      deps: createFixtureDeps(files)
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("schema-version-mismatch");
    expect(result.error.expected).toBe(1);
    expect(result.error.actual).toBe(2);
    expect(result.error.action.length).toBeGreaterThan(0);
  });

  it("restore preview with an undeclared-payload bundle returns invalid-bundle", () => {
    const files = new Map<string, string>();
    // domains declares only profiles, but the bundle carries a sessions payload
    const undeclaredBundle = {
      schemaVersion: 1,
      exportedAt: "2026-08-20T00:00:00.000Z",
      exporter: { app: "skfiy", version: "0.1.0" },
      domains: ["profiles"],
      redaction: { patterns: [], entriesRedacted: 0 },
      profiles: { activeProfileId: "Default", profiles: [] },
      sessions: { conversations: [] }
    };
    files.set("/tmp/skfiy-export-undeclared.json", JSON.stringify(undeclaredBundle));

    const result = runRestorePreviewCommand({
      inputPath: "/tmp/skfiy-export-undeclared.json",
      deps: createFixtureDeps(files)
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid-bundle");
    expect(result.error.message).toContain("undeclared");
  });

  it("restore preview with a valid bundle returns requiresConfirmation and backupPlan", () => {
    const files = new Map<string, string>([
      ["/tmp/skfiy-cli-export-test-home/Library/Application Support/skfiy/profiles/profiles.json", VALID_PROFILES_FILE]
    ]);
    const validBundle = buildDataExportBundle(
      ["profiles"],
      createCliExportBundleDeps(
        createDefaultCliExportDeps({
          homeDir: "/tmp/skfiy-cli-export-test-home",
          appVersion: "0.1.0",
          now: () => new Date("2026-08-20T00:00:00.000Z")
        })
      )
    );
    files.set("/tmp/skfiy-export-valid.json", JSON.stringify(validBundle));

    const result = runRestorePreviewCommand({
      inputPath: "/tmp/skfiy-export-valid.json",
      deps: createFixtureDeps(files)
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.requiresConfirmation).toBe(true);
    expect(result.data.backupPlan.path.length).toBeGreaterThan(0);
    expect(result.data.backupPlan.createdAt.length).toBeGreaterThan(0);
    expect(result.data.domains.length).toBeGreaterThan(0);
  });

  it("restore preview with a missing file returns file-not-found", () => {
    const result = runRestorePreviewCommand({
      inputPath: "/tmp/skfiy-export-missing.json",
      deps: createFixtureDeps(new Map())
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("file-not-found");
  });

  it("maps schema-version-mismatch to exit code 3", () => {
    expect(readExitCodeForError("schema-version-mismatch")).toBe(CliExitCode.SchemaVersionMismatch);
    expect(readExitCodeForError("unknown-command")).toBe(CliExitCode.UsageError);
    expect(readExitCodeForError("internal")).toBe(CliExitCode.RuntimeError);
  });
});
