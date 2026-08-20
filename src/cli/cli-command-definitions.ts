/**
 * CLI Command Definitions — the versioned command surface.
 *
 * CRITICAL INVARIANT: every command declares `executesSystemMutation: false`.
 * The CLI never mutates the system. Mutation control (approve/stop) lives
 * only in the MCP server, and even there it can only act on approvals the
 * app itself raised. This is the "no hidden mutation primitives" acceptance
 * criterion encoded in the contract itself.
 */

import { CLI_SURFACE_SCHEMA_VERSION } from "./cli-contract.js";

export interface CliCommandDefinition {
  /** Command path, e.g. "restore preview" or "mcp serve". */
  readonly path: string;
  readonly summary: string;
  readonly jsonOutput: true;
  readonly plannedMutation: boolean;
  readonly executesSystemMutation: boolean;
  readonly outputShape: string;
}

export interface CliCommandSurface {
  readonly schemaVersion: typeof CLI_SURFACE_SCHEMA_VERSION;
  readonly commands: readonly CliCommandDefinition[];
}

export const CLI_COMMAND_DEFINITIONS: readonly CliCommandDefinition[] = [
  {
    path: "commands",
    summary: "Print the versioned CLI command surface. Call this first to negotiate schemaVersion.",
    jsonOutput: true,
    plannedMutation: false,
    executesSystemMutation: false,
    outputShape: "command-surface"
  },
  {
    path: "status",
    summary: "Live status: readiness, runtime snapshot, binaries, and task control when the app is running.",
    jsonOutput: true,
    plannedMutation: false,
    executesSystemMutation: false,
    outputShape: "status"
  },
  {
    path: "readiness",
    summary: "Compact readiness summary for supervisor loops: overall state, blocker count, next action.",
    jsonOutput: true,
    plannedMutation: false,
    executesSystemMutation: false,
    outputShape: "readiness"
  },
  {
    path: "doctor",
    summary: "Full diagnostic report with blockers, remediation actions, and redaction summary.",
    jsonOutput: true,
    plannedMutation: false,
    executesSystemMutation: false,
    outputShape: "diagnostic-report"
  },
  {
    path: "export",
    summary: "Build a redacted data export bundle for the requested domains.",
    jsonOutput: true,
    plannedMutation: false,
    executesSystemMutation: false,
    outputShape: "data-export-bundle"
  },
  {
    path: "restore preview",
    summary: "Validate an export bundle and preview its restore impact. Never applies.",
    jsonOutput: true,
    plannedMutation: false,
    executesSystemMutation: false,
    outputShape: "restore-preview"
  },
  {
    path: "capabilities",
    summary: "Adapter capability discovery: static declarative contracts, never the mutation surface.",
    jsonOutput: true,
    plannedMutation: false,
    executesSystemMutation: false,
    outputShape: "adapter-capabilities"
  },
  {
    path: "provenance",
    summary: "Embedded build provenance: commit, build time, and codesign identity of the installed app.",
    jsonOutput: true,
    plannedMutation: false,
    executesSystemMutation: false,
    outputShape: "provenance"
  },
  {
    path: "mcp serve",
    summary: "Run the skfiy MCP stdio server (status, observation, replay, approve, stop).",
    jsonOutput: true,
    plannedMutation: false,
    executesSystemMutation: false,
    outputShape: "mcp-server"
  }
];

export function createCliCommandSurface(): CliCommandSurface {
  return {
    schemaVersion: CLI_SURFACE_SCHEMA_VERSION,
    commands: CLI_COMMAND_DEFINITIONS.map((command) => ({ ...command }))
  };
}

export function findCliCommandDefinition(path: string): CliCommandDefinition | undefined {
  return CLI_COMMAND_DEFINITIONS.find((command) => command.path === path);
}
