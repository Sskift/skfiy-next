import { readInitialAppPolicySettings } from "./app-policy-settings.js";
import type { AssistantAgentSettings } from "./assistant-agent-provider-registry.js";
import type { PlannerProviderSettings } from "./planner-provider-settings.js";
import type { PersonalMemorySettings } from "./personal-memory-settings.js";
import type {
  ProfileAppPolicySettings,
  ProfileManualMode,
  ProfileSettings
} from "../shared/profile.js";

/**
 * The live settings a profile captures. Profiles wrap the existing stores
 * rather than replacing them, so this is the narrow surface the runtime
 * reads from and writes back to the stores created in main.ts.
 */
export interface LiveProfileSettings {
  assistantAgent: Pick<AssistantAgentSettings, "mode" | "providerRuntime">;
  plannerProvider: Pick<PlannerProviderSettings, "mode">;
  appPolicy: ProfileAppPolicySettings;
  personalMemory: PersonalMemorySettings;
  defaultManualMode: ProfileManualMode;
}

export function createDefaultProfileSettings(): ProfileSettings {
  return {
    assistantAgent: { mode: "codex" },
    plannerProvider: { mode: "local-deterministic" },
    appPolicy: cloneAppPolicy(readInitialAppPolicySettings()),
    workflowDefaults: {
      defaultManualMode: "active",
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    }
  };
}

export function captureProfileSettings(live: LiveProfileSettings): ProfileSettings {
  return {
    assistantAgent: {
      mode: live.assistantAgent.mode,
      ...(live.assistantAgent.providerRuntime
        ? { providerRuntime: cloneProviderRuntime(live.assistantAgent.providerRuntime) }
        : {})
    },
    plannerProvider: { mode: live.plannerProvider.mode },
    appPolicy: cloneAppPolicy(live.appPolicy),
    workflowDefaults: {
      defaultManualMode: live.defaultManualMode,
      postTurnLearningEnabled: live.personalMemory.postTurnLearningEnabled,
      writeApprovalEnabled: live.personalMemory.writeApprovalEnabled
    }
  };
}

function cloneAppPolicy(settings: ProfileAppPolicySettings): ProfileAppPolicySettings {
  return {
    apps: settings.apps.map((entry) => ({ ...entry }))
  };
}

function cloneProviderRuntime(
  runtime: NonNullable<LiveProfileSettings["assistantAgent"]["providerRuntime"]>
): LiveProfileSettings["assistantAgent"]["providerRuntime"] {
  const cloned: NonNullable<LiveProfileSettings["assistantAgent"]["providerRuntime"]> = {};
  for (const [mode, entry] of Object.entries(runtime)) {
    if (!entry) {
      continue;
    }
    cloned[mode as keyof typeof cloned] = { ...entry };
  }
  return cloned;
}
