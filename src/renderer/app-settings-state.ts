import type {
  AppPolicy,
  AppPolicySettings,
  AssistantAgentMode,
  AssistantAgentProviderRuntime,
  AssistantAgentSettings,
  AssistantAgentSettingsResponse,
  PlannerProviderMode,
  PlannerProviderSettings
} from "./app-types";

export const APP_POLICY_OPTIONS: Array<{ policy: AppPolicy; label: string }> = [
  { policy: "allow", label: "允许" },
  { policy: "ask", label: "询问" },
  { policy: "deny", label: "拒绝" }
];

export const ASSISTANT_AGENT_OPTIONS: Array<{ mode: AssistantAgentMode; label: string; aria: string }> = [
  { mode: "codex", label: "Codex", aria: "选择 Codex background agent" },
  { mode: "claude-code", label: "Claude Code", aria: "选择 Claude Code background agent" },
  { mode: "hermes", label: "Hermes", aria: "选择 Hermes background agent" }
];

export const PLANNER_PROVIDER_OPTIONS: Array<{ mode: PlannerProviderMode; label: string; aria: string }> = [
  { mode: "local-deterministic", label: "本地确定性", aria: "选择本地确定性规划" },
  { mode: "external-cua", label: "External CUA", aria: "选择 External CUA 规划" },
  { mode: "disabled", label: "关闭", aria: "选择关闭规划" }
];

export const DEFAULT_APP_POLICY_SETTINGS: AppPolicySettings = {
  apps: [
    { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" },
    { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" },
    { name: "Finder", bundleId: "com.apple.finder", policy: "ask" }
  ]
};

export const DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE: AssistantAgentSettingsResponse = {
  settings: {
    mode: "codex",
    codexBinary: "codex",
    codexBinarySource: "default",
    claudeCodeBinary: "claude",
    claudeCodeBinarySource: "default",
    hermesBinary: "hermes",
    hermesBinarySource: "default",
    cwd: "",
    timeoutMs: 45_000
  },
  providers: [
    {
      provider: "assistant",
      id: "codex",
      label: "Codex",
      selected: true,
      configured: true,
      executablePath: "codex",
      executableSource: "default",
      readiness: "unavailable"
    },
    {
      provider: "assistant",
      id: "claude-code",
      label: "Claude Code",
      selected: false,
      configured: true,
      executablePath: "claude",
      executableSource: "default",
      readiness: "unavailable"
    },
    {
      provider: "assistant",
      id: "hermes",
      label: "Hermes",
      selected: false,
      configured: true,
      executablePath: "hermes",
      executableSource: "default",
      readiness: "unavailable"
    }
  ]
};

export const DEFAULT_PLANNER_PROVIDER_SETTINGS: PlannerProviderSettings = {
  mode: "local-deterministic",
  externalProviderLabel: "External CUA",
  externalEndpoint: undefined,
  externalApiKeyConfigured: false
};

export function reduceAppPolicySettings(
  settings: AppPolicySettings,
  update: { bundleId: string; policy: AppPolicy }
): AppPolicySettings {
  return {
    apps: settings.apps.map((entry) =>
      entry.bundleId === update.bundleId
        ? { ...entry, policy: update.policy }
        : entry
    )
  };
}

export function reduceAssistantAgentSettingsResponse(
  response: AssistantAgentSettingsResponse,
  update: {
    mode?: AssistantAgentMode;
    providerRuntime?: Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>>;
  }
): AssistantAgentSettingsResponse {
  const mode = update.mode ?? response.settings.mode;
  const providerRuntime = update.providerRuntime
    ? mergeProviderRuntime(response.settings.providerRuntime, update.providerRuntime)
    : response.settings.providerRuntime;

  return {
    ...response,
    settings: {
      ...response.settings,
      mode,
      ...(providerRuntime === undefined ? {} : { providerRuntime })
    },
    providers: response.providers.map((provider) => ({
      ...provider,
      selected: provider.id === mode
    }))
  };
}

function mergeProviderRuntime(
  current: Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>> | undefined,
  update: Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>>
): Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>> {
  const merged: Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>> = {
    ...(current ?? {})
  };

  for (const [mode, runtime] of Object.entries(update) as Array<[
    AssistantAgentMode,
    AssistantAgentProviderRuntime | undefined
  ]>) {
    if (!runtime) {
      continue;
    }
    const next: AssistantAgentProviderRuntime = { ...(merged[mode] ?? {}) };
    if (runtime.cwd !== undefined) {
      next.cwd = runtime.cwd;
    }
    if (runtime.timeoutMs !== undefined) {
      next.timeoutMs = runtime.timeoutMs;
    }
    if (Object.keys(next).length > 0) {
      merged[mode] = next;
    } else {
      delete merged[mode];
    }
  }

  return merged;
}

export function reducePlannerProviderSettings(
  settings: PlannerProviderSettings,
  update: Partial<Pick<PlannerProviderSettings, "mode">>
): PlannerProviderSettings {
  return {
    ...settings,
    mode: update.mode ?? settings.mode
  };
}
