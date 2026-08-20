import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  PROFILE_SCHEMA_VERSION,
  createProfileSummary,
  isProfileAppPolicy,
  isProfileAssistantAgentMode,
  isProfileManualMode,
  isProfileMemoryScope,
  isProfilePlannerMode,
  type Profile,
  type ProfileAppPolicyEntry,
  type ProfileMemoryScope,
  type ProfileRuntimeSnapshot,
  type ProfileSettings,
  type ProfileSummary
} from "../shared/profile.js";

export interface ProfileStoreIo {
  exists: (targetPath: string) => boolean;
  mkdir: (targetPath: string) => void;
  readFile: (targetPath: string) => string;
  writeFile: (targetPath: string, content: string) => void;
}

export interface ProfileStoreOptions {
  baseDir: string;
  io?: ProfileStoreIo;
  now?: () => Date;
  idFactory?: () => string;
  seed: ProfileSettings;
}

export interface ProfileStore {
  list(): Profile[];
  get(profileId: string): Profile | undefined;
  getActiveId(): string | null;
  setActiveId(profileId: string): void;
  create(input: { name: string; settings: ProfileSettings; memoryScope: ProfileMemoryScope }): Profile;
  rename(profileId: string, name: string): Profile;
  delete(profileId: string): void;
  captureActive(settings: ProfileSettings): Profile | undefined;
  upsert(profile: Profile): Profile;
  snapshot(): ProfileRuntimeSnapshot;
}

interface PersistedProfileRegistry {
  schemaVersion: 1;
  activeProfileId: string;
  profiles: Profile[];
}

export function createProfileStore({
  baseDir,
  io = createDefaultProfileStoreIo(),
  now = () => new Date(),
  idFactory = () => randomUUID(),
  seed
}: ProfileStoreOptions): ProfileStore {
  const filePath = createProfileStoreFilePath(baseDir);
  let registry = loadOrSeedRegistry({ filePath, io, now, seed });

  function persist(): void {
    io.mkdir(path.dirname(filePath));
    io.writeFile(filePath, `${JSON.stringify(registry, null, 2)}\n`);
  }

  function writeRegistry(next: PersistedProfileRegistry): void {
    registry = next;
    persist();
  }

  return {
    list(): Profile[] {
      return registry.profiles.map((profile) => ({ ...profile }));
    },

    get(profileId: string): Profile | undefined {
      const profile = registry.profiles.find((entry) => entry.id === profileId);
      return profile ? { ...profile } : undefined;
    },

    getActiveId(): string | null {
      return registry.activeProfileId;
    },

    setActiveId(profileId: string): void {
      if (!registry.profiles.some((profile) => profile.id === profileId)) {
        throw new Error(`Cannot activate unknown profile ${profileId}.`);
      }
      if (registry.activeProfileId === profileId) {
        return;
      }
      writeRegistry({ ...registry, activeProfileId: profileId });
    },

    create(input: { name: string; settings: ProfileSettings; memoryScope: ProfileMemoryScope }): Profile {
      const timestamp = now().toISOString();
      const profile: Profile = {
        ...input.settings,
        id: idFactory(),
        name: input.name,
        createdAt: timestamp,
        updatedAt: timestamp,
        memoryScope: input.memoryScope
      };
      writeRegistry({ ...registry, profiles: [...registry.profiles, profile] });
      return { ...profile };
    },

    rename(profileId: string, name: string): Profile {
      const duplicate = registry.profiles.some(
        (profile) =>
          profile.id !== profileId
          && profile.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
      );
      if (duplicate) {
        throw new Error(`A profile named ${name} already exists.`);
      }

      const profile = registry.profiles.find((entry) => entry.id === profileId);
      if (!profile) {
        throw new Error(`Profile ${profileId} not found.`);
      }

      const updated: Profile = {
        ...profile,
        name,
        updatedAt: now().toISOString()
      };
      writeRegistry({
        ...registry,
        profiles: registry.profiles.map((entry) => (entry.id === profileId ? updated : entry))
      });
      return { ...updated };
    },

    delete(profileId: string): void {
      if (!registry.profiles.some((profile) => profile.id === profileId)) {
        throw new Error(`Profile ${profileId} not found.`);
      }
      if (profileId === DEFAULT_PROFILE_ID) {
        throw new Error("The default profile cannot be deleted.");
      }
      if (registry.activeProfileId === profileId) {
        throw new Error("The active profile cannot be deleted. Switch profiles first.");
      }

      writeRegistry({
        ...registry,
        profiles: registry.profiles.filter((profile) => profile.id !== profileId)
      });
    },

    captureActive(settings: ProfileSettings): Profile | undefined {
      const activeId = registry.activeProfileId;
      if (!activeId) {
        return undefined;
      }

      const profile = registry.profiles.find((entry) => entry.id === activeId);
      if (!profile) {
        return undefined;
      }

      const updated: Profile = {
        ...profile,
        ...settings,
        id: profile.id,
        name: profile.name,
        createdAt: profile.createdAt,
        memoryScope: profile.memoryScope,
        updatedAt: now().toISOString()
      };
      writeRegistry({
        ...registry,
        profiles: registry.profiles.map((entry) => (entry.id === activeId ? updated : entry))
      });
      return { ...updated };
    },

    upsert(profile: Profile): Profile {
      const stored: Profile = { ...profile };
      writeRegistry({ ...registry, profiles: [...registry.profiles, stored] });
      return { ...stored };
    },

    snapshot(): ProfileRuntimeSnapshot {
      const summaries: ProfileSummary[] = registry.profiles.map((profile) =>
        createProfileSummary(profile, registry.activeProfileId)
      );
      const active = summaries.find((profile) => profile.isActive) ?? null;
      return {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        activeProfileId: active?.id ?? null,
        activeProfile: active,
        profiles: summaries,
        memoryBaseDirScope: active?.memoryScope === "isolated" ? "isolated" : "shared"
      };
    }
  };
}

