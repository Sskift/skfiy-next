export type PlannerProviderMode =
  | "local-deterministic"
  | "external-cua"
  | "disabled";

export interface PlannerProviderSettings {
  mode: PlannerProviderMode;
  externalProviderLabel: string;
  externalEndpoint?: string;
  externalApiKeyConfigured: boolean;
}

export interface PlannerProviderSettingsUpdate {
  mode?: unknown;
  externalProviderLabel?: unknown;
  externalEndpoint?: unknown;
  externalApiKey?: unknown;
}

export interface PlannerProviderSettingsSummary extends PlannerProviderSettings {
  provider: "planner";
}

const DEFAULT_EXTERNAL_PROVIDER_LABEL = "External CUA";

export function readInitialPlannerProviderSettings(
  env: {
    SKFIY_PLANNER_MODE?: string;
    SKFIY_EXTERNAL_CUA_ENDPOINT?: string;
    SKFIY_EXTERNAL_CUA_API_KEY?: string;
  }
): PlannerProviderSettings {
  return {
    mode: isPlannerProviderMode(env.SKFIY_PLANNER_MODE)
      ? env.SKFIY_PLANNER_MODE
      : "local-deterministic",
    externalProviderLabel: DEFAULT_EXTERNAL_PROVIDER_LABEL,
    externalEndpoint: readOptionalUrl(env.SKFIY_EXTERNAL_CUA_ENDPOINT),
    externalApiKeyConfigured: readOptionalString(env.SKFIY_EXTERNAL_CUA_API_KEY) !== undefined
  };
}

export function createPlannerProviderSettingsStore(
  initialSettings: PlannerProviderSettings
) {
  let settings = initialSettings;

  return {
    get(): PlannerProviderSettings {
      return settings;
    },
    set(update: PlannerProviderSettingsUpdate): PlannerProviderSettings {
      const externalProviderLabel = readOptionalString(update.externalProviderLabel);
      const externalEndpoint = readOptionalUrl(update.externalEndpoint);
      const externalApiKey = typeof update.externalApiKey === "string"
        ? update.externalApiKey
        : undefined;

      settings = {
        ...settings,
        mode: isPlannerProviderMode(update.mode) ? update.mode : settings.mode,
        externalProviderLabel: externalProviderLabel ?? settings.externalProviderLabel,
        externalEndpoint: externalEndpoint ?? settings.externalEndpoint,
        externalApiKeyConfigured: externalApiKey !== undefined
          ? externalApiKey.trim().length > 0
          : settings.externalApiKeyConfigured
      };

      return settings;
    }
  };
}

export function summarizePlannerProviderSettings(
  settings: PlannerProviderSettings
): PlannerProviderSettingsSummary {
  return {
    provider: "planner",
    mode: settings.mode,
    externalProviderLabel: settings.externalProviderLabel,
    externalEndpoint: settings.externalEndpoint,
    externalApiKeyConfigured: settings.externalApiKeyConfigured
  };
}

export function isPlannerProviderMode(value: unknown): value is PlannerProviderMode {
  return (
    value === "local-deterministic"
    || value === "external-cua"
    || value === "disabled"
  );
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readOptionalUrl(value: unknown): string | undefined {
  const candidate = readOptionalString(value);
  if (!candidate) {
    return undefined;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
