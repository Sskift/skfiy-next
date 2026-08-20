import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProfileIndicator,
  ProfileSwitchBanner
} from "./profile-indicator";
import type { ProfileSummary } from "./app-types";
import type { ProfileSwitchBanner as ProfileSwitchBannerState } from "./app-profile-state";

function createSummary(overrides: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: "writing",
    name: "Writing",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    memoryScope: "isolated",
    workflowDefaults: {
      defaultManualMode: "active",
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    },
    isDefault: false,
    isActive: true,
    ...overrides
  };
}

describe("ProfileIndicator", () => {
  it("renders nothing for the default profile", () => {
    const { container } = render(
      <ProfileIndicator activeProfile={createSummary({ id: "default", isDefault: true })} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no profile is active", () => {
    const { container } = render(<ProfileIndicator activeProfile={null} />);

    expect(container.firstChild).toBeNull();
  });

  it("shows the active profile name and memory scope for non-default profiles", () => {
    render(<ProfileIndicator activeProfile={createSummary()} />);

    expect(screen.getByLabelText("当前配置：Writing")).toBeTruthy();
    expect(screen.getByText("Writing")).toBeTruthy();
  });
});

describe("ProfileSwitchBanner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing without a banner", () => {
    const { container } = render(
      <ProfileSwitchBanner banner={null} onDismiss={vi.fn()} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("summarizes the switch and dismisses on click", () => {
    const onDismiss = vi.fn();
    const banner: ProfileSwitchBannerState = {
      profileName: "Writing",
      lines: ["Planner: local-deterministic → external-cua", "Memory: shared → isolated"],
      at: 1
    };

    render(<ProfileSwitchBanner banner={banner} onDismiss={onDismiss} />);

    expect(screen.getByText("已切换到 Writing")).toBeTruthy();
    expect(screen.getByText("Planner: local-deterministic → external-cua")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("关闭配置切换摘要"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("auto-dismisses after a few seconds", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const banner: ProfileSwitchBannerState = {
      profileName: "Writing",
      lines: [],
      at: 1
    };

    render(<ProfileSwitchBanner banner={banner} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8_000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
