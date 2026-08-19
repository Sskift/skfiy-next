import type {
  DesktopSessionStatus,
  PermissionState,
  PermissionSummary
} from "./types.js";

export type DesktopAppCapabilityId =
  | "observe_screenshot"
  | "observe_accessibility"
  | "activate_app"
  | "pointer_input"
  | "keyboard_input";

export type DesktopAppCapabilityStatus = "ready" | "blocked";

export type DesktopAppCapabilityBlocker =
  | {
      type: "permission";
      permission: "screenRecording" | "accessibility";
      state: PermissionState;
      message: string;
    }
  | {
      type: "desktop_session";
      reason: "not_controllable" | "loginwindow" | "display_asleep";
      message: string;
    };

export interface DesktopAppCapability {
  id: DesktopAppCapabilityId;
  status: DesktopAppCapabilityStatus;
  blockers: DesktopAppCapabilityBlocker[];
}

export interface DesktopAppCapabilityModel {
  target: {
    bundleId: string;
    pid?: number;
    name?: string;
  };
  status: DesktopAppCapabilityStatus;
  capabilities: DesktopAppCapability[];
}

export interface DesktopAppCapabilityModelInput {
  bundleId: string;
  pid?: number;
  name?: string;
  permissions?: PermissionSummary;
  desktopSession?: DesktopSessionStatus;
}

const ACCESSIBILITY_CAPABILITIES: DesktopAppCapabilityId[] = [
  "observe_accessibility",
  "activate_app",
  "pointer_input",
  "keyboard_input"
];

export function createDesktopAppCapabilityModel({
  bundleId,
  pid,
  name,
  permissions,
  desktopSession
}: DesktopAppCapabilityModelInput): DesktopAppCapabilityModel {
  const capabilities: DesktopAppCapability[] = [
    createCapability("observe_screenshot", [
      ...createDesktopSessionBlockers(desktopSession),
      ...createPermissionBlockers(permissions, "screenRecording")
    ]),
    ...ACCESSIBILITY_CAPABILITIES.map((id) => createCapability(id, [
      ...createDesktopSessionBlockers(desktopSession),
      ...createPermissionBlockers(permissions, "accessibility")
    ]))
  ];

  return {
    target: {
      bundleId,
      pid,
      name
    },
    status: capabilities.every((capability) => capability.status === "ready")
      ? "ready"
      : "blocked",
    capabilities
  };
}

export function getBlockedDesktopAppCapabilities(
  model: DesktopAppCapabilityModel
): DesktopAppCapability[] {
  return model.capabilities.filter((capability) => capability.status === "blocked");
}

function createCapability(
  id: DesktopAppCapabilityId,
  blockers: DesktopAppCapabilityBlocker[]
): DesktopAppCapability {
  return {
    id,
    status: blockers.length === 0 ? "ready" : "blocked",
    blockers
  };
}

function createPermissionBlockers(
  permissions: PermissionSummary | undefined,
  permission: "screenRecording" | "accessibility"
): DesktopAppCapabilityBlocker[] {
  const status = permissions?.[permission]?.state ?? "unknown";

  if (status === "granted") {
    return [];
  }

  const label = permission === "screenRecording" ? "Screen Recording" : "Accessibility";
  return [{
    type: "permission",
    permission,
    state: status,
    message: `${label} permission is required for this app capability.`
  }];
}

function createDesktopSessionBlockers(
  desktopSession: DesktopSessionStatus | undefined
): DesktopAppCapabilityBlocker[] {
  if (!desktopSession || desktopSession.controllable) {
    return [];
  }

  if (desktopSession.mainDisplayAsleep === true) {
    return [{
      type: "desktop_session",
      reason: "display_asleep",
      message: "Main display is asleep. Wake and unlock the Mac, then retry."
    }];
  }

  if (desktopSession.frontmostBundleId === "com.apple.loginwindow") {
    return [{
      type: "desktop_session",
      reason: "loginwindow",
      message: "Desktop session is locked by loginwindow. Unlock the Mac, then retry."
    }];
  }

  return [{
    type: "desktop_session",
    reason: "not_controllable",
    message: "Desktop session is not controllable. Keep the display awake and unlocked, then retry."
  }];
}
