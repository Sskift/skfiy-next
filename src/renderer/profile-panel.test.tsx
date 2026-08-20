import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ProfilePanel,
  ProfileSwitchConfirmationDialog
} from "./profile-panel";
import {
  DEFAULT_PROFILE_RUNTIME_SNAPSHOT,
  type ProfileState
} from "./app-profile-state";
import type {
  ProfileExportBundle,
  ProfileRuntimeSnapshot,
  ProfileSummary
} from "./app-types";

function createSummary(overrides: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: "default",
    name: "Default",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    memoryScope: "shared",
    workflowDefaults: {
      defaultManualMode: "active",
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

function createState(overrides: Partial<ProfileState> = {}): ProfileState {
  return {
    snapshot: createSnapshot(),
    loading: false,
    error: "",
    actionPending: false,
    switchRequest: null,
    banner: null,
    refresh: vi.fn(async () => undefined),
    switchTo: vi.fn(async () => null),
    confirmSwitch: vi.fn(async () => null),
    cancelSwitch: vi.fn(),
    createProfile: vi.fn(async () => true),
    renameProfile: vi.fn(async () => true),
    deleteProfile: vi.fn(async () => true),
    exportProfile: vi.fn(async () => null),
    importProfile: vi.fn(async () => true),
    showBanner: vi.fn(),
    dismissBanner: vi.fn(),
    ...overrides
  };
}

describe("ProfilePanel", () => {
  it("lists profiles with the active profile highlighted and no switch button", () => {
    const state = createState({
      snapshot: createSnapshot({
        profiles: [
          createSummary(),
          createSummary({
            id: "writing",
            name: "Writing",
            memoryScope: "isolated",
            isDefault: false,
            isActive: false
          })
        ]
      })
    });

    render(<ProfilePanel state={state} onSwitch={vi.fn()} />);

    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("Writing")).toBeTruthy();
    expect(screen.queryAllByLabelText("切换到 Default")).toHaveLength(0);
    expect(screen.getByLabelText("切换到 Writing")).toBeTruthy();
  });

  it("invokes onSwitch when a non-active profile's switch button is clicked", () => {
    const onSwitch = vi.fn();
    const state = createState({
      snapshot: createSnapshot({
        profiles: [
          createSummary(),
          createSummary({
            id: "writing",
            name: "Writing",
            isDefault: false,
            isActive: false
          })
        ]
      })
    });

    render(<ProfilePanel state={state} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByLabelText("切换到 Writing"));

    expect(onSwitch).toHaveBeenCalledWith("writing");
  });

  it("creates a profile with the form values", async () => {
    const state = createState();
    render(<ProfilePanel state={state} onSwitch={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("新配置名称"), {
      target: { value: "Obsidian" }
    });
    fireEvent.click(screen.getByText("创建配置"));

    await waitFor(() =>
      expect(state.createProfile).toHaveBeenCalledWith({
        name: "Obsidian",
        memoryScope: "isolated",
        cloneFromActive: true,
        defaultManualMode: "active"
      })
    );
  });

  it("renames a profile inline", async () => {
    const state = createState({
      snapshot: createSnapshot({
        profiles: [
          createSummary(),
          createSummary({
            id: "writing",
            name: "Writing",
            isDefault: false,
            isActive: false
          })
        ]
      })
    });

    render(<ProfilePanel state={state} onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("重命名 Writing"));
    fireEvent.change(screen.getByLabelText("重命名配置"), {
      target: { value: "Writing 2" }
    });
    fireEvent.click(screen.getByLabelText("确认重命名 Writing"));

    await waitFor(() =>
      expect(state.renameProfile).toHaveBeenCalledWith("writing", "Writing 2")
    );
  });

  it("deletes a non-default, non-active profile", () => {
    const state = createState({
      snapshot: createSnapshot({
        profiles: [
          createSummary(),
          createSummary({
            id: "writing",
            name: "Writing",
            isDefault: false,
            isActive: false
          })
        ]
      })
    });

    render(<ProfilePanel state={state} onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("删除 Writing"));

    expect(state.deleteProfile).toHaveBeenCalledWith("writing");
    expect(screen.queryByLabelText("删除 Default")).toBeNull();
  });

  it("exports a profile and downloads the bundle", async () => {
    const bundle: ProfileExportBundle = {
      schemaVersion: 1,
      exportedAt: "2026-08-01T00:00:00.000Z",
      profile: {
        id: "writing",
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
    };
    const state = createState({
      snapshot: createSnapshot({
        profiles: [
          createSummary(),
          createSummary({
            id: "writing",
            name: "Writing",
            isDefault: false,
            isActive: false
          })
        ]
      }),
      exportProfile: vi.fn(async () => bundle)
    });

    const clickSpy = vi.spyOn(HTMLElement.prototype, "click").mockImplementation(() => undefined);
    render(<ProfilePanel state={state} onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("导出 Writing"));

    await waitFor(() => expect(state.exportProfile).toHaveBeenCalledWith("writing", true));
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("shows the error state when the hook reports one", () => {
    const state = createState({ error: "Profiles are unavailable." });

    render(<ProfilePanel state={state} onSwitch={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toContain("unavailable");
  });
});

describe("ProfileSwitchConfirmationDialog", () => {
  it("lists every broadening and only completes the switch through confirm", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ProfileSwitchConfirmationDialog
        request={{
          profileId: "writing",
          profileName: "Writing",
          broadenings: [
            {
              kind: "app-policy",
              target: "com.google.Chrome",
              targetName: "Chrome",
              from: "ask",
              to: "allow"
            },
            {
              kind: "app-policy",
              target: "com.apple.finder",
              targetName: "Finder",
              from: "deny",
              to: "ask"
            }
          ]
        }}
        pending={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    expect(screen.getByLabelText("确认切换配置")).toBeTruthy();
    expect(screen.getByText("Chrome")).toBeTruthy();
    expect(screen.getByText("Finder")).toBeTruthy();
    expect(screen.getByText("询问 → 允许")).toBeTruthy();
    expect(screen.getByText("拒绝 → 询问")).toBeTruthy();

    fireEvent.click(screen.getByText("确认切换"));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("取消"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
