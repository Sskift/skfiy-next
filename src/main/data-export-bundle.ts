import {
  DATA_EXPORT_SCHEMA_VERSION,
  DATA_EXPORT_EXPORTER_APP,
  isDataDomain,
  type DataDomain,
  type DataExportAutomation,
  type DataExportAutomationMonitor,
  type DataExportBundle,
  type DataExportPersonalMemory,
  type DataExportPersonalSkillSettings,
  type DataExportProfiles,
  type DataExportRedaction,
  type DataExportRuntime,
  type DataExportRuntimeSnapshot,
  type DataExportSessions
} from "../shared/data-export.js";
import {
  MAX_PROFILE_MEMORY_ENTRIES,
  MAX_PROFILE_NAME_LENGTH,
  isProfileAppPolicy,
  isProfileAssistantAgentMode,
  isProfileManualMode,
  isProfileMemoryScope,
  isProfilePlannerMode,
  type Profile,
  type ProfileAppPolicyEntry
} from "../shared/profile.js";
import {
  isRouteOutcomeKind,
  isRouteOutcomeTone,
  type RouteOutcome
} from "../shared/route-outcome.js";
import type {
  ConversationApprovalDecision,
  ConversationResultStatus,
  ConversationSession
} from "../shared/conversation-history.js";
import {
  redactSecrets,
  redactSecretsWithCount,
  SECRET_REDACTION_PATTERN_SOURCES
} from "../shared/redaction.js";

const MAX_EXPORT_TEXT_LENGTH = 2_000;
const MAX_EXPORT_SESSIONS = 50;
const MAX_EXPORT_MONITORS = 50;
const MAX_EXPORT_MESSAGE_LENGTH = 20_000;
const MAX_EXPORT_MONITOR_LABEL_LENGTH = 200;

/**
 * The single source of truth for which files back each exportable/resettable
 * domain. Paths are relative to the skfiy app-support dir for the shared
 * memory scope; isolated profiles resolve the same files under
 * `profiles/<profileId>/...`.
 */
export interface DataDomainDescriptor {
  domain: DataDomain;
  label: string;
  files: string[];
  resetImpact: string;
}

export const DATA_DOMAIN_DESCRIPTORS: Record<DataDomain, DataDomainDescriptor> = {
  profiles: {
    domain: "profiles",
    label: "Profiles",
    files: ["profiles/profiles.json"],
    resetImpact:
      "Deletes every profile except Default and the active profile, and resets Default to seed settings."
  },
  "personal-memory": {
    domain: "personal-memory",
    label: "Personal memory",
    files: [
      "memory/USER.md",
      "memory/AGENT.md",
      "memory/settings.json",
      "memory/memory-journal.jsonl",
      "memory/pending-memory-writes.json",
      "memory/personal-skills.json"
    ],
    resetImpact: "Clears USER.md and AGENT.md entries, the journal, pending writes, and resets memory settings and skills."
  },
  sessions: {
    domain: "sessions",
    label: "Conversation sessions",
    files: ["memory/conversation-sessions.json", "memory/sessions.jsonl"],
    resetImpact: "Clears all conversation sessions and legacy session records."
  },
  automation: {
    domain: "automation",
    label: "Automation monitors",
    files: ["automation-monitors.json", "automation-runs.json"],
    resetImpact:
      "Stops every automation monitor and its in-flight runs, then deletes all monitor definitions and run history. Monitors must be re-created afterward."
  },
  runtime: {
    domain: "runtime",
    label: "Runtime snapshot",
    files: ["runtime-snapshot.json", "runtime-turn-marker.json"],
    resetImpact: "Clears the persisted runtime snapshot so the next turn starts from an empty state."
  }
};

export const DATA_DOMAIN_ORDER: readonly DataDomain[] = [
  "profiles",
  "personal-memory",
  "sessions",
  "automation",
  "runtime"
];

