export function readDefaultApprovalBypass(
  env: { SKFIY_BYPASS_APPROVAL?: string }
): boolean {
  const value = env.SKFIY_BYPASS_APPROVAL?.trim().toLowerCase();

  return value !== "0"
    && value !== "false"
    && value !== "strict"
    && value !== "ask";
}
