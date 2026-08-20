/**
 * Multi-step Chrome workflow orchestration with page-state recovery.
 *
 * Runs a bounded, value-free workflow plan against Chrome over CDP. Every
 * mutating step is followed by a page-state classification: navigations and
 * reloads re-bind the workflow and continue, new tabs and auth walls block,
 * and downloads are reported as informational events. Fill values are bound
 * at execution time and never appear in events or previews.
 */

import {
  buildCdpCommand,
  type BrowserPageIdentity
} from "../computer-use/browser-control.js";
import {
  formatChromeVerifyExpected,
  readChromeDomVerificationResult,
  type ChromeVerifySelectorExpected
} from "../computer-use/chrome-dom-verification.js";
import {
  classifyPageStateChange,
  detectAuthWall,
  detectDownload,
  detectNewTab,
  type ChromeDownloadsStatus,
  type ChromePageSafetyState,
  type ChromePageStateSnapshot,
  type ChromePageTarget
} from "../computer-use/chrome-page-state.js";
import {
  CHROME_WORKFLOW_MAX_STEPS,
  CHROME_WORKFLOW_TEMPLATE_LIBRARY,
  instantiateChromeWorkflowTemplate,
  type ChromeWorkflowPlan,
  type ChromeWorkflowStep,
  type ChromeWorkflowStepKind
} from "../computer-use/chrome-workflow-template.js";
import type { RiskDecision } from "../../shared/types.js";
import {
  captureChromeScreenshotFallback,
  readCurrentPageSnapshotResult,
  readErrorMessage,
  readPageIdentity,
  type ChromeCurrentPageSnapshot,
  type ChromeDesktopClient,
  type ChromeTaskClient,
  type ChromeTaskEvent,
  type ChromeWorkflowPlanPreview,
  type ChromeWorkflowStepPreview,
  type ChromeWorkflowStepRisk
} from "./chrome-task.js";

export const CHROME_WORKFLOW_RISK: RiskDecision = {
  level: "medium",
  reason: "Chrome workflow control executes a multi-step browser plan that navigates and interacts with the page.",
  requiresApproval: true
};

/**
 * CDP client for workflow execution. The observation hooks are optional:
 * when a hook is absent the corresponding classifier sees an empty baseline
 * and never fires, which keeps single-channel test doubles simple.
 */
export interface ChromeWorkflowClient extends ChromeTaskClient {
  readPageSafetyState?(): Promise<ChromePageSafetyState>;
  readDownloadsStatus?(): Promise<ChromeDownloadsStatus>;
  readPageTargets?(): Promise<readonly ChromePageTarget[]>;
}

export interface ChromeWorkflowTaskOptions {
  plan: ChromeWorkflowPlan;
  approved?: boolean;
  workflowApproved?: boolean;
  desktopClient?: ChromeDesktopClient;
  cdpClient?: ChromeWorkflowClient;
}

type ChromeWorkflowFailureStage = "navigation" | "interaction" | "verification" | "extraction";

interface ChromeWorkflowBaselines {
  pageIdentity?: BrowserPageIdentity;
  pageState?: ChromePageStateSnapshot;
  targets: readonly ChromePageTarget[];
  downloads: ChromeDownloadsStatus;
}

interface ChromeWorkflowStateCheck {
  events: ChromeTaskEvent[];
  blocked: boolean;
  baselines: ChromeWorkflowBaselines;
}