export function createProfileStoreFilePath(baseDir: string): string {
  return path.join(baseDir, "profiles", "profiles.json");
}

function loadOrSeedRegistry({
  filePath,
  io,
  now,
  seed
}: {
  filePath: string;
  io: ProfileStoreIo;
  now: () => Date;
  seed: ProfileSettings;
}): PersistedProfileRegistry {
  if (!io.exists(filePath)) {
    const timestamp = now().toISOString();
    const seeded: Profile = {
      ...seed,
      id: DEFAULT_PROFILE_ID,
      name: DEFAULT_PROFILE_NAME,
      createdAt: timestamp,
      updatedAt: timestamp,
      memoryScope: "shared"
    };
    return {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      activeProfileId: DEFAULT_PROFILE_ID,
      profiles: [seeded]
    };
  }

  try {
    const parsed = JSON.parse(io.readFile(filePath)) as unknown;
    return normalizeRegistry(parsed, seed);
  } catch {
    return createFallbackRegistry(seed);
  }
}

function normalizeRegistry(value: unknown, seed: ProfileSettings): PersistedProfileRegistry {
  const fallback = createFallbackRegistry(seed);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.profiles)) {
    return fallback;
  }

  const profiles = record.profiles
    .map((entry) => normalizeProfile(entry))
    .filter((profile): profile is Profile => Boolean(profile));

  if (profiles.length === 0) {
    return fallback;
  }

  const hasDefault = profiles.some((profile) => profile.id === DEFAULT_PROFILE_ID);
  const activeProfileId = typeof record.activeProfileId === "string"
    && profiles.some((profile) => profile.id === record.activeProfileId)
    ? record.activeProfileId
    : hasDefault
      ? DEFAULT_PROFILE_ID
      : profiles[0].id;

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    activeProfileId,
    profiles
  };
}

