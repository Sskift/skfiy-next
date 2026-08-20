import type { AssistantAgentMode, AssistantAgentProviderFallback } from "./app-types";

export interface ProviderOfflineBannerProps {
  fallback: AssistantAgentProviderFallback | undefined;
  onSelectProvider?: (mode: AssistantAgentMode) => void;
}

export function ProviderOfflineBanner({
  fallback,
  onSelectProvider
}: ProviderOfflineBannerProps) {
  if (!fallback) {
    return null;
  }

  if (fallback.kind === "offline") {
    return (
      <div className="provider-offline-banner" role="alert" data-kind="offline">
        <strong>Background Agent 离线</strong>
        <p>{fallback.reason}</p>
        <p>请选择一个可用的 provider，或运行 bounded test 确认状态。</p>
      </div>
    );
  }

  return (
    <div className="provider-offline-banner" role="status" data-kind="fallback">
      <strong>Background Agent 已切换</strong>
      <p>{fallback.reason}</p>
      {onSelectProvider ? (
        <button
          type="button"
          className="provider-offline-banner-action"
          onClick={() => onSelectProvider(fallback.activeMode)}
        >
          切换到 {fallback.activeMode}
        </button>
      ) : null}
    </div>
  );
}
