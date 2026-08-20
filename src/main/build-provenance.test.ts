import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(nodeExecFile);
const GENERATE_SCRIPT = path.join(process.cwd(), "scripts/generate-build-info.mjs");
const VERIFY_SCRIPT = path.join(process.cwd(), "scripts/verify-build-provenance.mjs");
const PACKAGE_SCRIPT = path.join(process.cwd(), "scripts/package-macos-app.mjs");
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

interface BuildInfo {
  schemaVersion: number;
  appName: string;
  version: string;
  commitSha: string;
  commitShortSha: string;
  treeStatus: string;
  buildTimeIso: string;
  nodeVersion: string;
  electronVersion: string;
  builder: string;
  runner: string;
}

interface BuildInfoIo {
  execFile: (
    command: string,
    args: string[],
    options?: { cwd?: string }
  ) => Promise<{ stdout: string; stderr: string }>;
  readFile: (targetPath: string) => Promise<string>;
}

interface GenerateBuildInfoModule {
  BUILD_INFO_SCHEMA_VERSION: number;
  BUILD_INFO_APP_NAME: string;
  createBuildInfo: (input: {
    rootDir?: string;
    env?: Record<string, string | undefined>;
    now?: () => Date;
    io?: Partial<BuildInfoIo>;
  }) => Promise<BuildInfo>;
  parseBuildInfoArgs: (argv: string[]) => {
    rootDir: string;
    outputPath?: string;
    help: boolean;
  };
}

interface VerifyProvenanceModule {
  PROVENANCE_FAILURE: Record<string, string>;
  verifyBuildProvenance: (input: {
    appPath: string;
    expectedCommitSha: string;
    expectedVersion: string;
    requireCleanTree?: boolean;
    rootDir?: string;
    io?: {
      exists?: (targetPath: string) => boolean;
      readFile?: (targetPath: string) => string;
    };
  }) => Promise<{
    ok: boolean;
    failures: Array<{ type: string; message: string; expected?: string; actual?: string }>;
    buildInfo: BuildInfo | null;
  }>;
}

interface PackageMacosAppModule {
  createPackagePlan: (input: { rootDir: string }) => {
    appBundlePath: string;
    buildInfoPath: string;
    [key: string]: unknown;
  };
  packageMacosApp: (input: {
    rootDir: string;
    io?: {
      execFile: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
    };
  }) => Promise<{ appBundlePath: string; buildInfoPath: string; [key: string]: unknown }>;
}

async function loadGenerateModule(): Promise<GenerateBuildInfoModule> {
  return await import(pathToFileURL(GENERATE_SCRIPT).href) as GenerateBuildInfoModule;
}

async function loadVerifyModule(): Promise<VerifyProvenanceModule> {
  return await import(pathToFileURL(VERIFY_SCRIPT).href) as VerifyProvenanceModule;
}

async function loadPackageModule(): Promise<PackageMacosAppModule> {
  return await import(pathToFileURL(PACKAGE_SCRIPT).href) as PackageMacosAppModule;
}

function createBuildInfoIo(overrides: Partial<BuildInfoIo> = {}): BuildInfoIo {
  return {
    execFile: async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: `${COMMIT_SHA}\n`, stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    },
    readFile: async (targetPath: string) => {
      if (targetPath.endsWith(path.join("electron", "package.json"))) {
        return JSON.stringify({ version: "43.4.1" });
      }
      if (targetPath.endsWith("package.json")) {
        return JSON.stringify({ version: "0.1.0" });
      }
      throw new Error(`unexpected read: ${targetPath}`);
    },
    ...overrides
  };
}

function createFixtureBuildInfo(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    schemaVersion: 1,
    appName: "skfiy",
    version: "0.1.0",
    commitSha: COMMIT_SHA,
    commitShortSha: COMMIT_SHA.slice(0, 7),
    treeStatus: "clean",
    buildTimeIso: "2026-08-20T12:00:00.000Z",
    nodeVersion: "22.0.0",
    electronVersion: "43.4.1",
    builder: "github-actions",
    runner: "macos-15",
    ...overrides
  };
}

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "skfiy-prov-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

