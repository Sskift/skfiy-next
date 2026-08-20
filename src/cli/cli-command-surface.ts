/**
 * CLI Command Surface — the entry point for the skfiy CLI.
 *
 * bin/skfiy.mjs is a thin shim that imports this module and calls
 * runSkfiyCli with process argv/stdout/stderr. The surface parses global
 * flags, dispatches to the command handlers, writes the JSON envelope, and
 * returns the process exit code.
 *
 * Every command emits the same envelope shape. Every command declares
 * executesSystemMutation=false — the CLI never mutates the system.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliExitCode,
  createCliError,
  readExitCodeForError,
  type CliEnvelope,
  type CliError
} from "./cli-contract.js";
import { createCliCommandSurface } from "./cli-command-definitions.js";
import {
  parseCliArgs,
  readStringFlag,
  readBooleanFlag
} from "./cli-command-runner.js";
import { buildCliErrorEnvelope, buildCliOkEnvelope, formatCliJson } from "./cli-output.js";
import { runCapabilitiesCommand } from "./cli-capabilities.js";
import {
  runStatusCommand,
  runReadinessCommand,
  type CliStatusDeps
} from "./cli-status.js";
import {
  createFileDiagnosticReportSources,
  runDoctorCommand,
  type CliDiagnosticDeps
} from "./cli-diagnostic.js";
import {
  createDefaultCliExportDeps,
  createSkfiyApplicationSupportPath,
  parseExportDomains,
  runExportCommand,
  runRestorePreviewCommand,
  type CliExportDeps
} from "./cli-export.js";
import { runMcpServeCommand } from "./cli-mcp.js";
import {
  createLoopbackControlClientFromHome,
  type ControlClient
} from "./control-client.js";

export interface RunSkfiyCliOptions {
  readonly argv: readonly string[];
  readonly stdout: { write: (chunk: string) => unknown };
  readonly stderr: { write: (chunk: string) => unknown };
  readonly stdin?: Parameters<typeof runMcpServeCommand>[0]["stdin"];
  readonly homeDir?: string;
  readonly appVersion?: string;
  readonly now?: () => Date;
  readonly exists?: (targetPath: string) => boolean;
  readonly readFile?: (targetPath: string) => string;
  readonly writeFile?: (targetPath: string, content: string) => void;
  readonly mkdir?: (targetPath: string) => void;
  readonly controlClient?: ControlClient | null;
  readonly fetchImpl?: typeof fetch;
  readonly appPath?: string;
  readonly helperPath?: string | null;
  readonly cliShimPath?: string;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");

function readAppVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    ) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function runSkfiyCli(options: RunSkfiyCliOptions): Promise<number> {
  const now = options.now ?? (() => new Date());
  const parsed = parseCliArgs(options.argv);
  const globalFlags = parsed.ok ? parsed.invocation.flags : {};
  const homeDir = readStringFlag(globalFlags, "home")
    ?? options.homeDir
    ?? os.homedir();
  const appSupportDir = createSkfiyApplicationSupportPath(homeDir);
  const appVersion = options.appVersion ?? readAppVersion();
  const exists = options.exists ?? ((targetPath: string) => fs.existsSync(targetPath));
  const readFile = options.readFile ?? ((targetPath: string) => fs.readFileSync(targetPath, "utf8"));
  const writeFile = options.writeFile ?? ((targetPath: string, content: string) => {
    fs.writeFileSync(targetPath, content, "utf8");
  });
  const mkdir = options.mkdir ?? ((targetPath: string) => {
    fs.mkdirSync(targetPath, { recursive: true });
  });
  const appPath = options.appPath ?? "/Applications/skfiy.app";
  const helperPath = options.helperPath === undefined
    ? path.join(REPO_ROOT, "dist", "skfiy-helper")
    : options.helperPath;
  const cliShimPath = options.cliShimPath ?? path.join(REPO_ROOT, "bin", "skfiy.mjs");

  const controlClient = options.controlClient === undefined
    ? createLoopbackControlClientFromHome(appSupportDir, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
      })
    : options.controlClient;

  if (!parsed.ok) {
    return writeError(
      options.stdout,
      "unknown",
      createCliError({
        code: "unknown-command",
        message: parsed.message,
        action: "Run `skfiy commands` to list the available commands."
      }),
      now,
      readBooleanFlag(globalFlags, "pretty")
    );
  }

  const { commandPath, flags } = parsed.invocation;
  const pretty = readBooleanFlag(flags, "pretty");

  try {
    if (commandPath === "mcp serve") {
      // The process becomes the MCP server; no JSON envelope.
      return runMcpServeCommand({
        homeDir,
        appSupportDir,
        appVersion,
        stdin: options.stdin ?? process.stdin,
        stdout: options.stdout,
        stderr: options.stderr,
        exists,
        readFile,
        ...(controlClient !== null ? { controlClient } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
      });
    }

    const envelope = await dispatchCommand({
      commandPath,
      flags,
      deps: {
        homeDir,
        appSupportDir,
        appVersion,
        now,
        exists,
        readFile,
        writeFile,
        mkdir,
        controlClient,
        appPath,
        helperPath,
        cliShimPath
      }
    });

    options.stdout.write(formatCliJson(envelope, pretty));
    return envelope.result === "ok"
      ? CliExitCode.Ok
      : readExitCodeForError(envelope.error.code);
  } catch (error) {
    return writeError(
      options.stdout,
      commandPath,
      createCliError({
        code: "internal",
        message: error instanceof Error ? error.message : String(error),
        action: "Report this error with the command that triggered it."
      }),
      now,
      pretty
    );
  }
}

async function dispatchCommand(input: {
  commandPath: string;
  flags: Record<string, string | boolean>;
  deps: CliSurfaceDeps;
}): Promise<CliEnvelope<unknown>> {
  const { commandPath, flags, deps } = input;
  const now = deps.now;

  switch (commandPath) {
    case "commands":
      return buildCliOkEnvelope(
        commandPath,
        { surface: createCliCommandSurface() },
        now
      );

    case "status": {
      const data = await runStatusCommand(createStatusDeps(deps));
      return buildCliOkEnvelope(commandPath, data, now);
    }

    case "readiness": {
      const data = await runReadinessCommand(createStatusDeps(deps));
      return buildCliOkEnvelope(commandPath, data, now);
    }

    case "doctor": {
      const diagnosticDeps: CliDiagnosticDeps = {
        homeDir: deps.homeDir,
        appVersion: deps.appVersion,
        helperPath: deps.helperPath,
        cliShimPath: deps.cliShimPath,
        exists: deps.exists
      };
      const report = await runDoctorCommand(
        createFileDiagnosticReportSources(diagnosticDeps)
      );
      return buildCliOkEnvelope(commandPath, report, now);
    }

    case "export": {
      const domainsValue = readStringFlag(flags, "domains");
      const domains = parseExportDomains(domainsValue);
      if (!Array.isArray(domains)) {
        return buildCliErrorEnvelope(commandPath, domains as CliError, now);
      }
      const outPath = readStringFlag(flags, "out");
      const result = runExportCommand({
        domains,
        ...(outPath ? { outPath } : {}),
        deps: createExportDeps(deps)
      });
      return result.ok
        ? buildCliOkEnvelope(commandPath, result.data, now)
        : buildCliErrorEnvelope(commandPath, result.error, now);
    }

    case "restore preview": {
      const inputPath = readStringFlag(flags, "in");
      if (!inputPath) {
        return buildCliErrorEnvelope(
          commandPath,
          createCliError({
            code: "unknown-command",
            message: "restore preview requires --in <file>.",
            action: "Provide the path to a skfiy data export bundle."
          }),
          now
        );
      }
      const result = runRestorePreviewCommand({
        inputPath,
        deps: createExportDeps(deps)
      });
      return result.ok
        ? buildCliOkEnvelope(commandPath, result.data, now)
        : buildCliErrorEnvelope(commandPath, result.error, now);
    }

    case "capabilities": {
      const adapterId = readStringFlag(flags, "adapter");
      const result = runCapabilitiesCommand({
        ...(adapterId ? { adapterId } : {})
      });
      return result.ok
        ? buildCliOkEnvelope(commandPath, result.data, now)
        : buildCliErrorEnvelope(commandPath, result.error, now);
    }

    default:
      return buildCliErrorEnvelope(
        commandPath,
        createCliError({
          code: "unknown-command",
          message: `Unknown skfiy command: ${commandPath}`,
          action: "Run `skfiy commands` to list the available commands."
        }),
        now
      );
  }
}

interface CliSurfaceDeps {
  homeDir: string;
  appSupportDir: string;
  appVersion: string;
  now: () => Date;
  exists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string;
  writeFile: (targetPath: string, content: string) => void;
  mkdir: (targetPath: string) => void;
  controlClient: ControlClient | null;
  appPath: string;
  helperPath: string | null;
  cliShimPath: string;
}

function createStatusDeps(deps: CliSurfaceDeps): CliStatusDeps {
  return {
    homeDir: deps.homeDir,
    appVersion: deps.appVersion,
    appPath: deps.appPath,
    helperPath: deps.helperPath,
    cliShimPath: deps.cliShimPath,
    exists: deps.exists,
    readFile: deps.readFile,
    controlClient: deps.controlClient
  };
}

function createExportDeps(deps: CliSurfaceDeps): CliExportDeps {
  return {
    homeDir: deps.homeDir,
    appSupportDir: deps.appSupportDir,
    appVersion: deps.appVersion,
    exists: deps.exists,
    readFile: deps.readFile,
    writeFile: deps.writeFile,
    mkdir: deps.mkdir,
    ...(deps.now ? { now: deps.now } : {})
  };
}

function writeError(
  stdout: { write: (chunk: string) => unknown },
  commandPath: string,
  error: CliError,
  now: () => Date,
  pretty: boolean
): number {
  stdout.write(formatCliJson(buildCliErrorEnvelope(commandPath, error, now), pretty));
  return readExitCodeForError(error.code);
}
