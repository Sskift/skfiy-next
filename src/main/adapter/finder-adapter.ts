import type {
  AdapterContract,
  AdapterIntent,
  AdapterPermission
} from "../../shared/adapter-contract.js";
import type { RiskDecision } from "../../shared/types.js";
import {
  parseFinderOrganizationIntent,
  readFinderTaskRisk,
  runFinderOrganizationTask,
  type FinderDesktopClient,
  type FinderOrganizationTarget,
  type FinderTaskEvent,
  type FinderTaskOptions
} from "../orchestrator/finder-task.js";

export const FINDER_ADAPTER_ID = "finder" as const;
export const FINDER_TARGET_BUNDLE_ID = "com.apple.finder";

/** The ok-true Finder organization intent (command + resolved target). */
export type FinderOrganizationPlan = {
  command: string;
  target: FinderOrganizationTarget;
};

export type FinderAdapter = AdapterContract<
  string,
  FinderOrganizationPlan,
  FinderTaskEvent,
  FinderDesktopClient | undefined,
  FinderTaskOptions
>;

export function createFinderAdapter(): FinderAdapter {
  return {
    id: FINDER_ADAPTER_ID,
    displayName: "Finder",

    targetIdentity: {
      kind: "bundle_id",
      value: FINDER_TARGET_BUNDLE_ID
    },

    parseInput(input: string): AdapterIntent<FinderOrganizationPlan> {
      const parsed = parseFinderOrganizationIntent(input);
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
      }
      return {
        ok: true,
        command: parsed.command,
        plan: { command: parsed.command, target: parsed.target }
      };
    },

    matchesRoute(input: string): boolean {
      return parseFinderOrganizationIntent(input).ok;
    },

    capabilities: [
      "desktop_action_execute",
      "desktop_screenshot",
      "desktop_session_status",
      "finder_selection",
      "finder_item_layout"
    ],

    async readRequiredPermissions(
      _client: FinderDesktopClient | undefined
    ): Promise<AdapterPermission[]> {
      return [];
    },

    readRisk(input: string): RiskDecision {
      return readFinderTaskRisk(input);
    },

    approvalPolicy: {
      gates: ["action", "plan"]
    },

    planSchema: {
      schemaVersion: 1
    },

    async *run(
      input: string,
      client: FinderDesktopClient | undefined,
      options: FinderTaskOptions
    ): AsyncGenerator<FinderTaskEvent> {
      // The finder orchestrator receives its desktop client via options; the
      // contract surfaces it as a dedicated client parameter, so merge it in.
      const merged = client === undefined
        ? options
        : { ...options, desktopClient: client };
      yield* runFinderOrganizationTask(input, merged);
    },

    verificationStrategy: "filesystem_post_condition",

    stopBehavior: {
      supportsAbortSignal: false
    },

    blockerStages: [
      "input",
      "file_operation",
      "desktop_session",
      "activate",
      "observe",
      "selection",
      "layout",
      "drag"
    ]
  };
}
