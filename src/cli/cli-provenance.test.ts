import { describe, expect, it } from "vitest";
import { parseCodesignIdentity, runProvenanceCommand, type EmbeddedBuildInfo } from "./cli-provenance.js";
import { runSkfiyCli } from "./cli-command-surface.js";

const BUILD_INFO: EmbeddedBuildInfo = {
  schemaVersion: 1,
  appName: "skfiy",
  version: "0.1.0",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  commitShortSha: "0123456",
  treeStatus: "clean",
  buildTimeIso: "2026-08-20T12:00:00.000Z",
  nodeVersion: "22.0.0",
  electronVersion: "43.4.1",
  builder: "github-actions",
  runner: "macos-15"
};

const CODESIGN_OUTPUT = [
  "Executable=/Applications/skfiy.app/Contents/MacOS/skfiy",
  "Identifier=com.sskift.skfiy",
  "Authority=Developer ID Application: Skfiy (TEAMID)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "TeamIdentifier=TEAMID",
  "Timestamp=Aug 20, 2026 at 12:00:00 PM"
].join("\n");

function createOutputCapture() {
  const chunks: string[] = [];
  return {
    stdout: { write: (chunk: string) => { chunks.push(chunk); return true; } },
    stderr: { write: () => true },
    lastJson: <T>() => JSON.parse(chunks.join("")) as T
  };
}

describe("parseCodesignIdentity", () => {
  it("parses the first Authority line and TeamIdentifier", () => {
    const parsed = parseCodesignIdentity(CODESIGN_OUTPUT);
    expect(parsed.identity).toBe("Developer ID Application: Skfiy (TEAMID)");
    expect(parsed.teamIdentifier).toBe("TEAMID");
  });

  it("maps TeamIdentifier 'not set' to null", () => {
    const parsed = parseCodesignIdentity("Authority=adhoc\nTeamIdentifier=not set\n");
    expect(parsed.identity).toBe("adhoc");
    expect(parsed.teamIdentifier).toBeNull();
  });

  it("returns nulls when no identity is present", () => {
    const parsed = parseCodesignIdentity("Executable=/tmp/app\n");
    expect(parsed.identity).toBeNull();
    expect(parsed.teamIdentifier).toBeNull();
  });
});

describe("runProvenanceCommand", () => {
  it("returns embedded build-info plus the codesign identity", async () => {
    const result = await runProvenanceCommand({
      appPath: "/Applications/skfiy.app",
      exists: () => true,
      readFile: () => JSON.stringify(BUILD_INFO),
      execFile: async () => ({ stdout: "", stderr: CODESIGN_OUTPUT })
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.appPath).toBe("/Applications/skfiy.app");
    expect(result.data.buildInfo.commitSha).toBe(BUILD_INFO.commitSha);
    expect(result.data.buildInfo.version).toBe("0.1.0");
    expect(result.data.signature.state).toBe("signed");
    expect(result.data.signature.identity).toBe("Developer ID Application: Skfiy (TEAMID)");
    expect(result.data.signature.teamIdentifier).toBe("TEAMID");
  });

  it("returns a typed provenance-unavailable error when build-info is missing", async () => {
    const result = await runProvenanceCommand({
      appPath: "/Applications/skfiy.app",
      exists: () => false,
      readFile: () => {
        throw new Error("missing");
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("provenance-unavailable");
    expect(result.error.action.length).toBeGreaterThan(0);
  });

  it("returns an error when build-info is malformed or foreign", async () => {
    const result = await runProvenanceCommand({
      appPath: "/Applications/skfiy.app",
      exists: () => true,
      readFile: () => JSON.stringify({ schemaVersion: 99, appName: "other" })
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("provenance-unavailable");
  });

  it("degrades to unsigned when codesign fails (dev build)", async () => {
    const result = await runProvenanceCommand({
      appPath: "/Applications/skfiy.app",
      exists: () => true,
      readFile: () => JSON.stringify(BUILD_INFO),
      execFile: async () => {
        throw new Error("code object is not signed at all");
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.signature.state).toBe("unsigned");
    expect(result.data.signature.identity).toBeNull();
  });
});

describe("skfiy provenance CLI surface", () => {
  it("dispatches `skfiy provenance` and returns the provenance envelope", async () => {
    const output = createOutputCapture();
    const exitCode = await runSkfiyCli({
      argv: ["provenance"],
      stdout: output.stdout,
      stderr: output.stderr,
      homeDir: "/tmp/skfiy-provenance-test-home",
      appVersion: "0.1.0",
      appPath: "/Applications/skfiy.app",
      exists: (targetPath) => targetPath.endsWith("build-info.json"),
      readFile: (targetPath) => {
        if (targetPath.endsWith("build-info.json")) {
          return JSON.stringify(BUILD_INFO);
        }
        throw new Error(`unexpected read: ${targetPath}`);
      },
      execFile: async () => ({ stdout: "", stderr: CODESIGN_OUTPUT })
    });

    expect(exitCode).toBe(0);
    const envelope = output.lastJson<{
      result: string;
      command: string;
      data: {
        buildInfo: { commitSha: string };
        signature: { state: string; identity: string | null };
      };
    }>();
    expect(envelope.result).toBe("ok");
    expect(envelope.command).toBe("provenance");
    expect(envelope.data.buildInfo.commitSha).toBe(BUILD_INFO.commitSha);
    expect(envelope.data.signature.state).toBe("signed");
  });

  it("returns exit 1 and a provenance-unavailable error envelope for dev builds", async () => {
    const output = createOutputCapture();
    const exitCode = await runSkfiyCli({
      argv: ["provenance"],
      stdout: output.stdout,
      stderr: output.stderr,
      homeDir: "/tmp/skfiy-provenance-test-home",
      appVersion: "0.1.0",
      appPath: "/Applications/skfiy.app",
      exists: () => false,
      readFile: () => {
        throw new Error("missing");
      }
    });

    expect(exitCode).toBe(1);
    const envelope = output.lastJson<{
      result: string;
      error: { code: string };
    }>();
    expect(envelope.result).toBe("error");
    expect(envelope.error.code).toBe("provenance-unavailable");
  });
});
