import {
  readAssistantAgentProviderStates,
  type AssistantAgentProviderState,
  type AssistantAgentSettings
} from "./assistant-agent.js";
import type { AssistantAgentSettingsUpdate } from "./assistant-agent-settings.js";
import {
  createAssistantAgentSettingsResponse,
  type AssistantAgentSettingsResponse
} from "./main-renderer-payload.js";

export interface AssistantAgentSettingsStoreLike {
  get(): AssistantAgentSettings;
  set(update: AssistantAgentSettingsUpdate): AssistantAgentSettings;
}

export type ReadAssistantAgentProviderStates = (
  settings: AssistantAgentSettings
) => Promise<AssistantAgentProviderState[]>;

export async function readAssistantAgentSettingsResponse({
  store,
  readProviderStates = readAssistantAgentProviderStates
}: {
  store: AssistantAgentSettingsStoreLike;
  readProviderStates?: ReadAssistantAgentProviderStates;
}): Promise<AssistantAgentSettingsResponse> {
  return createSettingsResponse({
    settings: store.get(),
    readProviderStates
  });
}

export async function updateAssistantAgentSettingsResponse({
  store,
  update,
  readProviderStates = readAssistantAgentProviderStates
}: {
  store: AssistantAgentSettingsStoreLike;
  update: unknown;
  readProviderStates?: ReadAssistantAgentProviderStates;
}): Promise<AssistantAgentSettingsResponse> {
  return createSettingsResponse({
    settings: store.set(readAssistantAgentSettingsUpdate(update)),
    readProviderStates
  });
}

export function readAssistantAgentSettingsUpdate(update: unknown): AssistantAgentSettingsUpdate {
  return update && typeof update === "object" ? update : {};
}

async function createSettingsResponse({
  settings,
  readProviderStates
}: {
  settings: AssistantAgentSettings;
  readProviderStates: ReadAssistantAgentProviderStates;
}): Promise<AssistantAgentSettingsResponse> {
  return createAssistantAgentSettingsResponse(
    settings,
    await readProviderStates(settings)
  );
}
