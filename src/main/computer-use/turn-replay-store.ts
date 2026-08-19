import {
  createTurnTranscript,
  type ComputerUseTurnEvent,
  type TurnTranscript,
  type TurnTranscriptAction,
  type TurnTranscriptOutcome
} from "./turn-transcript.js";
import {
  isRouteOutcomeKind,
  isRouteOutcomeTone,
  readRouteOutcome,
  type RouteOutcome
} from "../../shared/route-outcome.js";

export type TurnReplayTaskStatus =
  | "idle"
  | "planned"
  | "observing"
  | "executing"
  | "approval_required"
  | "needs_confirmation"
  | "needs_clarification"
  | "running"
  | "completed"
  | "denied"
  | "blocked"
  | "cancelled"
  | "failed";

export interface TurnReplayTaskEvent {
  status: TurnReplayTaskStatus;
  message?: string;
  command?: string;
  turnId?: string;
  toolCallId?: string;
  route?: string;
  routeReason?: string;
  denialKind?: string;
  policyKind?: string;
  routeOutcome?: RouteOutcome;
  stopTurnBehavior?: TurnReplayStopTurnBehavior;
}

export interface TurnReplayStopTurnBehavior {
  result?: string;
  source?: string;
  command?: string;
  beforeStatus?: string;
  beforeMessage?: string;
  afterStatus?: string;
  afterMessage?: string;
}

export interface TurnReplay {
  transcript: TurnTranscript;
  routeOutcome?: RouteOutcome;
  timeline: TurnReplayTaskEvent[];
}

export interface TurnReplayStoreOptions {
  onReplayChanged?: (replay: TurnReplay | null) => void;
}

export function createTurnReplayStore(options: TurnReplayStoreOptions = {}) {
  let active = false;
  let hasReplay = false;
  let computerUseEvents: ComputerUseTurnEvent[] = [];
  let timeline: TurnReplayTaskEvent[] = [];

  const notifyReplayChanged = () => {
    options.onReplayChanged?.(readReplay());
  };

  return {
    startTurn(): void {
      active = true;
      hasReplay = true;
      computerUseEvents = [];
      timeline = [];
      notifyReplayChanged();
    },
    recordComputerUseEvent(event: ComputerUseTurnEvent): void {
      if (!hasReplay) {
        return;
      }

      computerUseEvents = [...computerUseEvents, event];

      if (event.type === "completed") {
        active = false;
      }
      notifyReplayChanged();
    },
    recordTaskEvent(event: TurnReplayTaskEvent): void {
      if (!hasReplay) {
        return;
      }

      timeline = [...timeline, sanitizeTurnReplayTaskEvent(event)];

      if (
        event.status === "completed"
        || event.status === "failed"
        || event.status === "denied"
        || event.status === "blocked"
        || event.status === "cancelled"
        || event.status === "needs_confirmation"
        || event.status === "needs_clarification"
        || event.status === "idle"
      ) {
        active = false;
      }
      notifyReplayChanged();
    },
    getReplay(): TurnReplay | null {
      return readReplay();
    }
  };

  function readReplay(): TurnReplay | null {
    if (!hasReplay && !active) {
      return null;
    }

    const transcript = createReplayTranscript(computerUseEvents, timeline);

    return {
      transcript,
      routeOutcome: createReplayRouteOutcome(transcript, timeline),
      timeline: timeline.map((event) => ({ ...event }))
    };
  }
}

function createReplayTranscript(
  events: readonly ComputerUseTurnEvent[],
  timeline: readonly TurnReplayTaskEvent[]
): TurnTranscript {
  const transcript = createTurnTranscript(events);
  const finalStatus = timeline.at(-1)?.status;

  if (
    finalStatus === "failed"
    || finalStatus === "denied"
    || finalStatus === "blocked"
    || finalStatus === "cancelled"
    || finalStatus === "needs_confirmation"
    || finalStatus === "needs_clarification"
  ) {
    return {
      ...transcript,
      outcome: finalStatus
    };
  }

  return transcript;
}

