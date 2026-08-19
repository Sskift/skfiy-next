import type {
  AutomationMonitorNotificationEvent,
  AutomationMonitorNotificationOutcome
} from "./automation-monitor.js";

export interface AutomationMonitorNotificationContext {
  windowFocused: boolean;
}

export interface AutomationMonitorNotice {
  runId: string;
  outcome: AutomationMonitorNotificationOutcome;
  title: string;
  body: string;
}

export interface AutomationMonitorNotificationCoordinator {
  take: (
    value: unknown,
    context: AutomationMonitorNotificationContext
  ) => AutomationMonitorNotice | null;
}

const MAX_RUN_ID_LENGTH = 240;
const MAX_LABEL_LENGTH = 80;

export function createAutomationMonitorNotificationCoordinator({
  maxRemembered = 256
}: {
  maxRemembered?: number;
} = {}): AutomationMonitorNotificationCoordinator {
  const rememberedRunIds = new Set<string>();
  const insertionOrder: string[] = [];
  const boundedMaximum = Math.max(1, Math.floor(maxRemembered));

  return {
    take(value, context) {
      const event = readAutomationMonitorNotificationEvent(value);
      if (!event || context.windowFocused || rememberedRunIds.has(event.runId)) {
        return null;
      }

      rememberedRunIds.add(event.runId);
      insertionOrder.push(event.runId);
      while (insertionOrder.length > boundedMaximum) {
        const oldestRunId = insertionOrder.shift();
        if (oldestRunId) rememberedRunIds.delete(oldestRunId);
      }

      return createAutomationMonitorNotice(event);
    }
  };
}

export function readAutomationMonitorNotificationEvent(
  value: unknown
): AutomationMonitorNotificationEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3
    || !("runId" in record)
    || !("label" in record)
    || !("outcome" in record)
  ) {
    return null;
  }
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  const label = normalizeAutomationMonitorNotificationLabel(record.label);
  const outcome = normalizeAutomationMonitorNotificationOutcome(record.outcome);
  if (!runId || runId.length > MAX_RUN_ID_LENGTH || !label || !outcome) {
    return null;
  }

  return { runId, label, outcome };
}

function createAutomationMonitorNotice(
  event: AutomationMonitorNotificationEvent
): AutomationMonitorNotice {
  if (event.outcome === "completed") {
    return {
      runId: event.runId,
      outcome: event.outcome,
      title: "Automation completed",
      body: `${event.label} completed its read-only check.`
    };
  }
  if (event.outcome === "attention") {
    return {
      runId: event.runId,
      outcome: event.outcome,
      title: "Automation needs attention",
      body: `${event.label} found a result to review in skfiy.`
    };
  }
  return {
    runId: event.runId,
    outcome: event.outcome,
    title: "Automation check failed",
    body: `${event.label} could not complete its read-only check. Open skfiy to review.`
  };
}

function normalizeAutomationMonitorNotificationOutcome(
  value: unknown
): AutomationMonitorNotificationOutcome | undefined {
  return value === "completed" || value === "attention" || value === "failure"
    ? value
    : undefined;
}

function normalizeAutomationMonitorNotificationLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, MAX_LABEL_LENGTH) : undefined;
}
