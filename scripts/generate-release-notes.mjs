#!/usr/bin/env node
/**
 * Release notes generation — deterministic markdown from git history.
 *
 * Pure exported functions (resolveTagRange, readCommitLog, groupCommits,
 * createReleaseNotes) + a thin CLI wrapper guarded by the import.meta.url
 * check. Output is deterministic given the same inputs (sorted sections, no
 * timestamps beyond buildTimeIso from the embedded build-info), so the
 * generator is unit-testable.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const REPOSITORY_URL = "https://github.com/Sskift/skfiy-next";

export const RELEASE_NOTE_SECTIONS = Object.freeze([
  { heading: "Features", prefixes: ["feat"] },
  { heading: "Fixes", prefixes: ["fix"] },
  { heading: "Refactors", prefixes: ["refactor"] },
  { heading: "Tests", prefixes: ["test"] },
  { heading: "Docs", prefixes: ["docs"] },
  { heading: "Other", prefixes: [] }
]);

const MERGE_COMMIT_PATTERN = /^merge(\(|:|\s)/i;
const VERSION_BUMP_PATTERN = /^(release:|chore\(release\):|v?\d+\.\d+\.\d+\s*$|version bump)/i;
const CONVENTIONAL_SUBJECT_PATTERN = /^(\w+)(?:\([^)]*\))?!?:\s/;

export const DEFAULT_UPGRADE_NOTES = Object.freeze([
  "First launch: notarized releases open with a double-click and Gatekeeper shows the Developer ID identity. Unsigned dev builds require right-click > Open once.",
  "Your data survives upgrades: sessions, memory, and profiles live in ~/Library/Application Support/skfiy, keyed by the stable bundle identifier com.sskift.skfiy.",
  "Chrome native messaging keeps working across upgrades: the native-host manifest path and the CLI shim path inside the app bundle are stable, and the app regenerates the manifest if extension IDs change."
]);

/**
 * Resolves the commit range for a release tag. When `from` is omitted, asks
 * git for the previous tag (`git describe --tags --abbrev=0 <to>^`). When no
 * previous tag exists (first release), falls back to the full commit list.
 */
export async function resolveTagRange({ from, to, rootDir = DEFAULT_ROOT_DIR, io } = {}) {
  const resolvedIo = resolveNotesIo(io);

  if (from) {
    return { from, to, isFirstRelease: false };
  }

  try {
    const { stdout } = await resolvedIo.execFile(
      "git",
      ["describe", "--tags", "--abbrev=0", `${to}^`],
      { cwd: rootDir }
    );
    const previousTag = stdout.trim();
    if (!previousTag) {
      throw new Error("git describe returned an empty tag");
    }
    return { from: previousTag, to, isFirstRelease: false };
  } catch {
    return { from: undefined, to, isFirstRelease: true };
  }
}

/**
 * Reads the commit log for a range. Without `from`, reads the full history
 * reachable from `to` (first release).
 */
export async function readCommitLog({ from, to, rootDir = DEFAULT_ROOT_DIR, io } = {}) {
  const resolvedIo = resolveNotesIo(io);
  const range = from ? `${from}..${to}` : to;
  const { stdout } = await resolvedIo.execFile(
    "git",
    ["log", "--format=%H%x09%s", range],
    { cwd: rootDir }
  );

  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const tabIndex = line.indexOf("\t");
      const sha = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
      const subject = tabIndex >= 0 ? line.slice(tabIndex + 1) : "";
      return { sha, shortSha: sha.slice(0, 7), subject };
    });
}

/**
 * Groups parsed commits into conventional-commit sections. Merge commits and
 * version-bump commits are filtered. Unknown prefixes land in "Other".
 */
export function groupCommits(commits) {
  const buckets = new Map(RELEASE_NOTE_SECTIONS.map((section) => [section.heading, []]));

  for (const commit of commits) {
    if (isFilteredCommit(commit.subject)) {
      continue;
    }
    const heading = headingForSubject(commit.subject);
    buckets.get(heading)?.push(commit);
  }

  return RELEASE_NOTE_SECTIONS
    .map((section) => ({ heading: section.heading, commits: buckets.get(section.heading) ?? [] }))
    .filter((section) => section.commits.length > 0);
}

function isFilteredCommit(subject) {
  return MERGE_COMMIT_PATTERN.test(subject) || VERSION_BUMP_PATTERN.test(subject);
}

function headingForSubject(subject) {
  const match = CONVENTIONAL_SUBJECT_PATTERN.exec(subject);
  const prefix = match ? match[1].toLowerCase() : "";
  const section = RELEASE_NOTE_SECTIONS.find(
    (candidate) => candidate.prefixes.includes(prefix)
  );
  return section ? section.heading : "Other";
}

/**
 * Renders the release notes markdown. Deterministic: the only timestamp is
 * buildTimeIso, supplied by the caller from the embedded build-info.
 */
