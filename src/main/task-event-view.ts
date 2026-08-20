import type {
  DesktopAppState,
  FinderSelectionResult
} from "./computer-use/types.js";
import type { TurnReplayTaskEvent } from "./computer-use/turn-replay-store.js";
import type { TmuxSupervisionReport } from "./computer-use/tmux-supervisor.js";
import type { TmuxRecoveryAction, TmuxRecoveryOutcome } from "./computer-use/tmux-recovery.js";
import { describeTmuxRecoveryAction } from "./computer-use/tmux-recovery.js";
import type { GhosttyTaskEvent } from "./orchestrator/events.js";
import type {
  ChromeTaskEvent,
  ChromeWorkflowPlanPreview
} from "./orchestrator/chrome-task.js";
import type {
  FinderPlanPreview,
  FinderTaskEvent
} from "./orchestrator/finder-task.js";
import type { FinderTaskResult } from "./orchestrator/finder-task-result.js";
import type { TmuxSupervisionTaskEvent } from "./orchestrator/tmux-supervision-task.js";
import {
  formatTmuxRecoveryProposals,
  type TmuxRecoveryTaskEvent
} from "./orchestrator/tmux-recovery-task.js";
import type { CommandRoute, ExecutableCommandRoute } from "./task-routing.js";
import {
  createTaskEventRouteMetadata,
  type TaskEventRouteMetadata
} from "./task-event-route-metadata.js";
import {
  readRouteOutcome,
  type RouteOutcome
} from "../shared/route-outcome.js";
import type { TaskControlSnapshot } from "../shared/task-control.js";

export type ManualMode = "active" | "quiet";
export type TaskStatus =
  | "idle"
  | "planned"
  | "waiting"
  | "observing"
  | "executing"
  | "verifying"
  | "running"
  | "approval_required"
  | "needs_confirmation"
  | "needs_clarification"
  | "completed"
  | "denied"
  | "blocked"
  | "failed"
  | "cancelled";
export type ComputerUseTaskEvent =
  | GhosttyTaskEvent
  | ChromeTaskEvent
  | FinderTaskEvent
  | TmuxSupervisionTaskEvent
  | TmuxRecoveryTaskEvent;

export interface ObserveAppReplayRecord extends DesktopAppState {
  stage: "before" | "after";
}

export interface TaskEvent {
  status: TaskStatus;
  message?: string;
  command?: string;
  route?: string;
  routeReason?: string;
  denialKind?: string;
  policyKind?: string;
  routeOutcome?: RouteOutcome;
  taskControl?: TaskControlSnapshot;
  stopTurnBehavior?: TaskEventStopTurnBehavior;
  replayReset?: boolean;
  replayRecord?: ObserveAppReplayRecord;
  finderSelection?: FinderSelectionResult;
  finderPlanPreview?: FinderPlanPreview;
  finderTaskResult?: FinderTaskResult;
  chromeWorkflowPreview?: ChromeWorkflowPlanPreview;
  tmuxSupervisionReport?: TmuxSupervisionReport;
  tmuxRecoveryOutcome?: TmuxRecoveryOutcome;
}

export interface TaskEventStopTurnBehavior {
  result?: string;
  source?: string;
  command?: string;
  beforeStatus?: string;
  beforeMessage?: string;
  afterStatus?: string;
  afterMessage?: string;
}

