import type {
  AdapterContract,
  AdapterIntent,
  AdapterPermission
} from "../../shared/adapter-contract.js";
import type { RiskDecision } from "../../shared/types.js";
import {
  readTmuxSupervisionTaskRisk,
  runTmuxSupervisionTask,
  type TmuxSupervisionTaskClient,
  type TmuxSupervisionTaskEvent,
  type TmuxSupervisionTaskOptions
} from "../orchestrator/tmux-supervision-task.js";

export const TMUX_SUPERVISION_ADAPTER_ID = "tmux_supervision" as const;

/**
 * Extract the money-run tmux session name from a supervision request.
 * Moved from task-routing.ts so the tmux adapter owns its route-matching logic.
 */
export function readMoneyRunSupervisionSessionName(command: string): string | undefined {
  const normalized = command.trim().toLowerCase();

  if (!normalized.includes("money-run")) {
    return undefined;
  }

  const mentionsTmuxContext = /\btmux\b|\bsession\b|会话/u.test(normalized);
  const asksForSupervision = [
    "监督",
    "观察",
    "监控",
    "看着",
    "盯着",
    "supervise",
    "monitor",
    "watch",
    "observe"
  ].some((phrase) => normalized.includes(phrase));

  if (!mentionsTmuxContext || !asksForSupervision) {
    return undefined;
  }

  return command.match(/\b[A-Za-z0-9_.-]*money-run[A-Za-z0-9_.-]*\b/iu)?.[0] ?? "money-run";
}

export type TmuxSupervisionAdapterPlan = string;

export type TmuxSupervisionAdapter = AdapterContract<
  string,
  TmuxSupervisionAdapterPlan,
  TmuxSupervisionTaskEvent,
  TmuxSupervisionTaskClient,
  TmuxSupervisionTaskOptions
>;

export function createTmuxSupervisionAdapter(): TmuxSupervisionAdapter {
  return {
    id: TMUX_SUPERVISION_ADAPTER_ID,
    displayName: "tmux supervision",

    targetIdentity: {
      kind: "session_name",
      value: "money-run"
    },

    parseInput(input: string): AdapterIntent<string> {
      const sessionName = readMoneyRunSupervisionSessionName(input);
      if (!sessionName) {
        return {
          ok: false,
          reason: "tmux supervision requires a money-run tmux session name."
        };
      }
      return { ok: true, command: sessionName, plan: sessionName };
    },

    matchesRoute(input: string): boolean {
      return readMoneyRunSupervisionSessionName(input) !== undefined;
    },

    capabilities: [
      "tmux_observe"
    ],

    async readRequiredPermissions(
      _client: TmuxSupervisionTaskClient
    ): Promise<AdapterPermission[]> {
      return [];
    },

    readRisk(_input: string): RiskDecision {
      return readTmuxSupervisionTaskRisk();
    },

    approvalPolicy: {
      gates: ["action"]
    },

    planSchema: {
      schemaVersion: 0
    },

    async *run(
      input: string,
      client: TmuxSupervisionTaskClient,
      options: TmuxSupervisionTaskOptions
    ): AsyncGenerator<TmuxSupervisionTaskEvent> {
      const sessionName = readMoneyRunSupervisionSessionName(input);
      if (!sessionName) {
        yield {
          type: "verification_failed",
          stage: "tmux",
          reason: "Could not identify a money-run tmux session in the request."
        };
        return;
      }
      yield* runTmuxSupervisionTask(sessionName, client, options);
    },

    verificationStrategy: "supervision_report",

    stopBehavior: {
      supportsAbortSignal: false
    },

    blockerStages: [
      "tmux"
    ]
  };
}
