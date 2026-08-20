import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PLAN_MODULE_PATH = path.join(process.cwd(), "scripts/sign-notarize-macos-plan.mjs");
const CLI_MODULE_PATH = path.join(process.cwd(), "scripts/sign-notarize-macos.mjs");

interface MacReleasePlan {
  appPath: string;
  outputDir: string;
  zipPath: string;
  entitlementsPath: string;
  bundleIdentifier: string;
}

interface MacReleaseOptions {
  plan: MacReleasePlan;
  signingIdentity?: string;
  appleId?: string;
  appleTeamId?: string;
  applePassword?: string;
  keychainProfile?: string;
  dryRun: boolean;
  sign: boolean;
  notarize: boolean;
  jsonOutputPath?: string;
  help?: boolean;
}

interface SignPlanModule {
  createMacReleasePlan: (input: { rootDir: string }) => MacReleasePlan;
  createDefaultMacReleaseOptions: (input: {
    rootDir: string;
    env: Record<string, string | undefined>;
  }) => MacReleaseOptions;
  parseMacReleaseArgs: (argv: string[], defaults: MacReleaseOptions) => MacReleaseOptions;
  createCodeSignCommand: (input: {
    appPath: string;
    identity: string;
    entitlementsPath?: string;
  }) => { command: string; args: string[] };
  createZipCommand: (input: { appPath: string; zipPath: string }) => {
    command: string;
    args: string[];
  };
  createSignatureVerificationCommands: (input: { appPath: string }) => Array<{
    command: string;
    args: string[];
  }>;
  createNotarySubmitCommand: (input: {
    zipPath: string;
    appleId?: string;
    appleTeamId?: string;
    applePassword?: string;
    keychainProfile?: string;
  }) => { command: string; args: string[] };
  createStapleCommand: (input: { appPath: string }) => { command: string; args: string[] };
  createMacReleaseReadinessReport: (input: {
    signingIdentity?: string;
    appleId?: string;
    appleTeamId?: string;
    applePassword?: string;
    keychainProfile?: string;
  }) => {
    ready: boolean;
    missing: string[];
    signing: { ready: boolean; missing: string[] };
    notarization: { ready: boolean; missing: string[] };
  };
  createMacReleaseSteps: (options: MacReleaseOptions) => Array<{
    name: string;
    command: { command: string; args: string[] };
  }>;
  createHelpText: (defaults: MacReleaseOptions) => string;
}

interface MacReleaseCliModule {
  redactCommand: (command: { command: string; args: string[] }) => {
    command: string;
    args: string[];
  };
  runMacReleaseCli: (input: {
    rootDir?: string;
    argv?: string[];
    env?: Record<string, string | undefined>;
    io?: {
      exists?: (targetPath: string) => boolean;
      mkdir?: (targetPath: string, options?: { recursive?: boolean }) => Promise<void>;
      execFile?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
      writeText?: (targetPath: string, content: string) => Promise<void>;
      write?: (message: string) => unknown;
    };
  }) => Promise<{ status: string } & Record<string, unknown>>;
}

async function loadPlanModule(): Promise<SignPlanModule> {
  return await import(pathToFileURL(PLAN_MODULE_PATH).href) as SignPlanModule;
}

async function loadCliModule(): Promise<MacReleaseCliModule> {
  return await import(pathToFileURL(CLI_MODULE_PATH).href) as MacReleaseCliModule;
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

function createTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "skfiy-mac-release-"));
  tempRoots.push(root);
  return root;
}

function createRecordingIo() {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    exists: () => true,
    mkdir: async () => {},
    execFile: async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    },
    writeText: async () => {},
    write: () => {}
  };
}

