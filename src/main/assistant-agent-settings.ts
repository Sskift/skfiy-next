import {
  isAssistantAgentMode,
  readInitialAssistantAgentSettings,
  type AssistantAgentMode,
  type AssistantAgentProviderRuntime,
  type AssistantAgentSettings
} from "./assistant-agent.js";

export interface AssistantAgentSettingsUpdate {
  mode?: unknown;
  providerRuntime?: unknown;
}

export function readInitialAssistantAgentSettingsFromConfig(
  env: {
    SKFIY_ASSISTANT_AGENT?: string;
    SKFIY_CODEX_BIN?: string;
    SKFIY_CLAUDE_CODE_BIN?: string;
    SKFIY_HERMES_BIN?: string;
    SKFIY_ASSISTANT_AGENT_CWD?: string;
    SKFIY_ASSISTANT_AGENT_TIMEOUT_MS?: string;
  },
  defaults: { cwd?: string } = {}
): AssistantAgentSettings {
  return readInitialAssistantAgentSettings(env, defaults);
}

export function createAssistantAgentSettingsStore(initialSettings: AssistantAgentSettings) {
  let settings = initialSettings;

  return {
    get(): AssistantAgentSettings {
      return settings;
    },
    set(update: AssistantAgentSettingsUpdate): AssistantAgentSettings {
      const providerRuntime = readProviderRuntimeUpdate(
        settings.providerRuntime,
        update.providerRuntime
      );

      settings = {
        ...settings,
        mode: isAssistantAgentMode(update.mode) ? update.mode : settings.mode,
        ...(providerRuntime === undefined ? {} : { providerRuntime })
      };

      return settings;
    }
  };
}

export function isAssistantAgentModeValue(value: unknown): value is AssistantAgentMode {
  return isAssistantAgentMode(value);
}

function readProviderRuntimeUpdate(
  current: Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>> | undefined,
  update: unknown
): Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>> | undefined {
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return current;
  }

  const merged: Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>> = {
    ...(current ?? {})
  };
  let changed = false;

  for (const [mode, runtime] of Object.entries(update as Record<string, unknown>)) {
    if (!isAssistantAgentMode(mode) || !runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
      continue;
    }

    const candidate = runtime as Record<string, unknown>;
    const existing = merged[mode] ?? {};
    const next: AssistantAgentProviderRuntime = { ...existing };
    let modeChanged = false;

    if (typeof candidate.cwd === "string" && candidate.cwd.trim().length > 0) {
      next.cwd = candidate.cwd.trim();
      modeChanged = true;
    } else if (candidate.cwd === null) {
      delete next.cwd;
      modeChanged = true;
    }

    if (
      typeof candidate.timeoutMs === "number"
      && Number.isSafeInteger(candidate.timeoutMs)
      && candidate.timeoutMs > 0
    ) {
      next.timeoutMs = candidate.timeoutMs;
      modeChanged = true;
    } else if (candidate.timeoutMs === null) {
      delete next.timeoutMs;
      modeChanged = true;
    }

    if (!modeChanged) {
      continue;
    }

    if (Object.keys(next).length > 0) {
      merged[mode] = next;
    } else {
      delete merged[mode];
    }
    changed = true;
  }

  return changed ? merged : current;
}
