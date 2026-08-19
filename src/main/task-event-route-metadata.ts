import type { CommandRoute, ExecutableCommandRoute } from "./task-routing.js";

export interface TaskEventRouteMetadata {
  route?: string;
  routeReason?: string;
  denialKind?: string;
  policyKind?: string;
}

export function createTaskEventRouteMetadata(
  route: CommandRoute | ExecutableCommandRoute,
  metadata: TaskEventRouteMetadata = {}
): TaskEventRouteMetadata {
  const routeLabel = metadata.route ?? readTaskEventRouteLabel(route);
  const routeReason = metadata.routeReason ?? ("reason" in route ? route.reason : undefined);
  const denialKind = metadata.denialKind ?? (route.kind === "denied" ? "user" : undefined);
  const policyKind = metadata.policyKind ?? readTaskEventPolicyKind(route);

  return {
    ...(routeLabel ? { route: routeLabel } : {}),
    ...(routeReason ? { routeReason } : {}),
    ...(denialKind ? { denialKind } : {}),
    ...(policyKind ? { policyKind } : {})
  };
}

function readTaskEventRouteLabel(route: CommandRoute | ExecutableCommandRoute): string | undefined {
  if (
    route.kind === "ghostty"
    || route.kind === "chrome"
    || route.kind === "finder"
    || route.kind === "tmux_supervision"
  ) {
    return route.kind;
  }

  return "targetRoute" in route ? route.targetRoute?.kind : undefined;
}

function readTaskEventPolicyKind(route: CommandRoute | ExecutableCommandRoute): string | undefined {
  if (route.kind === "blocked" || route.kind === "needs_confirmation") {
    return "route-policy";
  }

  return undefined;
}
