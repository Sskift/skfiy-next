import type { ComputerUseCommandRoute, PendingApproval } from "./main-pending-approval.js";
import { createStopTurnTaskEvent } from "./main-route-task-events.js";
import type { TaskEvent } from "./task-event-view.js";

export const STOP_TASK_MESSAGE = "Task stopped.";

export type StopTaskEventDelivery = "turn-replay" | "transient";

export interface StopTaskEventDecision {
  cancellationReason: string;
  delivery: StopTaskEventDelivery;
  event: TaskEvent;
  route: ComputerUseCommandRoute | null;
}

export interface CreateStopTaskEventDecisionOptions {
  activeRoute: ComputerUseCommandRoute | null;
  message?: string;
  pendingApproval: PendingApproval | null;
}

export function createStopTaskEventDecision({
  activeRoute,
  message = STOP_TASK_MESSAGE,
  pendingApproval
}: CreateStopTaskEventDecisionOptions): StopTaskEventDecision {
  const route = pendingApproval?.route ?? activeRoute;

  return {
    cancellationReason: message,
    delivery: route ? "turn-replay" : "transient",
    event: createStopTurnTaskEvent(route, message),
    route
  };
}