function createFixtureApp(
  overrides: {
    buildInfo?: BuildInfo | string | null;
    bundledVersion?: string;
    rootVersion?: string;
  } = {}
): { root: string; appPath: string } {
  const root = createTempRoot();
  const appPath = path.join(root, "dist", "skfiy.app");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  mkdirSync(path.join(resourcesPath, "app"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: overrides.rootVersion ?? "0.1.0" })
  );
  writeFileSync(
    path.join(resourcesPath, "app", "package.json"),
    JSON.stringify({ version: overrides.bundledVersion ?? "0.1.0" })
  );
  if (overrides.buildInfo !== null) {
    const content = typeof overrides.buildInfo === "string"
      ? overrides.buildInfo
      : JSON.stringify(overrides.buildInfo ?? createFixtureBuildInfo());
    writeFileSync(path.join(resourcesPath, "build-info.json"), content);
  }
  return { root, appPath };
}

describe("generate-build-info.mjs", () => {
  it("captures version, commit, tree status, and builder from the live checkout", async () => {
    const { createBuildInfo, BUILD_INFO_SCHEMA_VERSION, BUILD_INFO_APP_NAME } = await loadGenerateModule();
    const buildInfo = await createBuildInfo({
      rootDir: "/repo",
      env: { GITHUB_ACTIONS: "true", GITHUB_RUNNER: "macos-15" },
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      io: createBuildInfoIo()
    });

    expect(buildInfo.schemaVersion).toBe(BUILD_INFO_SCHEMA_VERSION);
    expect(buildInfo.schemaVersion).toBe(1);
    expect(buildInfo.appName).toBe(BUILD_INFO_APP_NAME);
    expect(buildInfo.appName).toBe("skfiy");
    expect(buildInfo.version).toBe("0.1.0");
    expect(buildInfo.commitSha).toBe(COMMIT_SHA);
    expect(buildInfo.commitShortSha).toBe(COMMIT_SHA.slice(0, 7));
    expect(buildInfo.treeStatus).toBe("clean");
    expect(buildInfo.buildTimeIso).toBe("2026-08-20T12:00:00.000Z");
    expect(buildInfo.nodeVersion).toBe(process.versions.node);
    expect(buildInfo.electronVersion).toBe("43.4.1");
    expect(buildInfo.builder).toBe("github-actions");
    expect(buildInfo.runner).toBe("macos-15");
  });

  it("marks the tree dirty when git status --porcelain has output", async () => {
    const { createBuildInfo } = await loadGenerateModule();
    const buildInfo = await createBuildInfo({
      rootDir: "/repo",
      env: {},
      io: createBuildInfoIo({
        execFile: async (command, args) => {
          if (command === "git" && args[0] === "rev-parse") {
            return { stdout: `${COMMIT_SHA}\n`, stderr: "" };
          }
          if (command === "git" && args[0] === "status") {
            return { stdout: " M src/main.ts\n", stderr: "" };
          }
          throw new Error(`unexpected exec: ${command}`);
        }
      })
    });

    expect(buildInfo.treeStatus).toBe("dirty");
  });

  it("derives builder local and runner from os.release outside GitHub Actions", async () => {
    const { createBuildInfo } = await loadGenerateModule();
    const buildInfo = await createBuildInfo({
      rootDir: "/repo",
      env: {},
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      io: createBuildInfoIo()
    });

    expect(buildInfo.builder).toBe("local");
    expect(typeof buildInfo.runner).toBe("string");
    expect(buildInfo.runner.length).toBeGreaterThan(0);
  });

  it("degrades to unknown commit and tree status when git is absent", async () => {
    const { createBuildInfo } = await loadGenerateModule();
    const buildInfo = await createBuildInfo({
      rootDir: "/repo",
      env: {},
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      io: createBuildInfoIo({
        execFile: async () => {
          throw new Error("git: command not found");
        }
      })
    });

    expect(buildInfo.commitSha).toBe("unknown");
    expect(buildInfo.commitShortSha).toBe("unknown");
    expect(buildInfo.treeStatus).toBe("unknown");
    // Packaging still succeeds: version and electron version are unaffected.
    expect(buildInfo.version).toBe("0.1.0");
    expect(buildInfo.electronVersion).toBe("43.4.1");
  });

  it("falls back to 0.0.0 when package.json has no version", async () => {
    const { createBuildInfo } = await loadGenerateModule();
    const buildInfo = await createBuildInfo({
      rootDir: "/repo",
      env: {},
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      io: createBuildInfoIo({
        readFile: async (targetPath) => {
          if (targetPath.endsWith(path.join("electron", "package.json"))) {
            return JSON.stringify({ version: "43.4.1" });
          }
          if (targetPath.endsWith("package.json")) {
            return JSON.stringify({ name: "skfiy" });
          }
          throw new Error(`unexpected read: ${targetPath}`);
        }
      })
    });

    expect(buildInfo.version).toBe("0.0.0");
  });

  it("falls back to unknown electron version when electron package.json is missing", async () => {
    const { createBuildInfo } = await loadGenerateModule();
    const buildInfo = await createBuildInfo({
      rootDir: "/repo",
      env: {},
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      io: createBuildInfoIo({
        readFile: async (targetPath) => {
          if (targetPath.endsWith(path.join("electron", "package.json"))) {
            throw new Error("missing electron package.json");
          }
          if (targetPath.endsWith("package.json")) {
            return JSON.stringify({ version: "0.1.0" });
          }
          throw new Error(`unexpected read: ${targetPath}`);
        }
      })
    });

    expect(buildInfo.electronVersion).toBe("unknown");
  });

  it("parses CLI args with --root, --output, and --help", async () => {
    const { parseBuildInfoArgs } = await loadGenerateModule();
    expect(parseBuildInfoArgs(["--root", "/repo", "--output", "/tmp/build-info.json"])).toMatchObject({
      rootDir: path.resolve("/repo"),
      outputPath: path.resolve("/tmp/build-info.json"),
      help: false
    });
    expect(parseBuildInfoArgs(["--help"]).help).toBe(true);
    expect(() => parseBuildInfoArgs(["--bogus"])).toThrow("Unknown build-info option: --bogus");
  });

  it("writes build-info JSON through the CLI wrapper", async () => {
    const outputPath = path.join(createTempRoot(), "nested", "build-info.json");
    const { stdout } = await execFileAsync("node", [
      GENERATE_SCRIPT,
      "--root",
      process.cwd(),
      "--output",
      outputPath
    ]);
    const printed = JSON.parse(stdout) as BuildInfo;
    expect(printed.appName).toBe("skfiy");
    expect(printed.version).toBe("0.1.0");
    const written = JSON.parse(readFileSync(outputPath, "utf8")) as BuildInfo;
    expect(written.commitSha).toBe(printed.commitSha);
    expect(written.buildTimeIso).toBe(printed.buildTimeIso);
  });
});

