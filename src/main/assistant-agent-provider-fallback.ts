import type {
  AssistantAgentMode,
  AssistantAgentProviderReadiness,
  AssistantAgentProviderState,
  AssistantAgentSettings
} from "./assistant-agent.js";

export type AssistantAgentProviderFallback =
  | {
      kind: "fallback";
      requestedMode: AssistantAgentMode;
      activeMode: AssistantAgentMode;
      reason: string;
    }
  | {
      kind: "offline";
      requestedMode: AssistantAgentMode;
      reason: string;
    };

const AVAILABLE_READINESS: readonly AssistantAgentProviderReadiness[] = [
  "chat-ready",
  "version-ok"
];

export function isAssistantAgentProviderAvailable(
  readiness: AssistantAgentProviderReadiness
): boolean {
  return AVAILABLE_READINESS.includes(readiness);
}

export function readAssistantAgentFallback(
  settings: AssistantAgentSettings,
  providers: AssistantAgentProviderState[]
): AssistantAgentProviderFallback | undefined {
  const selected = providers.find((provider) => provider.id === settings.mode);
  if (!selected || isAssistantAgentProviderAvailable(selected.readiness)) {
    return undefined;
  }

  const fallbackProvider = providers.find(
    (provider) =>
      provider.id !== settings.mode
      && isAssistantAgentProviderAvailable(provider.readiness)
  );

  if (fallbackProvider) {
    return {
      kind: "fallback",
      requestedMode: settings.mode,
      activeMode: fallbackProvider.id,
      reason: `${selected.label} is ${selected.readiness}; skfiy can fall back to ${fallbackProvider.label}.`
    };
  }

  return {
    kind: "offline",
    requestedMode: settings.mode,
    reason: `${selected.label} is ${selected.readiness} and no fallback provider is available.`
  };
}

export function readAssistantAgentFallbackLabel(
  fallback: AssistantAgentProviderFallback | undefined
): string {
  if (!fallback) {
    return "";
  }
  if (fallback.kind === "offline") {
    return "offline";
  }
  return `fallback:${fallback.activeMode}`;
}
