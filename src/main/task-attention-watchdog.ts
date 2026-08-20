export const TASK_ATTENTION_THRESHOLD_MS = 300_000;

export const TASK_ATTENTION_ACTIVE_STATUSES = [
  "waiting",
  "running",
  "executing"
] as const;

export type TaskAttentionActiveStatus = (typeof TASK_ATTENTION_ACTIVE_STATUSES)[number];

export const TASK_ATTENTION_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "denied"
] as const;

export type TaskAttentionTerminalStatus = (typeof TASK_ATTENTION_TERMINAL_STATUSES)[number];

export interface TaskAttentionScheduler {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface TaskAttentionWatchdogOptions {
  thresholdMs?: number;
  maxRemembered?: number;
  scheduler?: TaskAttentionScheduler;
  onAttention: (taskId: string) => void;
}

export interface TaskAttentionWatchdog {
  start: (taskId: string) => void;
  reset: () => void;
  stop: () => void;
}

const defaultScheduler: TaskAttentionScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export function isTaskAttentionActiveStatus(
  value: unknown
): value is TaskAttentionActiveStatus {
  return typeof value === "string"
    && (TASK_ATTENTION_ACTIVE_STATUSES as readonly string[]).includes(value);
}

export function isTaskAttentionTerminalStatus(
  value: unknown
): value is TaskAttentionTerminalStatus {
  return typeof value === "string"
    && (TASK_ATTENTION_TERMINAL_STATUSES as readonly string[]).includes(value);
}

export function createTaskAttentionWatchdog({
  thresholdMs = TASK_ATTENTION_THRESHOLD_MS,
  maxRemembered = 256,
  scheduler = defaultScheduler,
  onAttention
}: TaskAttentionWatchdogOptions): TaskAttentionWatchdog {
  const boundedThreshold = Math.max(1, Math.floor(thresholdMs));
  const boundedMaximum = Math.max(1, Math.floor(maxRemembered));
  const firedTaskIds = new Set<string>();
  const firedInsertionOrder: string[] = [];
  let armedTaskId: string | null = null;
  let timerHandle: unknown = null;
  let stopped = false;

  function clearTimer(): void {
    if (timerHandle !== null) {
      scheduler.clearTimeout(timerHandle);
      timerHandle = null;
    }
  }

  function rememberFired(taskId: string): void {
    if (firedTaskIds.has(taskId)) {
      return;
    }
    firedTaskIds.add(taskId);
    firedInsertionOrder.push(taskId);
    while (firedInsertionOrder.length > boundedMaximum) {
      const oldestTaskId = firedInsertionOrder.shift();
      if (oldestTaskId) firedTaskIds.delete(oldestTaskId);
    }
  }

  function fire(): void {
    timerHandle = null;
    const taskId = armedTaskId;
    armedTaskId = null;
    if (!taskId || stopped) {
      return;
    }
    rememberFired(taskId);
    onAttention(taskId);
  }

  return {
    start(taskId) {
      if (stopped || typeof taskId !== "string" || taskId.trim().length === 0) {
        return;
      }
      const normalizedTaskId = taskId.trim();
      if (armedTaskId === normalizedTaskId || firedTaskIds.has(normalizedTaskId)) {
        return;
      }
      clearTimer();
      armedTaskId = normalizedTaskId;
      timerHandle = scheduler.setTimeout(fire, boundedThreshold);
    },
    reset() {
      clearTimer();
      armedTaskId = null;
    },
    stop() {
      stopped = true;
      clearTimer();
      armedTaskId = null;
    }
  };
}
