import {
  readInitialAssistantAgentSettings,
  type AssistantAgentMode,
  type AssistantAgentSettings
} from "./assistant-agent.js";

export interface AssistantAgentSettingsUpdate {
  mode?: unknown;
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
      settings = {
        ...settings,
        mode: isAssistantAgentMode(update.mode) ? update.mode : settings.mode
      };

      return settings;
    }
  };
}

export function isAssistantAgentMode(value: unknown): value is AssistantAgentMode {
  return value === "codex" || value === "claude-code" || value === "hermes";
}
