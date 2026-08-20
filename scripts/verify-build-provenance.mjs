#!/usr/bin/env node
/**
 * Build provenance verification — the release gate.
 *
 * Verifies that a packaged skfiy.app carries embedded build-info.json whose
 * commit and version match the checkout that produced it. This is the
 * anti-relabeling check that closes known-gap #4: the commit is captured from
 * the live checkout during the same build that produces the bundle, embedded
 * inside the signed bundle, and the release workflow independently re-derives
 * the expected commit from GITHUB_SHA. A pre-existing app built from another
 * commit carries its own embedded commit and fails this gate.
 *
 * Dry-run by default: always prints the JSON report and exits 1 on any
 * failure. --execute additionally writes the report to --json-output.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

export const BUILD_INFO_RELATIVE_PATH = path.join("Contents", "Resources", "build-info.json");
export const BUNDLED_APP_PACKAGE_JSON_RELATIVE_PATH = path.join(
  "Contents",
  "Resources",
  "app",
  "package.json"
);

export const PROVENANCE_FAILURE = Object.freeze({
  MISSING_BUILD_INFO: "missing-build-info",
  MALFORMED_BUILD_INFO: "malformed-build-info",
  UNSUPPORTED_SCHEMA: "unsupported-schema-version",
  COMMIT_MISMATCH: "commit-mismatch",
  VERSION_MISMATCH: "version-mismatch",
  BUNDLED_VERSION_MISMATCH: "bundled-version-mismatch",
  ROOT_VERSION_MISMATCH: "root-version-mismatch",
  DIRTY_TREE: "dirty-tree",
  APP_NAME_MISMATCH: "app-name-mismatch"
});

/**
 * @param {object} input
 * @param {string} input.appPath Path to skfiy.app
 * @param {string} input.expectedCommitSha Expected full commit SHA (GITHUB_SHA in CI)
 * @param {string} input.expectedVersion Expected version (tag with leading v stripped)
 * @param {boolean} [input.requireCleanTree] Fail unless treeStatus is "clean"
 * @param {string} [input.rootDir] Repository root for the root package.json cross-check
 * @param {{exists?: (p: string) => boolean, readFile?: (p: string) => string}} [input.io]
 * @returns {Promise<{ok: boolean, failures: Array<{type: string, message: string, expected?: string, actual?: string}>, buildInfo: object|null}>}
 */
