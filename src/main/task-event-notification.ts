export type TaskEventNotificationStatus =
  | "approval_required"
  | "needs_confirmation"
  | "needs_clarification"
  | "completed"
  | "failed"
  | "blocked";

export interface TaskEventNotificationEvent {
  taskId: string;
  status: TaskEventNotificationStatus;
}

export interface TaskEventNotificationContext {
  windowFocused: boolean;
}

export interface TaskEventNotice {
  taskId: string;
  status: TaskEventNotificationStatus;
  title: string;
  body: string;
}

export interface TaskEventNotificationCoordinator {
  take: (
    value: unknown,
    context: TaskEventNotificationContext
  ) => TaskEventNotice | null;
}

const MAX_TASK_ID_LENGTH = 240;

const TERMINAL_TASK_EVENT_STATUSES: readonly TaskEventNotificationStatus[] = [
  "completed",
  "failed",
  "blocked"
];

const ATTENTION_TASK_EVENT_STATUSES: readonly TaskEventNotificationStatus[] = [
  "approval_required",
  "needs_confirmation",
  "needs_clarification"
];

export function createTaskEventNotificationCoordinator({
  maxRemembered = 256
}: {
  maxRemembered?: number;
} = {}): TaskEventNotificationCoordinator {
  const rememberedNotices = new Set<string>();
  const insertionOrder: string[] = [];
  const boundedMaximum = Math.max(1, Math.floor(maxRemembered));

  return {
    take(value, context) {
      const event = readTaskEventNotificationEvent(value);
      if (!event || context.windowFocused) {
        return null;
      }

      const dedupeKey = `${event.taskId}:${event.status}`;
      if (rememberedNotices.has(dedupeKey)) {
        return null;
      }

      rememberedNotices.add(dedupeKey);
      insertionOrder.push(dedupeKey);
      while (insertionOrder.length > boundedMaximum) {
        const oldestKey = insertionOrder.shift();
        if (oldestKey) rememberedNotices.delete(oldestKey);
      }

      return createTaskEventNotice(event);
    }
  };
}

export function readTaskEventNotificationEvent(
  value: unknown
): TaskEventNotificationEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || !("taskId" in record)
    || !("status" in record)
  ) {
    return null;
  }
  const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
  const status = normalizeTaskEventNotificationStatus(record.status);
  if (!taskId || taskId.length > MAX_TASK_ID_LENGTH || !status) {
    return null;
  }

  return { taskId, status };
}

export function isTaskEventNotificationStatus(
  value: unknown
): value is TaskEventNotificationStatus {
  return typeof value === "string"
    && (
      ATTENTION_TASK_EVENT_STATUSES.includes(value as TaskEventNotificationStatus)
      || TERMINAL_TASK_EVENT_STATUSES.includes(value as TaskEventNotificationStatus)
    );
}

function normalizeTaskEventNotificationStatus(
  value: unknown
): TaskEventNotificationStatus | undefined {
  return isTaskEventNotificationStatus(value) ? value : undefined;
}

function createTaskEventNotice(
  event: TaskEventNotificationEvent
): TaskEventNotice {
  if (event.status === "completed") {
    return {
      taskId: event.taskId,
      status: event.status,
      title: "Task completed",
      body: "A task finished in skfiy."
    };
  }
  if (event.status === "failed") {
    return {
      taskId: event.taskId,
      status: event.status,
      title: "Task failed",
      body: "A task failed in skfiy. Open to review."
    };
  }
  if (event.status === "blocked") {
    return {
      taskId: event.taskId,
      status: event.status,
      title: "Task blocked",
      body: "A task is blocked in skfiy. Open to review."
    };
  }
  return {
    taskId: event.taskId,
    status: event.status,
    title: "Approval requested",
    body: "A task is waiting for your approval in skfiy."
  };
}
