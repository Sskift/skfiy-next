import {
  CHROME_CURRENT_TURN_HOST_GRANT_REQUIRED_MESSAGE,
  createDefaultChromeHostPolicy,
  decideChromeHostPolicy,
  readChromeHostPolicyState,
  type ChromeHostPolicyIo
} from "./chrome-host-policy.js";
import type {
  ChromeTurnHostGrant,
  ChromeTurnHostGrantIdentity,
  ChromeTurnHostGrantStore
} from "./chrome-turn-host-grant.js";
import type { CommandRoute } from "./task-routing.js";

export type ApprovedChromeHostPolicyResult =
  | {
      status: "updated";
      host: string;
      action: "allow_current_turn";
      grant: ChromeTurnHostGrant;
    }
  | {
      status: "already_allowed";
      host: string;
      scope: "always" | "current_turn";
    }
  | {
      status: "blocked";
      host: string;
      reason: "blocked_host";
    }
  | {
      status: "skipped";
      reason: "not_chrome_route" | "missing_http_host";
    }
  | {
      status: "failed";
      host?: string;
      message: string;
    };

export type ChromeHostPolicyInspectionResult =
  | { status: "approval_required"; host: string }
  | { status: "already_allowed"; host: string; scope: "always" }
  | { status: "blocked"; host: string; reason: "blocked_host" }
  | { status: "skipped"; reason: "not_chrome_route" | "missing_http_host" }
  | { status: "failed"; host?: string; message: string };

export async function inspectChromeTaskHostPolicy({
  command,
  route,
  homeDir,
  io
}: {
  command: string;
  route: CommandRoute;
  homeDir: string;
  io?: ChromeHostPolicyIo;
}): Promise<ChromeHostPolicyInspectionResult> {
  if (route.kind !== "chrome") {
    return { status: "skipped", reason: "not_chrome_route" };
  }

  const host = readChromeApprovalPolicyHost(command);
  if (!host) {
    return { status: "skipped", reason: "missing_http_host" };
  }

  try {
    const current = await readChromeHostPolicyState({ homeDir, io });
    if (current.state === "invalid") {
      return {
        status: "failed",
        host,
        message: current.reason ?? "Chrome host policy state is invalid."
      };
    }

    const decision = decideChromeHostPolicy({
      ...current.policy,
      currentTurnAllowedHosts: []
    }, host);
    if (decision.decision === "block") {
      return { status: "blocked", host, reason: "blocked_host" };
    }
    if (decision.decision === "allow") {
      return { status: "already_allowed", host, scope: "always" };
    }
    return { status: "approval_required", host };
  } catch (error) {
    return {
      status: "failed",
      host,
      message: error instanceof Error ? error.message : "Chrome host policy approval failed."
    };
  }
}

export async function applyApprovedChromeTaskHostPolicy({
  command,
  route,
  homeDir,
  io,
  toolIdentity,
  turnGrantStore
}: {
  command: string;
  route: CommandRoute;
  homeDir: string;
  io?: ChromeHostPolicyIo;
  toolIdentity?: ChromeTurnHostGrantIdentity;
  turnGrantStore?: ChromeTurnHostGrantStore;
}): Promise<ApprovedChromeHostPolicyResult> {
  const inspection = await inspectChromeTaskHostPolicy({ command, route, homeDir, io });
  if (inspection.status !== "approval_required") {
    return inspection;
  }

  const host = inspection.host;
  if (!toolIdentity || !turnGrantStore) {
    return {
      status: "failed",
      host,
      message: CHROME_CURRENT_TURN_HOST_GRANT_REQUIRED_MESSAGE
    };
  }
  if (turnGrantStore.has(toolIdentity, host)) {
    return { status: "already_allowed", host, scope: "current_turn" };
  }

  return {
    status: "updated",
    host,
    action: "allow_current_turn",
    grant: turnGrantStore.grant(toolIdentity, host)
  };
}

export function readChromeApprovalPolicyHost(command: string): string | undefined {
  const match = command.match(/\bhttps?:\/\/[^\s"'<>]+/iu);
  if (!match) {
    return undefined;
  }

  const candidate = trimChromeApprovalUrlCandidate(match[0]);
  const decision = decideChromeHostPolicy(createDefaultChromeHostPolicy(), candidate);
  return decision.host || undefined;
}

function trimChromeApprovalUrlCandidate(value: string): string {
  return value.replace(/[)\],，。；;!！?？]+$/u, "");
}