function createReplayRouteOutcome(
  transcript: TurnTranscript,
  timeline: readonly TurnReplayTaskEvent[]
): RouteOutcome {
  const latestTimelineEvent = timeline.at(-1);
  const explicitRouteOutcome = sanitizeTurnReplayRouteOutcome(latestTimelineEvent?.routeOutcome);

  if (explicitRouteOutcome) {
    return explicitRouteOutcome;
  }

  const latestToolAction = transcript.actions.filter(isRouteToolAction).at(-1);
  const currentTurn = {
    state: latestTimelineEvent?.status ?? readRouteStateFromTranscriptOutcome(transcript.outcome),
    source: "turn-replay",
    ...(transcript.command ? { command: transcript.command } : {}),
    ...(latestTimelineEvent?.command ? { command: latestTimelineEvent.command } : {}),
    ...(latestTimelineEvent?.route ? { route: latestTimelineEvent.route } : {}),
    ...(latestTimelineEvent?.routeReason ? { routeReason: latestTimelineEvent.routeReason } : {}),
    ...(latestTimelineEvent?.denialKind ? { denialKind: latestTimelineEvent.denialKind } : {}),
    ...(latestTimelineEvent?.policyKind ? { policyKind: latestTimelineEvent.policyKind } : {}),
    ...(latestTimelineEvent?.message ? { latestMessage: latestTimelineEvent.message } : {}),
    ...(latestToolAction ? { latestAction: summarizeRouteToolAction(latestToolAction) } : {})
  };
  const replay = {
    source: "turn-replay",
    outcome: transcript.outcome,
    ...(latestTimelineEvent?.message ? { latestMessage: latestTimelineEvent.message } : {}),
    ...(latestToolAction ? { latestToolCall: summarizeRouteToolAction(latestToolAction) } : {})
  };

  return readRouteOutcome({
    currentTurn,
    replay,
    defaultSource: "turn-replay",
    includeCommandDetail: false,
    sanitizeString: sanitizeTurnReplayRouteOutcomeString
  });
}

function sanitizeTurnReplayTaskEvent(event: TurnReplayTaskEvent): TurnReplayTaskEvent {
  const { routeOutcome, ...eventWithoutRouteOutcome } = event;
  const sanitizedRouteOutcome = sanitizeTurnReplayRouteOutcome(routeOutcome);

  return {
    ...eventWithoutRouteOutcome,
    ...(sanitizedRouteOutcome ? { routeOutcome: sanitizedRouteOutcome } : {})
  };
}

function sanitizeTurnReplayRouteOutcome(value: unknown): RouteOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const kind = isRouteOutcomeKind(record.kind) ? record.kind : undefined;
  const title = readSanitizedTurnReplayRouteOutcomeString(record.title);
  const outcomeValue = readSanitizedTurnReplayRouteOutcomeString(record.value);
  const detail = readSanitizedTurnReplayRouteOutcomeString(record.detail);
  const tone = isRouteOutcomeTone(record.tone) ? record.tone : undefined;
  const source = readSanitizedTurnReplayRouteOutcomeString(record.source);
  const routeLabel = readSanitizedTurnReplayRouteOutcomeString(record.routeLabel);
  const state = readSanitizedTurnReplayRouteOutcomeString(record.state);
  const denialKind = readSanitizedTurnReplayRouteOutcomeString(record.denialKind);
  const policyKind = readSanitizedTurnReplayRouteOutcomeString(record.policyKind);

  if (!kind || !title || !outcomeValue || !detail || !tone || !source || !routeLabel || !state) {
    return undefined;
  }

  return {
    kind,
    title,
    value: outcomeValue,
    detail,
    tone,
    source,
    routeLabel,
    state,
    ...(denialKind ? { denialKind } : {}),
    ...(policyKind ? { policyKind } : {})
  };
}

function readSanitizedTurnReplayRouteOutcomeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? sanitizeTurnReplayRouteOutcomeString(value)
    : undefined;
}

function readRouteStateFromTranscriptOutcome(outcome: TurnTranscriptOutcome): string {
  if (outcome === "verification_failed") {
    return "needs_confirmation";
  }

  return outcome;
}

function isRouteToolAction(
  action: TurnTranscriptAction
): action is Extract<TurnTranscriptAction, { type: "tool_call" | "tool_result" }> {
  return action.type === "tool_call" || action.type === "tool_result";
}

function summarizeRouteToolAction(
  action: Extract<TurnTranscriptAction, { type: "tool_call" | "tool_result" }>
): Record<string, unknown> {
  return {
    type: action.type,
    route: action.route,
    status: action.status,
    ...("summary" in action && action.summary ? { summary: action.summary } : {}),
    ...("evidenceSummary" in action && action.evidenceSummary
      ? { evidenceSummary: action.evidenceSummary }
      : {}),
    ...("command" in action && action.command ? { command: action.command } : {})
  };
}

function sanitizeTurnReplayRouteOutcomeString(value: string): string {
  return value
    .replace(/\b(token|password|secret|api[_-]?key)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}
