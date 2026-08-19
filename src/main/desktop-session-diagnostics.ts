import type { DesktopSessionStatus } from "./computer-use/types.js";

export type DesktopSessionDiagnosticState = "controllable" | "blocked" | "unknown";

export interface DesktopSessionDiagnostics {
  state: DesktopSessionDiagnosticState;
  status: DesktopSessionStatus | null;
  reason: string;
}

export const UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS: DesktopSessionDiagnostics = {
  state: "unknown",
  status: null,
  reason: "Desktop session status is unknown."
};

interface DesktopSessionReader {
  getDesktopSessionStatus: () => Promise<DesktopSessionStatus>;
}

export async function readDesktopSessionDiagnosticsForRenderer({
  helper,
  onError
}: {
  helper: DesktopSessionReader;
  onError?: (message: string) => void;
}): Promise<DesktopSessionDiagnostics> {
  try {
    return createDesktopSessionDiagnostics(await helper.getDesktopSessionStatus());
  } catch (error) {
    onError?.(error instanceof Error ? error.message : "Desktop session status could not be read.");
    return UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS;
  }
}

export function createDesktopSessionDiagnostics(
  status: DesktopSessionStatus
): DesktopSessionDiagnostics {
  if (status.controllable) {
    return {
      state: "controllable",
      status,
      reason: "Desktop session is controllable."
    };
  }

  if (status.frontmostBundleId === "com.apple.loginwindow") {
    const pid = Number.isInteger(status.frontmostProcessIdentifier)
      ? ` (pid ${status.frontmostProcessIdentifier})`
      : "";

    if (status.mainDisplayAsleep === true) {
      return {
        state: "blocked",
        status,
        reason: `Main display is asleep and desktop session is locked by loginwindow${pid}. Wake and unlock the Mac, then retry.`
      };
    }

    return {
      state: "blocked",
      status,
      reason: `Desktop session is locked by loginwindow${pid}. Unlock the Mac and keep the display awake, then retry.`
    };
  }

  if (status.mainDisplayAsleep === true) {
    return {
      state: "blocked",
      status,
      reason: "Main display is asleep. Wake and unlock the Mac, then retry."
    };
  }

  const frontmost = status.frontmostBundleId
    ? ` Frontmost app: ${status.frontmostBundleId}.`
    : "";

  return {
    state: "blocked",
    status,
    reason: `Desktop session is not controllable.${frontmost} Keep the display awake/unlocked, then retry.`
  };
}
