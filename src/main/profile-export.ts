import {
  MAX_PROFILE_MEMORY_ENTRIES,
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROFILE_SESSION_RECORDS,
  PROFILE_SCHEMA_VERSION,
  isProfileAppPolicy,
  isProfileAssistantAgentMode,
  isProfileManualMode,
  isProfileMemoryScope,
  isProfilePlannerMode,
  type Profile,
  type ProfileAppPolicyEntry,
  type ProfileExportBundle,
  type ProfileSessionRecord
} from "../shared/profile.js";
import type { SessionMemoryRecord } from "./session-memory.js";
import type { PersonalMemorySnapshot } from "./personal-memory.js";

export interface ProfileExportInput {
  profile: Profile;
  memory?: Pick<PersonalMemorySnapshot, "userEntries" | "agentEntries">;
  sessions?: SessionMemoryRecord[];
}

const MAX_EXPORT_TEXT_LENGTH = 2_000;

export function buildProfileExportBundle(
  input: ProfileExportInput,
  { now = () => new Date() }: { now?: () => Date } = {}
): ProfileExportBundle {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    exportedAt: now().toISOString(),
    profile: sanitizeExportedProfile(input.profile),
    ...(input.memory
      ? {
          memory: {
            userEntries: capMemoryEntries(input.memory.userEntries),
            agentEntries: capMemoryEntries(input.memory.agentEntries)
          }
        }
      : {}),
    ...(input.sessions && input.sessions.length > 0
      ? { sessions: input.sessions.slice(0, MAX_PROFILE_SESSION_RECORDS).map(normalizeSessionRecord) }
      : {})
  };
}

/**
 * Validates an incoming bundle. Throws on any structural violation so a
 * malformed or hostile bundle can never reach the profile store. App policy
 * is NOT stripped here — the runtime strips it to defaults on import so an
 * imported profile can never smuggle in broadened policy.
 */
export function parseProfileExportBundle(value: unknown): ProfileExportBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Profile export bundle must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported profile export schema version: ${String(record.schemaVersion)}.`);
  }
  if (typeof record.exportedAt !== "string" || record.exportedAt.length === 0) {
    throw new Error("Profile export bundle requires an exportedAt timestamp.");
  }

  const profile = parseProfile(record.profile);
  const bundle: ProfileExportBundle = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    exportedAt: record.exportedAt,
    profile
  };

  if (record.memory !== undefined) {
    bundle.memory = parseMemory(record.memory);
  }
  if (record.sessions !== undefined) {
    if (!Array.isArray(record.sessions)) {
      throw new Error("Profile export sessions must be an array.");
    }
    bundle.sessions = record.sessions
      .map(parseSessionRecord)
      .filter((session): session is ProfileSessionRecord => Boolean(session))
      .slice(0, MAX_PROFILE_SESSION_RECORDS);
  }

  return bundle;
}

function sanitizeExportedProfile(profile: Profile): Profile {
  return {
    ...profile,
    name: profile.name.slice(0, MAX_PROFILE_NAME_LENGTH),
    assistantAgent: {
      mode: profile.assistantAgent.mode,
      ...(profile.assistantAgent.providerRuntime
        ? { providerRuntime: profile.assistantAgent.providerRuntime }
        : {})
    },
    appPolicy: {
      apps: profile.appPolicy.apps.map((entry) => ({ ...entry }))
    },
    workflowDefaults: { ...profile.workflowDefaults }
  };
}

function capMemoryEntries(entries: string[]): string[] {
  return Array.from(new Set(
    entries
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.slice(0, MAX_EXPORT_TEXT_LENGTH))
  )).slice(0, MAX_PROFILE_MEMORY_ENTRIES);
}

function normalizeSessionRecord(record: SessionMemoryRecord): ProfileSessionRecord {
  return {
    turnId: truncate(record.turnId, 100),
    createdAt: record.createdAt,
    userInput: truncate(record.userInput, MAX_EXPORT_TEXT_LENGTH),
    assistantReply: truncate(record.assistantReply, MAX_EXPORT_TEXT_LENGTH),
    providerLabel: truncate(record.providerLabel, 100),
    ...(record.browserContext
      ? {
          browserContext: {
            ...(record.browserContext.url ? { url: truncate(record.browserContext.url, 500) } : {}),
            ...(record.browserContext.title ? { title: truncate(record.browserContext.title, 300) } : {})
          }
        }
      : {})
  };
}

function parseProfile(value: unknown): Profile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Profile export bundle requires a profile object.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new Error("Exported profile requires an id.");
  }
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    throw new Error("Exported profile requires a name.");
  }
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
    throw new Error("Exported profile requires createdAt and updatedAt timestamps.");
  }
  if (!isProfileMemoryScope(record.memoryScope)) {
    throw new Error("Exported profile has an invalid memoryScope.");
  }

  const assistantAgent = parseAssistantAgent(record.assistantAgent);
  const plannerProvider = parsePlanner(record.plannerProvider);
  const appPolicy = parseAppPolicy(record.appPolicy);
  const workflowDefaults = parseWorkflowDefaults(record.workflowDefaults);

  return {
    id: record.id,
    name: record.name.trim().slice(0, MAX_PROFILE_NAME_LENGTH),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    memoryScope: record.memoryScope,
    assistantAgent,
    plannerProvider,
    appPolicy,
    workflowDefaults
  };
}

function parseAssistantAgent(value: unknown): Profile["assistantAgent"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported profile requires assistantAgent settings.");
  }

  const record = value as Record<string, unknown>;
  if (!isProfileAssistantAgentMode(record.mode)) {
    throw new Error("Exported profile has an invalid assistant agent mode.");
  }

  const providerRuntime = parseProviderRuntime(record.providerRuntime);
  return {
    mode: record.mode,
    ...(providerRuntime ? { providerRuntime } : {})
  };
}

function parseProviderRuntime(value: unknown): Profile["assistantAgent"]["providerRuntime"] {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported profile providerRuntime must be an object.");
  }

  const record = value as Record<string, unknown>;
  const runtime: NonNullable<Profile["assistantAgent"]["providerRuntime"]> = {};
  for (const [mode, entry] of Object.entries(record)) {
    if (!isProfileAssistantAgentMode(mode)) {
      throw new Error(`Exported profile providerRuntime has unknown mode ${mode}.`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Exported profile providerRuntime entry for ${mode} must be an object.`);
    }
    const entryRecord = entry as Record<string, unknown>;
    const normalized: { cwd?: string; timeoutMs?: number } = {};
    if (entryRecord.cwd !== undefined) {
      if (typeof entryRecord.cwd !== "string" || entryRecord.cwd.trim().length === 0) {
        throw new Error(`Exported profile providerRuntime cwd for ${mode} must be text.`);
      }
      normalized.cwd = entryRecord.cwd;
    }
    if (entryRecord.timeoutMs !== undefined) {
      if (
        typeof entryRecord.timeoutMs !== "number"
        || !Number.isSafeInteger(entryRecord.timeoutMs)
        || entryRecord.timeoutMs <= 0
      ) {
        throw new Error(`Exported profile providerRuntime timeoutMs for ${mode} must be a positive integer.`);
      }
      normalized.timeoutMs = entryRecord.timeoutMs;
    }
    runtime[mode] = normalized;
  }

  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

