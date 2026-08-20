import type { RiskDecision } from "../../shared/types.js";
import {
  evaluateGroundingCoverage,
  type GroundingCoverageEvaluation
} from "./grounding-evaluation.js";
import { extractObservedElementsFromAppState } from "./observed-elements.js";
import type { DesktopAppState, FinderSelectionResult } from "./types.js";

export interface FinderPlanPreviewTranscriptPayload {
  rootPath: string;
  operationCount: number;
  destructiveOperationCount: number;
  createFolders: string[];
  moveFiles: Array<{ from: string; to: string }>;
  copyFiles?: Array<{ from: string; to: string }>;
}

export interface FinderTaskResultTranscriptPayload {
  schemaVersion: 1;
  rootPath: string;
  destinationPath: string;
  collisionPolicy: "cancel" | "skip" | "rename" | "replace";
  totalOperationCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  completedItems: Array<{
    operationId: string;
    operationType: "create_folder" | "move_file" | "copy_file";
    from?: string;
    to: string;
    resultingName: string;
    resolution: "create" | "move" | "copy" | "skip" | "rename" | "replace";
  }>;
  failedItems: Array<{
    operationId: string;
    operationType: "create_folder" | "move_file" | "copy_file";
    from?: string;
    to: string;
    reason: string;
    errorCode: string;
  }>;
  destinationVerified: boolean;
  resultingNamesVerified: boolean;
}

export interface ChromeSubmitConfirmationTranscriptPayload {
  schemaVersion: 1;
  url: string;
  fieldSelectors: string[];
  submitSelector: string;
}

export interface ChromeWorkflowStepPreviewTranscriptPayload {
  stepKind: string;
  selector?: string;
  url?: string;
  risk: string;
}

export interface ChromeWorkflowPlanPreviewTranscriptPayload {
  planId: string;
  stepCount: number;
  steps: ChromeWorkflowStepPreviewTranscriptPayload[];
  maxSteps: number;
}

export type ComputerUseTurnEvent =
  | { type: "started"; command: string; risk: RiskDecision }
  | { type: "approval_required"; command: string; risk: RiskDecision }
  | {
    type: "submit_confirmation_required";
    command: string;
    binding: ChromeSubmitConfirmationTranscriptPayload;
    reason: string;
  }
  | {
    type: "workflow_confirmation_required";
    command: string;
    preview: ChromeWorkflowPlanPreviewTranscriptPayload;
    reason: string;
  }
  | {
    type: "navigation_detected";
    fromUrl: string;
    toUrl: string;
    stepIndex: number;
    reason: string;
  }
  | {
    type: "new_tab_detected";
    tabUrl: string;
    stepIndex: number;
    reason: string;
  }
  | {
    type: "auth_wall_detected";
    url: string;
    reason: string;
    safetyFindings: Array<{ kind: string; severity: string }>;
  }
  | {
    type: "download_detected";
    downloadUrl: string;
    stepIndex: number;
    reason: string;
  }
  | {
    type: "page_reload_detected";
    url: string;
    stepIndex: number;
    reason: string;
  }
  | {
    type: "dom_verification_passed";
    stepIndex: number;
    selector: string;
    expected: string;
    actual: string;
  }
  | {
    type: "dom_verification_failed";
    stepIndex: number;
    selector: string;
    expected: string;
    actual: string;
    screenshotPath?: string;
  }
  | {
    type: "workflow_step_started";
    stepIndex: number;
    stepKind: string;
    selector?: string;
  }
  | {
    type: "workflow_step_completed";
    stepIndex: number;
    stepKind: string;
    status: "passed";
  }
  | {
    type: "tool_call";
    turnId: string;
    toolCallId: string;
    command: string;
    route: string;
    status: "planned" | "approval_required" | "running" | "completed" | "denied" | "blocked" | "failed" | "cancelled";
  }
  | {
    type: "approval_decision";
    turnId: string;
    toolCallId: string;
    command: string;
    route: string;
    decision: "approved" | "denied" | "bypassed";
    reason?: string;
  }
  | {
    type: "tool_result";
    turnId: string;
    toolCallId: string;
    command: string;
    route: string;
    status: "completed" | "denied" | "blocked" | "failed" | "cancelled";
    summary?: string;
    evidence?: {
      summary: string;
      artifacts?: string[];
    };
  }
  | {
    type: "planner_resolved";
    providerLabel: string;
    input: string;
    command: string;
    rationale?: string;
  }
  | { type: "locating_app"; appName: string }
  | { type: "session_opened"; appName: string; title: string; pid: number }
  | { type: "app_activated"; appName: string; bundleId: string; pid?: number }
  | {
    type: "fallback_switch";
    from: string;
    to: string;
    stage: string;
    reason: string;
  }
  | { type: "session_initialized"; title: string; marker: string }
  | {
    type: "action_verified";
    actionType: string;
    status: "passed" | "failed" | "needs_user_confirmation";
    message?: string;
    reason?: string;
  }
  | { type: "verification_failed"; stage: string; code?: string; reason: string }
  | {
    type: "recovery_attempted";
    stage: string;
    action: "activate" | "open" | "reobserve";
    reason: string;
  }
  | { type: "screenshot_before"; path: string; observation: DesktopAppState }
  | { type: "finder_selection_observed"; context: FinderSelectionResult }
  | { type: "plan_preview"; preview: FinderPlanPreviewTranscriptPayload }
  | {
    type: "plan_confirmation_required";
    command: string;
    preview: FinderPlanPreviewTranscriptPayload;
    reason: string;
  }
  | { type: "typing"; command: string }
  | { type: "submitted"; key: "enter" }
  | { type: "screenshot_after"; path: string; observation: DesktopAppState }
  | {
      type: "completed";
      command: string;
      summary: string;
      result?: FinderTaskResultTranscriptPayload;
    };

