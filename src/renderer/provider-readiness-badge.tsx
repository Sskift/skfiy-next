import type { AssistantAgentProviderReadiness } from "./app-types";
import { readAssistantAgentReadinessLabel } from "./app-view-model";

const READINESS_BADGE_TONES: Record<AssistantAgentProviderReadiness, string> = {
  "chat-ready": "#8de6b0",
  "version-ok": "#8ecbff",
  "binary-found": "#ffe08a",
  "binary-configured": "#ffe08a",
  "auth-or-permission-blocked": "#ffc48a",
  "unconfigured": "rgba(238, 247, 255, 0.5)",
  "unavailable": "#ffaba6"
};

export interface ProviderReadinessBadgeProps {
  readiness: AssistantAgentProviderReadiness;
  readinessDetail?: string;
}

export function ProviderReadinessBadge({
  readiness,
  readinessDetail
}: ProviderReadinessBadgeProps) {
  const tone = READINESS_BADGE_TONES[readiness];
  const label = readAssistantAgentReadinessLabel(readiness);

  return (
    <span
      className="provider-readiness-badge"
      data-readiness={readiness}
      style={{ "--badge-tone": tone } as React.CSSProperties}
      title={readinessDetail ?? label}
    >
      {label}
    </span>
  );
}
