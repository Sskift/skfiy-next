import type { PermissionSummary } from "./computer-use/types.js";
import {
  createAppProcessPermissionSummary,
  readPermissionDiagnosticsForRenderer,
  type ElectronMediaPermissionState,
  type PermissionDiagnostics,
  type PermissionDiagnosticsIdentity
} from "./permissions.js";

export interface MainPermissionDiagnosticsIdentityInput {
  appPath: string;
  executablePath: string;
  helperPath: string;
  resourcesPath: string;
  isPackaged: boolean;
}

export interface MainPermissionDiagnosticsResponseInput {
  active: PermissionSummary;
  appProcess: {
    screenRecording: ElectronMediaPermissionState;
    accessibilityTrusted: boolean;
  };
  identity: MainPermissionDiagnosticsIdentityInput;
}

export function createMainPermissionDiagnosticsIdentity(
  identity: MainPermissionDiagnosticsIdentityInput
): PermissionDiagnosticsIdentity {
  return {
    appPath: identity.appPath,
    executablePath: identity.executablePath,
    helperPath: identity.helperPath,
    resourcesPath: identity.resourcesPath,
    isPackaged: identity.isPackaged
  };
}

export async function createMainPermissionDiagnosticsResponse({
  active,
  appProcess,
  identity
}: MainPermissionDiagnosticsResponseInput): Promise<PermissionDiagnostics> {
  return readPermissionDiagnosticsForRenderer({
    active,
    appProcess: createAppProcessPermissionSummary(appProcess),
    helper: {
      getPermissions: async () => active
    },
    identity: createMainPermissionDiagnosticsIdentity(identity)
  });
}
