import { readRecord } from "./record-utils.js";
import type { ProfileRuntime } from "./profile-runtime.js";

export const PROFILE_IPC_CHANNELS = [
  "skfiy:get-profiles",
  "skfiy:switch-profile",
  "skfiy:create-profile",
  "skfiy:update-profile",
  "skfiy:delete-profile",
  "skfiy:export-profile",
  "skfiy:import-profile",
  "skfiy:profile-changed"
] as const;

export type ProfileIpcChannel = (typeof PROFILE_IPC_CHANNELS)[number];

export interface ProfileIpcMain {
  handle(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown
  ): void;
}

export function registerProfileIpc({
  ipcMain,
  runtime
}: {
  ipcMain: ProfileIpcMain;
  runtime: ProfileRuntime;
}): void {
  ipcMain.handle("skfiy:get-profiles", () => {
    return runtime.snapshot();
  });

  ipcMain.handle("skfiy:switch-profile", async (_event, input: unknown) => {
    const record = readRecord(input);
    const profileId = typeof record?.profileId === "string" ? record.profileId : undefined;
    if (!profileId) {
      throw new Error("skfiy:switch-profile requires a profileId.");
    }
    return runtime.switchProfile({
      profileId,
      confirm: record?.confirm === true
    });
  });

  ipcMain.handle("skfiy:create-profile", (_event, input: unknown) => {
    const record = readRecord(input);
    const name = typeof record?.name === "string" ? record.name : undefined;
    if (!name) {
      throw new Error("skfiy:create-profile requires a name.");
    }
    return runtime.createProfile({
      name,
      ...(record?.memoryScope !== undefined ? { memoryScope: record.memoryScope } : {}),
      ...(record?.cloneFromActive !== undefined
        ? { cloneFromActive: record.cloneFromActive === true }
        : {}),
      ...(record?.defaultManualMode !== undefined
        ? { defaultManualMode: record.defaultManualMode }
        : {})
    });
  });

  ipcMain.handle("skfiy:update-profile", (_event, input: unknown) => {
    const record = readRecord(input);
    const profileId = typeof record?.profileId === "string" ? record.profileId : undefined;
    if (!profileId) {
      throw new Error("skfiy:update-profile requires a profileId.");
    }
    return runtime.updateProfile({
      profileId,
      ...(typeof record?.name === "string" ? { name: record.name } : {})
    });
  });

  ipcMain.handle("skfiy:delete-profile", (_event, input: unknown) => {
    const record = readRecord(input);
    const profileId = typeof record?.profileId === "string" ? record.profileId : undefined;
    if (!profileId) {
      throw new Error("skfiy:delete-profile requires a profileId.");
    }
    return runtime.deleteProfile({ profileId });
  });

  ipcMain.handle("skfiy:export-profile", (_event, input: unknown) => {
    const record = readRecord(input);
    const profileId = typeof record?.profileId === "string" ? record.profileId : undefined;
    if (!profileId) {
      throw new Error("skfiy:export-profile requires a profileId.");
    }
    return runtime.exportProfile({
      profileId,
      includeMemory: record?.includeMemory === true
    });
  });

  ipcMain.handle("skfiy:import-profile", (_event, input: unknown) => {
    return runtime.importProfile(input);
  });
}
