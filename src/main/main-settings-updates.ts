import type { AppPolicySettingsUpdate } from "./app-policy-settings.js";
import type { PlannerProviderSettingsUpdate } from "./planner-provider-settings.js";

export function readAppPolicySettingsUpdate(update: unknown): AppPolicySettingsUpdate {
  return readSettingsUpdate(update);
}

export function readPlannerProviderSettingsUpdate(update: unknown): PlannerProviderSettingsUpdate {
  return readSettingsUpdate(update);
}

function readSettingsUpdate(update: unknown): Record<string, unknown> {
  return update && typeof update === "object" && !Array.isArray(update)
    ? update as Record<string, unknown>
    : {};
}