export interface DataExportBundleDeps {
  appVersion: string;
  now?: () => Date;
  readProfiles: () => DataExportProfiles;
  readPersonalMemory: () => DataExportPersonalMemory;
  readSessions: () => DataExportSessions;
  readAutomation: () => DataExportAutomation;
  readRuntime: () => DataExportRuntime;
}

/**
 * Builds the unified export bundle for the requested domains. Every string
 * field passes through the shared secret redaction, entries are capped and
 * deduped, and the `redaction` block reports what was scrubbed so the bundle
 * is token-free, bounded, and inspectable.
 */
export function buildDataExportBundle(
  domains: readonly DataDomain[],
  deps: DataExportBundleDeps
): DataExportBundle {
  const now = deps.now ?? (() => new Date());
  const requested = normalizeRequestedDomains(domains);
  const redactionCounts = { entriesRedacted: 0 };

  const bundle: DataExportBundle = {
    schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
    exportedAt: now().toISOString(),
    exporter: { app: DATA_EXPORT_EXPORTER_APP, version: deps.appVersion },
    domains: requested,
    redaction: { patterns: [...SECRET_REDACTION_PATTERN_SOURCES], entriesRedacted: 0 }
  };

  for (const domain of requested) {
    switch (domain) {
      case "profiles":
        bundle.profiles = redactDeep(sanitizeProfiles(deps.readProfiles()), redactionCounts);
        break;
      case "personal-memory":
        bundle.personalMemory = redactDeep(sanitizePersonalMemory(deps.readPersonalMemory()), redactionCounts);
        break;
      case "sessions":
        bundle.sessions = redactDeep(sanitizeSessions(deps.readSessions()), redactionCounts);
        break;
      case "automation":
        bundle.automation = redactDeep(sanitizeAutomation(deps.readAutomation()), redactionCounts);
        break;
      case "runtime":
        bundle.runtime = redactDeep(sanitizeRuntime(deps.readRuntime()), redactionCounts);
        break;
    }
  }

  bundle.redaction.entriesRedacted = redactionCounts.entriesRedacted;
  return bundle;
}

function normalizeRequestedDomains(domains: readonly DataDomain[]): DataDomain[] {
  const seen = new Set<DataDomain>();
  const result: DataDomain[] = [];
  for (const domain of domains) {
    if (!seen.has(domain)) {
      seen.add(domain);
      result.push(domain);
    }
  }
  return result;
}

function sanitizeProfiles(payload: DataExportProfiles): DataExportProfiles {
  return {
    activeProfileId: truncate(payload.activeProfileId, 200),
    profiles: payload.profiles.map(sanitizeExportedProfile)
  };
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

function sanitizePersonalMemory(payload: DataExportPersonalMemory): DataExportPersonalMemory {
  const sanitized: DataExportPersonalMemory = {
    scope: payload.scope === "isolated" ? "isolated" : "shared",
    ...(payload.profileId ? { profileId: truncate(payload.profileId, 200) } : {}),
    userEntries: capMemoryEntries(payload.userEntries),
    agentEntries: capMemoryEntries(payload.agentEntries)
  };
  if (payload.settings) {
    sanitized.settings = {
      postTurnLearningEnabled: payload.settings.postTurnLearningEnabled === true,
      writeApprovalEnabled: payload.settings.writeApprovalEnabled === true
    };
  }
  if (payload.skills) {
    sanitized.skills = sanitizeSkillSettings(payload.skills);
  }
  return sanitized;
}

function sanitizeSkillSettings(skills: DataExportPersonalSkillSettings): DataExportPersonalSkillSettings {
  const sanitized: DataExportPersonalSkillSettings = {
    disabledSkillIds: Array.from(new Set(
      skills.disabledSkillIds
        .filter((id) => typeof id === "string")
        .map((id) => truncate(id, 100))
    )).slice(0, MAX_PROFILE_MEMORY_ENTRIES)
  };
  if (skills.updatedAt) {
    sanitized.updatedAt = skills.updatedAt;
  }
  return sanitized;
}

function capMemoryEntries(entries: readonly string[]): string[] {
  return Array.from(new Set(
    entries
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => truncate(entry, MAX_EXPORT_TEXT_LENGTH))
  )).slice(0, MAX_PROFILE_MEMORY_ENTRIES);
}

