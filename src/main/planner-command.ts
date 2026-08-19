import type {
  ExternalCuaTerminalPlanner,
  ExternalCuaTerminalPlan
} from "./external-cua-planner.js";
import type { PlannerProviderRuntimeDecision } from "./planner-provider-runtime.js";

export interface ResolvePlannerCommandInput {
  input: string;
  runtime: PlannerProviderRuntimeDecision;
  signal?: AbortSignal;
  createExternalPlanner: () => ExternalCuaTerminalPlanner;
}

export interface ResolvedPlannerCommand {
  command: string;
  providerLabel?: string;
  rationale?: string;
}

export async function resolvePlannerCommand({
  input,
  runtime,
  signal,
  createExternalPlanner
}: ResolvePlannerCommandInput): Promise<ResolvedPlannerCommand> {
  if (runtime.decision === "run-local-deterministic") {
    return { command: input };
  }

  if (runtime.decision === "run-external-cua") {
    const plan = await createExternalPlanner().planTerminalCommand({ input, signal });
    return createExternalResolution(runtime.label, plan);
  }

  throw new Error(runtime.message);
}

function createExternalResolution(
  providerLabel: string,
  plan: ExternalCuaTerminalPlan
): ResolvedPlannerCommand {
  return {
    command: plan.command,
    providerLabel,
    ...(plan.rationale ? { rationale: plan.rationale } : {})
  };
}