export async function verifyBuildProvenance({
  appPath,
  expectedCommitSha,
  expectedVersion,
  requireCleanTree = false,
  rootDir = DEFAULT_ROOT_DIR,
  io
} = {}) {
  const resolvedIo = resolveProvenanceIo(io);
  const failures = [];
  const buildInfoPath = path.join(appPath, BUILD_INFO_RELATIVE_PATH);

  if (!resolvedIo.exists(buildInfoPath)) {
    return {
      ok: false,
      failures: [
        {
          type: PROVENANCE_FAILURE.MISSING_BUILD_INFO,
          message: `build-info.json is missing at ${buildInfoPath}. Was the app packaged with scripts/package-macos-app.mjs?`
        }
      ],
      buildInfo: null
    };
  }

  let buildInfo;
  try {
    buildInfo = JSON.parse(resolvedIo.readFile(buildInfoPath));
  } catch (error) {
    return {
      ok: false,
      failures: [
        {
          type: PROVENANCE_FAILURE.MALFORMED_BUILD_INFO,
          message: `build-info.json at ${buildInfoPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      buildInfo: null
    };
  }

  if (buildInfo.schemaVersion !== 1) {
    failures.push({
      type: PROVENANCE_FAILURE.UNSUPPORTED_SCHEMA,
      message: `build-info.json schemaVersion ${String(buildInfo.schemaVersion)} is not supported (expected 1).`,
      expected: "1",
      actual: String(buildInfo.schemaVersion)
    });
  }

  if (buildInfo.appName !== "skfiy") {
    failures.push({
      type: PROVENANCE_FAILURE.APP_NAME_MISMATCH,
      message: `build-info.json appName is ${JSON.stringify(buildInfo.appName)} (expected "skfiy").`,
      expected: "skfiy",
      actual: String(buildInfo.appName)
    });
  }

  if (buildInfo.commitSha !== expectedCommitSha) {
    failures.push({
      type: PROVENANCE_FAILURE.COMMIT_MISMATCH,
      message: `Embedded commit ${String(buildInfo.commitSha)} does not match expected ${expectedCommitSha}. The app was not built from this checkout.`,
      expected: expectedCommitSha,
      actual: String(buildInfo.commitSha)
    });
  }

  if (buildInfo.version !== expectedVersion) {
    failures.push({
      type: PROVENANCE_FAILURE.VERSION_MISMATCH,
      message: `Embedded version ${String(buildInfo.version)} does not match release version ${expectedVersion}.`,
      expected: expectedVersion,
      actual: String(buildInfo.version)
    });
  }

  const bundledVersion = readJsonVersion(
    resolvedIo,
    path.join(appPath, BUNDLED_APP_PACKAGE_JSON_RELATIVE_PATH)
  );
  if (bundledVersion !== undefined && bundledVersion !== buildInfo.version) {
    failures.push({
      type: PROVENANCE_FAILURE.BUNDLED_VERSION_MISMATCH,
      message: `Bundled Resources/app/package.json version ${bundledVersion} does not match embedded version ${String(buildInfo.version)}.`,
      expected: String(buildInfo.version),
      actual: bundledVersion
    });
  }

  const rootVersion = readJsonVersion(resolvedIo, path.join(rootDir, "package.json"));
  if (rootVersion !== undefined && rootVersion !== buildInfo.version) {
    failures.push({
      type: PROVENANCE_FAILURE.ROOT_VERSION_MISMATCH,
      message: `Root package.json version ${rootVersion} does not match embedded version ${String(buildInfo.version)}.`,
      expected: String(buildInfo.version),
      actual: rootVersion
    });
  }

  if (requireCleanTree && buildInfo.treeStatus !== "clean") {
    failures.push({
      type: PROVENANCE_FAILURE.DIRTY_TREE,
      message: `Release builds require a clean tree; embedded treeStatus is ${String(buildInfo.treeStatus)}.`,
      expected: "clean",
      actual: String(buildInfo.treeStatus)
    });
  }

  return {
    ok: failures.length === 0,
    failures,
    buildInfo
  };
}

function readJsonVersion(io, packageJsonPath) {
  try {
    const parsed = JSON.parse(io.readFile(packageJsonPath));
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function resolveProvenanceIo(io) {
  return {
    exists: io?.exists ?? defaultExists,
    readFile: io?.readFile ?? defaultReadFile
  };
}

function defaultExists(targetPath) {
  return existsSync(targetPath);
}

function defaultReadFile(targetPath) {
  if (!existsSync(targetPath)) {
    throw new Error(`Missing file: ${targetPath}`);
  }
  return Buffer.from(readFileSync(targetPath)).toString("utf8");
}

export function parseProvenanceArgs(argv) {
  const options = {
    appPath: undefined,
    expectedCommitSha: undefined,
    expectedVersion: undefined,
    requireCleanTree: false,
    rootDir: DEFAULT_ROOT_DIR,
    execute: false,
    jsonOutputPath: undefined,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--app":
        options.appPath = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--commit":
        options.expectedCommitSha = readRequiredValue(argv, index, arg);
        index += 1;
        break;
      case "--version":
        options.expectedVersion = readRequiredValue(argv, index, arg);
        index += 1;
        break;
      case "--root":
        options.rootDir = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--require-clean":
        options.requireCleanTree = true;
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--json-output":
        options.jsonOutputPath = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown provenance option: ${arg}`);
    }
  }

  return options;
}

export function createProvenanceHelpText() {
  return `Usage: node scripts/verify-build-provenance.mjs --app <path> --commit <sha> --version <v> [options]

Verifies that a packaged skfiy.app carries embedded build-info.json matching
the given commit and version. Exits 1 on any failure. Read-only by default;
--execute writes the JSON report to --json-output.

Options:
  --app <path>          Path to skfiy.app.
  --commit <sha>        Expected full commit SHA (GITHUB_SHA in CI).
  --version <version>   Expected version (tag with leading v stripped).
  --root <dir>          Repository root for the package.json cross-check.
  --require-clean       Fail unless the embedded treeStatus is "clean".
  --execute             Write the report to --json-output.
  --json-output <path>  Report output path (with --execute).
  -h, --help            Show this help.
`;
}

async function writeProvenanceReport(outputPath, report, io = { mkdir, writeFile }) {
  await io.mkdir(path.dirname(outputPath), { recursive: true });
  await io.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function readRequiredValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseProvenanceArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(createProvenanceHelpText());
    } else {
      if (!options.appPath || !options.expectedCommitSha || !options.expectedVersion) {
        throw new Error("--app, --commit, and --version are required.");
      }
      const report = await verifyBuildProvenance({
        appPath: options.appPath,
        expectedCommitSha: options.expectedCommitSha,
        expectedVersion: options.expectedVersion,
        requireCleanTree: options.requireCleanTree,
        rootDir: options.rootDir
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (options.execute && options.jsonOutputPath) {
        await writeProvenanceReport(options.jsonOutputPath, report);
      }
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