export function createTaskEvent(event: ComputerUseTaskEvent, mode: ManualMode): TaskEvent {
  const prefix = mode === "quiet" ? "Quiet mode: " : "";

  switch (event.type) {
    case "started":
      return {
        status: "waiting",
        message: `${prefix}Risk ${event.risk.level}: ${event.risk.reason}`,
        replayReset: true
      };
    case "recovery_started":
      return {
        status: "waiting",
        message: `${prefix}Risk ${event.risk.level}: ${event.risk.reason}`,
        replayReset: true
      };
    case "approval_required":
      if (event.risk.level === "blocked") {
        return {
          status: "blocked",
          message: event.risk.reason,
          command: readTaskEventCommand(event)
        };
      }

      return {
        status: "approval_required",
        message: `Approval required (${event.risk.level}): ${event.risk.reason}`,
        command: readTaskEventCommand(event)
      };
    case "observing":
      return {
        status: "observing",
        message: `${prefix}${event.message}`
      };
    case "locating_app":
      return {
        status: "observing",
        message: `${prefix}Finding ${event.appName}.`
      };
    case "session_opened":
      return {
        status: "observing",
        message: `${prefix}Opened ${event.appName} session: ${event.title}.`
      };
    case "app_activated":
      return {
        status: "executing",
        message: `${prefix}Activated ${event.appName}.`
      };
    case "fallback_switch":
      return {
        status: "executing",
        message: `${prefix}Switching Chrome control from ${formatControlChannel(event.from)} to ${event.to} (${event.stage}): ${event.reason}`
      };
    case "session_initialized":
      return {
        status: "executing",
        message: `${prefix}Initialized Ghostty session marker: ${event.title}.`
      };
    case "action_verified":
      if (event.status === "needs_user_confirmation") {
        return {
          status: "needs_confirmation",
          message: `${prefix}Verification needs confirmation for ${event.actionType}: ${event.reason}`
        };
      }
      if (event.status === "failed") {
        return {
          status: "failed",
          message: `${prefix}Verification failed for ${event.actionType}: ${event.reason}`
        };
      }
      return {
        status: "verifying",
        message: `${prefix}Verified ${event.actionType}: ${event.message ?? "passed."}`
      };
    case "executing":
      return {
        status: "executing",
        message: `${prefix}Recovering tmux (attempt ${event.attempt}): ${describeTmuxRecoveryAction(event.action)}.`
      };
    case "verification_failed":
      return {
        status: "failed",
        message: event.stage === "permissions"
          ? `${prefix}${event.reason}`
          : `${prefix}Verification failed (${event.stage}): ${event.reason}`
      };
    case "failed":
      return {
        status: "failed",
        message: `${prefix}${event.summary}`,
        tmuxRecoveryOutcome: event.outcome
      };
    case "budget_exhausted":
      return {
        status: "blocked",
        message: `${prefix}${event.reason}`
      };
    case "recovery_attempted":
      return {
        status: "executing",
        message: `${prefix}Recovering ${event.stage} observation with ${event.action}: ${event.reason}`
      };
    case "screenshot_before":
      return {
        status: "observing",
        message: `${prefix}Captured before screenshot: ${event.path}`,
        replayRecord: createObserveAppReplayRecord("before", event.observation)
      };
    case "terminal_context_observed":
      return {
        status: "observing",
        message: `${prefix}Observed Ghostty terminal context in ${event.context.workingDirectory}.`
      };
    case "command_preview":
      return {
        status: "executing",
        message: `${prefix}Ghostty command preview: ${event.preview.command} (${event.preview.risk.level}, ${event.preview.mutating ? "mutating" : "read-only"}) in ${event.preview.workingDirectory}.`
      };
    case "retry_attempted":
      return {
        status: "verifying",
        message: `${prefix}Retrying ${event.stage} observation (attempt ${event.attempt}): ${event.reason}`
      };
    case "finder_selection_observed":
      return {
        status: "observing",
        message: `${prefix}Observed Finder selection: ${formatFinderSelectionSummary(event.context)}`,
        finderSelection: event.context
      };
    case "plan_preview":
      return {
        status: "executing",
        message: `${prefix}Finder plan preview: ${event.preview.createFolders.length} folders, ${event.preview.moveFiles.length} moves, ${event.preview.destructiveOperationCount} destructive operations.`,
        finderPlanPreview: event.preview
      };
    case "plan_confirmation_required":
      return {
        status: "approval_required",
        message: `${prefix}Finder plan confirmation required: ${event.reason}`,
        command: event.command,
        finderPlanPreview: event.preview
      };
    case "submit_confirmation_required":
      return {
        status: "needs_confirmation",
        message: `${prefix}Chrome submit confirmation required: ${event.reason}`,
        command: event.command
      };
    case "workflow_confirmation_required":
      return {
        status: "needs_confirmation",
        message: `${prefix}Chrome workflow confirmation required: ${event.reason}`,
        command: event.command,
        chromeWorkflowPreview: event.preview
      };
    case "navigation_detected":
      return {
        status: "executing",
        message: `${prefix}Chrome page navigated from ${event.fromUrl} to ${event.toUrl} at step ${event.stepIndex}; re-binding. ${event.reason}`
      };
    case "new_tab_detected":
      return {
        status: "blocked",
        message: `${prefix}Chrome opened a new tab (${event.tabUrl}) at step ${event.stepIndex}. ${event.reason}`
      };
    case "auth_wall_detected":
      return {
        status: "blocked",
        message: `${prefix}Chrome auth wall detected at ${event.url}. ${event.reason}`
      };
    case "download_detected":
      return {
        status: "executing",
        message: `${prefix}Chrome download detected from ${event.downloadUrl} at step ${event.stepIndex}. ${event.reason}`
      };
    case "page_reload_detected":
      return {
        status: "executing",
        message: `${prefix}Chrome page reloaded at ${event.url} step ${event.stepIndex}; re-observing. ${event.reason}`
      };
    case "dom_verification_passed":
      return {
        status: "verifying",
        message: `${prefix}DOM verification passed for ${event.selector}: expected ${event.expected}, actual ${event.actual}.`
      };
    case "dom_verification_failed":
      return {
        status: "failed",
        message: `${prefix}DOM verification failed for ${event.selector}: expected ${event.expected}, actual ${event.actual}.`
      };
    case "workflow_step_started":
      return {
        status: "executing",
        message: `${prefix}Chrome workflow step ${event.stepIndex} (${event.stepKind}) started.`
      };
    case "workflow_step_completed":
      return {
        status: "verifying",
        message: `${prefix}Chrome workflow step ${event.stepIndex} (${event.stepKind}) passed.`
      };
    case "typing":
      return {
        status: "executing",
        message: `${prefix}Typing command in Ghostty.`
      };
    case "submitted":
      return {
        status: "executing",
        message: `${prefix}Submitted command with ${event.key}.`
      };
    case "screenshot_after":
      return {
        status: "verifying",
        message: `${prefix}Captured after screenshot: ${event.path}`,
        replayRecord: createObserveAppReplayRecord("after", event.observation)
      };
    case "completed": {
      const proposalSummary = "report" in event
        ? formatTmuxRecoveryProposals(event.report)
        : "";
      return {
        status: "completed",
        message: proposalSummary
          ? `${event.summary}\n${proposalSummary}`
          : event.summary,
        ...("report" in event ? { tmuxSupervisionReport: event.report } : {}),
        ...("outcome" in event ? { tmuxRecoveryOutcome: event.outcome } : {}),
        ...("result" in event ? { finderTaskResult: event.result } : {})
      };
    }
  }

  return {
    status: "failed",
    message: "Unknown task event."
  };
}