function sanitizeSessions(payload: DataExportSessions): DataExportSessions {
  return {
    conversations: payload.conversations
      .filter((session): session is ConversationSession => Boolean(session))
      .slice(0, MAX_EXPORT_SESSIONS)
      .map((session) => truncateDeep(session, MAX_EXPORT_MESSAGE_LENGTH) as ConversationSession)
  };
}

function sanitizeAutomation(payload: DataExportAutomation): DataExportAutomation {
  return {
    monitors: payload.monitors
      .filter((monitor): monitor is DataExportAutomationMonitor => Boolean(monitor))
      .slice(0, MAX_EXPORT_MONITORS)
      .map((monitor) => ({
        ...monitor,
        id: truncate(monitor.id, 240),
        label: truncate(monitor.label, MAX_EXPORT_MONITOR_LABEL_LENGTH),
        sessionName: truncate(monitor.sessionName, 200)
      }))
  };
}

function sanitizeRuntime(payload: DataExportRuntime): DataExportRuntime {
  if (!payload.snapshot) {
    return {};
  }
  return {
    snapshot: truncateDeep(payload.snapshot, MAX_EXPORT_TEXT_LENGTH) as DataExportRuntimeSnapshot
  };
}

/**
 * Validates an incoming bundle. Throws on any structural violation so a
 * malformed or hostile bundle can never reach the stores.
 */