function parsePlanner(value: unknown): Profile["plannerProvider"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported profile requires plannerProvider settings.");
  }

  const record = value as Record<string, unknown>;
  if (!isProfilePlannerMode(record.mode)) {
    throw new Error("Exported profile has an invalid planner mode.");
  }
  return { mode: record.mode };
}

function parseAppPolicy(value: unknown): Profile["appPolicy"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported profile requires appPolicy settings.");
  }

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.apps)) {
    throw new Error("Exported profile appPolicy must list apps.");
  }

  const apps: ProfileAppPolicyEntry[] = [];
  const seen = new Set<string>();
  for (const entry of record.apps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Exported profile appPolicy entries must be objects.");
    }
    const app = entry as Record<string, unknown>;
    if (
      typeof app.name !== "string"
      || app.name.trim().length === 0
      || typeof app.bundleId !== "string"
      || app.bundleId.trim().length === 0
      || !isProfileAppPolicy(app.policy)
    ) {
      throw new Error("Exported profile contains an invalid app policy entry.");
    }
    if (seen.has(app.bundleId)) {
      throw new Error(`Exported profile lists app policy for ${app.bundleId} more than once.`);
    }
    seen.add(app.bundleId);
    apps.push({ name: app.name, bundleId: app.bundleId, policy: app.policy });
  }

  return { apps };
}

function parseWorkflowDefaults(value: unknown): Profile["workflowDefaults"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported profile requires workflowDefaults.");
  }

  const record = value as Record<string, unknown>;
  if (
    !isProfileManualMode(record.defaultManualMode)
    || typeof record.postTurnLearningEnabled !== "boolean"
    || typeof record.writeApprovalEnabled !== "boolean"
  ) {
    throw new Error("Exported profile has invalid workflowDefaults.");
  }

  return {
    defaultManualMode: record.defaultManualMode,
    postTurnLearningEnabled: record.postTurnLearningEnabled,
    writeApprovalEnabled: record.writeApprovalEnabled
  };
}

function parseMemory(value: unknown): { userEntries: string[]; agentEntries: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported profile memory must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.userEntries) || !Array.isArray(record.agentEntries)) {
    throw new Error("Exported profile memory requires userEntries and agentEntries arrays.");
  }

  return {
    userEntries: capMemoryEntries(record.userEntries.filter((entry): entry is string => typeof entry === "string")),
    agentEntries: capMemoryEntries(record.agentEntries.filter((entry): entry is string => typeof entry === "string"))
  };
}

function parseSessionRecord(value: unknown): ProfileSessionRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.turnId !== "string"
    || typeof record.createdAt !== "string"
    || typeof record.userInput !== "string"
    || typeof record.assistantReply !== "string"
    || typeof record.providerLabel !== "string"
  ) {
    return undefined;
  }

  const session: ProfileSessionRecord = {
    turnId: truncate(record.turnId, 100),
    createdAt: record.createdAt,
    userInput: truncate(record.userInput, MAX_EXPORT_TEXT_LENGTH),
    assistantReply: truncate(record.assistantReply, MAX_EXPORT_TEXT_LENGTH),
    providerLabel: truncate(record.providerLabel, 100)
  };

  if (record.browserContext && typeof record.browserContext === "object" && !Array.isArray(record.browserContext)) {
    const browserContext = record.browserContext as Record<string, unknown>;
    session.browserContext = {
      ...(typeof browserContext.url === "string" ? { url: truncate(browserContext.url, 500) } : {}),
      ...(typeof browserContext.title === "string" ? { title: truncate(browserContext.title, 300) } : {})
    };
  }

  return session;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