describe("sign-notarize-macos-plan.mjs", () => {
  it("plans app, output dir, zip, entitlements, and bundle identifier paths", async () => {
    const { createMacReleasePlan } = await loadPlanModule();
    const plan = createMacReleasePlan({ rootDir: "/repo" });

    expect(plan.appPath).toBe(path.join("/repo", "dist", "skfiy.app"));
    expect(plan.outputDir).toBe(path.join("/repo", ".skfiy-release"));
    expect(plan.zipPath).toBe(path.join("/repo", ".skfiy-release", "skfiy-macos-notarization.zip"));
    expect(plan.entitlementsPath).toBe(path.join("/repo", "release", "skfiy.entitlements.plist"));
    expect(plan.bundleIdentifier).toBe("com.sskift.skfiy");
  });

  it("maps env vars in defaults and stays dry-run", async () => {
    const { createDefaultMacReleaseOptions } = await loadPlanModule();
    const options = createDefaultMacReleaseOptions({
      rootDir: "/repo",
      env: {
        SKFIY_DEVELOPER_ID_APPLICATION: "Developer ID Application: Skfiy (TEAMID)",
        APPLE_ID: "you@example.com",
        APPLE_TEAM_ID: "TEAMID",
        APPLE_APP_SPECIFIC_PASSWORD: "aaaa-bbbb-cccc-dddd",
        APPLE_KEYCHAIN_PROFILE: "skfiy-notary"
      }
    });

    expect(options.signingIdentity).toBe("Developer ID Application: Skfiy (TEAMID)");
    expect(options.appleId).toBe("you@example.com");
    expect(options.appleTeamId).toBe("TEAMID");
    expect(options.applePassword).toBe("aaaa-bbbb-cccc-dddd");
    expect(options.keychainProfile).toBe("skfiy-notary");
    expect(options.dryRun).toBe(true);
    expect(options.sign).toBe(false);
    expect(options.notarize).toBe(false);
  });

  it("parses args: --notarize implies --sign, unknown args throw", async () => {
    const { parseMacReleaseArgs, createDefaultMacReleaseOptions } = await loadPlanModule();
    const defaults = createDefaultMacReleaseOptions({ rootDir: "/repo", env: {} });

    const notarize = parseMacReleaseArgs(["--notarize"], defaults);
    expect(notarize.notarize).toBe(true);
    expect(notarize.sign).toBe(true);

    const signOnly = parseMacReleaseArgs(["--sign"], defaults);
    expect(signOnly.sign).toBe(true);
    expect(signOnly.notarize).toBe(false);

    const execute = parseMacReleaseArgs(["--sign", "--execute"], defaults);
    expect(execute.dryRun).toBe(false);

    const withPassword = parseMacReleaseArgs(
      ["--sign", "--password", "aaaa-bbbb-cccc-dddd"],
      defaults
    );
    expect(withPassword.applePassword).toBe("aaaa-bbbb-cccc-dddd");

    expect(() => parseMacReleaseArgs(["--bogus"], defaults)).toThrow("Unknown argument: --bogus");
  });

  it("builds the codesign command with hardened runtime, timestamp, and entitlements", async () => {
    const { createCodeSignCommand } = await loadPlanModule();
    const command = createCodeSignCommand({
      appPath: "/repo/dist/skfiy.app",
      identity: "Developer ID Application: Skfiy (TEAMID)",
      entitlementsPath: "/repo/release/skfiy.entitlements.plist"
    });

    expect(command.command).toBe("codesign");
    expect(command.args).toEqual([
      "--force",
      "--deep",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      "/repo/release/skfiy.entitlements.plist",
      "--sign",
      "Developer ID Application: Skfiy (TEAMID)",
      "/repo/dist/skfiy.app"
    ]);
  });

  it("builds zip, verification, notary, and staple commands", async () => {
    const plan = await loadPlanModule();

    const zip = plan.createZipCommand({
      appPath: "/repo/dist/skfiy.app",
      zipPath: "/repo/.skfiy-release/skfiy-macos-notarization.zip"
    });
    expect(zip).toEqual({
      command: "ditto",
      args: ["-c", "-k", "--keepParent", "/repo/dist/skfiy.app", "/repo/.skfiy-release/skfiy-macos-notarization.zip"]
    });

    const verification = plan.createSignatureVerificationCommands({ appPath: "/repo/dist/skfiy.app" });
    expect(verification).toHaveLength(2);
    expect(verification[0]?.command).toBe("codesign");
    expect(verification[0]?.args).toContain("--verify");
    expect(verification[1]?.command).toBe("spctl");
    expect(verification[1]?.args).toEqual(["--assess", "--type", "execute", "--verbose", "/repo/dist/skfiy.app"]);

    const keychainSubmit = plan.createNotarySubmitCommand({
      zipPath: "/repo/.skfiy-release/skfiy-macos-notarization.zip",
      keychainProfile: "skfiy-notary"
    });
    expect(keychainSubmit.args).toContain("--keychain-profile");
    expect(keychainSubmit.args).toContain("skfiy-notary");
    expect(keychainSubmit.args).not.toContain("--apple-id");

    const passwordSubmit = plan.createNotarySubmitCommand({
      zipPath: "/repo/.skfiy-release/skfiy-macos-notarization.zip",
      appleId: "you@example.com",
      appleTeamId: "TEAMID",
      applePassword: "aaaa-bbbb-cccc-dddd"
    });
    expect(passwordSubmit.args).toContain("--apple-id");
    expect(passwordSubmit.args).toContain("you@example.com");
    expect(passwordSubmit.args).toContain("--password");
    expect(passwordSubmit.args).toContain("aaaa-bbbb-cccc-dddd");

    const staple = plan.createStapleCommand({ appPath: "/repo/dist/skfiy.app" });
    expect(staple).toEqual({
      command: "xcrun",
      args: ["stapler", "staple", "/repo/dist/skfiy.app"]
    });
  });

  it("reports readiness split into signing and notarization", async () => {
    const { createMacReleaseReadinessReport } = await loadPlanModule();

    const nothing = createMacReleaseReadinessReport({});
    expect(nothing.ready).toBe(false);
    expect(nothing.signing.missing).toEqual(["SKFIY_DEVELOPER_ID_APPLICATION"]);
    expect(nothing.notarization.missing).toContain("APPLE_ID");
    expect(nothing.notarization.missing).toContain("APPLE_TEAM_ID");
    expect(nothing.notarization.missing).toContain("APPLE_APP_SPECIFIC_PASSWORD or APPLE_KEYCHAIN_PROFILE");

    const keychainOnly = createMacReleaseReadinessReport({
      signingIdentity: "Developer ID Application: Skfiy (TEAMID)",
      keychainProfile: "skfiy-notary"
    });
    expect(keychainOnly.ready).toBe(true);
    expect(keychainOnly.notarization.ready).toBe(true);
    expect(keychainOnly.notarization.missing).toEqual([]);

    const signReady = createMacReleaseReadinessReport({
      signingIdentity: "Developer ID Application: Skfiy (TEAMID)"
    });
    expect(signReady.signing.ready).toBe(true);
    expect(signReady.notarization.ready).toBe(false);
  });

  it("orders steps: sign, verify codesign, verify spctl, zip, submit, staple", async () => {
    const { createMacReleaseSteps, createDefaultMacReleaseOptions } = await loadPlanModule();
    const defaults = createDefaultMacReleaseOptions({ rootDir: "/repo", env: {} });
    const steps = createMacReleaseSteps({
      ...defaults,
      sign: true,
      notarize: true,
      signingIdentity: "Developer ID Application: Skfiy (TEAMID)",
      appleId: "you@example.com",
      appleTeamId: "TEAMID",
      applePassword: "aaaa-bbbb-cccc-dddd"
    });

    expect(steps.map((step) => step.name)).toEqual([
      "codesign-app",
      "verify-codesign",
      "verify-spctl",
      "zip-for-notary",
      "submit-notary",
      "staple-ticket"
    ]);
  });
});

