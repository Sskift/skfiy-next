/**
 * CLI Provenance — the `skfiy provenance` command.
 *
 * Prints the build provenance embedded in the installed app
 * (Contents/Resources/build-info.json) plus the codesign identity, so users
 * can see who built and signed the app. Read-only: it only reads files and
 * runs `codesign -dv` (which itself never modifies the bundle).
 *
 * Dev builds have no embedded build-info: the command returns a typed
 * "provenance-unavailable" error instead of guessing.
 */

import { execFile as nodeExecFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createCliError, type CliError } from "./cli-contract.js";

const execFileAsync = promisify(nodeExecFile);

export const BUILD_INFO_RELATIVE_PATH = path.join(
  "Contents",
  "Resources",
  "build-info.json"
);

export interface EmbeddedBuildInfo {
  readonly schemaVersion: 1;
  readonly appName: string;
  readonly version: string;
  readonly commitSha: string;
  readonly commitShortSha: string;
  readonly treeStatus: string;
  readonly buildTimeIso: string;
  readonly nodeVersion: string;
  readonly electronVersion: string;
  readonly builder: string;
  readonly runner: string;
}

export interface CliSignatureProvenance {
  /** "signed" when codesign reports an identity, "unsigned" otherwise. */
  readonly state: "signed" | "unsigned";
  /** First Authority line from codesign -dv, e.g. "Developer ID Application: ...". */
  readonly identity: string | null;
  readonly teamIdentifier: string | null;
}

export interface CliProvenanceData {
  readonly appPath: string;
  readonly buildInfo: EmbeddedBuildInfo;
  readonly signature: CliSignatureProvenance;
}

export interface CliProvenanceDeps {
  readonly appPath: string;
  readonly exists: (targetPath: string) => boolean;
  readonly readFile: (targetPath: string) => string;
  readonly execFile?: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string }>;
}

export async function runProvenanceCommand(
  deps: CliProvenanceDeps
): Promise<{ ok: true; data: CliProvenanceData } | { ok: false; error: CliError }> {
  const buildInfoPath = path.join(deps.appPath, BUILD_INFO_RELATIVE_PATH);

  if (!deps.exists(buildInfoPath)) {
    return {
      ok: false,
      error: createCliError({
        code: "provenance-unavailable",
        message: `No embedded build-info at ${buildInfoPath}. Dev builds are unsigned and carry no provenance; install a release build.`,
        action: "Install a notarized release from the GitHub releases page, then retry."
      })
    };
  }

  let buildInfo: EmbeddedBuildInfo;
  try {
    const parsed = JSON.parse(deps.readFile(buildInfoPath)) as EmbeddedBuildInfo;
    if (parsed.schemaVersion !== 1 || parsed.appName !== "skfiy") {
      throw new Error("unsupported build-info schema");
    }
    buildInfo = parsed;
  } catch (error) {
    return {
      ok: false,
      error: createCliError({
        code: "provenance-unavailable",
        message: `Embedded build-info at ${buildInfoPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        action: "Reinstall the app from a notarized release; the bundle may be damaged."
      })
    };
  }

  const signature = await readSignatureProvenance(deps.appPath, deps.execFile);

  return {
    ok: true,
    data: {
      appPath: deps.appPath,
      buildInfo,
      signature
    }
  };
}

/**
 * Parses `codesign -dv --verbose=4` output. codesign writes to stderr, and
 * fails entirely on unsigned bundles — both are expected for dev builds.
 */
export function parseCodesignIdentity(output: string): {
  identity: string | null;
  teamIdentifier: string | null;
} {
  let identity: string | null = null;
  let teamIdentifier: string | null = null;

  for (const line of output.split("\n")) {
    const authorityMatch = /^Authority=(.+)$/.exec(line.trim());
    if (authorityMatch && identity === null) {
      identity = authorityMatch[1];
    }
    const teamMatch = /^TeamIdentifier=([^\s]+)$/.exec(line.trim());
    if (teamMatch && teamIdentifier === null) {
      teamIdentifier = teamMatch[1] === "not set" ? null : teamMatch[1];
    }
  }

  return { identity, teamIdentifier };
}

async function readSignatureProvenance(
  appPath: string,
  execFile: CliProvenanceDeps["execFile"]
): Promise<CliSignatureProvenance> {
  const run = execFile ?? defaultExecFile;
  try {
    const { stderr } = await run("codesign", ["-dv", "--verbose=4", appPath]);
    const { identity, teamIdentifier } = parseCodesignIdentity(stderr);
    if (!identity) {
      return { state: "unsigned", identity: null, teamIdentifier: null };
    }
    return { state: "signed", identity, teamIdentifier };
  } catch {
    return { state: "unsigned", identity: null, teamIdentifier: null };
  }
}

async function defaultExecFile(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args);
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}
