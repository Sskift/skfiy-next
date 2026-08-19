import type { PlannerProviderSettings } from "./planner-provider-settings.js";

export type PlannerProviderRuntimeDecision =
  | { decision: "run-local-deterministic" }
  | { decision: "run-external-cua"; label: string; endpoint: string }
  | { decision: "unavailable"; status: "failed"; message: string };

export function decidePlannerProviderRuntime(
  settings: PlannerProviderSettings
): PlannerProviderRuntimeDecision {
  if (settings.mode === "local-deterministic") {
    return { decision: "run-local-deterministic" };
  }

  if (settings.mode === "external-cua") {
    if (!settings.externalEndpoint) {
      return {
        decision: "unavailable",
        status: "failed",
        message: "External CUA endpoint is not configured. Set SKFIY_EXTERNAL_CUA_ENDPOINT."
      };
    }

    if (!settings.externalApiKeyConfigured) {
      return {
        decision: "unavailable",
        status: "failed",
        message: "External CUA API key is not configured. Set SKFIY_EXTERNAL_CUA_API_KEY."
      };
    }

    return {
      decision: "run-external-cua",
      label: settings.externalProviderLabel,
      endpoint: settings.externalEndpoint
    };
  }

  return {
    decision: "unavailable",
    status: "failed",
    message: "Computer Use planner is disabled in settings."
  };
}
