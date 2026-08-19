import type { RuntimeSnapshotCurrentTurnInput } from "./runtime-snapshot.js";
import type { TaskEvent } from "./task-event-view.js";

export function createRuntimeSnapshotCurrentTurnFromTaskEvent(
  event: TaskEvent
): RuntimeSnapshotCurrentTurnInput {
  return {
    state: event.status,
    ...(event.message ? { message: event.message } : {}),
    ...(event.command ? { command: event.command } : {}),
    ...(event.route ? { route: event.route } : {}),
    ...(event.routeReason ? { routeReason: event.routeReason } : {}),
    ...(event.denialKind ? { denialKind: event.denialKind } : {}),
    ...(event.policyKind ? { policyKind: event.policyKind } : {}),
    ...(event.routeOutcome ? { routeOutcome: event.routeOutcome } : {}),
    ...(event.stopTurnBehavior ? { stopTurnBehavior: event.stopTurnBehavior } : {})
  };
}
