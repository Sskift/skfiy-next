import { describe, expect, it } from "vitest";
import {
  PERSONAL_MEMORY_WRITE_APPROVAL_ENV,
  createPersonalMemorySettingsFilePath,
  createPersonalMemorySettingsStore,
  readPersonalMemorySettings,
  readPersonalMemorySettingsUpdate
} from "./personal-memory-settings";
import type { PersonalMemorySettingsIo } from "./personal-memory-settings";

describe("personal memory settings store", () => {
  it("defaults to post-turn learning on and write approval off", () => {
    const files = new Map<string, string>();
    const store = createPersonalMemorySettingsStore({
      baseDir: "/tmp/skfiy",
      io: createSettingsIo(files)
    });

    expect(store.read()).toEqual({
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    });
  });

  it("persists partial updates and merges them with the stored flags", () => {
    const files = new Map<string, string>();
    const store = createPersonalMemorySettingsStore({
      baseDir: "/tmp/skfiy",
      io: createSettingsIo(files),
      now: () => new Date("2026-08-20T09:00:00.000Z")
    });

    expect(store.update({ postTurnLearningEnabled: false })).toEqual({
      postTurnLearningEnabled: false,
      writeApprovalEnabled: false
    });
    expect(store.update({ writeApprovalEnabled: true })).toEqual({
      postTurnLearningEnabled: false,
      writeApprovalEnabled: true
    });

    const filePath = createPersonalMemorySettingsFilePath("/tmp/skfiy");
    expect(files.get(filePath)).toContain('"postTurnLearningEnabled": false');
    expect(files.get(filePath)).toContain('"writeApprovalEnabled": true');
    expect(files.get(filePath)).toContain('"updatedAt": "2026-08-20T09:00:00.000Z"');

    const rereadStore = createPersonalMemorySettingsStore({
      baseDir: "/tmp/skfiy",
      io: createSettingsIo(files)
    });
    expect(rereadStore.read()).toEqual({
      postTurnLearningEnabled: false,
      writeApprovalEnabled: true
    });
  });

  it("forces write approval on when the env flag is enabled, without persisting the force", () => {
    const files = new Map<string, string>();
    const env = { [PERSONAL_MEMORY_WRITE_APPROVAL_ENV]: "1" };
    const store = createPersonalMemorySettingsStore({
      baseDir: "/tmp/skfiy",
      io: createSettingsIo(files),
      env
    });

    expect(store.read()).toEqual({
      postTurnLearningEnabled: true,
      writeApprovalEnabled: true
    });

    store.update({ postTurnLearningEnabled: false });
    expect(store.read()).toEqual({
      postTurnLearningEnabled: false,
      writeApprovalEnabled: true
    });

    const withoutEnv = createPersonalMemorySettingsStore({
      baseDir: "/tmp/skfiy",
      io: createSettingsIo(files),
      env: {}
    });
    expect(withoutEnv.read()).toEqual({
      postTurnLearningEnabled: false,
      writeApprovalEnabled: false
    });
  });

  it("falls back to defaults when the settings file is invalid JSON", () => {
    const files = new Map<string, string>([
      [createPersonalMemorySettingsFilePath("/tmp/skfiy"), "{not json"]
    ]);

    expect(readPersonalMemorySettings({
      baseDir: "/tmp/skfiy",
      io: createSettingsIo(files)
    })).toEqual({
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    });
  });

  it("reads only boolean flags from update payloads", () => {
    expect(readPersonalMemorySettingsUpdate({
      postTurnLearningEnabled: false,
      writeApprovalEnabled: "yes",
      unexpected: true
    })).toEqual({
      postTurnLearningEnabled: false
    });
    expect(readPersonalMemorySettingsUpdate("nope")).toEqual({});
    expect(readPersonalMemorySettingsUpdate(null)).toEqual({});
  });
});

function createSettingsIo(files: Map<string, string>): PersonalMemorySettingsIo {
  return {
    exists: (targetPath) => files.has(targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => files.get(targetPath) ?? "",
    writeFile: (targetPath, content) => {
      files.set(targetPath, content);
    }
  };
}