export async function* runChromeWorkflowTask(
  options: ChromeWorkflowTaskOptions
): AsyncGenerator<ChromeTaskEvent> {
  const { plan, approved, workflowApproved, cdpClient } = options;
  const command = plan.command;

  yield {
    type: "started",
    command,
    risk: CHROME_WORKFLOW_RISK
  };

  yield {
    type: "approval_required",
    command,
    risk: CHROME_WORKFLOW_RISK
  };

  if (!approved) {
    return;
  }

  if (!workflowApproved) {
    yield {
      type: "workflow_confirmation_required",
      command,
      preview: createChromeWorkflowPlanPreview(plan),
      reason: createChromeWorkflowConfirmationReason(plan)
    };
    return;
  }

  if (!cdpClient) {
    yield* captureChromeScreenshotFallback(
      { desktopClient: options.desktopClient },
      {
        stage: "connection",
        reason: "Chrome CDP endpoint is not configured."
      }
    );
    return;
  }

  let baselines: ChromeWorkflowBaselines = {
    targets: [],
    downloads: { downloads: [] }
  };
  let passedCount = 0;

  for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
    const step = plan.steps[stepIndex];

    yield {
      type: "workflow_step_started",
      stepIndex,
      stepKind: step.kind,
      ...(step.selector ? { selector: step.selector } : {})
    };

    try {
      switch (step.kind) {
        case "observe": {
          const snapshot = await takeWorkflowSnapshot(cdpClient);
          baselines = {
            pageIdentity: readPageIdentity(snapshot),
            pageState: toPageStateSnapshot(snapshot),
            targets: await readWorkflowPageTargets(cdpClient),
            downloads: await readWorkflowDownloadsStatus(cdpClient)
          };
          break;
        }
        case "click":
        case "submit": {
          await cdpClient.sendCdpCommand(buildCdpCommand({
            type: "click_selector",
            selector: requireWorkflowSelector(step, stepIndex),
            ...(baselines.pageIdentity ? { expectedPageIdentity: baselines.pageIdentity } : {})
          }));
          break;
        }
        case "fill": {
          // The fill value is bound into the CDP expression but never yielded.
          await cdpClient.sendCdpCommand(buildCdpCommand({
            type: "fill_selector",
            selector: requireWorkflowSelector(step, stepIndex),
            value: requireWorkflowFillValue(step, stepIndex),
            ...(baselines.pageIdentity ? { expectedPageIdentity: baselines.pageIdentity } : {})
          }));
          break;
        }
        case "scroll": {
          await cdpClient.sendCdpCommand(buildCdpCommand({
            type: "scroll_selector",
            selector: requireWorkflowSelector(step, stepIndex),
            deltaY: requireWorkflowScrollDistance(step, stepIndex),
            ...(baselines.pageIdentity ? { expectedPageIdentity: baselines.pageIdentity } : {})
          }));
          break;
        }
        case "verify": {
          const selector = requireWorkflowSelector(step, stepIndex);
          const expected = requireWorkflowExpected(step, stepIndex);
          const result = await cdpClient.sendCdpCommand(buildCdpCommand({
            type: "verify_selector",
            selector,
            expected,
            ...(baselines.pageIdentity ? { expectedPageIdentity: baselines.pageIdentity } : {})
          }));
          const evidence = readChromeDomVerificationResult(result);
          const expectedLabel = formatChromeVerifyExpected(expected);

          if (evidence.passed) {
            yield {
              type: "dom_verification_passed",
              stepIndex,
              selector,
              expected: expectedLabel,
              actual: evidence.actual
            };
            break;
          }

          yield {
            type: "dom_verification_failed",
            stepIndex,
            selector,
            expected: expectedLabel,
            actual: evidence.actual
          };
          yield {
            type: "completed",
            command,
            summary: createChromeWorkflowCompletionSummary(passedCount, plan.steps.length)
          };
          return;
        }
      }
    } catch (error) {
      yield {
        type: "verification_failed",
        stage: readWorkflowFailureStage(step.kind),
        reason: readErrorMessage(error, `Chrome workflow step ${stepIndex} (${step.kind}) failed.`)
      };
      return;
    }

    if (isWorkflowMutationStep(step.kind)) {
      let stateCheck: ChromeWorkflowStateCheck;
      try {
        await cdpClient.waitForPageReady?.();
        stateCheck = await readWorkflowPostMutationState(cdpClient, baselines, stepIndex);
      } catch (error) {
        yield {
          type: "verification_failed",
          stage: "verification",
          reason: readErrorMessage(error, `Chrome workflow could not re-observe the page after step ${stepIndex}.`)
        };
        return;
      }

      for (const event of stateCheck.events) {
        yield event;
      }
      baselines = stateCheck.baselines;
      if (stateCheck.blocked) {
        return;
      }
    }

    passedCount += 1;
    yield {
      type: "workflow_step_completed",
      stepIndex,
      stepKind: step.kind,
      status: "passed"
    };
  }

  yield {
    type: "completed",
    command,
    summary: createChromeWorkflowCompletionSummary(passedCount, plan.steps.length)
  };
}

/**
 * Classifies the page after a mutating step. Navigations and reloads re-bind
 * the workflow baselines and continue; new tabs and auth walls block;
 * downloads are informational and refresh only the download baseline.
 */
