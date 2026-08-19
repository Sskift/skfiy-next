import {
  applyChromeHostPolicyAction,
  createDefaultChromeHostPolicy,
  decideChromeHostPolicy,
  readChromeHostPolicyState,
  writeChromeHostPolicyState,
  type ChromeHostPolicyIo,
  type ChromeHostPolicyState
} from "./chrome-host-policy.js";
import type { CommandRoute } from "./task-routing.js";

export type ApprovedChromeHostPolicyResult =
  | {
      status: "updated";
      host: string;
      action: "allow_current_turn";
      state: ChromeHostPolicyState;
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

export async function applyApprovedChromeTaskHostPolicy({
  command,
  route,
  homeDir,
  io
}: {
  command: string;
  route: CommandRoute;
  homeDir: string;
  io?: ChromeHostPolicyIo;
}): Promise<ApprovedChromeHostPolicyResult> {
  if (route.kind !== "chrome") {
    return {
      status: "skipped",
      reason: "not_chrome_route"
    };
  }

  const host = readChromeApprovalPolicyHost(command);
  if (!host) {
    return {
      status: "skipped",
      reason: "missing_http_host"
    };
  }

  try {
    const current = await readChromeHostPolicyState({
      homeDir,
      io
    });

    if (current.state === "invalid") {
      return {
        status: "failed",
        host,
        message: current.reason ?? "Chrome host policy state is invalid."
      };
    }

    const currentDecision = decideChromeHostPolicy(current.policy, host);

    if (currentDecision.decision === "block") {
      return {
        status: "blocked",
        host,
        reason: "blocked_host"
      };
    }

    if (currentDecision.decision === "allow") {
      return {
        status: "already_allowed",
        host,
        scope: currentDecision.scope
      };
    }

    const nextPolicy = applyChromeHostPolicyAction(current.policy, {
      action: "allow_current_turn",
      host
    });
    const state = await writeChromeHostPolicyState({
      homeDir,
      policy: nextPolicy,
      io
    });

    return {
      status: "updated",
      host,
      action: "allow_current_turn",
      state
    };
  } catch (error) {
    return {
      status: "failed",
      host,
      message: error instanceof Error ? error.message : "Chrome host policy approval failed."
    };
  }
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
