/**
 * CLI Command Runner — argv parsing and command dispatch.
 *
 * Parsing follows the old repo's normalizeCliCommand pattern: global flags
 * (--json/--pretty/--home/--control-url/--control-token) are accepted
 * anywhere, the first one or two positional tokens select the command path
 * ("restore preview", "mcp serve" are two-word commands), and the remaining
 * tokens are command-specific flags.
 */

import { CLI_COMMAND_DEFINITIONS } from "./cli-command-definitions.js";

export interface CliFlags {
  readonly [key: string]: string | boolean;
}

export interface ParsedCliInvocation {
  readonly commandPath: string;
  readonly flags: CliFlags;
  readonly positionals: readonly string[];
}

/** Per-command flags that take a value. Everything else is boolean. */
const VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  export: ["domains", "out"],
  "restore preview": ["in"],
  capabilities: ["adapter"],
  "mcp serve": ["transport"],
  status: ["include-task-control"]
};

const GLOBAL_VALUE_FLAGS = new Set(["home", "control-url", "control-token"]);

export function parseCliArgs(
  argv: readonly string[]
):
  | { ok: true; invocation: ParsedCliInvocation }
  | { ok: false; message: string } {
  const flags: Record<string, string | boolean> = {};
  const tokens: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--pretty") {
      flags.pretty = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const eqIndex = withoutPrefix.indexOf("=");
      const name = eqIndex >= 0 ? withoutPrefix.slice(0, eqIndex) : withoutPrefix;
      const inlineValue = eqIndex >= 0 ? withoutPrefix.slice(eqIndex + 1) : undefined;

      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
        continue;
      }
      if (GLOBAL_VALUE_FLAGS.has(name) || isCommandValueFlag(tokens, name)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          return { ok: false, message: `--${name} requires a value.` };
        }
        flags[name] = value;
        index += 1;
        continue;
      }
      flags[name] = true;
      continue;
    }
    tokens.push(arg);
  }

  const commandPath = readCommandPath(tokens);
  if (!commandPath) {
    return {
      ok: false,
      message: tokens.length === 0
        ? "Missing command. Run `skfiy commands` to list the available commands."
        : `Unknown skfiy command: ${tokens.join(" ")}`
    };
  }

  const pathTokenCount = commandPath.split(" ").length;
  return {
    ok: true,
    invocation: {
      commandPath,
      flags,
      positionals: tokens.slice(pathTokenCount)
    }
  };
}

function isCommandValueFlag(tokens: readonly string[], flagName: string): boolean {
  const commandPath = readCommandPath(tokens);
  if (!commandPath) {
    return false;
  }
  return VALUE_FLAGS[commandPath]?.includes(flagName) ?? false;
}

function readCommandPath(tokens: readonly string[]): string | undefined {
  if (tokens.length >= 2) {
    const twoWord = `${tokens[0]} ${tokens[1]}`;
    if (CLI_COMMAND_DEFINITIONS.some((command) => command.path === twoWord)) {
      return twoWord;
    }
  }
  if (tokens.length >= 1) {
    const oneWord = tokens[0];
    if (CLI_COMMAND_DEFINITIONS.some((command) => command.path === oneWord)) {
      return oneWord;
    }
  }
  return undefined;
}

/** Reads a string flag value, or undefined when absent. */
export function readStringFlag(flags: CliFlags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Reads a boolean flag. */
export function readBooleanFlag(flags: CliFlags, name: string): boolean {
  return flags[name] === true;
}
