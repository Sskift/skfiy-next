import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  DesktopApi,
  ProfileExportBundle,
  ProfileRuntimeSnapshot,
  ProfileSwitchResult
} from "./app-types";
import {
  DEFAULT_PROFILE_RUNTIME_SNAPSHOT,
  createProfileSwitchBanner,
  useProfileState
} from "./app-profile-state";

function createSummary(overrides: Partial<ProfileRuntimeSnapshot["profiles"][number]> = {}) {
  return {
    id: "default",
    name: "Default",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    memoryScope: "shared" as const,
    workflowDefaults: {
      defaultManualMode: "active" as const,
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    },
    isDefault: true,
    isActive: true,
    ...overrides
  };
}

function createSnapshot(
  overrides: Partial<ProfileRuntimeSnapshot> = {}
): ProfileRuntimeSnapshot {
  return {
    ...DEFAULT_PROFILE_RUNTIME_SNAPSHOT,
    profiles: [createSummary()],
    activeProfile: createSummary(),
    ...overrides
  };
}

function createFakeApi({
  snapshot = createSnapshot(),
  switchResult
}: {
  snapshot?: ProfileRuntimeSnapshot;
  switchResult?: ProfileSwitchResult;
} = {}) {
  const changeListeners = new Set<(snapshot: ProfileRuntimeSnapshot) => void>();
  const api = {
    getProfiles: vi.fn(async () => snapshot),
    switchProfile: vi.fn(async () => switchResult ?? ({
      status: "switched",
      profile: createSummary({ isDefault: false, isActive: true, id: "writing", name: "Writing" }),
      previousProfileId: "default"
    } satisfies ProfileSwitchResult)),
    createProfile: vi.fn(async () => snapshot),
    updateProfile: vi.fn(async () => snapshot),
    deleteProfile: vi.fn(async () => snapshot),
    exportProfile: vi.fn(async () => {
      throw new Error("unavailable");
    }),
    importProfile: vi.fn(async () => snapshot),
    onProfileChanged: vi.fn((callback: (snapshot: ProfileRuntimeSnapshot) => void) => {
      changeListeners.add(callback);
      return () => changeListeners.delete(callback);
    })
  } as unknown as DesktopApi & {
    emitChange: (snapshot: ProfileRuntimeSnapshot) => void;
  };
  (api as unknown as { emitChange: (snapshot: ProfileRuntimeSnapshot) => void }).emitChange =
    (next) => changeListeners.forEach((listener) => listener(next));

  return { api, changeListeners };
}

