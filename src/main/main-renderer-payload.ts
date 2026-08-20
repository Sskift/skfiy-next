import type {
  AssistantAgentProviderState,
  AssistantAgentSettings,
  AssistantAgentTurnResult
} from "./assistant-agent.js";
import type { AssistantAgentProviderFallback } from "./assistant-agent-provider-fallback.js";
import { readAssistantAgentFallback } from "./assistant-agent-provider-fallback.js";
import {
  readStopTurnHotkeyStatus,
  type StopTurnHotkeyStatus
} from "./stop-turn-hotkey.js";

export { createBrowserPageContextReadFailure } from "./main-browser-context-reader.js";
export { readAssistantComputerUseToolCall } from "./main-assistant-computer-use-plan.js";

export interface AssistantAgentSettingsResponse {
  settings: AssistantAgentSettings;
  providers: AssistantAgentProviderState[];
  fallback?: AssistantAgentProviderFallback;
}

export interface RuntimeStatusResponse {
  stopTurnHotkey: StopTurnHotkeyStatus;
}

export function createAssistantAgentSettingsResponse(
  settings: AssistantAgentSettings,
  providers: AssistantAgentProviderState[]
): AssistantAgentSettingsResponse {
  return {
    settings,
    providers,
    fallback: readAssistantAgentFallback(settings, providers)
  };
}

export function createRuntimeStatusResponse(
  stopTurnHotkeyRegistered: boolean
): RuntimeStatusResponse {
  return {
    stopTurnHotkey: readStopTurnHotkeyStatus(stopTurnHotkeyRegistered)
  };
}

export function createAssistantAgentTaskMessage(turn: AssistantAgentTurnResult): string {
  if (turn.status === "completed") {
    return `${turn.providerLabel}: ${turn.message}`;
  }

  return `Assistant agent failed: ${turn.error?.message ?? "unknown error"}`;
}
