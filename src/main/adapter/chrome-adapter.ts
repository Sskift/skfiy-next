import type {
  AdapterContract,
  AdapterIntent,
  AdapterPermission
} from "../../shared/adapter-contract.js";
import type { RiskDecision } from "../../shared/types.js";
import {
  parseChromePageIntent,
  readChromeTaskRisk,
  runChromePageTask,
  type ChromeTaskClient,
  type ChromeTaskEvent,
  type ChromeTaskOptions
} from "../orchestrator/chrome-task.js";

export const CHROME_ADAPTER_ID = "chrome" as const;
export const CHROME_TARGET_BUNDLE_ID = "com.google.Chrome";

/**
 * The ok-true Chrome page intent. `ChromePageIntent` itself is not exported by
 * the orchestrator, so we derive the plan type from the parser return type.
 */
export type ChromePagePlan = Extract<
  ReturnType<typeof parseChromePageIntent>,
  { ok: true }
>;

export type ChromeAdapter = AdapterContract<
  string,
  ChromePagePlan,
  ChromeTaskEvent,
  ChromeTaskClient | undefined,
  ChromeTaskOptions
>;

/** Normalized command string for a parsed Chrome page intent. */
export function readChromePlanCommand(intent: ChromePagePlan): string {
  if ("kind" in intent && intent.kind === "current_page") {
    return "Chrome current page";
  }
  return intent.url;
}

export function createChromeAdapter(): ChromeAdapter {
  return {
    id: CHROME_ADAPTER_ID,
    displayName: "Chrome",

    targetIdentity: {
      kind: "bundle_id",
      value: CHROME_TARGET_BUNDLE_ID
    },

    parseInput(input: string): AdapterIntent<ChromePagePlan> {
      const parsed = parseChromePageIntent(input);
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
      }
      return { ok: true, command: readChromePlanCommand(parsed), plan: parsed };
    },

    matchesRoute(input: string): boolean {
      return parseChromePageIntent(input).ok;
    },

    capabilities: [
      "cdp_command",
      "desktop_action_execute",
      "desktop_screenshot"
    ],

    async readRequiredPermissions(
      _client: ChromeTaskClient | undefined
    ): Promise<AdapterPermission[]> {
      return [];
    },

    readRisk(input: string): RiskDecision {
      return readChromeTaskRisk(input);
    },

    approvalPolicy: {
      gates: ["action", "submit"]
    },

    planSchema: {
      schemaVersion: 1
    },

    async *run(
      input: string,
      client: ChromeTaskClient | undefined,
      options: ChromeTaskOptions
    ): AsyncGenerator<ChromeTaskEvent> {
      yield* runChromePageTask(input, client, options);
    },

    verificationStrategy: "browser_page_identity",

    stopBehavior: {
      supportsAbortSignal: false
    },

    blockerStages: [
      "input",
      "connection",
      "navigation",
      "interaction",
      "extraction",
      "sensitive"
    ],

    smoke: {
      npmScript: "smoke:chrome",
      planModule: "scripts/smoke-chrome-plan.mjs",
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      evidenceClassifiers: [
        "classifyChromeSmokeEvidence",
        "classifyChromeFallbackSmokeEvidence",
        "classifyChromeCurrentPageSmokeEvidence",
        "classifyChromeBringYourOwnCurrentPageEvidence",
        "classifyChromeFallbackSwitchEvidence"
      ]
    }
  };
}
