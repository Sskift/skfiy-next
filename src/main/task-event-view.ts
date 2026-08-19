import type {
  DesktopAppState,
  FinderSelectionResult
} from "./computer-use/types.js";
import type { TurnReplayTaskEvent } from "./computer-use/turn-replay-store.js";
import type { TmuxSupervisionReport } from "./computer-use/tmux-supervisor.js";
import type { GhosttyTaskEvent } from "./orchestrator/events.js";
import type {
  ChromeTaskEvent
} from "./orchestrator/chrome-task.js";
import type {
  FinderPlanPreview,
  FinderTaskEvent
} from "./orchestrator/finder-task.js";
import type { TmuxSupervisionTaskEvent } from "./orchestrator/tmux-supervision-task.js";
import type { CommandRoute, ExecutableCommandRoute } from "./task-routing.js";
import {
  createTaskEventRouteMetadata,
  type TaskEventRouteMetadata
} from "./task-event-route-metadata.js";
import {
  readRouteOutcome,
  type RouteOutcome
} from "../shared/route-outcome.js";

export type ManualMode = "active" | "quiet";
export type TaskStatus =
  | "idle"
  | "planned"
  | "observing"
  | "executing"
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
  | TmuxSupervisionTaskEvent;

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
  stopTurnBehavior?: TaskEventStopTurnBehavior;
  replayReset?: boolean;
  replayRecord?: ObserveAppReplayRecord;
  finderSelection?: FinderSelectionResult;
  finderPlanPreview?: FinderPlanPreview;
  tmuxSupervisionReport?: TmuxSupervisionReport;
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
        status: "executing",
        message: `${prefix}Risk ${event.risk.level}: ${event.risk.reason}`,
        replayReset: true
      };
    case "approval_required":
      return {
        status: "approval_required",
        message: `Approval required (${event.risk.level}): ${event.risk.reason}`,
        command: "command" in event ? event.command : `监督 tmux ${event.sessionName}`
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
      return {
        status: event.status === "passed" ? "executing" : "needs_confirmation",
        message: event.status === "passed"
          ? `${prefix}Verified ${event.actionType}: ${event.message ?? "passed."}`
          : `${prefix}Verification needs confirmation for ${event.actionType}: ${event.reason ?? event.status}`
      };
    case "verification_failed":
      if (event.stage === "permissions") {
        return {
          status: "failed",
          message: `${prefix}${event.reason}`
        };
      }

      return {
        status: "needs_confirmation",
        message: `${prefix}Verification failed (${event.stage}): ${event.reason}`
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
        status: "observing",
        message: `${prefix}Captured after screenshot: ${event.path}`,
        replayRecord: createObserveAppReplayRecord("after", event.observation)
      };
    case "completed":
      return {
        status: "completed",
        message: event.summary,
        ...("report" in event ? { tmuxSupervisionReport: event.report } : {})
      };
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

function createObserveAppReplayRecord(
  stage: "before" | "after",
  observation: DesktopAppState
): ObserveAppReplayRecord {
  return {
    ...observation,
    stage
  };
}
