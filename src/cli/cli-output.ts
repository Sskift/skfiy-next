/**
 * CLI Output — envelope builders and JSON formatting. Every command, success
 * or error, emits the same envelope shape so agents can parse uniformly.
 */

import {
  CLI_ENVELOPE_SCHEMA_VERSION,
  type CliEnvelope,
  type CliError
} from "./cli-contract.js";

export function buildCliOkEnvelope<T>(
  command: string,
  data: T,
  now: () => Date = () => new Date()
): CliEnvelope<T> {
  return {
    schemaVersion: CLI_ENVELOPE_SCHEMA_VERSION,
    command,
    generatedAt: now().toISOString(),
    result: "ok",
    data
  };
}

export function buildCliErrorEnvelope(
  command: string,
  error: CliError,
  now: () => Date = () => new Date()
): CliEnvelope<never> {
  return {
    schemaVersion: CLI_ENVELOPE_SCHEMA_VERSION,
    command,
    generatedAt: now().toISOString(),
    result: "error",
    error
  };
}

/** Compact by default; --pretty indents two spaces. */
export function formatCliJson(value: unknown, pretty: boolean): string {
  return pretty ? `${JSON.stringify(value, null, 2)}\n` : `${JSON.stringify(value)}\n`;
}
