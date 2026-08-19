import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type {
  AppPolicySettings,
  AssistantAgentMode,
  AssistantAgentSettingsResponse,
  DesktopApi,
  PlannerProviderSettings,
  TaskEvent
} from "./app-types";
import type { PetAtlasManifest } from "./pet-atlas";

let emitTaskEvent: (event: TaskEvent) => void;
let emitStopTurnHotkey: () => void;

const LOCAL_LUOXIAOHEI_SKIN = {
  displayName: "Luo Xiaohei local",
  slug: "luoxiaohei-local",
  asset: "file:///Users/tester/Library/Application%20Support/skfiy/skins/luoxiaohei-local/source.png",
  frameWidth: 192,
  frameHeight: 208,
  columns: 1,
  rows: 1,
  source: "custom-user",
  states: {
    idle: { row: 0, frames: 1, frameMs: 170 },
    "running-right": { row: 0, frames: 1, frameMs: 90 },
    "running-left": { row: 0, frames: 1, frameMs: 90 },
    waving: { row: 0, frames: 1, frameMs: 120 },
    jumping: { row: 0, frames: 1, frameMs: 95 },
    failed: { row: 0, frames: 1, frameMs: 150 },
    waiting: { row: 0, frames: 1, frameMs: 190 },
    running: { row: 0, frames: 1, frameMs: 85 },
    review: { row: 0, frames: 1, frameMs: 135 }
  }
} satisfies PetAtlasManifest;

function createAssistantAgentFixture(mode: AssistantAgentMode): AssistantAgentSettingsResponse {
  return {
    settings: {
      mode,
      codexBinary: "codex",
      codexBinarySource: "default",
      claudeCodeBinary: "claude",
      claudeCodeBinarySource: "default",
      hermesBinary: "hermes",
      hermesBinarySource: "default",
      cwd: "/repo",
      timeoutMs: 45_000
    },
    providers: [
      {
        provider: "assistant",
        id: "codex",
        label: "Codex",
        selected: mode === "codex",
        configured: true,
        executablePath: "codex",
        executableSource: "default",
        resolvedExecutablePath: "/opt/homebrew/bin/codex",
        readiness: "chat-ready"
      },
      {
        provider: "assistant",
        id: "claude-code",
        label: "Claude Code",
        selected: mode === "claude-code",
        configured: true,
        executablePath: "claude",
        executableSource: "default",
        resolvedExecutablePath: "/opt/homebrew/bin/claude",
        readiness: "chat-ready"
      },
      {
        provider: "assistant",
        id: "hermes",
        label: "Hermes",
        selected: mode === "hermes",
        configured: true,
        executablePath: "hermes",
        executableSource: "default",
        resolvedExecutablePath: "/Users/tester/.local/bin/hermes",
        readiness: "chat-ready"
      }
    ]
  };
}

