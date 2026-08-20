import { useState } from "react";
import type {
  AssistantAgentMode,
  AssistantAgentProviderRuntime,
  AssistantAgentProviderState,
  AssistantAgentSettingsResponse
} from "./app-types";
import { readAssistantAgentProviderDetail } from "./app-view-model";
import { ProviderOfflineBanner } from "./provider-offline-banner";
import { ProviderReadinessBadge } from "./provider-readiness-badge";

export interface ProviderDiscoveryPanelProps {
  response: AssistantAgentSettingsResponse;
  onSelectMode: (mode: AssistantAgentMode) => void;
  onTestProvider: (mode: AssistantAgentMode) => Promise<AssistantAgentProviderState>;
  onUpdateProviderRuntime: (
    mode: AssistantAgentMode,
    runtime: AssistantAgentProviderRuntime
  ) => void;
  onSelectFallbackProvider?: (mode: AssistantAgentMode) => void;
  testingProvider?: AssistantAgentMode | null;
}

export function ProviderDiscoveryPanel({
  response,
  onSelectMode,
  onTestProvider,
  onUpdateProviderRuntime,
  onSelectFallbackProvider,
  testingProvider
}: ProviderDiscoveryPanelProps) {
  const [expandedProvider, setExpandedProvider] = useState<AssistantAgentMode | null>(null);
  const [testResults, setTestResults] = useState<
    Partial<Record<AssistantAgentMode, AssistantAgentProviderState>>
  >({});
  const [runtimeDrafts, setRuntimeDrafts] = useState<
    Partial<Record<AssistantAgentMode, { cwd: string; timeoutMs: string }>>
  >({});

  const handleTestProvider = async (mode: AssistantAgentMode) => {
    try {
      const result = await onTestProvider(mode);
      setTestResults((current) => ({ ...current, [mode]: result }));
    } catch {
      // The parent surfaces failures through the task event channel.
    }
  };

  const handleRuntimeDraft = (
    mode: AssistantAgentMode,
    field: "cwd" | "timeoutMs",
    value: string
  ) => {
    setRuntimeDrafts((current) => ({
      ...current,
      [mode]: {
        cwd: current[mode]?.cwd ?? "",
        timeoutMs: current[mode]?.timeoutMs ?? "",
        [field]: value
      }
    }));
  };

  const handleRuntimeCommit = (mode: AssistantAgentMode) => {
    const draft = runtimeDrafts[mode];
    if (!draft) {
      return;
    }
    const runtime: AssistantAgentProviderRuntime = {};
    if (draft.cwd.trim().length > 0) {
      runtime.cwd = draft.cwd.trim();
    }
    const timeoutMs = Number.parseInt(draft.timeoutMs, 10);
    if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
      runtime.timeoutMs = timeoutMs;
    }
    onUpdateProviderRuntime(mode, runtime);
    setRuntimeDrafts((current) => {
      const next = { ...current };
      delete next[mode];
      return next;
    });
  };

  return (
    <div className="provider-discovery-panel" aria-label="Background Agent provider discovery">
      <ProviderOfflineBanner
        fallback={response.fallback}
        onSelectProvider={onSelectFallbackProvider}
      />
      <div className="provider-discovery-list">
        {response.providers.map((provider) => {
          const testResult = testResults[provider.id];
          const displayedProvider = testResult ?? provider;
          const isExpanded = expandedProvider === provider.id;
          const isTesting = testingProvider === provider.id;
          const draft = runtimeDrafts[provider.id];
          const runtime = response.settings.providerRuntime?.[provider.id] ?? {};

          return (
            <div
              key={provider.id}
              className="provider-discovery-row"
              data-selected={provider.selected}
              data-provider={provider.id}
            >
              <div className="provider-discovery-header">
                <button
                  type="button"
                  className="provider-discovery-select"
                  aria-pressed={provider.selected}
                  aria-label={`选择 ${provider.label} background agent`}
                  onClick={() => onSelectMode(provider.id)}
                >
                  {provider.label}
                </button>
                <ProviderReadinessBadge
                  readiness={displayedProvider.readiness}
                  readinessDetail={displayedProvider.readinessDetail}
                />
                <button
                  type="button"
                  className="provider-discovery-test"
                  aria-label={`测试 ${provider.label} provider`}
                  disabled={isTesting}
                  onClick={() => void handleTestProvider(provider.id)}
                >
                  {isTesting ? "测试中" : "测试"}
                </button>
                <button
                  type="button"
                  className="provider-discovery-expand"
                  aria-expanded={isExpanded}
                  aria-label={`${provider.label} 高级设置`}
                  onClick={() =>
                    setExpandedProvider(isExpanded ? null : provider.id)
                  }
                >
                  {isExpanded ? "收起" : "高级"}
                </button>
              </div>
              <p className="provider-discovery-detail">
                {readAssistantAgentProviderDetail(response, displayedProvider)}
              </p>
              {displayedProvider.lastError ? (
                <p className="provider-discovery-error">{displayedProvider.lastError}</p>
              ) : null}
              {isExpanded ? (
                <div className="provider-discovery-runtime">
                  <label>
                    <span>cwd</span>
                    <input
                      type="text"
                      value={draft?.cwd ?? runtime.cwd ?? ""}
                      placeholder={response.settings.cwd || "default"}
                      onChange={(event) =>
                        handleRuntimeDraft(provider.id, "cwd", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    <span>timeout (ms)</span>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      value={draft?.timeoutMs ?? runtime.timeoutMs ?? ""}
                      placeholder={String(response.settings.timeoutMs)}
                      onChange={(event) =>
                        handleRuntimeDraft(provider.id, "timeoutMs", event.target.value)
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="provider-discovery-runtime-save"
                    disabled={!draft}
                    onClick={() => handleRuntimeCommit(provider.id)}
                  >
                    保存
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