describe("useProfileState", () => {
  it("loads the snapshot on mount", async () => {
    const { api } = createFakeApi();
    const { result } = renderHook(() => useProfileState(api));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot.activeProfileId).toBe("default");
  });

  it("applies profile-changed events to the snapshot", async () => {
    const { api, changeListeners } = createFakeApi();
    const { result } = renderHook(() => useProfileState(api));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const next = createSnapshot({
      activeProfileId: "writing",
      activeProfile: createSummary({
        id: "writing",
        name: "Writing",
        memoryScope: "isolated",
        isDefault: false,
        isActive: true
      }),
      profiles: [
        createSummary({ isActive: false }),
        createSummary({ id: "writing", name: "Writing", memoryScope: "isolated", isDefault: false, isActive: true })
      ],
      memoryBaseDirScope: "isolated"
    });

    act(() => {
      changeListeners.forEach((listener) => listener(next));
    });

    expect(result.current.snapshot.activeProfileId).toBe("writing");
    expect(result.current.snapshot.memoryBaseDirScope).toBe("isolated");
  });

  it("opens a confirmation request when a switch broadens policy", async () => {
    const { api } = createFakeApi({
      switchResult: {
        status: "confirmation-required",
        profileId: "writing",
        broadenings: [
          {
            kind: "app-policy",
            target: "com.google.Chrome",
            targetName: "Chrome",
            from: "ask",
            to: "allow"
          }
        ]
      }
    });
    const { result } = renderHook(() => useProfileState(api));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const switchResult = await act(async () => result.current.switchTo("writing"));

    expect(switchResult?.status).toBe("confirmation-required");
    expect(result.current.switchRequest?.broadenings).toHaveLength(1);
    expect(result.current.switchRequest?.profileName).toBe("writing");
  });

  it("confirms a pending switch with confirm:true", async () => {
    const { api } = createFakeApi({
      switchResult: {
        status: "confirmation-required",
        profileId: "writing",
        broadenings: [
          {
            kind: "app-policy",
            target: "com.google.Chrome",
            from: "ask",
            to: "allow"
          }
        ]
      }
    });
    const { result } = renderHook(() => useProfileState(api));

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.switchTo("writing");
    });
    expect(result.current.switchRequest).not.toBeNull();

    act(() => {
      result.current.cancelSwitch();
    });
    expect(result.current.switchRequest).toBeNull();
  });

  it("creates, renames, deletes, imports, and exports through the api", async () => {
    const { api } = createFakeApi();
    const { result } = renderHook(() => useProfileState(api));

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      expect(await result.current.createProfile({ name: "Writing" })).toBe(true);
    });
    expect(api.createProfile).toHaveBeenCalledWith({ name: "Writing" });

    await act(async () => {
      expect(await result.current.renameProfile("writing", "Writing 2")).toBe(true);
    });
    expect(api.updateProfile).toHaveBeenCalledWith({
      profileId: "writing",
      name: "Writing 2"
    });

    await act(async () => {
      expect(await result.current.deleteProfile("writing")).toBe(true);
    });
    expect(api.deleteProfile).toHaveBeenCalledWith("writing");

    await act(async () => {
      expect(
        await result.current.importProfile({ schemaVersion: 1 } as ProfileExportBundle)
      ).toBe(true);
    });
    expect(api.importProfile).toHaveBeenCalled();

    let exported: ProfileExportBundle | null = null;
    await act(async () => {
      exported = await result.current.exportProfile("writing", true);
    });
    expect(exported).toBeNull();
    expect(result.current.error).toContain("unavailable");
  });

  it("shows and dismisses the switch banner", async () => {
    const { api } = createFakeApi();
    const { result } = renderHook(() => useProfileState(api));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.showBanner({ profileName: "Writing", lines: ["Planner: x"], at: 1 });
    });
    expect(result.current.banner?.profileName).toBe("Writing");

    act(() => {
      result.current.dismissBanner();
    });
    expect(result.current.banner).toBeNull();
  });
});

describe("createProfileSwitchBanner", () => {
  it("summarizes every behavior change between profiles", () => {
    const banner = createProfileSwitchBanner({
      profileName: "Writing",
      before: {
        assistantMode: "codex",
        plannerMode: "local-deterministic",
        appPolicy: {
          apps: [
            { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" }
          ]
        },
        memoryScope: "shared"
      },
      after: {
        assistantMode: "claude-code",
        plannerMode: "external-cua",
        appPolicy: {
          apps: [
            { name: "Chrome", bundleId: "com.google.Chrome", policy: "allow" }
          ]
        },
        memoryScope: "isolated"
      }
    });

    expect(banner.lines).toEqual([
      "Background Agent: codex → claude-code",
      "Planner: local-deterministic → external-cua",
      "Chrome: ask → allow",
      "Memory: shared → isolated"
    ]);
  });

  it("reports no behavior changes when settings are identical", () => {
    const banner = createProfileSwitchBanner({
      profileName: "Writing",
      before: {
        assistantMode: "codex",
        plannerMode: "local-deterministic",
        appPolicy: { apps: [] },
        memoryScope: "shared"
      },
      after: {
        assistantMode: "codex",
        plannerMode: "local-deterministic",
        appPolicy: { apps: [] },
        memoryScope: "shared"
      }
    });

    expect(banner.lines).toEqual([]);
  });
});