export function readTurnReplayTaskEvent(event: TaskEvent): TurnReplayTaskEvent {
  return {
    status: event.status,
    message: event.message,
    command: event.command,
    ...(event.route ? { route: event.route } : {}),
    ...(event.routeReason ? { routeReason: event.routeReason } : {}),
    ...(event.denialKind ? { denialKind: event.denialKind } : {}),
    ...(event.policyKind ? { policyKind: event.policyKind } : {}),
    ...(event.routeOutcome ? { routeOutcome: event.routeOutcome } : {}),
    ...(event.taskControl ? { taskControl: event.taskControl } : {}),
    ...(event.stopTurnBehavior ? { stopTurnBehavior: event.stopTurnBehavior } : {})
  };
}

export function withRouteTaskEventMetadata(
  event: TaskEvent,
  route: CommandRoute | ExecutableCommandRoute,
  metadata: TaskEventRouteMetadata = {}
): TaskEvent {
  const routedEvent = {
    ...event,
    ...createTaskEventRouteMetadata(route, metadata)
  };

  return {
    ...routedEvent,
    routeOutcome: createTaskEventRouteOutcome(routedEvent)
  };
}

function createTaskEventRouteOutcome(event: TaskEvent): RouteOutcome {
  return readRouteOutcome({
    currentTurn: {
      state: event.status,
      source: "task-event",
      ...(event.command ? { command: event.command } : {}),
      ...(event.route ? { route: event.route } : {}),
      ...(event.routeReason ? { routeReason: event.routeReason } : {}),
      ...(event.denialKind ? { denialKind: event.denialKind } : {}),
      ...(event.policyKind ? { policyKind: event.policyKind } : {}),
      ...(event.stopTurnBehavior ? { stopTurnBehavior: event.stopTurnBehavior } : {}),
      ...(event.message ? { latestMessage: event.message } : {})
    },
    defaultSource: "task-event",
    includeCommandDetail: false,
    sanitizeString: sanitizeTaskEventRouteOutcomeString
  });
}

function sanitizeTaskEventRouteOutcomeString(value: string): string {
  return value
    .replace(/\b(token|password|secret|api[_-]?key)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}

function formatFinderSelectionSummary(context: FinderSelectionResult): string {
  const target = context.targetPath ?? "unknown folder";
  const count = context.selection.length;
  return `${count} selected item${count === 1 ? "" : "s"} in ${target}.`;
}

function formatControlChannel(channel: string): string {
  return channel.toLowerCase() === "cdp" ? "CDP" : channel;
}

function readTaskEventCommand(event: ComputerUseTaskEvent): string {
  if ("command" in event && typeof event.command === "string") {
    return event.command;
  }
  if ("sessionName" in event && typeof event.sessionName === "string") {
    return `监督 tmux ${event.sessionName}`;
  }
  if ("action" in event && typeof event.action === "object" && event.action !== null) {
    return `恢复 tmux ${describeTmuxRecoveryAction(event.action as TmuxRecoveryAction)}`;
  }
  return "tmux task";
}

function createObserveAppReplayRecord(
  stage: "before" | "after",
  observation: DesktopAppState
): ObserveAppReplayRecord {
  return {
    ...observation,
    stage
  };
}
