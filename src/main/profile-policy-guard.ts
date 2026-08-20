import type {
  PolicyBroadening,
  ProfileAppPolicy,
  ProfileAppPolicySettings
} from "../shared/profile.js";

/**
 * Policy guards are pure diffs. A profile switch provably never broadens
 * policy silently: app-policy movements that widen what the agent may do
 * without prompting are returned to the caller for explicit confirmation,
 * and host policy is snapshotted before and after every switch so a switch
 * can never smuggle in broader host grants.
 */

const POLICY_RANK: Record<ProfileAppPolicy, number> = {
  deny: 0,
  ask: 1,
  allow: 2
};

/**
 * Unknown apps default to "ask", so a profile that introduces a brand-new
 * app as "allow" broadens policy just like ask/deny -> allow on a known app.
 */
export function diffAppPolicyBroadening(
  from: ProfileAppPolicySettings,
  to: ProfileAppPolicySettings
): PolicyBroadening[] {
  const broadenings: PolicyBroadening[] = [];

  for (const next of to.apps) {
    const previous = from.apps.find((entry) => entry.bundleId === next.bundleId);
    const fromPolicy: ProfileAppPolicy = previous?.policy ?? "ask";
    if (POLICY_RANK[next.policy] <= POLICY_RANK[fromPolicy]) {
      continue;
    }

    broadenings.push({
      kind: "app-policy",
      target: next.bundleId,
      targetName: next.name,
      from: fromPolicy,
      to: next.policy
    });
  }

  return broadenings;
}

export function isAppPolicyBroadening(from: ProfileAppPolicy, to: ProfileAppPolicy): boolean {
  return POLICY_RANK[to] > POLICY_RANK[from];
}

export interface HostPolicySnapshot {
  allowedHosts: string[];
  blockedHosts: string[];
}

export interface HostPolicyBroadening {
  kind: "host-policy";
  host: string;
  from: "ask" | "blocked";
  to: "allow";
}

/**
 * Any host newly present in the allowed list is a broadening, including a
 * host that moved from the blocked list to the allowed list.
 */
export function diffHostPolicyBroadening(
  from: HostPolicySnapshot,
  to: HostPolicySnapshot
): HostPolicyBroadening[] {
  const previouslyAllowed = new Set(from.allowedHosts);
  const previouslyBlocked = new Set(from.blockedHosts);

  return to.allowedHosts
    .filter((host) => !previouslyAllowed.has(host))
    .map((host) => ({
      kind: "host-policy" as const,
      host,
      from: previouslyBlocked.has(host) ? ("blocked" as const) : ("ask" as const),
      to: "allow" as const
    }));
}

export function assertNoHostPolicyBroadening(
  from: HostPolicySnapshot,
  to: HostPolicySnapshot
): void {
  const broadenings = diffHostPolicyBroadening(from, to);
  if (broadenings.length === 0) {
    return;
  }

  const hosts = broadenings.map((broadening) => broadening.host).join(", ");
  throw new Error(`Profile switch would broaden Chrome host policy for: ${hosts}`);
}
