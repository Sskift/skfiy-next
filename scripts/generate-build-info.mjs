#!/usr/bin/env node
/**
 * Build info generation — the source of build provenance.
 *
 * createBuildInfo() captures the identity of the live checkout at packaging
 * time: the exact commit, tree status, version (from root package.json, the
 * same source as bundled Resources/app/package.json and app.getVersion()),
 * Node/Electron versions, builder, and runner. The result is embedded inside
 * the app bundle at Contents/Resources/build-info.json by package-macos-app.mjs
 * and independently re-verified by verify-build-provenance.mjs in CI.
 *
 * Pure exported functions + thin CLI wrapper. All side effects (git, fs) go
 * through injectable io so tests run without git or a filesystem.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

export const BUILD_INFO_SCHEMA_VERSION = 1;
export const BUILD_INFO_APP_NAME = "skfiy";
export const BUILD_INFO_TREE_STATUS = Object.freeze({
  CLEAN: "clean",
  DIRTY: "dirty",
  UNKNOWN: "unknown"
});

export async function createBuildInfo({
  rootDir = DEFAULT_ROOT_DIR,
  env = process.env,
  now = () => new Date(),
  io
} = {}) {
  const resolvedIo = resolveBuildInfoIo(io);
  const version = await readRootVersion(rootDir, resolvedIo);
  const commitSha = await readCommitSha(rootDir, resolvedIo);
  const treeStatus = await readTreeStatus(rootDir, resolvedIo);
  const electronVersion = await readElectronVersion(rootDir, resolvedIo);
  const builder = env.GITHUB_ACTIONS === "true" ? "github-actions" : "local";
  const runner = readRunner(env);

  return {
    schemaVersion: BUILD_INFO_SCHEMA_VERSION,
    appName: BUILD_INFO_APP_NAME,
    version,
    commitSha,
    commitShortSha: commitSha.length >= 7 ? commitSha.slice(0, 7) : commitSha,
    treeStatus,
    buildTimeIso: now().toISOString(),
    nodeVersion: process.versions.node,
    electronVersion,
    builder,
    runner
  };
}

export async function readRootVersion(rootDir, io = resolveBuildInfoIo()) {
  try {
    const packageJson = JSON.parse(await io.readFile(path.join(rootDir, "package.json")));
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function readCommitSha(rootDir, io = resolveBuildInfoIo()) {
  try {
    const { stdout } = await io.execFile("git", ["rev-parse", "HEAD"], { cwd: rootDir });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "unknown";
  } catch {
    // Non-git source tarballs still package; provenance degrades to "unknown".
    return "unknown";
  }
}

export async function readTreeStatus(rootDir, io = resolveBuildInfoIo()) {
  try {
    const { stdout } = await io.execFile("git", ["status", "--porcelain"], { cwd: rootDir });
    return stdout.trim().length === 0
      ? BUILD_INFO_TREE_STATUS.CLEAN
      : BUILD_INFO_TREE_STATUS.DIRTY;
  } catch {
    return BUILD_INFO_TREE_STATUS.UNKNOWN;
  }
}

export async function readElectronVersion(rootDir, io = resolveBuildInfoIo()) {
  try {
    const packageJson = JSON.parse(
      await io.readFile(path.join(rootDir, "node_modules", "electron", "package.json"))
    );
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readRunner(env) {
  const explicit = typeof env.GITHUB_RUNNER === "string" ? env.GITHUB_RUNNER.trim() : "";
  if (explicit) {
    return explicit;
  }
  try {
    return os.release();
  } catch {
    return "unknown";
  }
}

/**
 * Normalizes the injectable io. Defaults touch the real filesystem and git;
 * tests pass fakes with the same shape:
 *   execFile(command, args, options) -> Promise<{stdout, stderr}>
 *   readFile(path) -> Promise<string>
 */
export function resolveBuildInfoIo(io) {
  return {
    execFile: io?.execFile ?? defaultExecFile,
    readFile: io?.readFile ?? defaultReadFile
  };
}

function defaultExecFile(command, args, options) {
  return execFileAsync(command, args, options);
}

function defaultReadFile(targetPath) {
  if (!existsSync(targetPath)) {
    throw new Error(`Missing file: ${targetPath}`);
  }
  return Buffer.from(readFileSync(targetPath)).toString("utf8");
}

export function parseBuildInfoArgs(argv) {
  const options = {
    rootDir: DEFAULT_ROOT_DIR,
    outputPath: undefined,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--root":
        options.rootDir = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--output":
        options.outputPath = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown build-info option: ${arg}`);
    }
  }

  return options;
}

export function createBuildInfoHelpText() {
  return `Usage: node scripts/generate-build-info.mjs [options]

Generates build provenance (commit, tree status, version, builder) for the
current checkout. Prints JSON to stdout; with --output also writes the file.

Options:
  --root <dir>     Repository root. Default: ${DEFAULT_ROOT_DIR}
  --output <path>  Write build-info JSON to this path.
  -h, --help       Show this help.
`;
}

export async function writeBuildInfo(outputPath, buildInfo, io = { mkdir, writeFile }) {
  await io.mkdir(path.dirname(outputPath), { recursive: true });
  await io.writeFile(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
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
    const options = parseBuildInfoArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(createBuildInfoHelpText());
    } else {
      const buildInfo = await createBuildInfo({ rootDir: options.rootDir });
      process.stdout.write(`${JSON.stringify(buildInfo, null, 2)}\n`);
      if (options.outputPath) {
        await writeBuildInfo(options.outputPath, buildInfo);
        process.stderr.write(`Wrote build info: ${options.outputPath}\n`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
