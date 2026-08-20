export const PROFILE_SCHEMA_VERSION = 1;
export const DEFAULT_PROFILE_ID = "default";
export const DEFAULT_PROFILE_NAME = "Default";
export const MAX_PROFILE_NAME_LENGTH = 60;
export const MAX_PROFILE_MEMORY_ENTRIES = 100;
export const MAX_PROFILE_SESSION_RECORDS = 50;

export type ProfileMemoryScope = "isolated" | "shared";
export type ProfileAppPolicy = "allow" | "ask" | "deny";
export type ProfileAssistantAgentMode = "codex" | "claude-code" | "hermes";
export type ProfilePlannerMode = "local-deterministic" | "external-cua" | "disabled";
export type ProfileManualMode = "active" | "quiet";

export interface ProfileAppPolicyEntry {
  name: string;
  bundleId: string;
  policy: ProfileAppPolicy;
}

export interface ProfileAppPolicySettings {
  apps: ProfileAppPolicyEntry[];
}

export interface ProfileProviderRuntime {
  cwd?: string;
  timeoutMs?: number;
}

export interface ProfileAssistantAgentSettings {
  mode: ProfileAssistantAgentMode;
  providerRuntime?: Partial<Record<ProfileAssistantAgentMode, ProfileProviderRuntime>>;
}

export interface ProfilePlannerSettings {
  mode: ProfilePlannerMode;
}

export interface ProfileWorkflowDefaults {
  defaultManualMode: ProfileManualMode;
  postTurnLearningEnabled: boolean;
  writeApprovalEnabled: boolean;
}

/**
 * The preference subset of a profile. Profiles wrap the existing live
 * settings stores; this is the shape that gets captured back into the active
 * profile whenever the user edits settings in the existing UI.
 */
export interface ProfileSettings {
  assistantAgent: ProfileAssistantAgentSettings;
  plannerProvider: ProfilePlannerSettings;
  appPolicy: ProfileAppPolicySettings;
  workflowDefaults: ProfileWorkflowDefaults;
}

export interface Profile extends ProfileSettings {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  memoryScope: ProfileMemoryScope;
}

export interface ProfileSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  memoryScope: ProfileMemoryScope;
  workflowDefaults: ProfileWorkflowDefaults;
  isDefault: boolean;
  isActive: boolean;
}

export interface ProfileRuntimeSnapshot {
  schemaVersion: 1;
  activeProfileId: string | null;
  activeProfile: ProfileSummary | null;
  profiles: ProfileSummary[];
  memoryBaseDirScope: "shared" | "isolated";
}

/**
 * A single policy movement that broadens what the agent may do without
 * prompting. Switching to a profile that introduces any broadening requires
 * an explicit, confirmed user action.
 */
export interface PolicyBroadening {
  kind: "app-policy";
  target: string;
  targetName?: string;
  from: ProfileAppPolicy;
  to: ProfileAppPolicy;
}

export type ProfileSwitchResult =
  | {
      status: "switched";
      profile: ProfileSummary;
      previousProfileId: string | null;
    }
  | {
      status: "confirmation-required";
      profileId: string;
      broadenings: PolicyBroadening[];
    }
  | { status: "not-found"; profileId: string }
  | { status: "blocked"; profileId: string; reason: string };

export interface ProfileSessionRecord {
  turnId: string;
  createdAt: string;
  userInput: string;
  assistantReply: string;
  providerLabel: string;
  browserContext?: { url?: string; title?: string };
  recallReason?: string;
}

export interface ProfileExportBundle {
  schemaVersion: 1;
  exportedAt: string;
  profile: Profile;
  memory?: {
    userEntries: string[];
    agentEntries: string[];
  };
  sessions?: ProfileSessionRecord[];
}

export function isProfileMemoryScope(value: unknown): value is ProfileMemoryScope {
  return value === "isolated" || value === "shared";
}

export function isProfileAppPolicy(value: unknown): value is ProfileAppPolicy {
  return value === "allow" || value === "ask" || value === "deny";
}

export function isProfileAssistantAgentMode(
  value: unknown
): value is ProfileAssistantAgentMode {
  return value === "codex" || value === "claude-code" || value === "hermes";
}

export function isProfilePlannerMode(value: unknown): value is ProfilePlannerMode {
  return (
    value === "local-deterministic"
    || value === "external-cua"
    || value === "disabled"
  );
}

export function isProfileManualMode(value: unknown): value is ProfileManualMode {
  return value === "active" || value === "quiet";
}

export function normalizeProfileName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, MAX_PROFILE_NAME_LENGTH);
}

export function createProfileSummary(
  profile: Profile,
  activeProfileId: string | null
): ProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    memoryScope: profile.memoryScope,
    workflowDefaults: { ...profile.workflowDefaults },
    isDefault: profile.id === DEFAULT_PROFILE_ID,
    isActive: profile.id === activeProfileId
  };
}
