export type AppPolicy = "allow" | "ask" | "deny";

export interface ControlledAppPolicyEntry {
  name: string;
  bundleId: string;
  policy: AppPolicy;
}

export interface AppPolicySettings {
  apps: ControlledAppPolicyEntry[];
}

export interface AppPolicySettingsUpdate {
  bundleId?: unknown;
  policy?: unknown;
}

export interface AppPolicyDecision {
  decision: AppPolicy;
  reason: string;
}

const DEFAULT_APP_POLICIES: ControlledAppPolicyEntry[] = [
  { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" },
  { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" },
  { name: "Finder", bundleId: "com.apple.finder", policy: "ask" }
];

export function readInitialAppPolicySettings(): AppPolicySettings {
  return {
    apps: DEFAULT_APP_POLICIES.map((entry) => ({ ...entry }))
  };
}

export function decideAppPolicy(
  settings: AppPolicySettings,
  bundleId: string
): AppPolicyDecision {
  const entry = settings.apps.find((app) => app.bundleId === bundleId);

  if (!entry) {
    return {
      decision: "ask",
      reason: "Unknown app requires approval by app policy."
    };
  }

  if (entry.policy === "allow") {
    return {
      decision: "allow",
      reason: `${entry.name} is allowed by app policy.`
    };
  }

  if (entry.policy === "deny") {
    return {
      decision: "deny",
      reason: `${entry.name} is denied by app policy.`
    };
  }

  return {
    decision: "ask",
    reason: `${entry.name} requires approval by app policy.`
  };
}

export function createAppPolicySettingsStore(initialSettings: AppPolicySettings) {
  let settings = cloneSettings(initialSettings);

  return {
    get(): AppPolicySettings {
      return cloneSettings(settings);
    },
    set(update: AppPolicySettingsUpdate): AppPolicySettings {
      if (typeof update.bundleId !== "string" || !isAppPolicy(update.policy)) {
        return cloneSettings(settings);
      }

      const nextPolicy = update.policy;
      settings = {
        apps: settings.apps.map((entry) =>
          entry.bundleId === update.bundleId
            ? { ...entry, policy: nextPolicy }
            : entry
        )
      };

      return cloneSettings(settings);
    }
  };
}

export function isAppPolicy(value: unknown): value is AppPolicy {
  return value === "allow" || value === "ask" || value === "deny";
}

function cloneSettings(settings: AppPolicySettings): AppPolicySettings {
  return {
    apps: settings.apps.map((entry) => ({ ...entry }))
  };
}