export function createReleaseNotes({
  version,
  tagName,
  commitSha,
  buildTimeIso,
  electronVersion,
  checksums,
  commits,
  upgradeNotes = DEFAULT_UPGRADE_NOTES
}) {
  const sections = groupCommits(commits);
  const lines = [`# skfiy ${version}`, ""];

  for (const section of sections) {
    lines.push(`## ${section.heading}`, "");
    for (const commit of section.commits) {
      lines.push(`- \`${commit.shortSha}\` ${commit.subject}`);
    }
    lines.push("");
  }

  lines.push("## Upgrade notes", "");
  for (const note of upgradeNotes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  lines.push("## Build provenance", "");
  lines.push(`- Version: ${version}`);
  if (commitSha) {
    lines.push(`- Commit: [\`${commitSha.slice(0, 7)}\`](${REPOSITORY_URL}/commit/${commitSha})`);
  }
  if (buildTimeIso) {
    lines.push(`- Build time: ${buildTimeIso}`);
  }
  if (electronVersion) {
    lines.push(`- Electron: ${electronVersion}`);
  }
  const checksum = parseChecksumLine(checksums);
  if (checksum) {
    lines.push(`- SHA256 (${checksum.file}): \`${checksum.hash}\``);
  }
  lines.push("");

  lines.push(
    "## Install",
    "",
    `1. Download \`skfiy-macos-${version}.zip\` from the [${tagName} release](${REPOSITORY_URL}/releases/tag/${tagName}).`,
    "2. Unzip and drag `skfiy.app` to `/Applications`.",
    "3. First open: double-click the app. Gatekeeper shows the Developer ID identity for notarized releases; unsigned dev builds require right-click > Open once.",
    ""
  );

  return lines.join("\n");
}

function parseChecksumLine(checksums) {
  if (typeof checksums !== "string" || checksums.trim().length === 0) {
    return undefined;
  }
  for (const line of checksums.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) {
      return { hash: match[1], file: path.basename(match[2]) };
    }
  }
  return undefined;
}

export function resolveNotesIo(io) {
  return {
    execFile: io?.execFile ?? defaultExecFile
  };
}

function defaultExecFile(command, args, options) {
  return execFileAsync(command, args, options);
}

export function parseReleaseNotesArgs(argv) {
  const options = {
    to: undefined,
    from: undefined,
    buildInfoPath: undefined,
    checksumsPath: undefined,
    outputPath: undefined,
    rootDir: DEFAULT_ROOT_DIR,
    execute: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--to":
        options.to = readRequiredValue(argv, index, arg);
        index += 1;
        break;
      case "--from":
        options.from = readRequiredValue(argv, index, arg);
        index += 1;
        break;
      case "--build-info":
        options.buildInfoPath = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--checksums":
        options.checksumsPath = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--output":
        options.outputPath = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--root":
        options.rootDir = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown release-notes option: ${arg}`);
    }
  }

  return options;
}

export function createReleaseNotesHelpText() {
  return `Usage: node scripts/generate-release-notes.mjs --to <tag> [options]

Generates deterministic release notes from git history plus the embedded
build-info. Dry-run prints markdown to stdout; --execute writes --output.

Options:
  --to <tag>            Release tag (e.g. v0.1.0).
  --from <tag>          Previous tag. Default: git describe of <to>^.
  --build-info <path>   Embedded build-info.json for the provenance footer.
  --checksums <path>    SHA256SUMS file for the artifact checksum line.
  --output <path>       Notes output path (with --execute).
  --root <dir>          Repository root for git history.
  --execute             Write the notes file. Without this, read-only.
  -h, --help            Show this help.
`;
}

function readOptionalFile(targetPath) {
  try {
    if (!existsSync(targetPath)) {
      return undefined;
    }
    return Buffer.from(readFileSync(targetPath)).toString("utf8");
  } catch {
    return undefined;
  }
}

async function writeNotes(outputPath, notes, io = { mkdir, writeFile }) {
  await io.mkdir(path.dirname(outputPath), { recursive: true });
  await io.writeFile(outputPath, notes);
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
    const options = parseReleaseNotesArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(createReleaseNotesHelpText());
    } else {
      if (!options.to) {
        throw new Error("--to <tag> is required.");
      }
      if (options.execute && !options.outputPath) {
        throw new Error("--execute requires --output <path>.");
      }
      const range = await resolveTagRange({
        from: options.from,
        to: options.to,
        rootDir: options.rootDir
      });
      const commits = await readCommitLog({
        from: range.from,
        to: range.to,
        rootDir: options.rootDir
      });
      const buildInfoRaw = options.buildInfoPath
        ? readOptionalFile(options.buildInfoPath)
        : undefined;
      const buildInfo = buildInfoRaw ? JSON.parse(buildInfoRaw) : {};
      const checksums = options.checksumsPath
        ? readOptionalFile(options.checksumsPath)
        : undefined;
      const version = typeof buildInfo.version === "string"
        ? buildInfo.version
        : options.to.replace(/^v/, "");
      const notes = createReleaseNotes({
        version,
        tagName: options.to,
        commitSha: typeof buildInfo.commitSha === "string" ? buildInfo.commitSha : undefined,
        buildTimeIso: typeof buildInfo.buildTimeIso === "string" ? buildInfo.buildTimeIso : undefined,
        electronVersion: typeof buildInfo.electronVersion === "string"
          ? buildInfo.electronVersion
          : undefined,
        checksums,
        commits
      });
      if (options.execute) {
        await writeNotes(options.outputPath, notes);
        process.stdout.write(`Wrote release notes: ${options.outputPath}\n`);
      } else {
        process.stdout.write(notes);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
