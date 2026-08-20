/**
 * CLI Contract — the versioned envelope, typed error codes, and exit codes
 * for every skfiy CLI command.
 *
 * The CLI surface is a negotiation contract: external agents call
 * `skfiy commands` first, read `schemaVersion`, and refuse to proceed if the
 * major version is higher than they support. Per-payload versions
 * (diagnostic report, data export, task control, runtime snapshot, adapter
 * plan schemas) are versioned independently in their own modules.
 */

export const CLI_SURFACE_SCHEMA_VERSION = 1;
export const CLI_ENVELOPE_SCHEMA_VERSION = 1;

export const CliExitCode = {
  Ok: 0,
  RuntimeError: 1,
  UsageError: 2,
  SchemaVersionMismatch: 3
} as const;

export type CliExitCode = (typeof CliExitCode)[keyof typeof CliExitCode];

export type CliErrorCode =
  | "schema-version-mismatch"
  | "unknown-command"
  | "missing-app"
  | "app-not-running"
  | "invalid-bundle"
  | "adapter-not-found"
  | "file-not-found"
  | "internal";

export interface CliError {
  readonly code: CliErrorCode;
  readonly message: string;
  /** Always present: tells the agent exactly what to do next. */
  readonly action: string;
  readonly expected?: number;
  readonly actual?: number;
}

export interface CliOkEnvelope<T> {
  readonly schemaVersion: typeof CLI_ENVELOPE_SCHEMA_VERSION;
  readonly command: string;
  readonly generatedAt: string;
  readonly result: "ok";
  readonly data: T;
}

export interface CliErrorEnvelope {
  readonly schemaVersion: typeof CLI_ENVELOPE_SCHEMA_VERSION;
  readonly command: string;
  readonly generatedAt: string;
  readonly result: "error";
  readonly error: CliError;
}

export type CliEnvelope<T> = CliOkEnvelope<T> | CliErrorEnvelope;

export function createCliError(input: {
  code: CliErrorCode;
  message: string;
  action: string;
  expected?: number;
  actual?: number;
}): CliError {
  return {
    code: input.code,
    message: input.message,
    action: input.action,
    ...(input.expected !== undefined ? { expected: input.expected } : {}),
    ...(input.actual !== undefined ? { actual: input.actual } : {})
  };
}

/** Maps a typed error code to the process exit code. */
export function readExitCodeForError(code: CliErrorCode): CliExitCode {
  switch (code) {
    case "schema-version-mismatch":
      return CliExitCode.SchemaVersionMismatch;
    case "unknown-command":
      return CliExitCode.UsageError;
    default:
      return CliExitCode.RuntimeError;
  }
}
