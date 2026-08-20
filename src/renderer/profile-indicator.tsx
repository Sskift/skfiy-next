import { useEffect } from "react";
import { CheckCircle2, FolderLock, Share2, X } from "lucide-react";

import type { ProfileSummary } from "./app-types";
import type { ProfileSwitchBanner as ProfileSwitchBannerState } from "./app-profile-state";

/**
 * Chip shown in the settings header whenever a non-default profile is
 * active, so the active profile is visible exactly when it changes
 * behavior. The Default profile renders nothing.
 */
export function ProfileIndicator({
  activeProfile
}: {
  activeProfile: ProfileSummary | null;
}) {
  if (!activeProfile || activeProfile.isDefault) {
    return null;
  }

  return (
    <div
      className="profile-indicator"
      aria-label={`当前配置：${activeProfile.name}`}
      title={`当前配置：${activeProfile.name}`}
    >
      {activeProfile.memoryScope === "isolated" ? (
        <FolderLock size={12} aria-hidden="true" />
      ) : (
        <Share2 size={12} aria-hidden="true" />
      )}
      <span>{activeProfile.name}</span>
    </div>
  );
}

/**
 * Transient banner shown after a profile switch, summarizing the behavior
 * changes (provider mode, planner mode, app policy diffs, memory scope) so
 * the switch is visible exactly when it changes behavior.
 */
export function ProfileSwitchBanner({
  banner,
  onDismiss
}: {
  banner: ProfileSwitchBannerState | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!banner) {
      return;
    }

    const timer = window.setTimeout(onDismiss, 8_000);
    return () => window.clearTimeout(timer);
  }, [banner, onDismiss]);

  if (!banner) {
    return null;
  }

  return (
    <div className="profile-switch-banner" role="status" aria-label="配置切换摘要">
      <div className="profile-switch-banner-heading">
        <CheckCircle2 size={14} aria-hidden="true" />
        <strong>已切换到 {banner.profileName}</strong>
      </div>
      {banner.lines.length > 0 ? (
        <ul className="profile-switch-banner-lines">
          {banner.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p>行为设置与之前相同。</p>
      )}
      <button
        type="button"
        className="profile-switch-banner-dismiss"
        aria-label="关闭配置切换摘要"
        onClick={onDismiss}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
