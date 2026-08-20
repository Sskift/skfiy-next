import type {
  AdapterContract,
  AdapterIntent,
  AdapterPermission
} from "../../shared/adapter-contract.js";
import type { RiskDecision } from "../../shared/types.js";
import { parseTerminalIntent } from "../../shared/terminal-intent.js";
import {
  readGhosttyTaskRisk,
  runGhosttyCommandTask,
  type DesktopClient,
  type GhosttyTaskOptions
} from "../orchestrator/ghostty-task.js";
import type { GhosttyTaskEvent } from "../orchestrator/events.js";

export const GHOSTTY_ADAPTER_ID = "ghostty" as const;
export const GHOSTTY_TARGET_BUNDLE_ID = "com.mitchellh.ghostty";

const GHOSTTY_REQUIRED_PERMISSIONS = [
  { kind: "screenRecording", label: "Screen Recording" },
  { kind: "accessibility", label: "Accessibility" }
] as const;

/**
 * Whether the request explicitly names a terminal target. Moved from
 * task-routing.ts so the ghostty adapter owns its route-matching logic.
 */
export function isExplicitTerminalControlRequest(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  return /\b(ghostty|terminal|shell|term)\b|终端|命令行/u.test(normalized);
}

export type GhosttyAdapterPlan = string;

export type GhosttyAdapter = AdapterContract<
  string,
  GhosttyAdapterPlan,
  GhosttyTaskEvent,
  DesktopClient,
  GhosttyTaskOptions
>;

export function createGhosttyAdapter(): GhosttyAdapter {
  return {
    id: GHOSTTY_ADAPTER_ID,
    displayName: "Ghostty",

    targetIdentity: {
      kind: "bundle_id",
      value: GHOSTTY_TARGET_BUNDLE_ID
    },

    parseInput(input: string): AdapterIntent<string> {
      const parsed = parseTerminalIntent(input);
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
      }
      return { ok: true, command: parsed.command, plan: parsed.command };
    },

    matchesRoute(input: string): boolean {
      return parseTerminalIntent(input).ok && isExplicitTerminalControlRequest(input);
    },

    capabilities: [
      "desktop_action_execute",
      "desktop_screenshot",
      "desktop_ocr",
      "desktop_session_status",
      "desktop_permissions",
      "app_list"
    ],

    async readRequiredPermissions(client: DesktopClient): Promise<AdapterPermission[]> {
      if (!client.getPermissions) {
        return [];
      }
      const permissions = await client.getPermissions();
      return GHOSTTY_REQUIRED_PERMISSIONS.map(({ kind, label }) => ({
        kind,
        state: permissions[kind].state,
        label
      }));
    },

    readRisk(input: string): RiskDecision {
      return readGhosttyTaskRisk(input);
    },

    approvalPolicy: {
      gates: ["action"]
    },

    planSchema: {
      schemaVersion: 1
    },

    async *run(
      input: string,
      client: DesktopClient,
      options: GhosttyTaskOptions
    ): AsyncGenerator<GhosttyTaskEvent> {
      yield* runGhosttyCommandTask(client, input, options);
    },

    verificationStrategy: "terminal_completion_marker",

    stopBehavior: {
      supportsAbortSignal: true
    },

    blockerStages: [
      "permissions",
      "desktop_session",
      "activate",
      "initialize",
      "before",
      "after"
    ],

    smoke: {
      npmScript: "smoke:cli",
      planModule: "scripts/smoke-cli-plan.mjs",
      productPath:
        "dist/main -> assistant-agent + session-memory + browser-page-context + personal-memory + personal-skills + working-profile contracts",
      evidenceClassifiers: ["classifyCliSmokeEvidence"]
    }
  };
}