export interface TurnTranscriptApp {
  name: string;
  bundleId?: string;
  pid?: number;
}

export interface TurnTranscriptScreenshot {
  stage: "before" | "after";
  path: string;
  bundleId: string;
  pid?: number;
  accessibilityTrusted?: boolean;
  grounding: GroundingCoverageEvaluation;
}

export interface TurnTranscriptPlanner {
  providerLabel: string;
  input: string;
  command: string;
  rationale?: string;
}

export type TurnTranscriptAction =
  | {
    type: "tool_call";
    turnId: string;
    toolCallId: string;
    route: string;
    status: "planned" | "approval_required" | "running" | "completed" | "denied" | "blocked" | "failed" | "cancelled";
    command: string;
  }
  | {
    type: "approval_decision";
    turnId: string;
    toolCallId: string;
    route: string;
    decision: "approved" | "denied" | "bypassed";
    reason?: string;
  }
  | {
    type: "tool_result";
    turnId: string;
    toolCallId: string;
    route: string;
    status: "completed" | "denied" | "blocked" | "failed" | "cancelled";
    summary?: string;
    evidenceSummary?: string;
    artifactCount: number;
  }
  | { type: "plan"; providerLabel: string; command: string; rationale?: string }
  | { type: "open_session"; appName: string; pid: number }
  | { type: "activate_app"; appName: string; bundleId: string; pid?: number }
  | { type: "type_text"; text: string }
  | { type: "press_key"; key: "enter" }
  | {
    type: "observe_finder_selection";
    source: FinderSelectionResult["source"];
    frontmostBundleId?: string;
    targetPath?: string;
    selectedCount: number;
  }
  | {
    type: "preview_finder_plan";
    rootPath: string;
    operationCount: number;
    destructiveOperationCount: number;
    createFolderCount: number;
    moveFileCount: number;
    copyFileCount?: number;
  }
  | {
    type: "confirm_finder_plan";
    rootPath: string;
    operationCount: number;
    destructiveOperationCount: number;
    reason: string;
  }
  | {
    type: "confirm_chrome_submit";
    url: string;
    fieldSelectors: string[];
    submitSelector: string;
    reason: string;
  }
  | {
    type: "confirm_chrome_workflow";
    planId: string;
    stepCount: number;
    maxSteps: number;
    reason: string;
  }
  | {
    type: "chrome_page_event";
    kind:
      | "navigation_detected"
      | "new_tab_detected"
      | "auth_wall_detected"
      | "download_detected"
      | "page_reload_detected";
    stepIndex?: number;
    fromUrl?: string;
    toUrl?: string;
    url?: string;
    reason: string;
  }
  | {
    type: "chrome_dom_verification";
    status: "passed" | "failed";
    stepIndex: number;
    selector: string;
    expected: string;
    actual: string;
    screenshotPath?: string;
  }
  | {
    type: "chrome_workflow_step";
    status: "started" | "completed";
    stepIndex: number;
    stepKind: string;
    selector?: string;
  }
  | {
    type: "recover";
    action: "activate" | "open" | "reobserve";
    stage: string;
    reason: string;
  }
  | {
    type: "verify";
    actionType: string;
    status: "passed" | "failed" | "needs_user_confirmation";
    message?: string;
    reason?: string;
  }
  | { type: "switch_control"; from: string; to: string; stage: string; reason: string };

export type TurnTranscriptOutcome =
  | "completed"
  | "approval_required"
  | "needs_confirmation"
  | "needs_clarification"
  | "verification_failed"
  | "denied"
  | "blocked"
  | "cancelled"
  | "failed"
  | "running";

