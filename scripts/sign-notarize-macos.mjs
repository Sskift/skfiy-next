#!/usr/bin/env node
/**
 * macOS release CLI — checks or executes Developer ID signing and Apple
 * notarization for the packaged skfiy.app.
 *
 * Safety posture (restored from the old repo): read-only by default. The
 * script prints a JSON readiness report plus the planned commands with
 * secrets redacted (the arg after --password is masked). Only --execute
 * runs anything, and even then it refuses when credentials for the
 * requested actions are missing.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  createDefaultMacReleaseOptions,
  createHelpText,
  createMacReleaseReadinessReport,
  createMacReleaseSteps,
  parseMacReleaseArgs
} from "./sign-notarize-macos-plan.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

export async function runMacReleaseCli({
  rootDir = DEFAULT_ROOT_DIR,
  argv = process.argv.slice(2),
  env = process.env,
  io = createDefaultIo()
} = {}) {
  const defaults = createDefaultMacReleaseOptions({ rootDir, env });
  const options = parseMacReleaseArgs(argv, defaults);

  if (options.help) {
    io.write(createHelpText(defaults));
    return { status: "help" };
  }

  const readiness = createMacReleaseReadinessReport(options);
  const steps = createMacReleaseSteps(options);
  const report = {
    status: "checked",
    dryRun: options.dryRun,
    sign: options.sign,
    notarize: options.notarize,
    jsonOutputPath: options.jsonOutputPath,
    plan: options.plan,
    readiness,
    steps: steps.map((step) => ({
      name: step.name,
      command: redactCommand(step.command)
    }))
  };

  io.write(`${JSON.stringify(report, null, 2)}\n`);

  if (options.dryRun) {
    await writeJsonOutput(options, report, io);
    return report;
  }

  const missing = missingForRequestedActions(options, readiness);
  if (missing.length > 0) {
    throw new Error(`macOS release credentials are incomplete: ${missing.join(", ")}`);
  }

  if ((options.sign || options.notarize) && !io.exists(options.plan.appPath)) {
    throw new Error(`App bundle is missing at ${options.plan.appPath}. Run npm run build first.`);
  }

  await io.mkdir(options.plan.outputDir, { recursive: true });
  for (const step of steps) {
    await io.execFile(step.command.command, step.command.args);
  }

  const executedReport = {
    ...report,
    status: "executed"
  };
  await writeJsonOutput(options, executedReport, io);

  return executedReport;
}

function missingForRequestedActions(options, readiness) {
  if (options.notarize) {
    return readiness.missing;
  }

  if (options.sign) {
    return readiness.signing.missing;
  }

  return [];
}

export function redactCommand(command) {
  const args = command.args.map((arg, index, args) => {
    if (args[index - 1] === "--password") {
      return "<redacted>";
    }
    return arg;
  });

  return {
    command: command.command,
    args
  };
}

async function writeJsonOutput(options, report, io) {
  if (typeof options.jsonOutputPath !== "string") {
    return;
  }

  await io.mkdir(path.dirname(options.jsonOutputPath), { recursive: true });
  await io.writeText(options.jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function createDefaultIo() {
  return {
    exists: existsSync,
    mkdir,
    execFile: execFileAsync,
    writeText: writeFile,
    write: (message) => process.stdout.write(message)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runMacReleaseCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