function normalizeProfile(value: unknown): Profile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || record.id.length === 0
    || typeof record.name !== "string"
    || record.name.trim().length === 0
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
    || !isProfileMemoryScope(record.memoryScope)
  ) {
    return undefined;
  }

  const assistantAgent = normalizeAssistantAgent(record.assistantAgent);
  const plannerProvider = normalizePlanner(record.plannerProvider);
  const appPolicy = normalizeAppPolicy(record.appPolicy);
  const workflowDefaults = normalizeWorkflowDefaults(record.workflowDefaults);
  if (!assistantAgent || !plannerProvider || !appPolicy || !workflowDefaults) {
    return undefined;
  }

  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    memoryScope: record.memoryScope,
    assistantAgent,
    plannerProvider,
    appPolicy,
    workflowDefaults
  };
}

function normalizeAssistantAgent(value: unknown): Profile["assistantAgent"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (!isProfileAssistantAgentMode(record.mode)) {
    return undefined;
  }

  const providerRuntime = normalizeProviderRuntime(record.providerRuntime);
  return {
    mode: record.mode,
    ...(providerRuntime ? { providerRuntime } : {})
  };
}

function normalizeProviderRuntime(value: unknown): Profile["assistantAgent"]["providerRuntime"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const runtime: NonNullable<Profile["assistantAgent"]["providerRuntime"]> = {};
  let hasEntry = false;

  for (const [mode, entry] of Object.entries(record)) {
    if (!isProfileAssistantAgentMode(mode) || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const entryRecord = entry as Record<string, unknown>;
    const normalized: { cwd?: string; timeoutMs?: number } = {};
    if (typeof entryRecord.cwd === "string" && entryRecord.cwd.trim().length > 0) {
      normalized.cwd = entryRecord.cwd;
    }
    if (
      typeof entryRecord.timeoutMs === "number"
      && Number.isSafeInteger(entryRecord.timeoutMs)
      && entryRecord.timeoutMs > 0
    ) {
      normalized.timeoutMs = entryRecord.timeoutMs;
    }
    if (Object.keys(normalized).length > 0) {
      runtime[mode] = normalized;
      hasEntry = true;
    }
  }

  return hasEntry ? runtime : undefined;
}

function normalizePlanner(value: unknown): Profile["plannerProvider"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return isProfilePlannerMode(record.mode) ? { mode: record.mode } : undefined;
}

function normalizeAppPolicy(value: unknown): Profile["appPolicy"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.apps)) {
    return undefined;
  }

  const apps: ProfileAppPolicyEntry[] = [];
  for (const entry of record.apps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const app = entry as Record<string, unknown>;
    if (
      typeof app.name !== "string"
      || typeof app.bundleId !== "string"
      || !isProfileAppPolicy(app.policy)
    ) {
      continue;
    }
    apps.push({ name: app.name, bundleId: app.bundleId, policy: app.policy });
  }

  return { apps };
}

function normalizeWorkflowDefaults(value: unknown): Profile["workflowDefaults"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    !isProfileManualMode(record.defaultManualMode)
    || typeof record.postTurnLearningEnabled !== "boolean"
    || typeof record.writeApprovalEnabled !== "boolean"
  ) {
    return undefined;
  }

  return {
    defaultManualMode: record.defaultManualMode,
    postTurnLearningEnabled: record.postTurnLearningEnabled,
    writeApprovalEnabled: record.writeApprovalEnabled
  };
}

function createFallbackRegistry(seed: ProfileSettings): PersistedProfileRegistry {
  const timestamp = new Date(0).toISOString();
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [
      {
        ...seed,
        id: DEFAULT_PROFILE_ID,
        name: DEFAULT_PROFILE_NAME,
        createdAt: timestamp,
        updatedAt: timestamp,
        memoryScope: "shared"
      }
    ]
  };
}

function createDefaultProfileStoreIo(): ProfileStoreIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8")
  };
}