async function readWorkflowPostMutationState(
  cdpClient: ChromeWorkflowClient,
  baselines: ChromeWorkflowBaselines,
  stepIndex: number
): Promise<ChromeWorkflowStateCheck> {
  const snapshot = await takeWorkflowSnapshot(cdpClient);
  const currentState = toPageStateSnapshot(snapshot);

  // A step that ran before any observe step establishes the baseline instead
  // of flagging the existing page as a navigation.
  if (!baselines.pageState) {
    return {
      events: [],
      blocked: false,
      baselines: await refreshWorkflowBaselines(cdpClient, snapshot)
    };
  }

  const change = classifyPageStateChange(baselines.pageState, currentState);

  if (change.kind === "navigation") {
    return {
      events: [{
        type: "navigation_detected",
        fromUrl: change.fromUrl,
        toUrl: change.toUrl,
        stepIndex,
        reason: "The workflow re-bound to the new page and continues."
      }],
      blocked: false,
      baselines: await refreshWorkflowBaselines(cdpClient, snapshot)
    };
  }

  if (change.kind === "reload") {
    return {
      events: [{
        type: "page_reload_detected",
        url: change.url,
        stepIndex,
        reason: "The workflow re-observed the reloaded page."
      }],
      blocked: false,
      baselines: await refreshWorkflowBaselines(cdpClient, snapshot)
    };
  }

  const currentTargets = await readWorkflowPageTargets(cdpClient);
  const tabDecision = detectNewTab(baselines.targets, currentTargets);
  if (tabDecision.detected) {
    return {
      events: [{
        type: "new_tab_detected",
        tabUrl: tabDecision.tabUrl,
        stepIndex,
        reason: tabDecision.reason
      }],
      blocked: true,
      baselines: { ...baselines, targets: currentTargets }
    };
  }

  const safety = await readWorkflowPageSafetyState(cdpClient);
  const authDecision = detectAuthWall(safety);
  if (authDecision.detected) {
    return {
      events: [{
        type: "auth_wall_detected",
        url: snapshot.url,
        reason: authDecision.reason,
        safetyFindings: authDecision.findings
      }],
      blocked: true,
      baselines: { ...baselines, targets: currentTargets }
    };
  }

  const currentDownloads = await readWorkflowDownloadsStatus(cdpClient);
  const downloadDecision = detectDownload(baselines.downloads, currentDownloads);
  if (downloadDecision.detected) {
    return {
      events: [{
        type: "download_detected",
        downloadUrl: downloadDecision.downloadHost,
        stepIndex,
        reason: downloadDecision.reason
      }],
      blocked: false,
      baselines: { ...baselines, targets: currentTargets, downloads: currentDownloads }
    };
  }

  return {
    events: [],
    blocked: false,
    baselines: { ...baselines, targets: currentTargets, downloads: currentDownloads }
  };
}

async function refreshWorkflowBaselines(
  cdpClient: ChromeWorkflowClient,
  snapshot: ChromeCurrentPageSnapshot
): Promise<ChromeWorkflowBaselines> {
  return {
    pageIdentity: readPageIdentity(snapshot),
    pageState: toPageStateSnapshot(snapshot),
    targets: await readWorkflowPageTargets(cdpClient),
    downloads: await readWorkflowDownloadsStatus(cdpClient)
  };
}

async function takeWorkflowSnapshot(
  cdpClient: ChromeWorkflowClient
): Promise<ChromeCurrentPageSnapshot> {
  const result = await cdpClient.sendCdpCommand(
    buildCdpCommand({ type: "extract_page_snapshot" })
  );
  return readCurrentPageSnapshotResult(result);
}

function toPageStateSnapshot(snapshot: ChromeCurrentPageSnapshot): ChromePageStateSnapshot {
  return {
    url: snapshot.url,
    documentId: snapshot.documentId
  };
}

async function readWorkflowPageSafetyState(
  cdpClient: ChromeWorkflowClient
): Promise<ChromePageSafetyState> {
  return cdpClient.readPageSafetyState?.() ?? { findings: [], needsConfirmation: false };
}

async function readWorkflowDownloadsStatus(
  cdpClient: ChromeWorkflowClient
): Promise<ChromeDownloadsStatus> {
  return cdpClient.readDownloadsStatus?.() ?? { downloads: [] };
}

async function readWorkflowPageTargets(
  cdpClient: ChromeWorkflowClient
): Promise<readonly ChromePageTarget[]> {
  return cdpClient.readPageTargets?.() ?? [];
}

function requireWorkflowSelector(step: ChromeWorkflowStep, stepIndex: number): string {
  if (!step.selector) {
    throw new Error(`Chrome workflow step ${stepIndex} (${step.kind}) is missing a selector.`);
  }
  return step.selector;
}

function requireWorkflowFillValue(step: ChromeWorkflowStep, stepIndex: number): string {
  if (!step.value) {
    throw new Error(`Chrome workflow step ${stepIndex} (${step.kind}) is missing a fill value.`);
  }
  return step.value;
}

function requireWorkflowScrollDistance(step: ChromeWorkflowStep, stepIndex: number): number {
  if (step.deltaY === undefined || !Number.isFinite(step.deltaY)) {
    throw new Error(`Chrome workflow step ${stepIndex} (${step.kind}) is missing a finite scroll distance.`);
  }
  return step.deltaY;
}

