import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PROFILE_IPC_CHANNELS,
  registerProfileIpc
} from "./main-profile-wiring";
import type { ProfileRuntime } from "./profile-runtime";
import type {
  ProfileExportBundle,
  ProfileRuntimeSnapshot,
  ProfileSwitchResult
} from "../shared/profile";

function createSnapshot(): ProfileRuntimeSnapshot {
  return {
    schemaVersion: 1,
    activeProfileId: "default",
    activeProfile: null,
    profiles: [],
    memoryBaseDirScope: "shared"
  };
}

function createRuntimeMock(): ProfileRuntime & {
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    snapshot: [],
    switchProfile: [],
    createProfile: [],
    updateProfile: [],
    deleteProfile: [],
    exportProfile: [],
    importProfile: []
  };
  const runtime = {
    calls,
    snapshot: vi.fn(() => {
      calls.snapshot.push([]);
      return createSnapshot();
    }),
    switchProfile: vi.fn(async (input: { profileId: string; confirm?: boolean }) => {
      calls.switchProfile.push([input]);
      return {
        status: "not-found",
        profileId: input.profileId
      } satisfies ProfileSwitchResult;
    }),
    createProfile: vi.fn((input: { name: string }) => {
      calls.createProfile.push([input]);
      return createSnapshot();
    }),
    updateProfile: vi.fn((input: { profileId: string; name?: string }) => {
      calls.updateProfile.push([input]);
      return createSnapshot();
    }),
    deleteProfile: vi.fn((input: { profileId: string }) => {
      calls.deleteProfile.push([input]);
      return createSnapshot();
    }),
    exportProfile: vi.fn((input: { profileId: string; includeMemory?: boolean }) => {
      calls.exportProfile.push([input]);
      return {
        schemaVersion: 1,
        exportedAt: "2026-08-01T00:00:00.000Z",
        profile: {
          id: input.profileId,
          name: "Writing",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          memoryScope: "isolated",
          assistantAgent: { mode: "codex" },
          plannerProvider: { mode: "local-deterministic" },
          appPolicy: { apps: [] },
          workflowDefaults: {
            defaultManualMode: "active",
            postTurnLearningEnabled: true,
            writeApprovalEnabled: false
          }
        }
      } satisfies ProfileExportBundle;
    }),
    importProfile: vi.fn((bundle: unknown) => {
      calls.importProfile.push([bundle]);
      return createSnapshot();
    }),
    captureActiveProfile: vi.fn(() => createSnapshot())
  };
  return runtime;
}

function createIpcMainFake() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) {
      handlers.set(channel, handler);
    }
  };
}

describe("main profile wiring", () => {
  it("registers every profile IPC channel", () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();

    registerProfileIpc({ ipcMain, runtime });

    for (const channel of PROFILE_IPC_CHANNELS) {
      if (channel === "skfiy:profile-changed") {
        // profile-changed is a main->renderer event, not a handled channel.
        continue;
      }
      expect(ipcMain.handlers.has(channel)).toBe(true);
    }
  });

  it("get-profiles returns the runtime snapshot", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerProfileIpc({ ipcMain, runtime });

    const result = await ipcMain.handlers.get("skfiy:get-profiles")?.(undefined);

    expect(result).toEqual(createSnapshot());
  });

  it("switch-profile requires a profileId and forwards confirm", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerProfileIpc({ ipcMain, runtime });

    await expect(
      ipcMain.handlers.get("skfiy:switch-profile")?.(undefined, {})
    ).rejects.toThrow(/profileId/);

    await ipcMain.handlers.get("skfiy:switch-profile")?.(undefined, {
      profileId: "profile-1",
      confirm: true
    });

    expect(runtime.switchProfile).toHaveBeenCalledWith({
      profileId: "profile-1",
      confirm: true
    });
  });

  it("create-profile requires a name and forwards cloneFromActive", () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerProfileIpc({ ipcMain, runtime });

    expect(() =>
      ipcMain.handlers.get("skfiy:create-profile")?.(undefined, {})
    ).toThrow(/name/);

    void ipcMain.handlers.get("skfiy:create-profile")?.(undefined, {
      name: "Writing",
      cloneFromActive: true,
      defaultManualMode: "quiet"
    });

    expect(runtime.createProfile).toHaveBeenCalledWith({
      name: "Writing",
      cloneFromActive: true,
      defaultManualMode: "quiet"
    });
  });

  it("update-profile, delete-profile, and export-profile require a profileId", () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerProfileIpc({ ipcMain, runtime });

    expect(() =>
      ipcMain.handlers.get("skfiy:update-profile")?.(undefined, {})
    ).toThrow(/profileId/);
    expect(() =>
      ipcMain.handlers.get("skfiy:delete-profile")?.(undefined, {})
    ).toThrow(/profileId/);
    expect(() =>
      ipcMain.handlers.get("skfiy:export-profile")?.(undefined, {})
    ).toThrow(/profileId/);
  });

  it("export-profile forwards includeMemory", () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerProfileIpc({ ipcMain, runtime });

    void ipcMain.handlers.get("skfiy:export-profile")?.(undefined, {
      profileId: "profile-1",
      includeMemory: true
    });

    expect(runtime.exportProfile).toHaveBeenCalledWith({
      profileId: "profile-1",
      includeMemory: true
    });
  });

  it("import-profile passes the raw bundle through for validation", () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerProfileIpc({ ipcMain, runtime });

    const bundle = { schemaVersion: 1, profile: {} };
    void ipcMain.handlers.get("skfiy:import-profile")?.(undefined, bundle);

    expect(runtime.importProfile).toHaveBeenCalledWith(bundle);
  });

  it("keeps untrusted browser page content away from profile switching", () => {
    // Browser page content, chrome task orchestrators, and the browser page
    // context must never be able to switch profiles, so they must not import
    // the profile runtime or store.
    for (const relativePath of [
      "browser-context-source-actions.ts",
      "browser-page-context.ts",
      path.join("orchestrator", "chrome-task.ts")
    ]) {
      const source = readFileSync(
        path.join(process.cwd(), "src", "main", relativePath),
        "utf8"
      );
      expect(source).not.toContain("profile-runtime");
      expect(source).not.toContain("profile-store");
      expect(source).not.toContain("switch-profile");
    }
  });
});
