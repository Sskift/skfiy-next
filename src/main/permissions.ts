import type { PermissionState, PermissionSummary } from "./computer-use/types.js";

export type ElectronMediaPermissionState = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export const UNKNOWN_PERMISSION_SUMMARY: PermissionSummary = {
  screenRecording: { state: "unknown" },
  accessibility: { state: "unknown" }
};

export function readElectronMediaPermissionState(state: ElectronMediaPermissionState): PermissionState {
  if (state === "restricted") {
    return "denied";
  }

  return state;
}

export function createAppProcessPermissionSummary({
  accessibilityTrusted,
  screenRecording
}: {
  accessibilityTrusted: boolean;
  screenRecording: ElectronMediaPermissionState;
}): PermissionSummary {
  return {
    screenRecording: {
      state: readElectronMediaPermissionState(screenRecording)
    },
    accessibility: {
      state: accessibilityTrusted ? "granted" : "denied"
    }
  };
}

interface PermissionsReader {
  getPermissions: () => Promise<PermissionSummary>;
}

type DiagnosticPermissionKey = keyof PermissionSummary;

export interface PermissionDiagnosticsIdentity {
  appPath: string;
  executablePath: string;
  helperPath: string;
  resourcesPath: string;
  isPackaged: boolean;
}

export interface PermissionMismatch {
  permission: DiagnosticPermissionKey;
  appProcess: PermissionState;
  helperProcess: PermissionState;
}

export interface PermissionDiagnostics {
  active: PermissionSummary;
  appProcess: PermissionSummary;
  helperProcess: PermissionSummary;
  mismatches: PermissionMismatch[];
  identity: PermissionDiagnosticsIdentity;
}

export async function readPermissionsForRenderer({
  helper,
  onError
}: {
  helper: PermissionsReader;
  onError?: (message: string) => void;
}): Promise<PermissionSummary> {
  try {
    return await helper.getPermissions();
  } catch (error) {
    onError?.(error instanceof Error ? error.message : "Permission status could not be read.");
    return UNKNOWN_PERMISSION_SUMMARY;
  }
}

export async function readPermissionDiagnosticsForRenderer({
  active,
  appProcess,
  helper,
  identity,
  onError
}: {
  active: PermissionSummary;
  appProcess: PermissionSummary;
  helper: PermissionsReader;
  identity: PermissionDiagnosticsIdentity;
  onError?: (message: string) => void;
}): Promise<PermissionDiagnostics> {
  let helperProcess: PermissionSummary;

  try {
    helperProcess = await helper.getPermissions();
  } catch (error) {
    onError?.(error instanceof Error ? error.message : "Helper permission status could not be read.");
    helperProcess = UNKNOWN_PERMISSION_SUMMARY;
  }

  return {
    active,
    appProcess,
    helperProcess,
    mismatches: readPermissionMismatches(appProcess, helperProcess),
    identity
  };
}

function readPermissionMismatches(
  appProcess: PermissionSummary,
  helperProcess: PermissionSummary
): PermissionMismatch[] {
  return (Object.keys(appProcess) as DiagnosticPermissionKey[]).flatMap((permission) => {
    const appState = appProcess[permission].state;
    const helperState = helperProcess[permission].state;

    if (appState === "unknown" || helperState === "unknown") {
      return [];
    }

    if (appState === helperState) {
      return [];
    }

    return [{
      permission,
      appProcess: appState,
      helperProcess: helperState
    }];
  });
}
