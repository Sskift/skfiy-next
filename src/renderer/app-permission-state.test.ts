import { describe, expect, it } from "vitest";

import {
  UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS,
  UNKNOWN_PERMISSIONS,
  createPermissionOnboardingRefreshTransition,
  createUnknownPermissionRefreshState,
  isPermissionOnboardingComplete
} from "./app-permission-state";
import type {
  PermissionSummary
} from "./app-types";

const grantedPermissions: PermissionSummary = {
  screenRecording: { state: "granted" },
  accessibility: { state: "granted" }
};

const blockedPermissions: PermissionSummary = {
  screenRecording: { state: "denied" },
  accessibility: { state: "not-determined" }
};

describe("app permission state", () => {
  it("creates an unknown fallback permission refresh state", () => {
    expect(createUnknownPermissionRefreshState()).toEqual({
      permissions: UNKNOWN_PERMISSIONS,
      desktopSessionDiagnostics: UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS
    });
  });

  it("detects when permission onboarding is complete", () => {
    expect(isPermissionOnboardingComplete(grantedPermissions)).toBe(true);
    expect(isPermissionOnboardingComplete(blockedPermissions)).toBe(false);
  });

  it("derives permission onboarding refresh transitions", () => {
    expect(createPermissionOnboardingRefreshTransition({
      announceReady: true,
      permissionOnboardingOpen: true,
      permissions: blockedPermissions
    })).toEqual({
      closePermissionOnboarding: false
    });

    expect(createPermissionOnboardingRefreshTransition({
      announceReady: false,
      permissionOnboardingOpen: true,
      permissions: grantedPermissions
    })).toEqual({
      closePermissionOnboarding: true
    });

    expect(createPermissionOnboardingRefreshTransition({
      announceReady: true,
      permissionOnboardingOpen: true,
      permissions: grantedPermissions
    })).toEqual({
      closePermissionOnboarding: true,
      readyTaskMessage: "权限已就绪."
    });
  });
});