describe("verify-build-provenance.mjs", () => {
  it("passes on matching commit, version, and clean tree", async () => {
    const { verifyBuildProvenance } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp();
    const report = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "0.1.0",
      requireCleanTree: true,
      rootDir: root
    });

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.buildInfo?.commitSha).toBe(COMMIT_SHA);
  });

  it("fails with missing-build-info when build-info.json is absent", async () => {
    const { verifyBuildProvenance, PROVENANCE_FAILURE } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp({ buildInfo: null });
    const report = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "0.1.0",
      rootDir: root
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.type).toBe(PROVENANCE_FAILURE.MISSING_BUILD_INFO);
    expect(report.buildInfo).toBeNull();
  });

  it("fails with malformed-build-info on invalid JSON", async () => {
    const { verifyBuildProvenance, PROVENANCE_FAILURE } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp({ buildInfo: "{not json" });
    const report = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "0.1.0",
      rootDir: root
    });

    expect(report.ok).toBe(false);
    expect(report.failures[0]?.type).toBe(PROVENANCE_FAILURE.MALFORMED_BUILD_INFO);
  });

  it("fails with unsupported-schema-version on schemaVersion mismatch", async () => {
    const { verifyBuildProvenance, PROVENANCE_FAILURE } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp({
      buildInfo: createFixtureBuildInfo({ schemaVersion: 99 })
    });
    const report = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "0.1.0",
      rootDir: root
    });

    expect(report.failures.some((f) => f.type === PROVENANCE_FAILURE.UNSUPPORTED_SCHEMA)).toBe(true);
  });

  it("fails with commit-mismatch — the anti-relabeling check", async () => {
    const { verifyBuildProvenance, PROVENANCE_FAILURE } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp();
    const report = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: "ffffffffffffffffffffffffffffffffffffffff",
      expectedVersion: "0.1.0",
      rootDir: root
    });

    expect(report.ok).toBe(false);
    const failure = report.failures.find((f) => f.type === PROVENANCE_FAILURE.COMMIT_MISMATCH);
    expect(failure).toBeDefined();
    expect(failure?.expected).toBe("ffffffffffffffffffffffffffffffffffffffff");
    expect(failure?.actual).toBe(COMMIT_SHA);
  });

  it("fails with version-mismatch when the embedded version differs from the tag", async () => {
    const { verifyBuildProvenance, PROVENANCE_FAILURE } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp();
    const report = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "9.9.9",
      rootDir: root
    });

    expect(report.failures.some((f) => f.type === PROVENANCE_FAILURE.VERSION_MISMATCH)).toBe(true);
  });

  it("fails with bundled-version-mismatch vs Resources/app/package.json", async () => {
    const { verifyBuildProvenance, PROVENANCE_FAILURE } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp({ bundledVersion: "8.8.8" });
    const report = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "0.1.0",
      rootDir: root
    });

    expect(report.failures.some((f) => f.type === PROVENANCE_FAILURE.BUNDLED_VERSION_MISMATCH)).toBe(true);
  });

  it("fails with root-version-mismatch vs root package.json", async () => {
    const { verifyBuildProvenance, PROVENANCE_FAILURE } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp({ rootVersion: "8.8.8" });
    const report = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "0.1.0",
      rootDir: root
    });

    expect(report.failures.some((f) => f.type === PROVENANCE_FAILURE.ROOT_VERSION_MISMATCH)).toBe(true);
  });

  it("fails with dirty-tree only when requireCleanTree is set", async () => {
    const { verifyBuildProvenance, PROVENANCE_FAILURE } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp({
      buildInfo: createFixtureBuildInfo({ treeStatus: "dirty" })
    });

    const lenient = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "0.1.0",
      rootDir: root
    });
    expect(lenient.ok).toBe(true);

    const strict = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "0.1.0",
      requireCleanTree: true,
      rootDir: root
    });
    expect(strict.failures.some((f) => f.type === PROVENANCE_FAILURE.DIRTY_TREE)).toBe(true);
  });

  it("fails with app-name-mismatch on a foreign build-info", async () => {
    const { verifyBuildProvenance, PROVENANCE_FAILURE } = await loadVerifyModule();
    const { root, appPath } = createFixtureApp({
      buildInfo: createFixtureBuildInfo({ appName: "other-app" })
    });
    const report = await verifyBuildProvenance({
      appPath,
      expectedCommitSha: COMMIT_SHA,
      expectedVersion: "0.1.0",
      rootDir: root
    });

    expect(report.failures.some((f) => f.type === PROVENANCE_FAILURE.APP_NAME_MISMATCH)).toBe(true);
  });

  it("CLI wrapper exits 0 and prints the JSON report on success", async () => {
    const { root, appPath } = createFixtureApp();
    const { stdout } = await execFileAsync("node", [
      VERIFY_SCRIPT,
      "--app",
      appPath,
      "--commit",
      COMMIT_SHA,
      "--version",
      "0.1.0",
      "--require-clean",
      "--root",
      root
    ]);
    const report = JSON.parse(stdout) as { ok: boolean; failures: unknown[] };
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("CLI wrapper exits 1 on a commit mismatch", async () => {
    const { root, appPath } = createFixtureApp();
    await expect(
      execFileAsync("node", [
        VERIFY_SCRIPT,
        "--app",
        appPath,
        "--commit",
        "ffffffffffffffffffffffffffffffffffffffff",
        "--version",
        "0.1.0",
        "--root",
        root
      ])
    ).rejects.toMatchObject({ code: 1 });
  });
});

