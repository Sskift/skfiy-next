import type { AssistantAgentTurnStatus } from "./assistant-agent.js";
import type { CommandRoute, ExecutableCommandRoute } from "./task-routing.js";

export type RunCommandRouteDecision =
  | { kind: "chat"; route: Extract<CommandRoute, { kind: "chat" }> }
  | { kind: "assistant_failed"; route: CommandRoute }
  | { kind: "needs_clarification"; route: Extract<CommandRoute, { kind: "needs_clarification" }> }
  | { kind: "terminal_route_state"; route: Extract<CommandRoute, { kind: "denied" | "blocked" }> }
  | {
    kind: "needs_confirmation";
    route: Extract<CommandRoute, { kind: "needs_confirmation" }>;
    executionRoute: ExecutableCommandRoute;
  }
  | { kind: "continue"; route: ExecutableCommandRoute; executionRoute: ExecutableCommandRoute };

export function createRunCommandRouteDecision({
  approved,
  assistantTurnStatus,
  route
}: {
  approved: boolean;
  assistantTurnStatus: AssistantAgentTurnStatus;
  route: CommandRoute;
}): RunCommandRouteDecision {
  if (route.kind === "chat") {
    return { kind: "chat", route };
  }

  if (route.kind === "needs_clarification") {
    return { kind: "needs_clarification", route };
  }

  if (route.kind === "denied" || route.kind === "blocked") {
    return { kind: "terminal_route_state", route };
  }

  if (assistantTurnStatus !== "completed") {
    return { kind: "assistant_failed", route };
  }

  if (route.kind === "needs_confirmation") {
    return approved
      ? {
        kind: "continue",
        route: route.targetRoute,
        executionRoute: route.targetRoute
      }
      : {
        kind: "needs_confirmation",
        route,
        executionRoute: route.targetRoute
      };
  }

  return {
    kind: "continue",
    route,
    executionRoute: route
  };
}