export function parseDataExportBundle(value: unknown): DataExportBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data export bundle must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== DATA_EXPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported data export schema version: ${String(record.schemaVersion)}.`);
  }
  if (typeof record.exportedAt !== "string" || record.exportedAt.length === 0) {
    throw new Error("Data export bundle requires an exportedAt timestamp.");
  }
  const exporter = parseExporter(record.exporter);
  const domains = parseDomains(record.domains);
  const redaction = parseRedaction(record.redaction);

  const bundle: DataExportBundle = {
    schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
    exportedAt: record.exportedAt,
    exporter,
    domains,
    redaction
  };

  for (const domain of domains) {
    switch (domain) {
      case "profiles":
        bundle.profiles = parseProfilesPayload(record.profiles);
        break;
      case "personal-memory":
        bundle.personalMemory = parsePersonalMemoryPayload(record.personalMemory);
        break;
      case "sessions":
        bundle.sessions = parseSessionsPayload(record.sessions);
        break;
      case "automation":
        bundle.automation = parseAutomationPayload(record.automation);
        break;
      case "runtime":
        bundle.runtime = parseRuntimePayload(record.runtime);
        break;
    }
  }

  // Strict: a payload for a domain not declared in `domains` is a structural
  // violation — the bundle must not smuggle undeclared data.
  const declared = new Set<DataDomain>(domains);
  for (const domain of DATA_DOMAIN_ORDER) {
    const payload = record[domainToPayloadKey(domain)];
    if (payload !== undefined && !declared.has(domain)) {
      throw new Error(`Data export bundle carries an undeclared ${domain} payload.`);
    }
  }

  return bundle;
}

function domainToPayloadKey(domain: DataDomain): keyof DataExportBundle {
  switch (domain) {
    case "profiles":
      return "profiles";
    case "personal-memory":
      return "personalMemory";
    case "sessions":
      return "sessions";
    case "automation":
      return "automation";
    case "runtime":
      return "runtime";
  }
}

function parseExporter(value: unknown): DataExportBundle["exporter"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data export bundle requires an exporter object.");
  }
  const record = value as Record<string, unknown>;
  if (record.app !== DATA_EXPORT_EXPORTER_APP) {
    throw new Error(`Unsupported data export exporter: ${String(record.app)}.`);
  }
  if (typeof record.version !== "string" || record.version.length === 0) {
    throw new Error("Data export exporter requires a version string.");
  }
  return { app: DATA_EXPORT_EXPORTER_APP, version: record.version };
}

function parseDomains(value: unknown): DataDomain[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Data export bundle requires a non-empty domains array.");
  }
  const domains: DataDomain[] = [];
  const seen = new Set<DataDomain>();
  for (const entry of value) {
    if (!isDataDomain(entry)) {
      throw new Error(`Unknown data export domain: ${String(entry)}.`);
    }
    if (seen.has(entry)) {
      throw new Error(`Data export bundle lists domain ${entry} more than once.`);
    }
    seen.add(entry);
    domains.push(entry);
  }
  return domains;
}

function parseRedaction(value: unknown): DataExportRedaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data export bundle requires a redaction block.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.patterns) || !record.patterns.every((p) => typeof p === "string")) {
    throw new Error("Data export redaction patterns must be an array of strings.");
  }
  if (typeof record.entriesRedacted !== "number" || !Number.isFinite(record.entriesRedacted)) {
    throw new Error("Data export redaction entriesRedacted must be a number.");
  }
  return {
    patterns: [...record.patterns],
    entriesRedacted: Math.max(0, Math.round(record.entriesRedacted))
  };
}

function parseProfilesPayload(value: unknown): DataExportProfiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data export profiles payload must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.activeProfileId !== "string" || record.activeProfileId.length === 0) {
    throw new Error("Data export profiles payload requires an activeProfileId.");
  }
  if (!Array.isArray(record.profiles)) {
    throw new Error("Data export profiles payload requires a profiles array.");
  }
  return {
    activeProfileId: record.activeProfileId,
    profiles: record.profiles.map(parseExportedProfile)
  };
}

function parseExportedProfile(value: unknown): Profile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported profile must be an object.");
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
  const assistantAgent = parseExportedAssistantAgent(record.assistantAgent);
  const plannerProvider = parseExportedPlanner(record.plannerProvider);
  const appPolicy = parseExportedAppPolicy(record.appPolicy);
  const workflowDefaults = parseExportedWorkflowDefaults(record.workflowDefaults);

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

function parseExportedAssistantAgent(value: unknown): Profile["assistantAgent"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported profile requires assistantAgent settings.");
  }
  const record = value as Record<string, unknown>;
  if (!isProfileAssistantAgentMode(record.mode)) {
    throw new Error("Exported profile has an invalid assistant agent mode.");
  }
  const assistantAgent: Profile["assistantAgent"] = { mode: record.mode };
  if (record.providerRuntime !== undefined) {
    if (!value || typeof record.providerRuntime !== "object" || Array.isArray(record.providerRuntime)) {
      throw new Error("Exported profile providerRuntime must be an object.");
    }
    assistantAgent.providerRuntime = record.providerRuntime as Profile["assistantAgent"]["providerRuntime"];
  }
  return assistantAgent;
}

function parseExportedPlanner(value: unknown): Profile["plannerProvider"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported profile requires plannerProvider settings.");
  }
  const record = value as Record<string, unknown>;
  if (!isProfilePlannerMode(record.mode)) {
    throw new Error("Exported profile has an invalid planner mode.");
  }
  return { mode: record.mode };
}

function parseExportedAppPolicy(value: unknown): Profile["appPolicy"] {
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

function parseExportedWorkflowDefaults(value: unknown): Profile["workflowDefaults"] {
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

function parsePersonalMemoryPayload(value: unknown): DataExportPersonalMemory {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data export personal memory payload must be an object.");
  }
  const record = value as Record<string, unknown>;
  const scope = record.scope === "isolated" ? "isolated" : record.scope === "shared" ? "shared" : undefined;
  if (!scope) {
    throw new Error("Data export personal memory requires a shared or isolated scope.");
  }
  if (!Array.isArray(record.userEntries) || !Array.isArray(record.agentEntries)) {
    throw new Error("Data export personal memory requires userEntries and agentEntries arrays.");
  }
  const payload: DataExportPersonalMemory = {
    scope,
    ...(typeof record.profileId === "string" && record.profileId.length > 0
      ? { profileId: record.profileId }
      : {}),
    userEntries: capMemoryEntries(record.userEntries),
    agentEntries: capMemoryEntries(record.agentEntries)
  };
  if (record.settings !== undefined) {
    if (!record.settings || typeof record.settings !== "object" || Array.isArray(record.settings)) {
      throw new Error("Data export personal memory settings must be an object.");
    }
    const settings = record.settings as Record<string, unknown>;
    if (
      typeof settings.postTurnLearningEnabled !== "boolean"
      || typeof settings.writeApprovalEnabled !== "boolean"
    ) {
      throw new Error("Data export personal memory settings are invalid.");
    }
    payload.settings = {
      postTurnLearningEnabled: settings.postTurnLearningEnabled,
      writeApprovalEnabled: settings.writeApprovalEnabled
    };
  }
  if (record.skills !== undefined) {
    if (!record.skills || typeof record.skills !== "object" || Array.isArray(record.skills)) {
      throw new Error("Data export personal skill settings must be an object.");
    }
    const skills = record.skills as Record<string, unknown>;
    if (!Array.isArray(skills.disabledSkillIds)) {
      throw new Error("Data export personal skill settings require a disabledSkillIds array.");
    }
    payload.skills = {
      disabledSkillIds: skills.disabledSkillIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => truncate(id, 100))
        .slice(0, MAX_PROFILE_MEMORY_ENTRIES),
      ...(typeof skills.updatedAt === "string" && skills.updatedAt.length > 0
        ? { updatedAt: skills.updatedAt }
        : {})
    };
  }
  return payload;
}

function parseSessionsPayload(value: unknown): DataExportSessions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data export sessions payload must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.conversations)) {
    throw new Error("Data export sessions payload requires a conversations array.");
  }
  return {
    conversations: record.conversations
      .slice(0, MAX_EXPORT_SESSIONS)
      .map(parseExportedConversation)
  };
}

function parseExportedConversation(value: unknown): ConversationSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported conversation must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" || record.id.length === 0
    || typeof record.title !== "string"
    || (record.titleSource !== "generated" && record.titleSource !== "user")
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
    || !Array.isArray(record.turns)
  ) {
    throw new Error("Exported conversation has an invalid shape.");
  }
  const session: ConversationSession = {
    id: record.id,
    title: truncate(record.title, 120),
    titleSource: record.titleSource,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    turns: record.turns.map(parseExportedTurn)
  };
  if (typeof record.archivedAt === "string") {
    session.archivedAt = record.archivedAt;
  }
  if (typeof record.deletedAt === "string") {
    session.deletedAt = record.deletedAt;
  }
  return session;
}

function parseExportedTurn(value: unknown): ConversationSession["turns"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported conversation turn must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" || record.id.length === 0
    || typeof record.submissionId !== "string" || record.submissionId.length === 0
    || typeof record.attempt !== "number" || !Number.isInteger(record.attempt) || record.attempt <= 0
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
    || typeof record.status !== "string"
    || !record.provider || typeof record.provider !== "object" || Array.isArray(record.provider)
    || typeof record.computerUseState !== "string"
    || !Array.isArray(record.messages)
  ) {
    throw new Error("Exported conversation turn has an invalid shape.");
  }
  const provider = record.provider as Record<string, unknown>;
  if (typeof provider.id !== "string" || typeof provider.label !== "string") {
    throw new Error("Exported conversation turn provider is invalid.");
  }
  if (!isConversationTurnStatus(record.status)) {
    throw new Error("Exported conversation turn has an invalid status.");
  }
  if (!isConversationComputerUseState(record.computerUseState)) {
    throw new Error("Exported conversation turn has an invalid computerUseState.");
  }
  const turn: ConversationSession["turns"][number] = {
    id: record.id,
    submissionId: record.submissionId,
    attempt: record.attempt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    provider: { id: provider.id, label: provider.label },
    computerUseState: record.computerUseState,
    messages: record.messages.map(parseExportedMessage)
  };
  if (typeof record.retryOfTurnId === "string") {
    turn.retryOfTurnId = record.retryOfTurnId;
  }
  if (typeof record.retryRequestId === "string") {
    turn.retryRequestId = record.retryRequestId;
  }
  return turn;
}

function parseExportedMessage(value: unknown): ConversationSession["turns"][number]["messages"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported conversation message must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" || record.id.length === 0
    || typeof record.turnId !== "string" || record.turnId.length === 0
    || typeof record.createdAt !== "string"
    || typeof record.kind !== "string"
    || typeof record.text !== "string"
  ) {
    throw new Error("Exported conversation message has an invalid shape.");
  }
  const base = {
    id: record.id,
    turnId: record.turnId,
    createdAt: record.createdAt,
    text: truncate(record.text, MAX_EXPORT_MESSAGE_LENGTH)
  };
  switch (record.kind) {
    case "user-text":
      return { ...base, kind: "user-text", text: base.text };
    case "agent-reply": {
      if (record.state !== "completed" && record.state !== "error") {
        throw new Error("Exported agent reply message has an invalid state.");
      }
      if (!record.provider || typeof record.provider !== "object" || Array.isArray(record.provider)) {
        throw new Error("Exported agent reply message requires a provider.");
      }
      const provider = record.provider as Record<string, unknown>;
      if (typeof provider.id !== "string" || typeof provider.label !== "string") {
        throw new Error("Exported agent reply provider is invalid.");
      }
      return {
        ...base,
        kind: "agent-reply",
        text: base.text,
        provider: { id: provider.id, label: provider.label },
        state: record.state
      };
    }
    case "computer-use-request": {
      if (
        typeof record.toolCallId !== "string"
        || typeof record.command !== "string"
        || typeof record.route !== "string"
      ) {
        throw new Error("Exported computer-use-request message is invalid.");
      }
      return {
        ...base,
        kind: "computer-use-request",
        text: base.text,
        toolCallId: record.toolCallId,
        command: truncate(record.command, 5_000),
        route: record.route
      };
    }
    case "approval": {
      if (
        typeof record.toolCallId !== "string"
        || (record.decision !== "required"
          && record.decision !== "approved"
          && record.decision !== "denied"
          && record.decision !== "bypassed")
      ) {
        throw new Error("Exported approval message is invalid.");
      }
      return {
        ...base,
        kind: "approval",
        text: base.text,
        toolCallId: record.toolCallId,
        decision: record.decision as ConversationApprovalDecision,
        ...(typeof record.reason === "string" ? { reason: record.reason } : {})
      };
    }
    case "result": {
      if (
        typeof record.toolCallId !== "string"
        || typeof record.status !== "string"
        || typeof record.summary !== "string"
      ) {
        throw new Error("Exported result message is invalid.");
      }
      if (
        record.status !== "completed"
        && record.status !== "denied"
        && record.status !== "blocked"
        && record.status !== "failed"
        && record.status !== "cancelled"
      ) {
        throw new Error("Exported result message has an invalid status.");
      }
      return {
        ...base,
        kind: "result",
        text: base.text,
        toolCallId: record.toolCallId,
        status: record.status as ConversationResultStatus,
        summary: record.summary
      };
    }
    case "stopped": {
      if (typeof record.reason !== "string") {
        throw new Error("Exported stopped message is invalid.");
      }
      return { ...base, kind: "stopped", text: base.text, reason: record.reason };
    }
    default:
      throw new Error(`Exported conversation message has an unknown kind: ${String(record.kind)}.`);
  }
}

function parseAutomationPayload(value: unknown): DataExportAutomation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data export automation payload must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.monitors)) {
    throw new Error("Data export automation payload requires a monitors array.");
  }
  return {
    monitors: record.monitors
      .slice(0, MAX_EXPORT_MONITORS)
      .map(parseExportedAutomationMonitor)
  };
}

function parseExportedAutomationMonitor(value: unknown): DataExportAutomationMonitor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exported automation monitor must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" || record.id.length === 0
    || typeof record.kind !== "string"
    || typeof record.label !== "string"
    || typeof record.enabled !== "boolean"
    || typeof record.intervalMs !== "number" || !Number.isFinite(record.intervalMs)
    || typeof record.timeoutMs !== "number" || !Number.isFinite(record.timeoutMs)
    || typeof record.triggerMode !== "string"
    || typeof record.sessionName !== "string" || record.sessionName.length === 0
    || typeof record.concurrencyPolicy !== "string"
    || typeof record.maxConcurrency !== "number" || !Number.isFinite(record.maxConcurrency)
    || typeof record.maxAttempts !== "number" || !Number.isFinite(record.maxAttempts)
    || typeof record.backoffMs !== "number" || !Number.isFinite(record.backoffMs)
    || typeof record.backoffMultiplier !== "number" || !Number.isFinite(record.backoffMultiplier)
    || typeof record.maxBackoffMs !== "number" || !Number.isFinite(record.maxBackoffMs)
    || typeof record.runTtlMs !== "number" || !Number.isFinite(record.runTtlMs)
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
    || !record.preview || typeof record.preview !== "object" || Array.isArray(record.preview)
  ) {
    throw new Error("Exported automation monitor has an invalid shape.");
  }
  const preview = record.preview as Record<string, unknown>;
  if (
    typeof preview.adapter !== "string"
    || !Array.isArray(preview.triggerModes)
    || !preview.target || typeof preview.target !== "object" || Array.isArray(preview.target)
    || !Array.isArray(preview.requiredPermissions)
    || typeof preview.readWriteBehavior !== "string"
    || typeof preview.approvalMode !== "string"
    || typeof preview.timeoutMs !== "number" || !Number.isFinite(preview.timeoutMs)
    || typeof preview.verification !== "string"
    || typeof preview.mutatesSession !== "boolean"
  ) {
    throw new Error("Exported automation monitor preview has an invalid shape.");
  }
  const target = preview.target as Record<string, unknown>;
  if (typeof target.kind !== "string" || typeof target.sessionName !== "string") {
    throw new Error("Exported automation monitor preview target is invalid.");
  }
  const monitor: DataExportAutomationMonitor = {
    id: record.id,
    kind: record.kind,
    label: record.label,
    enabled: record.enabled,
    intervalMs: record.intervalMs,
    timeoutMs: record.timeoutMs,
    triggerMode: record.triggerMode,
    sessionName: record.sessionName,
    preview: {
      adapter: preview.adapter,
      triggerModes: preview.triggerModes.filter((mode): mode is string => typeof mode === "string"),
      target: { kind: target.kind, sessionName: target.sessionName },
      requiredPermissions: preview.requiredPermissions.filter(
        (permission): permission is string => typeof permission === "string"
      ),
      readWriteBehavior: preview.readWriteBehavior,
      approvalMode: preview.approvalMode,
      timeoutMs: preview.timeoutMs,
      verification: preview.verification,
      mutatesSession: preview.mutatesSession
    },
    concurrencyPolicy: record.concurrencyPolicy,
    maxConcurrency: record.maxConcurrency,
    maxAttempts: record.maxAttempts,
    backoffMs: record.backoffMs,
    backoffMultiplier: record.backoffMultiplier,
    maxBackoffMs: record.maxBackoffMs,
    runTtlMs: record.runTtlMs,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
  if (preview.concurrency && typeof preview.concurrency === "object" && !Array.isArray(preview.concurrency)) {
    const concurrency = preview.concurrency as Record<string, unknown>;
    if (typeof concurrency.policy === "string" && typeof concurrency.max === "number") {
      monitor.preview.concurrency = { policy: concurrency.policy, max: concurrency.max };
    }
  }
  if (preview.retry && typeof preview.retry === "object" && !Array.isArray(preview.retry)) {
    const retry = preview.retry as Record<string, unknown>;
    if (
      typeof retry.maxAttempts === "number"
      && typeof retry.backoffMs === "number"
      && typeof retry.maxBackoffMs === "number"
    ) {
      monitor.preview.retry = {
        maxAttempts: retry.maxAttempts,
        backoffMs: retry.backoffMs,
        maxBackoffMs: retry.maxBackoffMs
      };
    }
  }
  if (typeof preview.runTtlMs === "number") {
    monitor.preview.runTtlMs = preview.runTtlMs;
  }
  return monitor;
}

function parseRuntimePayload(value: unknown): DataExportRuntime {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data export runtime payload must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.snapshot === undefined) {
    return {};
  }
  if (!record.snapshot || typeof record.snapshot !== "object" || Array.isArray(record.snapshot)) {
    throw new Error("Data export runtime snapshot must be an object.");
  }
  const snapshot = record.snapshot as Record<string, unknown>;
  if (
    typeof snapshot.schemaVersion !== "number"
    || typeof snapshot.observedAt !== "string"
    || !snapshot.currentTurn || typeof snapshot.currentTurn !== "object" || Array.isArray(snapshot.currentTurn)
    || !snapshot.replay || typeof snapshot.replay !== "object" || Array.isArray(snapshot.replay)
  ) {
    throw new Error("Data export runtime snapshot has an invalid shape.");
  }
  return {
    snapshot: {
      schemaVersion: snapshot.schemaVersion,
      observedAt: snapshot.observedAt,
      currentTurn: { ...(snapshot.currentTurn as Record<string, unknown>) },
      routeOutcome: parseExportedRouteOutcome(snapshot.routeOutcome),
      replay: { ...(snapshot.replay as Record<string, unknown>) }
    }
  };
}

function parseExportedRouteOutcome(value: unknown): RouteOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data export runtime snapshot requires a routeOutcome.");
  }
  const record = value as Record<string, unknown>;
  if (
    !isRouteOutcomeKind(record.kind)
    || typeof record.title !== "string"
    || typeof record.value !== "string"
    || typeof record.detail !== "string"
    || !isRouteOutcomeTone(record.tone)
    || typeof record.source !== "string"
    || typeof record.routeLabel !== "string"
    || typeof record.state !== "string"
  ) {
    throw new Error("Data export runtime routeOutcome is invalid.");
  }
  return {
    kind: record.kind,
    title: record.title,
    value: record.value,
    detail: record.detail,
    tone: record.tone,
    source: record.source,
    routeLabel: record.routeLabel,
    state: record.state,
    ...(typeof record.denialKind === "string" ? { denialKind: record.denialKind } : {}),
    ...(typeof record.policyKind === "string" ? { policyKind: record.policyKind } : {})
  };
}

function redactDeep<T>(value: T, counts: { entriesRedacted: number }): T {
  if (typeof value === "string") {
    const result = redactSecretsWithCount(value);
    if (result.count > 0) {
      counts.entriesRedacted += 1;
    }
    return result.text as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, counts)) as T;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = redactDeep(entry, counts);
    }
    return result as T;
  }
  return value;
}

function truncateDeep<T>(value: T, maxLength: number): T {
  if (typeof value === "string") {
    return truncate(value, maxLength) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => truncateDeep(entry, maxLength)) as T;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = truncateDeep(entry, maxLength);
    }
    return result as T;
  }
  return value;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function isConversationTurnStatus(value: unknown): value is ConversationSession["turns"][number]["status"] {
  return value === "pending"
    || value === "completed"
    || value === "provider-failed"
    || value === "denied"
    || value === "blocked"
    || value === "failed"
    || value === "cancelled"
    || value === "stopped";
}

function isConversationComputerUseState(
  value: unknown
): value is ConversationSession["turns"][number]["computerUseState"] {
  return value === "none"
    || value === "requested"
    || value === "dispatching"
    || value === "finished"
    || value === "unknown";
}

// Re-export so callers can build redaction-aware text without another import.
export { redactSecrets };
