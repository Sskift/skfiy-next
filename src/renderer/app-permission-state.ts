import type {
  DesktopSessionDiagnostics,
  PermissionSummary
} from "./app-types";
import { readMissingPermissionRows } from "./app-view-model";

export const UNKNOWN_PERMISSIONS: PermissionSummary = {
  screenRecording: { state: "unknown" },
  accessibility: { state: "unknown" }
};

export const UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS: DesktopSessionDiagnostics = {
  state: "unknown",
  status: null,
  reason: "Desktop session status is unknown."
};

export interface PermissionRefreshState {
  permissions: PermissionSummary;
  desktopSessionDiagnostics: DesktopSessionDiagnostics;
}

export interface PermissionOnboardingRefreshTransition {
  closePermissionOnboarding: boolean;
  readyTaskMessage?: string;
}

export function createUnknownPermissionRefreshState(): PermissionRefreshState {
  return {
    permissions: UNKNOWN_PERMISSIONS,
    desktopSessionDiagnostics: UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS
  };
}

export function isPermissionOnboardingComplete(permissions: PermissionSummary): boolean {
  return readMissingPermissionRows(permissions).length === 0;
}

export function createPermissionOnboardingRefreshTransition({
  announceReady,
  permissionOnboardingOpen,
  permissions
}: {
  announceReady: boolean;
  permissionOnboardingOpen: boolean;
  permissions: PermissionSummary;
}): PermissionOnboardingRefreshTransition {
  const complete = isPermissionOnboardingComplete(permissions);

  return {
    closePermissionOnboarding: permissionOnboardingOpen && complete,
    ...(announceReady && complete ? { readyTaskMessage: "权限已就绪." } : {})
  };
}