describe("sign-notarize-macos.mjs", () => {
  it("redacts the value after --password in planned commands", async () => {
    const { redactCommand } = await loadCliModule();
    const redacted = redactCommand({
      command: "xcrun",
      args: ["notarytool", "submit", "app.zip", "--password", "aaaa-bbbb-cccc-dddd"]
    });

    expect(redacted.args).toContain("<redacted>");
    expect(redacted.args).not.toContain("aaaa-bbbb-cccc-dddd");
  });

  it("dry-run prints the report without executing any step", async () => {
    const { runMacReleaseCli } = await loadCliModule();
    const io = createRecordingIo();
    const report = await runMacReleaseCli({
      rootDir: "/repo",
      argv: ["--sign", "--notarize"],
      env: {
        SKFIY_DEVELOPER_ID_APPLICATION: "Developer ID Application: Skfiy (TEAMID)",
        APPLE_ID: "you@example.com",
        APPLE_TEAM_ID: "TEAMID",
        APPLE_APP_SPECIFIC_PASSWORD: "aaaa-bbbb-cccc-dddd"
      },
      io
    });

    expect(report.status).toBe("checked");
    expect(report.dryRun).toBe(true);
    expect(io.calls).toEqual([]);
    const steps = report.steps as Array<{ name: string; command: { args: string[] } }>;
    const submitStep = steps.find((step) => step.name === "submit-notary");
    expect(submitStep?.command.args).toContain("<redacted>");
  });

  it("--execute runs steps in order and writes the executed report", async () => {
    const { runMacReleaseCli } = await loadCliModule();
    const io = createRecordingIo();
    const jsonOutputPath = path.join(createTempRoot(), "release-report.json");
    const report = await runMacReleaseCli({
      rootDir: "/repo",
      argv: ["--sign", "--notarize", "--execute", "--json-output", jsonOutputPath],
      env: {
        SKFIY_DEVELOPER_ID_APPLICATION: "Developer ID Application: Skfiy (TEAMID)",
        APPLE_ID: "you@example.com",
        APPLE_TEAM_ID: "TEAMID",
        APPLE_APP_SPECIFIC_PASSWORD: "aaaa-bbbb-cccc-dddd"
      },
      io
    });

    expect(report.status).toBe("executed");
    expect(io.calls.map((call) => call.command)).toEqual([
      "codesign",
      "codesign",
      "spctl",
      "ditto",
      "xcrun",
      "xcrun"
    ]);
  });

  it("--execute --sign without a signing identity throws", async () => {
    const { runMacReleaseCli } = await loadCliModule();
    await expect(
      runMacReleaseCli({
        rootDir: "/repo",
        argv: ["--sign", "--execute"],
        env: {},
        io: createRecordingIo()
      })
    ).rejects.toThrow(/credentials are incomplete/);
  });

  it("--help returns help status", async () => {
    const { runMacReleaseCli } = await loadCliModule();
    const io = createRecordingIo();
    const report = await runMacReleaseCli({
      rootDir: "/repo",
      argv: ["--help"],
      env: {},
      io
    });

    expect(report.status).toBe("help");
    expect(io.calls).toEqual([]);
  });
});