beforeEach(() => {
  emitTaskEvent = () => undefined;
  emitStopTurnHotkey = () => undefined;
  const appPolicySettings: AppPolicySettings = {
    apps: [
      { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" },
      { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" },
      { name: "Finder", bundleId: "com.apple.finder", policy: "ask" }
    ]
  };
  const plannerProviderSettings: PlannerProviderSettings = {
    mode: "local-deterministic",
    externalProviderLabel: "External CUA",
    externalEndpoint: undefined,
    externalApiKeyConfigured: false
  };

  window.skfiy = {
    runCommand: vi.fn<DesktopApi["runCommand"]>().mockResolvedValue(undefined),
    approveTask: vi.fn<DesktopApi["approveTask"]>().mockResolvedValue(undefined),
    denyTask: vi.fn<DesktopApi["denyTask"]>().mockResolvedValue(undefined),
    takeScreenshot: vi.fn<DesktopApi["takeScreenshot"]>().mockResolvedValue(undefined),
    stopTask: vi.fn<DesktopApi["stopTask"]>().mockResolvedValue(undefined),
    getPermissions: vi.fn<DesktopApi["getPermissions"]>().mockResolvedValue({
      screenRecording: { state: "unknown" },
      accessibility: { state: "unknown" },
    }),
    getPermissionDiagnostics: vi.fn<DesktopApi["getPermissionDiagnostics"]>().mockResolvedValue({
      active: {
        screenRecording: { state: "unknown" },
        accessibility: { state: "unknown" },
      },
      appProcess: {
        screenRecording: { state: "unknown" },
        accessibility: { state: "unknown" },
      },
      helperProcess: {
        screenRecording: { state: "unknown" },
        accessibility: { state: "unknown" },
      },
      mismatches: [],
      identity: {
        appPath: "",
        executablePath: "",
        helperPath: "",
        resourcesPath: "",
        isPackaged: false
      }
    }),
    getDesktopSessionDiagnostics: vi
      .fn<DesktopApi["getDesktopSessionDiagnostics"]>()
      .mockResolvedValue({
        state: "unknown",
        status: null,
        reason: "Desktop session status is unknown."
      }),
    openPermissionSettings: vi.fn<DesktopApi["openPermissionSettings"]>().mockResolvedValue(
      undefined
    ),
    getStartupWarnings: vi.fn<DesktopApi["getStartupWarnings"]>().mockResolvedValue([]),
    getAppPolicySettings: vi.fn<DesktopApi["getAppPolicySettings"]>().mockResolvedValue(
      appPolicySettings
    ),
    setAppPolicy: vi.fn<DesktopApi["setAppPolicy"]>().mockImplementation(async (update) => ({
      apps: appPolicySettings.apps.map((entry) =>
        entry.bundleId === update.bundleId
          ? { ...entry, policy: update.policy }
          : entry
      )
    })),
    getAssistantAgentSettings: vi
      .fn<DesktopApi["getAssistantAgentSettings"]>()
      .mockResolvedValue(createAssistantAgentFixture("codex")),
    setAssistantAgentSettings: vi
      .fn<DesktopApi["setAssistantAgentSettings"]>()
      .mockImplementation(async (update) => createAssistantAgentFixture(update.mode ?? "codex")),
    getPlannerProviderSettings: vi
      .fn<DesktopApi["getPlannerProviderSettings"]>()
      .mockResolvedValue(plannerProviderSettings),
    setPlannerProviderSettings: vi
      .fn<DesktopApi["setPlannerProviderSettings"]>()
      .mockImplementation(async (update) => ({
        ...plannerProviderSettings,
        mode: update.mode ?? plannerProviderSettings.mode
      })),
    getTurnReplay: vi.fn<DesktopApi["getTurnReplay"]>().mockResolvedValue(null),
    getAutomationMonitors: vi.fn<DesktopApi["getAutomationMonitors"]>().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      activeCount: 0,
      attentionCount: 0,
      schedulerInactiveCount: 0,
      scheduler: {
        state: "inactive",
        scope: "app-process",
        owner: "skfiy",
        activeTimerCount: 0,
        mutatesSession: false,
        reason: "Open skfiy to resume interval checks."
      },
      monitors: []
    }),
    upsertTmuxMonitor: vi.fn<DesktopApi["upsertTmuxMonitor"]>().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      activeCount: 0,
      attentionCount: 0,
      schedulerInactiveCount: 0,
      scheduler: {
        state: "inactive",
        scope: "app-process",
        owner: "skfiy",
        activeTimerCount: 0,
        mutatesSession: false,
        reason: "Open skfiy to resume interval checks."
      },
      monitors: []
    }),
    runAutomationMonitorNow: vi.fn<DesktopApi["runAutomationMonitorNow"]>().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      activeCount: 0,
      attentionCount: 0,
      schedulerInactiveCount: 0,
      scheduler: {
        state: "inactive",
        scope: "app-process",
        owner: "skfiy",
        activeTimerCount: 0,
        mutatesSession: false,
        reason: "Open skfiy to resume interval checks."
      },
      monitors: []
    }),
    getRuntimeStatus: vi.fn<DesktopApi["getRuntimeStatus"]>().mockResolvedValue({
      stopTurnHotkey: {
        accelerator: "Control+Alt+Shift+Esc",
        label: "Ctrl Opt Shift Esc",
        registered: true
      }
    }),
    getPetSkin: vi.fn<DesktopApi["getPetSkin"]>().mockResolvedValue(null),
    getWindowBounds: vi.fn<DesktopApi["getWindowBounds"]>().mockResolvedValue({
      x: 100,
      y: 100,
      width: 90,
      height: 66
    }),
    moveWindowBy: vi.fn<DesktopApi["moveWindowBy"]>(),
    setWindowMode: vi.fn<DesktopApi["setWindowMode"]>(),
    onStopTurnHotkey: vi.fn((callback: () => void) => {
      emitStopTurnHotkey = callback;
      return vi.fn();
    }),
    onTaskEvent: vi.fn((callback: (event: TaskEvent) => void) => {
      emitTaskEvent = callback;
      return vi.fn();
    })
  } satisfies DesktopApi;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("starts as a Codex-style pet overlay with controls tucked away", () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    expect(pet).toBeInTheDocument();
    expect(pet).toHaveAttribute("data-pet-skin", "skfiy-black-cat");
    expect(pet).toHaveAttribute("data-atlas-state", "idle");
    expect(pet).toHaveAttribute("data-frame-count", "6");
    expect(pet.getAttribute("style")).toContain("--pet-frame-width: 192px");
    expect(pet).toHaveAttribute("data-agent-entry", "left-click");
    expect(pet).toHaveAttribute("data-settings-entry", "right-click");
    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Idle");
    expect(screen.queryByRole("textbox", { name: /command/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "执行" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/skfiy command capsule/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "语音" })).not.toBeInTheDocument();
  });

  it("prefers a local Luo Xiaohei skin loaded by the main process", async () => {
    (window.skfiy as DesktopApi).getPetSkin = vi
      .fn<DesktopApi["getPetSkin"]>()
      .mockResolvedValue(LOCAL_LUOXIAOHEI_SKIN);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/skfiy codex-style pet/i)).toHaveAttribute(
        "data-pet-skin",
        "luoxiaohei-local"
      );
    });
    expect(screen.getByLabelText(/skfiy codex-style pet/i).getAttribute("style")).toContain(
      "source.png"
    );
  });

  it("opens the agent panel from a plain left click on the pet without obsolete audio controls", async () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    fireEvent.click(pet);

    expect(pet).toHaveAttribute("data-drag-mode", "manual");
    expect(screen.queryByLabelText(/skfiy command capsule/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /command/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "执行" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("语音转写")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/skfiy audio status/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/skfiy agent status/i)).toHaveTextContent("agent");
  });

  it("keeps left click on the agent entry even when Computer Use permissions are missing", async () => {
    const api = window.skfiy as DesktopApi;
    api.getPermissions = vi.fn<DesktopApi["getPermissions"]>().mockResolvedValue({
      screenRecording: { state: "denied" },
      accessibility: { state: "not-determined" },
    });

    render(<App />);

    fireEvent.click(screen.getByLabelText(/skfiy codex-style pet/i));

    expect(screen.getByLabelText(/skfiy agent status/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("权限引导")).not.toBeInTheDocument();
    expect(api.openPermissionSettings).not.toHaveBeenCalled();
  });

  it("opens settings details from a right click on the pet without starting legacy input capture", () => {
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    expect(screen.getByLabelText(/skfiy settings/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("语音转写")).not.toBeInTheDocument();
    expect(screen.queryByText("左键")).not.toBeInTheDocument();
    expect(screen.queryByText("右键")).not.toBeInTheDocument();
  });

  it("renders right-click settings as clear user sections before advanced diagnostics", async () => {
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    const settings = await screen.findByLabelText(/skfiy settings/i);
    expect(within(settings).getByText("日常设置")).toBeInTheDocument();
    expect(within(settings).getByLabelText("Background Agent 设置")).toBeInTheDocument();
    expect(within(settings).getByLabelText("Computer Use 设置")).toBeInTheDocument();
    expect(within(settings).getByText("诊断/高级")).toBeInTheDocument();
    expect(within(settings).queryByText("偏好")).not.toBeInTheDocument();
  });

  it("keeps the daily right-click settings lightweight until advanced is opened", async () => {
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    const settings = await screen.findByLabelText(/skfiy settings/i);
    expect(within(settings).getByText("日常设置")).toBeInTheDocument();
    expect(within(settings).queryByText("Computer Use Planner")).not.toBeInTheDocument();
    expect(within(settings).queryByText("Release gate")).not.toBeInTheDocument();
    expect(within(settings).queryByText("Smoke evidence")).not.toBeInTheDocument();

    fireEvent.click(within(settings).getByText("诊断/高级"));

    expect(await within(settings).findByText("Computer Use Planner")).toBeInTheDocument();
  });

  it("shows a user-mode dashboard summary before advanced diagnostics", async () => {
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    const dashboard = await screen.findByLabelText("用户态 dashboard");
    expect(within(dashboard).getByText("助手状态")).toBeInTheDocument();
    expect(within(dashboard).getByText("当前任务")).toBeInTheDocument();
    expect(within(dashboard).getByText(/授权/)).toBeInTheDocument();
    expect(within(dashboard).getByText("未评估风险")).toBeInTheDocument();
    expect(within(dashboard).getByText("路由待命")).toBeInTheDocument();
    expect(within(dashboard).getByText("暂无最近执行")).toBeInTheDocument();
    expect(screen.getByText("诊断/高级")).toBeInTheDocument();
  });

  it("shows route denial detail in the user-mode dashboard", async () => {
    render(<App />);

    act(() => emitTaskEvent({
      status: "blocked",
      message: "Ghostty cannot continue.",
      route: "ghostty",
      routeReason: "Configured app policy blocked Ghostty.",
      denialKind: "app_policy",
      policyKind: "app-policy"
    }));
    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    const dashboard = await screen.findByLabelText("用户态 dashboard");
    expect(within(dashboard).getByText("应用策略拒绝")).toBeInTheDocument();
    expect(within(dashboard).getByText(
      "ghostty · Configured app policy blocked Ghostty. · 拒绝 app_policy · 策略 app-policy"
    )).toBeInTheDocument();
  });

  it("shows explicit task-event route outcomes in the user-mode dashboard", async () => {
    render(<App />);

    act(() => emitTaskEvent({
      status: "blocked",
      message: "Current Chrome route cannot continue.",
      routeOutcome: {
        kind: "chrome_host_policy_denied",
        title: "Chrome host policy denied route",
        value: "chrome_host_policy_denied",
        detail: "Chrome host policy blocked token=task-secret",
        tone: "danger",
        source: "task-event",
        routeLabel: "chrome",
        state: "blocked",
        policyKind: "chrome-host-policy"
      }
    }));
    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    const dashboard = await screen.findByLabelText("用户态 dashboard");
    expect(within(dashboard).getByText("Chrome 站点策略拒绝")).toBeInTheDocument();
    expect(within(dashboard).getByText(
      "chrome · Chrome host policy blocked token=[redacted] · 策略 chrome-host-policy"
    )).toBeInTheDocument();
  });

  it("shows startup guard warnings as a non-blocking pet bubble", async () => {
    const api = window.skfiy as DesktopApi;
    api.getStartupWarnings = vi.fn<DesktopApi["getStartupWarnings"]>().mockResolvedValue([
      {
        id: "tmux-launch",
        title: "tmux 启动会影响权限归属",
        message: "用户可见测试请通过 open -na dist/skfiy.app 启动。"
      }
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("tmux 启动会影响权限归属")).toBeInTheDocument();
    });
    expect(screen.getByText("用户可见测试请通过 open -na dist/skfiy.app 启动。")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /command/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "执行" })).not.toBeInTheDocument();
    expect(api.setWindowMode).toHaveBeenLastCalledWith("expanded");
  });

  it("shows only Computer Use permissions in settings and opens the matching macOS pane", async () => {
    const api = window.skfiy as DesktopApi & {
      getPermissions: () => Promise<{
        screenRecording: { state: "granted" | "denied" | "not-determined" | "unknown" };
        accessibility: { state: "granted" | "denied" | "not-determined" | "unknown" };
      }>;
      openPermissionSettings: (
        permission: "screen-recording" | "accessibility"
      ) => Promise<void>;
    };
    api.getPermissions = vi.fn().mockResolvedValue({
      screenRecording: { state: "denied" },
      accessibility: { state: "granted" },
    });
    api.openPermissionSettings = vi.fn().mockResolvedValue(undefined);

    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    await waitFor(() => {
      expect(screen.getByText("权限")).toBeInTheDocument();
    });
    expect(screen.getByText("屏幕录制")).toBeInTheDocument();
    expect(screen.getByText("辅助功能")).toBeInTheDocument();
    expect(screen.queryByText("麦克风")).not.toBeInTheDocument();
    expect(screen.queryByText("语音识别")).not.toBeInTheDocument();
    expect(screen.getByText("未授权")).toBeInTheDocument();
    expect(screen.getByText("已授权")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开屏幕录制设置" }));

    expect(api.openPermissionSettings).toHaveBeenCalledWith("screen-recording");
  });

  it("shows desktop session blockers in settings when permissions are granted", async () => {
    const api = window.skfiy as DesktopApi;
    api.getPermissions = vi.fn<DesktopApi["getPermissions"]>().mockResolvedValue({
      screenRecording: { state: "granted" },
      accessibility: { state: "granted" },
    });
    api.getDesktopSessionDiagnostics = vi
      .fn<DesktopApi["getDesktopSessionDiagnostics"]>()
      .mockResolvedValue({
        state: "blocked",
        status: {
          controllable: false,
          frontmostBundleId: "com.apple.loginwindow",
          frontmostLocalizedName: "loginwindow",
          frontmostProcessIdentifier: 591
        },
        reason: "Desktop session is locked by loginwindow (pid 591). Unlock the Mac and keep the display awake, then retry."
      });

    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    await waitFor(() => {
      expect(screen.getByText("桌面会话")).toBeInTheDocument();
    });
    expect(screen.getByText("不可控")).toBeInTheDocument();
    expect(screen.getByLabelText("桌面会话阻塞原因")).toHaveTextContent(
      "Desktop session is locked by loginwindow"
    );
  });

  it("does not load or expose obsolete audio provider settings in the pet settings bubble", async () => {
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    await waitFor(() => {
      expect(screen.getByText("日常设置")).toBeInTheDocument();
    });
    expect(screen.queryByText("语音入口")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Audio provider")).not.toBeInTheDocument();
    expect(screen.queryByText(/macOS 语音/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /语音/ })).not.toBeInTheDocument();
  });

  it("shows app policy choices and updates app allowlist decisions from settings", async () => {
    const api = window.skfiy as DesktopApi;
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    await waitFor(() => {
      expect(screen.getByText("应用策略")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "允许 Ghostty" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "询问 Chrome" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "拒绝 Chrome" }));

    await waitFor(() => {
      expect(api.setAppPolicy).toHaveBeenCalledWith({
        bundleId: "com.google.Chrome",
        policy: "deny"
      });
    });
    expect(screen.getByRole("button", { name: "拒绝 Chrome" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("shows planner provider choices and updates Computer Use planner mode from settings", async () => {
    const api = window.skfiy as DesktopApi;
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));
    fireEvent.click(screen.getByText("诊断/高级"));

    await waitFor(() => {
      expect(screen.getByText("Computer Use Planner")).toBeInTheDocument();
    });
    expect(screen.getByText("本地确定性")).toBeInTheDocument();
    expect(screen.getByText("External CUA")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择本地确定性规划" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "选择关闭规划" }));

    await waitFor(() => {
      expect(api.setPlannerProviderSettings).toHaveBeenCalledWith({ mode: "disabled" });
    });
    expect(screen.getByRole("button", { name: "选择关闭规划" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("shows background agent provider choices separately from Computer Use planner", async () => {
    const api = window.skfiy as DesktopApi;
    api.getAssistantAgentSettings = vi
      .fn<DesktopApi["getAssistantAgentSettings"]>()
      .mockResolvedValue(createAssistantAgentFixture("codex"));

    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    expect(await screen.findByText("Background Agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 Codex background agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 Claude Code background agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择 Hermes background agent" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("诊断/高级"));
    expect(await screen.findByText("Computer Use Planner")).toBeInTheDocument();
  });

  it("selects Codex as the background agent provider", async () => {
    const api = window.skfiy as DesktopApi;
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));
    fireEvent.click(await screen.findByRole("button", { name: "选择 Codex background agent" }));

    await waitFor(() => {
      expect(api.setAssistantAgentSettings).toHaveBeenCalledWith({ mode: "codex" });
    });
    expect(screen.getByRole("button", { name: "选择 Codex background agent" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("selects Hermes as the background agent provider", async () => {
    const api = window.skfiy as DesktopApi;
    api.getAssistantAgentSettings = vi
      .fn<DesktopApi["getAssistantAgentSettings"]>()
      .mockResolvedValue(createAssistantAgentFixture("hermes"));
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));
    fireEvent.click(await screen.findByRole("button", { name: "选择 Hermes background agent" }));

    await waitFor(() => {
      expect(api.setAssistantAgentSettings).toHaveBeenCalledWith({ mode: "hermes" });
    });
    expect(screen.getByRole("button", { name: "选择 Hermes background agent" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("shows concise external CUA configuration status", async () => {
    const api = window.skfiy as DesktopApi;
    api.getPlannerProviderSettings = vi.fn<DesktopApi["getPlannerProviderSettings"]>()
      .mockResolvedValue({
        mode: "external-cua",
        externalProviderLabel: "External CUA",
        externalEndpoint: "https://cua.example.test/plan",
        externalApiKeyConfigured: true
      });
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));
    fireEvent.click(screen.getByText("诊断/高级"));

    const planner = await screen.findByLabelText("Computer Use Planner");
    expect(within(planner).getAllByText("External CUA").length).toBeGreaterThan(0);
    expect(within(planner).getByText("External CUA 已配置")).toBeInTheDocument();
    expect(within(planner).getByText("在 dashboard 中配置")).toBeInTheDocument();
    expect(screen.queryByText("Endpoint 已配置")).not.toBeInTheDocument();
    expect(screen.queryByText("API Key 已配置")).not.toBeInTheDocument();
  });

  it("keeps heavy provider configuration out of the pet settings bubble", async () => {
    const api = window.skfiy as DesktopApi;
    api.getPlannerProviderSettings = vi.fn<DesktopApi["getPlannerProviderSettings"]>()
      .mockResolvedValue({
        mode: "external-cua",
        externalProviderLabel: "External CUA",
        externalEndpoint: "https://cua.example.test/plan",
        externalApiKeyConfigured: true
      });
    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));
    fireEvent.click(screen.getByText("诊断/高级"));

    const planner = await screen.findByLabelText("Computer Use Planner");
    expect(within(planner).getAllByText("External CUA").length).toBeGreaterThan(0);
    expect(within(planner).getByText("在 dashboard 中配置")).toBeInTheDocument();
    expect(screen.queryByText("https://cua.example.test/plan")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("https://cua.example.test/plan")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /endpoint/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
  });

  it("shows the latest local replay transcript in settings", async () => {
    const api = window.skfiy as DesktopApi & {
      getTurnReplay: () => Promise<{
        transcript: {
          command?: string;
          risk?: { level: string; reason: string; requiresApproval: boolean };
          planner?: {
            providerLabel: string;
            input: string;
            command: string;
            rationale?: string;
          };
          approvalRequired: boolean;
          apps: Array<{ name: string; bundleId?: string; pid?: number }>;
          screenshots: Array<{ stage: "before" | "after"; path: string }>;
          actions: Array<{
            type: string;
            text?: string;
            key?: string;
            actionType?: string;
            status?: string;
            message?: string;
          }>;
          outcome: string;
        };
        timeline: Array<{ status: string; message?: string }>;
      }>;
    };
    api.getTurnReplay = vi.fn().mockResolvedValue({
      transcript: {
        command: "pwd",
        risk: {
          level: "low",
          reason: "Read-only terminal command.",
          requiresApproval: false
        },
        planner: {
          providerLabel: "External CUA",
          input: "打开 Ghostty 执行 pwd 并截图",
          command: "pwd",
          rationale: "Read the current working directory."
        },
        approvalRequired: false,
        apps: [{ name: "Ghostty", bundleId: "com.mitchellh.ghostty", pid: 54502 }],
        screenshots: [
          {
            stage: "before",
            path: "/tmp/before.png",
            grounding: {
              recommendation: "structured_first",
              sources: [
                {
                  source: "macos_accessibility",
                  status: "covered",
                  observedElementCount: 1,
                  labelCount: 1,
                  notes: []
                }
              ]
            }
          },
          {
            stage: "after",
            path: "/tmp/after.png",
            grounding: {
              recommendation: "structured_first",
              sources: [
                {
                  source: "macos_accessibility",
                  status: "covered",
                  observedElementCount: 1,
                  labelCount: 1,
                  notes: []
                }
              ]
            }
          }
        ],
        actions: [
          { type: "type_text", text: "pwd" },
          { type: "press_key", key: "enter" },
          {
            type: "verify",
            actionType: "press_key",
            status: "passed",
            message: "press_key helper result accepted."
          }
        ],
        outcome: "completed"
      },
      timeline: [
        { status: "executing", message: "Typing command in Ghostty." },
        { status: "completed", message: "Command submitted to Ghostty." }
      ]
    });

    render(<App />);

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));
    fireEvent.click(screen.getByText("诊断/高级"));

    let replayPanel: HTMLElement | undefined;
    await waitFor(() => {
      replayPanel = screen.getByLabelText("本地回放");
      expect(replayPanel).toBeInTheDocument();
    });
    const replay = within(replayPanel as HTMLElement);
    expect(replay.getAllByText("pwd").length).toBeGreaterThan(0);
    expect(replay.getByText(/External CUA: pwd/)).toBeInTheDocument();
    expect(replay.getByText(/Read the current working directory/)).toBeInTheDocument();
    expect(replay.getByText("low")).toBeInTheDocument();
    expect(replay.getByText(/type_text/)).toBeInTheDocument();
    expect(replay.getByText(/verify: press_key passed/)).toBeInTheDocument();
    expect(replay.getByText(/\/tmp\/after\.png/)).toBeInTheDocument();
    expect(replay.getAllByText(/structured_first/).length).toBeGreaterThan(0);
    expect(replay.getByText(/Command submitted to Ghostty/)).toBeInTheDocument();
  });

  it("switches from the agent panel to settings on right click", async () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    fireEvent.click(pet);
    expect(screen.getByLabelText(/skfiy agent status/i)).toBeInTheDocument();

    fireEvent.contextMenu(pet);

    expect(screen.getByLabelText(/skfiy settings/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("语音转写")).not.toBeInTheDocument();
  });

  it("renders each task status and switches pet animation from task events", () => {
    render(<App />);

    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Idle");

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    expect(pet).toHaveAttribute("data-atlas-state", "idle");

    const cases: Array<[TaskEvent["status"], string, string, string]> = [
      ["observing", "Observing", "Reading the screen", "review"],
      ["executing", "Executing", "Typing in Ghostty", "running"],
      ["approval_required", "Approval required", "Needs a human check", "waiting"],
      ["needs_confirmation", "Needs confirmation", "Verification failed", "waiting"],
      ["needs_clarification", "Needs clarification", "Clarify the target app", "waiting"],
      ["completed", "Completed", "Task finished", "waving"],
      ["failed", "Failed", "Could not complete", "failed"]
    ];

    for (const [status, label, message, animation] of cases) {
      act(() => emitTaskEvent({ status, message }));

      expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent(label);
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(pet).toHaveAttribute("data-atlas-state", animation);
    }
  });

  it("renders denied as a cancel-safe terminal state without approval controls", () => {
    render(<App />);

    act(() => emitTaskEvent({ status: "denied" }));

    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Denied");
    expect(screen.getByText("请求已拒绝，未执行动作.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
  });

  it("renders blocked as an environment blocker instead of a generic failure", () => {
    render(<App />);

    act(() => emitTaskEvent({ status: "blocked" }));

    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Blocked");
    expect(screen.getByText("环境阻塞，无法继续执行.")).toBeInTheDocument();
  });

  it("renders cancelled as a stopped task instead of idle or failed", () => {
    render(<App />);

    act(() => emitTaskEvent({ status: "cancelled" }));

    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Cancelled");
    expect(screen.getByText("任务已停止.")).toBeInTheDocument();
  });

  it("opens a fresh assistant input from a terminal task bubble click", () => {
    render(<App />);

    act(() => emitTaskEvent({ status: "cancelled", message: "Task stopped." }));
    fireEvent.click(screen.getByLabelText(/skfiy codex-style pet/i));

    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Idle");
    expect(screen.queryByText("Task stopped.")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/skfiy assistant input/i)).toBeInTheDocument();
  });

  it("does not move the pet window from a plain left click", () => {
    render(<App />);

    fireEvent.click(screen.getByLabelText(/skfiy codex-style pet/i));

    expect((window.skfiy as DesktopApi).moveWindowBy).not.toHaveBeenCalled();
  });

  it("opens a focused command input from a plain left click without moving the pet by drag", async () => {
    render(<App />);

    const api = window.skfiy as DesktopApi;
    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    fireEvent.click(pet);

    const input = screen.getByRole("textbox", { name: /ask skfiy/i });
    expect(input).toHaveFocus();
    expect(screen.getByLabelText(/skfiy assistant input/i)).toBeInTheDocument();
    expect(api.moveWindowBy).not.toHaveBeenCalled();
    await waitFor(() => expect(api.setWindowMode).toHaveBeenLastCalledWith("expanded"));
  });

  it("submits command input through the active pet command path", async () => {
    render(<App />);

    const api = window.skfiy as DesktopApi;
    fireEvent.click(screen.getByLabelText(/skfiy codex-style pet/i));

    const input = screen.getByRole("textbox", { name: /ask skfiy/i });
    fireEvent.change(input, { target: { value: "打开 Ghostty 查看 pwd" } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 skfiy" }));

    await waitFor(() => {
      expect(api.runCommand).toHaveBeenCalledWith("打开 Ghostty 查看 pwd", { mode: "active" });
    });
    expect(screen.getByLabelText(/skfiy assistant input/i)).toBeInTheDocument();
    expect(screen.getByLabelText("你发送给 skfiy")).toHaveTextContent("打开 Ghostty 查看 pwd");
  });

  it("keeps the conversation panel usable while waiting for the background agent", async () => {
    const api = window.skfiy as DesktopApi;
    let resolveRunCommand: (() => void) | undefined;
    api.runCommand = vi.fn<DesktopApi["runCommand"]>().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRunCommand = resolve;
      })
    );
    render(<App />);

    fireEvent.click(screen.getByLabelText(/skfiy codex-style pet/i));
    fireEvent.change(screen.getByRole("textbox", { name: /ask skfiy/i }), {
      target: { value: "你好" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送给 skfiy" }));

    await waitFor(() => expect(api.runCommand).toHaveBeenCalledWith("你好", { mode: "active" }));
    expect(screen.getByLabelText(/skfiy assistant input/i)).toBeInTheDocument();
    expect(screen.getByText("Background Agent 正在回复...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送给 skfiy" })).toBeDisabled();

    act(() => resolveRunCommand?.());
  });

  it("shows the assistant reply in the same panel and keeps input ready for follow-up", async () => {
    render(<App />);

    fireEvent.click(screen.getByLabelText(/skfiy codex-style pet/i));
    fireEvent.change(screen.getByRole("textbox", { name: /ask skfiy/i }), {
      target: { value: "你好" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送给 skfiy" }));

    act(() => emitTaskEvent({
      status: "completed",
      message: "Codex: 你好，我在。"
    }));

    expect(screen.getByLabelText("skfiy 回复")).toHaveTextContent("你好，我在。");
    expect(screen.getByRole("textbox", { name: /ask skfiy/i })).not.toBeDisabled();
  });

  it("shows background agent provider failures as an inline conversation error", async () => {
    render(<App />);

    fireEvent.click(screen.getByLabelText(/skfiy codex-style pet/i));
    fireEvent.change(screen.getByRole("textbox", { name: /ask skfiy/i }), {
      target: { value: "你好" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送给 skfiy" }));

    act(() => emitTaskEvent({
      status: "failed",
      message: "Assistant agent failed: codex exited with code 1"
    }));

    const reply = screen.getByLabelText("skfiy 回复");
    expect(reply).toHaveAttribute("data-state", "error");
    expect(reply).toHaveTextContent("Assistant agent failed: codex exited with code 1");
    expect(screen.getByRole("textbox", { name: /ask skfiy/i })).not.toBeDisabled();
  });

  it("maps planned and running canonical statuses to non-idle pet animation", () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);

    act(() => emitTaskEvent({ status: "planned" }));
    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Planned");
    expect(pet).not.toHaveAttribute("data-atlas-state", "idle");

    act(() => emitTaskEvent({ status: "running" }));
    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Running");
    expect(pet).not.toHaveAttribute("data-atlas-state", "idle");
  });

  it("does not show a focusable box around the pet", () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    expect(pet.tagName.toLowerCase()).not.toBe("button");
    expect(pet).not.toHaveAttribute("tabindex");
    expect(screen.queryByLabelText(/skfiy command capsule/i)).not.toBeInTheDocument();
  });

  it("moves the window from pet pointer dragging, including upward movement", () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    const api = window.skfiy as DesktopApi;

    vi.spyOn(pet, "getBoundingClientRect").mockReturnValue({
      x: 114,
      y: 15,
      left: 114,
      top: 15,
      width: 90,
      height: 66,
      right: 204,
      bottom: 81,
      toJSON: () => ({})
    } as DOMRect);

    fireEvent.pointerDown(pet, { button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(pet, { pointerId: 7, screenX: 112, screenY: 42 });
    fireEvent.pointerMove(pet, { pointerId: 7, screenX: 112, screenY: 12 });
    fireEvent.pointerUp(pet, { pointerId: 7, screenX: 112, screenY: 12 });
    fireEvent.click(pet);

    expect(pet).toHaveAttribute("data-drag-mode", "manual");
    expect(api.moveWindowBy).toHaveBeenNthCalledWith(1, 12, -58, {
      x: 114,
      y: 15,
      width: 90,
      height: 66
    });
    expect(api.moveWindowBy).toHaveBeenNthCalledWith(2, 0, -30, {
      x: 114,
      y: 15,
      width: 90,
      height: 66
    });
    expect(screen.queryByLabelText(/skfiy command capsule/i)).not.toBeInTheDocument();
  });

  it("sends the visible pet rect when dragging", () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    const api = window.skfiy as DesktopApi;

    vi.spyOn(pet, "getBoundingClientRect").mockReturnValue({
      x: 114,
      y: 15,
      left: 114,
      top: 15,
      width: 90,
      height: 66,
      right: 204,
      bottom: 81,
      toJSON: () => ({})
    } as DOMRect);

    fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 200, screenY: 200 });
    fireEvent.pointerMove(pet, { pointerId: 1, screenX: 210, screenY: 215 });

    expect(api.moveWindowBy).toHaveBeenCalledWith(10, 15, {
      x: 114,
      y: 15,
      width: 90,
      height: 66
    });
  });

  it("collapses transient panels when dragging starts", async () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    const api = window.skfiy as DesktopApi;

    fireEvent.click(pet);
    expect(screen.getByLabelText(/skfiy agent status/i)).toBeInTheDocument();

    fireEvent.pointerDown(pet, { button: 0, pointerId: 2, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(pet, { pointerId: 2, screenX: 112, screenY: 110 });

    expect(api.moveWindowBy).toHaveBeenCalled();
    await waitFor(() => expect(api.setWindowMode).toHaveBeenLastCalledWith("compact"));
    expect(screen.queryByLabelText(/skfiy agent status/i)).not.toBeInTheDocument();
  });

  it("recaptures the visible pet rect when dragging starts from an open panel", async () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    const api = window.skfiy as DesktopApi;

    fireEvent.click(pet);
    await screen.findByLabelText(/skfiy agent status/i);

    vi.spyOn(pet, "getBoundingClientRect")
      .mockReturnValueOnce({
        x: 114,
        y: 433,
        left: 114,
        top: 433,
        width: 90,
        height: 66,
        right: 204,
        bottom: 499,
        toJSON: () => ({})
      } as DOMRect)
      .mockReturnValue({
        x: 114,
        y: 15,
        left: 114,
        top: 15,
        width: 90,
        height: 66,
        right: 204,
        bottom: 81,
        toJSON: () => ({})
      } as DOMRect);

    fireEvent.pointerDown(pet, { button: 0, pointerId: 3, screenX: 200, screenY: 200 });
    fireEvent.pointerMove(pet, { pointerId: 3, screenX: 210, screenY: 215 });

    expect(api.moveWindowBy).toHaveBeenCalledWith(10, 15, {
      x: 114,
      y: 15,
      width: 90,
      height: 66
    });
  });

  it("dismisses terminal task bubbles before compact pet dragging", async () => {
    render(<App />);

    const pet = screen.getByLabelText(/skfiy codex-style pet/i);
    const api = window.skfiy as DesktopApi;

    act(() => emitTaskEvent({ status: "cancelled", message: "Task stopped." }));
    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Cancelled");

    fireEvent.pointerDown(pet, { button: 0, pointerId: 3, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(pet, { pointerId: 3, screenX: 112, screenY: 42 });

    expect(api.moveWindowBy).toHaveBeenCalled();
    await waitFor(() => expect(api.setWindowMode).toHaveBeenLastCalledWith("compact"));
    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Idle");
    expect(screen.queryByText("Task stopped.")).not.toBeInTheDocument();
  });

  it("uses a compact transparent window until an input, task, or settings bubble is visible", async () => {
    render(<App />);

    const api = window.skfiy as DesktopApi;
    expect(screen.getByLabelText(/skfiy desktop pet/i)).not.toHaveClass("panel-open");
    expect(api.setWindowMode).toHaveBeenLastCalledWith("compact");

    fireEvent.click(screen.getByLabelText(/skfiy codex-style pet/i));

    await waitFor(() => {
      expect(api.setWindowMode).toHaveBeenLastCalledWith("expanded");
    });
    expect(screen.getByLabelText(/skfiy desktop pet/i)).toHaveClass("panel-open");

    fireEvent.click(screen.getByLabelText(/skfiy codex-style pet/i));

    await waitFor(() => {
      expect(api.setWindowMode).toHaveBeenLastCalledWith("compact");
    });
    expect(screen.getByLabelText(/skfiy desktop pet/i)).not.toHaveClass("panel-open");

    fireEvent.contextMenu(screen.getByLabelText(/skfiy codex-style pet/i));

    await waitFor(() => {
      expect(api.setWindowMode).toHaveBeenLastCalledWith("expanded");
    });
  });

  it("stops an active task with the Escape stop-turn hotkey", () => {
    render(<App />);

    act(() => emitTaskEvent({ status: "executing", message: "Running" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect((window.skfiy as DesktopApi).stopTask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent("Cancelled");
    expect(screen.getByText("任务已停止.")).toBeInTheDocument();
  });

  it("exposes approval controls when a command is waiting for approval", () => {
    render(<App />);

    act(() => emitTaskEvent({ status: "approval_required", message: "Needs a human check" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    const api = window.skfiy as DesktopApi;
    expect(api.approveTask).toHaveBeenCalledTimes(1);
    expect(api.denyTask).toHaveBeenCalledTimes(1);
  });

  it("shows Finder plan preview details inside the approval panel", () => {
    render(<App />);

    act(() => emitTaskEvent({
      status: "approval_required",
      message: "Finder plan confirmation required before file operations.",
      finderPlanPreview: {
        rootPath: "/tmp/skfiy-finder-smoke",
        operationCount: 6,
        destructiveOperationCount: 0,
        createFolders: [
          "/tmp/skfiy-finder-smoke/Images",
          "/tmp/skfiy-finder-smoke/Documents",
          "/tmp/skfiy-finder-smoke/Code"
        ],
        moveFiles: [
          {
            from: "/tmp/skfiy-finder-smoke/photo.png",
            to: "/tmp/skfiy-finder-smoke/Images/photo.png"
          },
          {
            from: "/tmp/skfiy-finder-smoke/notes.pdf",
            to: "/tmp/skfiy-finder-smoke/Documents/notes.pdf"
          },
          {
            from: "/tmp/skfiy-finder-smoke/script.ts",
            to: "/tmp/skfiy-finder-smoke/Code/script.ts"
          }
        ]
      }
    } as TaskEvent));

    expect(screen.getByText("Finder plan preview")).toBeInTheDocument();
    expect(screen.getByText("6 operations")).toBeInTheDocument();
    expect(screen.getByText("0 destructive")).toBeInTheDocument();
    expect(screen.getByText("3 moves")).toBeInTheDocument();
    expect(screen.getByText("photo.png -> Images/photo.png")).toBeInTheDocument();
  });

  it("shows verification failure as human confirmation without approval execution controls", () => {
    render(<App />);

    act(() => emitTaskEvent({
      status: "needs_confirmation",
      message: "Verification failed: Ghostty did not become frontmost."
    }));

    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent(
      "Needs confirmation"
    );
    expect(screen.getByText("Verification failed: Ghostty did not become frontmost.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
  });

  it("shows unsupported route clarification without approval execution controls", () => {
    render(<App />);

    act(() => emitTaskEvent({
      status: "needs_clarification",
      message: "No supported desktop control route matched this request. 请明确目标应用和动作。",
      routeReason: "No supported desktop control route matched this request."
    }));

    expect(screen.getByRole("status", { name: /task status/i })).toHaveTextContent(
      "Needs clarification"
    );
    expect(screen.getByText("No supported desktop control route matched this request. 请明确目标应用和动作。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
  });

  it("shows observe_app replay records with screenshot paths and accessibility trust", () => {
    render(<App />);

    act(() => emitTaskEvent({
      status: "observing",
      message: "Captured before screenshot: /tmp/before.png",
      replayRecord: {
        stage: "before",
        bundleId: "com.mitchellh.ghostty",
        isRunning: true,
        isActive: true,
        screenshotPath: "/tmp/before.png",
        frontmostBundleId: "com.mitchellh.ghostty",
        accessibilityTrusted: true,
        ocrLabels: [
          {
            text: "pwd",
            confidence: 0.88,
            bounds: { x: 36, y: 88, width: 42, height: 18 }
          }
        ]
      }
    }));
    act(() => emitTaskEvent({
      status: "observing",
      message: "Captured after screenshot: /tmp/after.png",
      replayRecord: {
        stage: "after",
        bundleId: "com.mitchellh.ghostty",
        isRunning: true,
        isActive: true,
        screenshotPath: "/tmp/after.png",
        frontmostBundleId: "com.mitchellh.ghostty",
        accessibilityTrusted: false
      }
    }));

    const replay = screen.getByLabelText("Computer Use replay");
    expect(replay).toHaveTextContent("before");
    expect(replay).toHaveTextContent("/tmp/before.png");
    expect(replay).toHaveTextContent("AX ok");
    expect(replay).toHaveTextContent("OCR 1");
    expect(replay).toHaveTextContent("after");
    expect(replay).toHaveTextContent("/tmp/after.png");
    expect(replay).toHaveTextContent("AX denied");
  });

  it("clears old replay records when a new task starts", () => {
    render(<App />);

    act(() => emitTaskEvent({
      status: "observing",
      message: "Captured before screenshot: /tmp/before.png",
      replayRecord: {
        stage: "before",
        bundleId: "com.mitchellh.ghostty",
        isRunning: true,
        isActive: true,
        screenshotPath: "/tmp/before.png",
        accessibilityTrusted: true
      }
    }));

    expect(screen.getByLabelText("Computer Use replay")).toHaveTextContent("/tmp/before.png");

    act(() => emitTaskEvent({
      status: "executing",
      message: "Risk low: Read-only terminal command.",
      replayReset: true
    }));

    expect(screen.queryByLabelText("Computer Use replay")).not.toBeInTheDocument();
  });

});