export interface TurnTranscript {
  command?: string;
  risk?: RiskDecision;
  planner?: TurnTranscriptPlanner;
  approvalRequired: boolean;
  apps: TurnTranscriptApp[];
  screenshots: TurnTranscriptScreenshot[];
  actions: TurnTranscriptAction[];
  outcome: TurnTranscriptOutcome;
  finderTaskResult?: FinderTaskResultTranscriptPayload;
}

export function createTurnTranscript(
  events: readonly ComputerUseTurnEvent[]
): TurnTranscript {
  const apps = new Map<string, TurnTranscriptApp>();
  const screenshots: TurnTranscriptScreenshot[] = [];
  const actions: TurnTranscriptAction[] = [];
  let command: string | undefined;
  let risk: RiskDecision | undefined;
  let planner: TurnTranscriptPlanner | undefined;
  let approvalRequired = false;
  let outcome: TurnTranscriptOutcome = "running";
  let finderTaskResult: FinderTaskResultTranscriptPayload | undefined;

  for (const event of events) {
    switch (event.type) {
      case "started":
        command = event.command;
        risk = event.risk;
        break;
      case "approval_required":
        command = event.command;
        risk = event.risk;
        approvalRequired = true;
        outcome = "approval_required";
        break;
      case "submit_confirmation_required":
        command = event.command;
        approvalRequired = true;
        outcome = "approval_required";
        actions.push({
          type: "confirm_chrome_submit",
          url: event.binding.url,
          fieldSelectors: [...event.binding.fieldSelectors],
          submitSelector: event.binding.submitSelector,
          reason: event.reason
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "workflow_confirmation_required":
        command = event.command;
        approvalRequired = true;
        outcome = "approval_required";
        actions.push({
          type: "confirm_chrome_workflow",
          planId: event.preview.planId,
          stepCount: event.preview.stepCount,
          maxSteps: event.preview.maxSteps,
          reason: event.reason
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "navigation_detected":
        actions.push({
          type: "chrome_page_event",
          kind: "navigation_detected",
          stepIndex: event.stepIndex,
          fromUrl: event.fromUrl,
          toUrl: event.toUrl,
          reason: event.reason
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "new_tab_detected":
        actions.push({
          type: "chrome_page_event",
          kind: "new_tab_detected",
          stepIndex: event.stepIndex,
          url: event.tabUrl,
          reason: event.reason
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "auth_wall_detected":
        actions.push({
          type: "chrome_page_event",
          kind: "auth_wall_detected",
          url: event.url,
          reason: event.reason
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "download_detected":
        actions.push({
          type: "chrome_page_event",
          kind: "download_detected",
          stepIndex: event.stepIndex,
          url: event.downloadUrl,
          reason: event.reason
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "page_reload_detected":
        actions.push({
          type: "chrome_page_event",
          kind: "page_reload_detected",
          stepIndex: event.stepIndex,
          url: event.url,
          reason: event.reason
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "dom_verification_passed":
        actions.push({
          type: "chrome_dom_verification",
          status: "passed",
          stepIndex: event.stepIndex,
          selector: event.selector,
          expected: event.expected,
          actual: event.actual
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "dom_verification_failed":
        actions.push({
          type: "chrome_dom_verification",
          status: "failed",
          stepIndex: event.stepIndex,
          selector: event.selector,
          expected: event.expected,
          actual: event.actual,
          ...(event.screenshotPath ? { screenshotPath: event.screenshotPath } : {})
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "workflow_step_started":
        actions.push({
          type: "chrome_workflow_step",
          status: "started",
          stepIndex: event.stepIndex,
          stepKind: event.stepKind,
          ...(event.selector ? { selector: event.selector } : {})
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "workflow_step_completed":
        actions.push({
          type: "chrome_workflow_step",
          status: "completed",
          stepIndex: event.stepIndex,
          stepKind: event.stepKind
        });
        mergeApp(apps, {
          name: "Chrome",
          bundleId: "com.google.Chrome"
        });
        break;
      case "tool_call":
        command = event.command;
        if (event.status === "approval_required") {
          approvalRequired = true;
          outcome = "approval_required";
        } else if (event.status === "running" || event.status === "planned") {
          outcome = "running";
        } else {
          outcome = event.status;
        }
        actions.push({
          type: "tool_call",
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          route: event.route,
          status: event.status,
          command: event.command
        });
        break;
      case "approval_decision":
        command = event.command;
        approvalRequired = true;
        actions.push({
          type: "approval_decision",
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          route: event.route,
          decision: event.decision,
          reason: event.reason
        });
        break;
      case "tool_result":
        command = event.command;
        outcome = event.status;
        actions.push({
          type: "tool_result",
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          route: event.route,
          status: event.status,
          summary: event.summary,
          evidenceSummary: event.evidence?.summary,
          artifactCount: event.evidence?.artifacts?.length ?? 0
        });
        break;
      case "planner_resolved":
        planner = {
          providerLabel: event.providerLabel,
          input: event.input,
          command: event.command,
          rationale: event.rationale
        };
        actions.push({
          type: "plan",
          providerLabel: event.providerLabel,
          command: event.command,
          rationale: event.rationale
        });
        break;
      case "session_opened":
        actions.push({ type: "open_session", appName: event.appName, pid: event.pid });
        mergeApp(apps, { name: event.appName, pid: event.pid });
        break;
      case "app_activated":
        actions.push({
          type: "activate_app",
          appName: event.appName,
          bundleId: event.bundleId,
          pid: event.pid
        });
        mergeApp(apps, {
          name: event.appName,
          bundleId: event.bundleId,
          pid: event.pid
        });
        break;
      case "recovery_attempted":
        actions.push({
          type: "recover",
          action: event.action,
          stage: event.stage,
          reason: event.reason
        });
        break;
      case "fallback_switch":
        actions.push({
          type: "switch_control",
          from: event.from,
          to: event.to,
          stage: event.stage,
          reason: event.reason
        });
        break;
      case "screenshot_before":
      case "screenshot_after":
        screenshots.push(createScreenshot(event));
        break;
      case "finder_selection_observed":
        actions.push({
          type: "observe_finder_selection",
          source: event.context.source,
          frontmostBundleId: event.context.frontmostBundleId,
          targetPath: event.context.targetPath,
          selectedCount: event.context.selection.length
        });
        mergeApp(apps, {
          name: "Finder",
          bundleId: "com.apple.finder"
        });
        break;
      case "plan_preview":
        actions.push({
          type: "preview_finder_plan",
          rootPath: event.preview.rootPath,
          operationCount: event.preview.operationCount,
          destructiveOperationCount: event.preview.destructiveOperationCount,
          createFolderCount: event.preview.createFolders.length,
          moveFileCount: event.preview.moveFiles.length,
          copyFileCount: event.preview.copyFiles?.length ?? 0
        });
        mergeApp(apps, {
          name: "Finder",
          bundleId: "com.apple.finder"
        });
        break;
      case "plan_confirmation_required":
        command = event.command;
        approvalRequired = true;
        outcome = "needs_confirmation";
        actions.push({
          type: "confirm_finder_plan",
          rootPath: event.preview.rootPath,
          operationCount: event.preview.operationCount,
          destructiveOperationCount: event.preview.destructiveOperationCount,
          reason: event.reason
        });
        mergeApp(apps, {
          name: "Finder",
          bundleId: "com.apple.finder"
        });
        break;
      case "typing":
        actions.push({ type: "type_text", text: event.command });
        break;
      case "submitted":
        actions.push({ type: "press_key", key: event.key });
        break;
      case "action_verified":
        actions.push({
          type: "verify",
          actionType: event.actionType,
          status: event.status,
          message: event.message,
          reason: event.reason
        });

        if (event.status === "needs_user_confirmation") {
          outcome = "needs_confirmation";
        } else if (event.status !== "passed") {
          outcome = "verification_failed";
        }
        break;
      case "verification_failed":
        outcome = event.stage === "permissions" ? "failed" : "needs_confirmation";
        break;
      case "completed":
        command = event.command;
        outcome = "completed";
        finderTaskResult = event.result;
        break;
    }
  }

  return {
    command,
    risk,
    planner,
    approvalRequired,
    apps: Array.from(apps.values()),
    screenshots,
    actions,
    outcome,
    ...(finderTaskResult ? { finderTaskResult } : {})
  };
}

function mergeApp(apps: Map<string, TurnTranscriptApp>, next: TurnTranscriptApp): void {
  const key = `${next.name}:${next.pid ?? ""}`;
  apps.set(key, {
    ...apps.get(key),
    ...next
  });
}

function createScreenshot(
  event: Extract<ComputerUseTurnEvent, { type: "screenshot_before" | "screenshot_after" }>
): TurnTranscriptScreenshot {
  return {
    stage: event.type === "screenshot_before" ? "before" : "after",
    path: event.path,
    bundleId: event.observation.bundleId,
    pid: event.observation.pid,
    accessibilityTrusted: event.observation.accessibilityTrusted,
    grounding: evaluateGroundingCoverage({
      state: event.observation,
      elements: extractObservedElementsFromAppState(event.observation),
      ocrLabels: event.observation.ocrLabels
    })
  };
}
