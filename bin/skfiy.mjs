#!/usr/bin/env node
/**
 * skfiy CLI — thin shim.
 *
 * Resolves the built CLI surface (dist/cli/cli-command-surface.js) relative to
 * this file and delegates to runSkfiyCli. The shim stays intentionally dumb:
 * all parsing, dispatch, and envelope logic lives in src/cli/.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const binPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(binPath), "..");
const builtCliPath = path.join(repoRoot, "dist", "cli", "cli-command-surface.js");

if (!existsSync(builtCliPath)) {
  process.stderr.write(
    "skfiy CLI is not built yet. Run `npm run build:cli` from the skfiy repository, then retry.\n"
  );
  process.exitCode = 1;
} else {
  try {
    const cli = await import(pathToFileURL(builtCliPath).href);
    if (typeof cli.runSkfiyCli !== "function") {
      process.stderr.write(
        "skfiy CLI build is missing runSkfiyCli(). Rebuild with `npm run build:cli` and retry.\n"
      );
      process.exitCode = 1;
    } else {
      process.exitCode = await cli.runSkfiyCli({
        argv: process.argv.slice(2),
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin
      });
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
