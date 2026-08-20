import { createPersonalMemoryStore } from "./personal-memory.js";
import { createPersonalMemorySettingsStore } from "./personal-memory-settings.js";
import { createSessionMemoryStore } from "./session-memory.js";
import { createPersonalMemoryJournalStore } from "./personal-memory-journal.js";
import { createPendingPersonalMemoryStore } from "./personal-memory-pending.js";
import { createPersonalSkillSettingsStore } from "./personal-skills.js";

/**
 * The six memory-backed stores all resolve their files under
 * `<baseDir>/memory/...`. Profiles rebuild this bundle against a
 * profile-scoped base dir when an isolated profile is active, so every
 * existing memory consumer reads profile-scoped data with no further
 * changes. The Default profile keeps the global base dir, preserving
 * existing USER.md / AGENT.md / sessions.jsonl on disk.
 */
export interface MemoryStores {
  baseDir: string;
  personalMemory: ReturnType<typeof createPersonalMemoryStore>;
  personalMemorySettings: ReturnType<typeof createPersonalMemorySettingsStore>;
  sessionMemory: ReturnType<typeof createSessionMemoryStore>;
  personalMemoryJournal: ReturnType<typeof createPersonalMemoryJournalStore>;
  pendingPersonalMemory: ReturnType<typeof createPendingPersonalMemoryStore>;
  personalSkillSettings: ReturnType<typeof createPersonalSkillSettingsStore>;
}

export function createMemoryStores(baseDir: string): MemoryStores {
  return {
    baseDir,
    personalMemory: createPersonalMemoryStore({ baseDir }),
    personalMemorySettings: createPersonalMemorySettingsStore({ baseDir }),
    sessionMemory: createSessionMemoryStore({ baseDir }),
    personalMemoryJournal: createPersonalMemoryJournalStore({ baseDir }),
    pendingPersonalMemory: createPendingPersonalMemoryStore({ baseDir }),
    personalSkillSettings: createPersonalSkillSettingsStore({ baseDir })
  };
}