describe("package-macos-app.mjs build-info embedding", () => {
  function createFixtureRepo(version = "7.7.7"): string {
    const root = createTempRoot();
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "skfiy", version }));

    const electronContents = path.join(root, "node_modules/electron/dist/Electron.app/Contents");
    mkdirSync(path.join(electronContents, "MacOS"), { recursive: true });
    mkdirSync(path.join(electronContents, "Resources"), { recursive: true });
    mkdirSync(path.join(electronContents, "Frameworks"), { recursive: true });
    writeFileSync(path.join(electronContents, "MacOS", "Electron"), "fake electron");
    writeFileSync(
      path.join(electronContents, "Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>\n'
    );

    mkdirSync(path.join(root, "dist/main"), { recursive: true });
    mkdirSync(path.join(root, "dist/renderer"), { recursive: true });
    mkdirSync(path.join(root, "dist/shared"), { recursive: true });
    writeFileSync(path.join(root, "dist/main/main.js"), "// main");
    writeFileSync(path.join(root, "dist/renderer/index.html"), "<html></html>");
    writeFileSync(path.join(root, "dist/shared/shared.js"), "// shared");
    writeFileSync(path.join(root, "dist/skfiy-helper"), "// helper");

    return root;
  }

  it("exposes buildInfoPath in the package plan", async () => {
    const { createPackagePlan } = await loadPackageModule();
    const plan = createPackagePlan({ rootDir: "/repo" });
    expect(plan.buildInfoPath).toBe(
      path.join("/repo", "dist", "skfiy.app", "Contents", "Resources", "build-info.json")
    );
  });

  it("embeds build-info.json whose version matches the fixture package.json", async () => {
    const { packageMacosApp } = await loadPackageModule();
    const root = createFixtureRepo("7.7.7");
    const calls: Array<{ command: string; args: string[] }> = [];
    let buildInfoPresentAtAdhocSign = false;

    await packageMacosApp({
      rootDir: root,
      io: {
        execFile: async (command: string, args: string[]) => {
          calls.push({ command, args });
          if (
            command === "codesign"
            && args.includes("--sign")
            && args[args.length - 1]?.endsWith("skfiy.app")
          ) {
            buildInfoPresentAtAdhocSign = existsSync(
              path.join(root, "dist/skfiy.app/Contents/Resources/build-info.json")
            );
          }
          return { stdout: "", stderr: "" };
        }
      }
    });

    const buildInfoPath = path.join(root, "dist/skfiy.app/Contents/Resources/build-info.json");
    expect(existsSync(buildInfoPath)).toBe(true);
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as BuildInfo;
    expect(buildInfo.version).toBe("7.7.7");
    expect(buildInfo.appName).toBe("skfiy");
    expect(buildInfo.schemaVersion).toBe(1);
    expect(typeof buildInfo.buildTimeIso).toBe("string");

    // Regression: adhoc signing still runs, and only AFTER embedding so the
    // signature covers build-info.json.
    const adhocSign = calls.find(
      (call) => call.command === "codesign"
        && call.args.includes("--sign")
        && call.args[call.args.length - 1]?.endsWith("skfiy.app")
    );
    expect(adhocSign).toBeDefined();
    expect(buildInfoPresentAtAdhocSign).toBe(true);
  });

  it("still packages without git (graceful provenance fallback)", async () => {
    const { packageMacosApp } = await loadPackageModule();
    const root = createFixtureRepo("0.0.1");
    await packageMacosApp({
      rootDir: root,
      io: {
        execFile: async () => ({ stdout: "", stderr: "" })
      }
    });

    const buildInfo = JSON.parse(
      readFileSync(path.join(root, "dist/skfiy.app/Contents/Resources/build-info.json"), "utf8")
    ) as BuildInfo;
    expect(buildInfo.version).toBe("0.0.1");
    expect(buildInfo.commitSha).toBe("unknown");
    expect(buildInfo.treeStatus).toBe("unknown");
    expect(buildInfo.builder).toBe("local");
  });
});
