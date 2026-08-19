export type RiskLevel = "low" | "medium" | "high" | "blocked";

export interface RiskDecision {
  level: RiskLevel;
  reason: string;
  requiresApproval: boolean;
}