function requireWorkflowExpected(
  step: ChromeWorkflowStep,
  stepIndex: number
): ChromeVerifySelectorExpected {
  if (!step.expected) {
    throw new Error(`Chrome workflow step ${stepIndex} (${step.kind}) is missing a verify assertion.`);
  }
  return step.expected;
}

function isWorkflowMutationStep(kind: ChromeWorkflowStepKind): boolean {
  return kind === "click" || kind === "fill" || kind === "submit" || kind === "scroll";
}

function readWorkflowFailureStage(kind: ChromeWorkflowStepKind): ChromeWorkflowFailureStage {
  switch (kind) {
    case "observe":
      return "extraction";
    case "verify":
      return "verification";
    case "click":
    case "fill":
    case "submit":
    case "scroll":
      return "interaction";
  }
}

/** Builds the value-free approval preview: step kinds, selectors, URLs, and risks only. */
export function createChromeWorkflowPlanPreview(plan: ChromeWorkflowPlan): ChromeWorkflowPlanPreview {
  return {
    planId: createChromeWorkflowPlanId(plan),
    stepCount: plan.steps.length,
    steps: plan.steps.map(createChromeWorkflowStepPreview),
    maxSteps: CHROME_WORKFLOW_MAX_STEPS
  };
}

function createChromeWorkflowStepPreview(step: ChromeWorkflowStep): ChromeWorkflowStepPreview {
  return {
    stepKind: step.kind,
    ...(step.selector ? { selector: step.selector } : {}),
    ...(step.url ? { url: step.url } : {}),
    risk: readChromeWorkflowStepRisk(step.kind)
  };
}

function readChromeWorkflowStepRisk(kind: ChromeWorkflowStepKind): ChromeWorkflowStepRisk {
  switch (kind) {
    case "submit":
      return "high";
    case "click":
    case "fill":
      return "medium";
    case "observe":
    case "scroll":
    case "verify":
      return "low";
  }
}

function createChromeWorkflowPlanId(plan: ChromeWorkflowPlan): string {
  const valueFreeShape = plan.steps
    .map((step) => `${step.kind}:${step.selector ?? ""}:${step.url ?? ""}`)
    .join("|");
  let hash = 0;
  for (const char of valueFreeShape) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return `chrome-workflow-${(hash >>> 0).toString(36)}`;
}

function createChromeWorkflowConfirmationReason(plan: ChromeWorkflowPlan): string {
  const mutatingCount = plan.steps.filter((step) => isWorkflowMutationStep(step.kind)).length;
  return `Confirm a ${plan.steps.length}-step Chrome workflow (${mutatingCount} mutating steps) with value-free selectors only.`;
}

function createChromeWorkflowCompletionSummary(passedCount: number, totalCount: number): string {
  return `Chrome workflow completed: ${passedCount}/${totalCount} steps passed.`;
}

// ---------------------------------------------------------------------------
// Command parsing (built-in template library)
// ---------------------------------------------------------------------------

const CHROME_WORKFLOW_COMMAND_PATTERN =
  /^(?:执行\s*)?chrome(?:\s+workflow|\s+工作流)\s+([a-z][a-z0-9-]*)(?:\s+(.+))?$/iu;

export type ChromeWorkflowCommandResult =
  | { ok: true; plan: ChromeWorkflowPlan }
  | { ok: false; reason: string };

/**
 * Parses a `Chrome workflow <template-id> [placeholder=value ...]` command
 * into an instantiated plan. Fill values are checked against the
 * sensitive-text policy by the template instantiator.
 */
export function parseChromeWorkflowCommand(input: string): ChromeWorkflowCommandResult {
  const match = CHROME_WORKFLOW_COMMAND_PATTERN.exec(input.trim());
  if (!match) {
    return {
      ok: false,
      reason: "Chrome workflow command requires: Chrome workflow <template-id> [placeholder=value ...]"
    };
  }

  const [, templateId, valuesAssignment] = match;
  const template = CHROME_WORKFLOW_TEMPLATE_LIBRARY.find(
    (candidate) => candidate.templateId === templateId
  );
  if (!template) {
    return {
      ok: false,
      reason: `Unknown Chrome workflow template: ${templateId}`
    };
  }

  const values = valuesAssignment ? parseChromeWorkflowValues(valuesAssignment) : {};
  return instantiateChromeWorkflowTemplate(template, values);
}

function parseChromeWorkflowValues(assignment: string): Record<string, string> {
  const values: Record<string, string> = {};
  const chunks = assignment
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const equalsIndex = chunk.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const placeholder = chunk.slice(0, equalsIndex).trim();
    const value = chunk.slice(equalsIndex + 1).trim();
    if (placeholder && value) {
      values[placeholder] = value;
    }
  }

  return values;
}
