import { describe, expect, it } from "vitest";

import {
  formatReplayAction,
  formatReplayPlanner,
  getAssistantInputPanelViewModel,
  getAppRootViewModel,
  getAppShellViewModel,
  getFinderPlanPreviewSummaryViewModel,
  getLocalReplayViewModel,
  getPanelVisibilityState,
  getPetRouteOutcomeSignal,
  getPermissionDisplayRows,
  getPermissionsPanelViewModel,
  getPlannerProviderDisplayViewModel,
  getReplayAccessibilityLabel,
  getReplayOcrLabel,
  getTaskReplayRows,
  getUserDashboardPanelViewModel,
  readPetRouteOutcome,
  readSelectedAssistantAgentProvider
} from "./app-view-model";

describe("app view model", () => {
  it("derives assistant input panel labels and submit availability", () => {
    expect(getAssistantInputPanelViewModel({
      input: "  ",
      provider: {
        label: "Codex",
        readiness: "chat-ready"
      },
      submitting: false
    })).toEqual({
      statusLabel: "Codex · chat ready",
      submitDisabled: true,
      submitLabel: "发送"
    });

    expect(getAssistantInputPanelViewModel({
      input: "organize Downloads",
      provider: {
        label: "Claude Code",
        readiness: "unavailable"
      },
      submitting: false
    })).toEqual({
      statusLabel: "Claude Code · unavailable",
      submitDisabled: false,
      submitLabel: "发送"
    });

    expect(getAssistantInputPanelViewModel({
      input: "open Finder",
      provider: {
        label: "Local",
        readiness: "unconfigured"
      },
      submitting: true
    })).toEqual({
      statusLabel: "等待回复",
      submitDisabled: true,
      submitLabel: "发送中"
    });
  });

  it("derives panel visibility without React state", () => {
    expect(getPanelVisibilityState({
      assistantPanelOpen: false,
      detailsOpen: false,
      hasStartupWarning: false,
      permissionOnboardingOpen: false,
      taskStatus: "idle"
    })).toEqual({
      bubbleAriaLabel: "skfiy task status",
      settingsBubble: false,
      showPanel: false,
      showStartupWarning: false
    });

    expect(getPanelVisibilityState({
      assistantPanelOpen: true,
      detailsOpen: false,
      hasStartupWarning: true,
      permissionOnboardingOpen: false,
      taskStatus: "idle"
    })).toMatchObject({
      bubbleAriaLabel: "skfiy assistant panel",
      settingsBubble: false,
      showPanel: true,
      showStartupWarning: true
    });

    expect(getPanelVisibilityState({
      assistantPanelOpen: false,
      detailsOpen: true,
      hasStartupWarning: true,
      permissionOnboardingOpen: false,
      taskStatus: "idle"
    })).toEqual({
      bubbleAriaLabel: "skfiy settings",
      settingsBubble: true,
      showPanel: true,
      showStartupWarning: false
    });

    expect(getPanelVisibilityState({
      assistantPanelOpen: false,
      detailsOpen: false,
      hasStartupWarning: false,
      permissionOnboardingOpen: false,
      taskStatus: "blocked"
    })).toMatchObject({
      bubbleAriaLabel: "skfiy task status",
      showPanel: true
    });
  });

  it("formats replay accessibility and OCR labels", () => {
    expect(getReplayAccessibilityLabel({ accessibilityTrusted: true })).toBe("AX ok");
    expect(getReplayAccessibilityLabel({ accessibilityTrusted: false })).toBe("AX denied");
    expect(getReplayAccessibilityLabel({})).toBe("AX unknown");

    expect(getReplayOcrLabel({})).toBeNull();
    expect(getReplayOcrLabel({ ocrLabels: [{ text: "Open" }, { text: "Save" }] })).toBe("OCR 2");
  });

  it("shows clarification as a warning task state in dashboard copy", () => {
    expect(getUserDashboardPanelViewModel({
      desktopSessionDiagnostics: {
        state: "controllable",
        reason: "Desktop session is interactive."
      },
      task: {
        status: "needs_clarification",
        message: "Clarify the target app."
      },
      permissions: {
        screenRecording: { state: "granted" },
        accessibility: { state: "granted" }
      },
      turnReplay: null
    }).status).toEqual({
      label: "需要澄清目标",
      detail: "Clarify the target app.",
      tone: "warning"
    });
  });

  it("derives task replay rows for display", () => {
    expect(getTaskReplayRows([])).toEqual([]);
    expect(getTaskReplayRows([
      {
        stage: "before",
        screenshotPath: "/tmp/before.png",
        accessibilityTrusted: false,
        ocrLabels: [{ text: "Open" }]
      },
      {
        stage: "after",
        screenshotPath: "/tmp/after.png",
        accessibilityTrusted: true
      }
    ])).toEqual([
      {
        accessibilityLabel: "AX denied",
        accessibilityState: "denied",
        key: "before",
        ocrLabel: "OCR 1",
        screenshotPath: "/tmp/before.png",
        stage: "before"
      },
      {
        accessibilityLabel: "AX ok",
        accessibilityState: "ok",
        key: "after",
        ocrLabel: null,
        screenshotPath: "/tmp/after.png",
        stage: "after"
      }
    ]);
  });

  it("derives the Finder plan preview summary model", () => {
    expect(getFinderPlanPreviewSummaryViewModel({
      rootPath: "/Users/me/Desktop",
      operationCount: 4,
      destructiveOperationCount: 1,
      moveFiles: [
        { from: "/Users/me/Desktop/a.txt", to: "/Users/me/Desktop/folder/a.txt" },
        { from: "/Users/me/Desktop/b.txt", to: "/Users/me/Desktop/folder/b.txt" },
        { from: "/Users/me/Desktop/c.txt", to: "/Users/me/Desktop/folder/c.txt" },
        { from: "/Users/me/Desktop/d.txt", to: "/Users/me/Desktop/folder/d.txt" }
      ]
    })).toEqual({
      destructiveOperationCount: 1,
      moveCount: 4,
      moveItems: [
        { key: "/Users/me/Desktop/a.txt->/Users/me/Desktop/folder/a.txt", label: "a.txt -> folder/a.txt" },
        { key: "/Users/me/Desktop/b.txt->/Users/me/Desktop/folder/b.txt", label: "b.txt -> folder/b.txt" },
        { key: "/Users/me/Desktop/c.txt->/Users/me/Desktop/folder/c.txt", label: "c.txt -> folder/c.txt" }
      ],
      operationCount: 4
    });
  });

  it("selects the assistant agent provider by selected flag, mode, then fallback", () => {
    const fallbackProvider = { id: "codex", label: "Codex" };
    const providers = [
      fallbackProvider,
      { id: "claude-code", label: "Claude Code" },
      { id: "hermes", label: "Hermes", selected: true }
    ];

    expect(readSelectedAssistantAgentProvider(providers, "claude-code", fallbackProvider))
      .toEqual({ id: "hermes", label: "Hermes", selected: true });
    expect(readSelectedAssistantAgentProvider(providers.slice(0, 2), "claude-code", fallbackProvider))
      .toEqual({ id: "claude-code", label: "Claude Code" });
    expect(readSelectedAssistantAgentProvider(providers.slice(0, 1), "hermes", fallbackProvider))
      .toBe(fallbackProvider);
  });

  it("derives the app root view model from renderer state", () => {
    const fallbackProvider = { id: "codex", label: "Codex" };
    const claudeProvider = { id: "claude-code", label: "Claude Code" };
    const startupWarning = {
      title: "Launch warning",
      message: "Started outside bundle"
    };

    expect(getAppRootViewModel({
      assistantAgentSettings: {
        providers: [fallbackProvider, claudeProvider],
        settings: { mode: "claude-code" }
      },
      fallbackAssistantAgentProvider: fallbackProvider,
      panelState: {
        assistantPanelOpen: false,
        detailsOpen: false,
        permissionOnboardingOpen: false
      },
      permissions: {
        screenRecording: { state: "granted" },
        accessibility: { state: "not-determined" }
      },
      startupWarnings: [startupWarning],
      taskStatus: "idle"
    })).toEqual({
      panelVisibility: {
        bubbleAriaLabel: "skfiy task status",
        settingsBubble: false,
        showPanel: true,
        showStartupWarning: true
      },
      permissionOnboardingRows: [
        { key: "accessibility", settingsTarget: "accessibility", label: "辅助功能" }
      ],
      petState: "idle",
      selectedAssistantAgentProvider: claudeProvider,
      startupWarning,
      status: {
        label: "Idle",
        message: "待命中.",
        pulse: "Tucked"
      }
    });
  });

  it("derives the app shell view model without React state", () => {
    const fallbackProvider = {
      id: "codex",
      label: "Codex",
      readiness: "chat-ready" as const
    };
    const claudeProvider = {
      id: "claude-code",
      label: "Claude Code",
      readiness: "unavailable" as const
    };

    expect(getAppShellViewModel({
      assistantAgentSettings: {
        providers: [fallbackProvider, claudeProvider],
        settings: { mode: "claude-code" }
      },
      assistantInput: "organize Downloads",
      assistantInputSubmitting: false,
      desktopSessionDiagnostics: {
        state: "blocked",
        reason: "Desktop is locked."
      },
      fallbackAssistantAgentProvider: fallbackProvider,
      panelState: {
        assistantPanelOpen: true,
        detailsOpen: false,
        permissionOnboardingOpen: false
      },
      permissions: {
        screenRecording: { state: "not-determined" },
        accessibility: { state: "denied" }
      },
      permissionsLoading: true,
      plannerProviderSettings: {
        mode: "external-cua",
        externalProviderLabel: "External CUA"
      },
      startupWarnings: [{ title: "Launch warning", message: "Started outside bundle" }],
      taskStatus: "idle"
    })).toMatchObject({
      assistantInputPanel: {
        statusLabel: "Claude Code · unavailable",
        submitDisabled: false,
        submitLabel: "发送"
      },
      panelVisibility: {
        bubbleAriaLabel: "skfiy assistant panel",
        settingsBubble: false,
        showPanel: true,
        showStartupWarning: true
      },
      permissionOnboardingDisplayRows: [
        {
          key: "screenRecording",
          label: "屏幕录制",
          settingsTarget: "screen-recording",
          state: "not-determined",
          stateLabel: "检查中"
        },
        {
          key: "accessibility",
          label: "辅助功能",
          settingsTarget: "accessibility",
          state: "denied",
          stateLabel: "检查中"
        }
      ],
      permissionPanelViewModel: {
        desktopSession: {
          reason: "Desktop is locked.",
          showReason: true,
          state: "denied",
          stateLabel: "检查中"
        }
      },
      petState: "idle",
      plannerProviderDisplay: {
        runtimeLabel: "规划可用",
        settingsHeading: "External CUA",
        showExternalStatus: true
      },
      selectedAssistantAgentProvider: claudeProvider,
      status: {
        label: "Idle",
        message: "待命中.",
        pulse: "Tucked"
      }
    });
  });

  it("derives permission panel display rows", () => {
    expect(getPermissionsPanelViewModel({
      desktopSessionDiagnostics: {
        state: "blocked",
        reason: "Desktop is locked."
      },
      permissions: {
        screenRecording: { state: "granted" },
        accessibility: { state: "denied" }
      },
      permissionsLoading: false
    })).toEqual({
      desktopSession: {
        reason: "Desktop is locked.",
        showReason: true,
        state: "denied",
        stateLabel: "不可控"
      },
      permissionRows: [
        {
          key: "screenRecording",
          label: "屏幕录制",
          settingsTarget: "screen-recording",
          state: "granted",
          stateLabel: "已授权"
        },
        {
          key: "accessibility",
          label: "辅助功能",
          settingsTarget: "accessibility",
          state: "denied",
          stateLabel: "未授权"
        }
      ]
    });

    expect(getPermissionDisplayRows({
      loading: true,
      permissions: {
        screenRecording: { state: "not-determined" },
        accessibility: { state: "unknown" }
      },
      rows: [{ key: "accessibility", label: "辅助功能", settingsTarget: "accessibility" }]
    })).toEqual([
      {
        key: "accessibility",
        label: "辅助功能",
        settingsTarget: "accessibility",
        state: "unknown",
        stateLabel: "检查中"
      }
    ]);
  });

  it("derives planner provider display labels", () => {
    expect(getPlannerProviderDisplayViewModel({
      mode: "external-cua",
      externalProviderLabel: "Claude Desktop"
    })).toEqual({
      runtimeLabel: "规划可用",
      settingsHeading: "Claude Desktop",
      showExternalStatus: true
    });

    expect(getPlannerProviderDisplayViewModel({
      mode: "disabled",
      externalProviderLabel: "Claude Desktop"
    })).toEqual({
      runtimeLabel: "规划已关闭",
      settingsHeading: "Computer Use",
      showExternalStatus: false
    });
  });

  it("derives the user dashboard panel view model", () => {
    expect(getUserDashboardPanelViewModel({
      desktopSessionDiagnostics: {
        state: "blocked",
        reason: "Desktop is locked."
      },
      permissions: {
        screenRecording: { state: "granted" },
        accessibility: { state: "denied" }
      },
      task: {
        status: "approval_required",
        message: "Need approval."
      },
      turnReplay: {
        transcript: {
          outcome: "verification_failed",
          command: "move files",
          risk: {
            level: "medium",
            reason: "Moving files needs review.",
            requiresApproval: true
          }
        }
      }
    })).toEqual({
      canApprove: true,
      canStop: true,
      permissionHealth: {
        label: "桌面暂不可控",
        detail: "Desktop is locked.",
        tone: "danger"
      },
      recent: {
        label: "需要确认",
        detail: "move files",
        tone: "danger"
      },
      risk: {
        label: "中风险，需要审批",
        detail: "Moving files needs review.",
        tone: "warning"
      },
      routeOutcome: {
        kind: "approval_required",
        title: "Route approval required",
        value: "approval_required",
        detail: "Need approval.",
        tone: "warning",
        source: "pet-ui",
        routeLabel: "unknown",
        state: "approval_required"
      },
      routeOutcomeSignal: {
        label: "路由待审批",
        detail: "Need approval.",
        tone: "warning"
      },
      status: {
        label: "等待审批",
        detail: "Need approval.",
        tone: "warning"
      }
    });
  });

  it.each([
    [
      "app-policy denial",
      {
        task: {
          status: "blocked" as const,
          message: "Ghostty is denied by app policy with token=secret-token.",
          command: "open Ghostty"
        },
        turnReplay: {
          transcript: {
            command: "open Ghostty",
            actions: [
              {
                type: "tool_result",
                route: "ghostty",
                status: "blocked",
                summary: "Ghostty is denied by app policy with token=secret-token."
              }
            ]
          },
          timeline: [
            {
              status: "blocked" as const,
              route: "ghostty",
              message: "Ghostty is denied by app policy."
            }
          ]
        }
      },
      {
        kind: "app_policy_denied",
        title: "App policy denied route",
        value: "app_policy_denied",
        tone: "danger",
        routeLabel: "ghostty",
        detail: "Ghostty is denied by app policy with token=[redacted]"
      }
    ],
    [
      "user denial",
      {
        task: {
          status: "denied" as const,
          message: "User denied this Computer Use turn."
        },
        turnReplay: {
          transcript: {
            actions: [
              {
                type: "tool_call",
                route: "chrome",
                status: "approval_required"
              }
            ]
          },
          timeline: [
            {
              status: "denied" as const,
              route: "chrome",
              message: "User denied this Computer Use turn."
            }
          ]
        }
      },
      {
        kind: "user_denied",
        title: "User denied route",
        value: "user_denied",
        tone: "neutral",
        routeLabel: "chrome"
      }
    ],
    [
      "blocked user denial metadata",
      {
        task: {
          status: "blocked" as const,
          message: "User denied this Finder organization request.",
          denialKind: "user"
        },
        turnReplay: {
          transcript: {
            actions: [
              {
                type: "tool_call",
                route: "finder",
                status: "approval_required"
              }
            ]
          }
        }
      },
      {
        kind: "user_denied",
        title: "User denied route",
        value: "user_denied",
        tone: "neutral",
        routeLabel: "finder"
      }
    ],
    [
      "confirmation gate",
      {
        task: {
          status: "needs_confirmation" as const,
          message: "Finder plan confirmation required."
        },
        turnReplay: {
          transcript: {
            actions: [
              {
                type: "tool_call",
                route: "finder",
                status: "approval_required"
              }
            ]
          }
        }
      },
      {
        kind: "needs_confirmation",
        title: "Route needs confirmation",
        value: "needs_confirmation",
        tone: "warning",
        routeLabel: "finder"
      }
    ],
    [
      "clarification request",
      {
        task: {
          status: "needs_clarification" as const,
          message: "No supported desktop control route matched this request. 请明确目标应用和动作。"
        },
        turnReplay: {
          timeline: [
            {
              status: "needs_clarification" as const,
              routeReason: "No supported desktop control route matched this request."
            }
          ]
        }
      },
      {
        kind: "needs_clarification",
        title: "Route needs clarification",
        value: "needs_clarification",
        tone: "warning",
        routeLabel: "unknown",
        detail: "No supported desktop control route matched this request."
      }
    ],
    [
      "cancellation",
      {
        task: {
          status: "cancelled" as const,
          message: "Browser task cancelled before execution."
        },
        turnReplay: {
          transcript: {
            actions: [
              {
                type: "tool_result",
                route: "tmux_supervision",
                status: "cancelled"
              }
            ]
          }
        }
      },
      {
        kind: "cancelled",
        title: "Route cancelled",
        value: "cancelled",
        tone: "neutral",
        routeLabel: "tmux_supervision",
        detail: "Browser task cancelled before execution."
      }
    ],
    [
      "stop turn",
      {
        task: {
          status: "cancelled" as const,
          message: "Task stopped."
        },
        turnReplay: {
          transcript: {
            actions: [
              {
                type: "tool_result",
                route: "tmux_supervision",
                status: "cancelled"
              }
            ]
          }
        }
      },
      {
        kind: "stopped",
        title: "Route stopped",
        value: "stopped",
        tone: "neutral",
        routeLabel: "tmux_supervision",
        detail: "Task stopped."
      }
    ],
    [
      "completion",
      {
        task: {
          status: "completed" as const,
          message: "Chrome page opened."
        },
        turnReplay: {
          transcript: {
            command: "open Chrome",
            actions: [
              {
                type: "tool_result",
                route: "chrome",
                status: "completed",
                summary: "Chrome page opened."
              }
            ]
          }
        }
      },
      {
        kind: "completed",
        title: "Route completed",
        value: "completed",
        tone: "success",
        routeLabel: "chrome",
        detail: "Chrome page opened."
      }
    ]
  ])("preserves pet route outcome for %s", (_label, input, expected) => {
    expect(readPetRouteOutcome(input)).toMatchObject({
      ...expected,
      source: "pet-ui"
    });
  });

  it("uses structured stopTurnBehavior for pet stopped routes without matching message text", () => {
    const outcome = readPetRouteOutcome({
      task: {
        status: "cancelled",
        message: "Operator interrupted the current turn.",
        route: "chrome",
        stopTurnBehavior: {
          result: "stopped",
          source: "hotkey",
          command: "stop-current-turn",
          beforeStatus: "running",
          beforeMessage: "Observing Chrome.",
          afterStatus: "cancelled",
          afterMessage: "Task stopped."
        }
      },
      turnReplay: null
    });

    expect(outcome).toMatchObject({
      kind: "stopped",
      title: "Route stopped",
      value: "stopped",
      tone: "neutral",
      routeLabel: "chrome",
      detail: "Operator interrupted the current turn."
    });
    expect(getPetRouteOutcomeSignal(outcome)).toEqual({
      label: "路由已停止",
      detail: "chrome · Operator interrupted the current turn.",
      tone: "neutral"
    });
  });

  it("normalizes canceled stopTurnBehavior status aliases for pet stopped routes", () => {
    const outcome = readPetRouteOutcome({
      task: {
        status: "cancelled",
        message: "Operator interrupted the current turn.",
        route: "chrome",
        stopTurnBehavior: {
          result: "stopped",
          source: "hotkey",
          command: "stop-current-turn",
          beforeStatus: "running",
          afterStatus: "canceled",
          afterMessage: "Operator interruption recorded."
        }
      },
      turnReplay: null
    });

    expect(outcome).toMatchObject({
      kind: "stopped",
      title: "Route stopped",
      value: "stopped",
      tone: "neutral",
      routeLabel: "chrome",
      state: "cancelled",
      detail: "Operator interrupted the current turn."
    });
    expect(getPetRouteOutcomeSignal(outcome)).toEqual({
      label: "路由已停止",
      detail: "chrome · Operator interrupted the current turn.",
      tone: "neutral"
    });
  });

  it("uses task event route metadata before falling back to message text", () => {
    const outcome = readPetRouteOutcome({
      task: {
        status: "blocked",
        message: "Ghostty cannot continue.",
        route: "ghostty",
        routeReason: "Configured app policy blocked Ghostty.",
        denialKind: "app_policy",
        policyKind: "app-policy"
      },
      turnReplay: null
    });

    expect(outcome).toMatchObject({
      kind: "app_policy_denied",
      title: "App policy denied route",
      value: "app_policy_denied",
      tone: "danger",
      routeLabel: "ghostty",
      detail: "Configured app policy blocked Ghostty."
    });
    expect(getPetRouteOutcomeSignal(outcome)).toEqual({
      label: "应用策略拒绝",
      detail: "ghostty · Configured app policy blocked Ghostty. · 拒绝 app_policy · 策略 app-policy",
      tone: "danger"
    });
  });

  it("uses explicit replay route outcome for the pet route signal with UI redaction", () => {
    const outcome = readPetRouteOutcome({
      task: {
        status: "blocked",
        message: "Blocked by policy."
      },
      turnReplay: {
        routeOutcome: {
          kind: "app_policy_denied",
          title: "App policy denied route",
          value: "app_policy_denied",
          detail: "Ghostty denied by app policy with token=secret-token at /Users/tester/Work",
          tone: "danger",
          source: "turn-replay",
          routeLabel: "ghostty",
          state: "blocked",
          denialKind: "app_policy",
          policyKind: "app-policy"
        },
        transcript: {
          actions: []
        }
      }
    });

    expect(outcome).toEqual({
      kind: "app_policy_denied",
      title: "App policy denied route",
      value: "app_policy_denied",
      detail: "Ghostty denied by app policy with token=[redacted] at [path]",
      tone: "danger",
      source: "turn-replay",
      routeLabel: "ghostty",
      state: "blocked",
      denialKind: "app_policy",
      policyKind: "app-policy"
    });
    expect(getPetRouteOutcomeSignal(outcome)).toEqual({
      label: "应用策略拒绝",
      detail: "ghostty · Ghostty denied by app policy with token=[redacted] at [path] · 拒绝 app_policy · 策略 app-policy",
      tone: "danger"
    });
    expect(JSON.stringify(outcome)).not.toContain("/Users/tester");
  });

  it("normalizes explicit replay route outcome denial aliases for the pet route signal", () => {
    const outcome = readPetRouteOutcome({
      task: {
        status: "blocked",
        message: "Blocked by policy."
      },
      turnReplay: {
        routeOutcome: {
          kind: "chrome_host_policy_denied",
          title: "Chrome host policy denied route",
          value: "chrome-host-policy-blocked",
          detail: "Chrome host policy blocked token=task-secret",
          tone: "danger",
          source: "turn-replay",
          routeLabel: "chrome",
          state: "blocked_by_chrome_host_policy",
          policyKind: "chrome-host-policy"
        },
        transcript: {
          actions: []
        }
      }
    });

    expect(outcome).toEqual({
      kind: "chrome_host_policy_denied",
      title: "Chrome host policy denied route",
      value: "chrome_host_policy_denied",
      detail: "Chrome host policy blocked token=[redacted]",
      tone: "danger",
      source: "turn-replay",
      routeLabel: "chrome",
      state: "chrome_host_policy_denied",
      policyKind: "chrome-host-policy"
    });
    expect(getPetRouteOutcomeSignal(outcome)).toEqual({
      label: "Chrome 站点策略拒绝",
      detail: "chrome · Chrome host policy blocked token=[redacted] · 策略 chrome-host-policy",
      tone: "danger"
    });
  });

  it("normalizes explicit replay route outcome approval aliases for the pet route signal", () => {
    const outcome = readPetRouteOutcome({
      task: {
        status: "running",
        message: "Preparing Finder approval."
      },
      turnReplay: {
        routeOutcome: {
          kind: "approval_required",
          title: "Route approval required",
          value: "needs-approval",
          detail: "Finder file moves need review.",
          tone: "warning",
          source: "turn-replay",
          routeLabel: "finder",
          state: "requires_approval"
        },
        transcript: {
          actions: []
        }
      }
    });

    expect(outcome).toEqual({
      kind: "approval_required",
      title: "Route approval required",
      value: "approval_required",
      detail: "Finder file moves need review.",
      tone: "warning",
      source: "turn-replay",
      routeLabel: "finder",
      state: "approval_required"
    });
    expect(getPetRouteOutcomeSignal(outcome)).toEqual({
      label: "路由待审批",
      detail: "finder · Finder file moves need review.",
      tone: "warning"
    });
  });

  it("normalizes explicit replay route outcome completion and failure aliases for the pet route signal", () => {
    const completed = readPetRouteOutcome({
      task: {
        status: "running",
        message: "Chrome route is reporting."
      },
      turnReplay: {
        routeOutcome: {
          kind: "completed",
          title: "Route completed",
          value: "passed",
          detail: "Chrome page action passed.",
          tone: "success",
          source: "turn-replay",
          routeLabel: "chrome",
          state: "verified"
        },
        transcript: {
          actions: []
        }
      }
    });

    expect(completed).toEqual({
      kind: "completed",
      title: "Route completed",
      value: "completed",
      detail: "Chrome page action passed.",
      tone: "success",
      source: "turn-replay",
      routeLabel: "chrome",
      state: "completed"
    });
    expect(getPetRouteOutcomeSignal(completed)).toEqual({
      label: "路由完成",
      detail: "chrome · Chrome page action passed.",
      tone: "success"
    });

    const failed = readPetRouteOutcome({
      task: {
        status: "running",
        message: "Chrome route is reporting."
      },
      turnReplay: {
        routeOutcome: {
          kind: "failed",
          title: "Route failed",
          value: "error",
          detail: "Chrome action returned an error.",
          tone: "danger",
          source: "turn-replay",
          routeLabel: "chrome",
          state: "timed-out"
        },
        transcript: {
          actions: []
        }
      }
    });

    expect(failed).toEqual({
      kind: "failed",
      title: "Route failed",
      value: "failed",
      detail: "Chrome action returned an error.",
      tone: "danger",
      source: "turn-replay",
      routeLabel: "chrome",
      state: "failed"
    });
    expect(getPetRouteOutcomeSignal(failed)).toEqual({
      label: "路由失败",
      detail: "chrome · Chrome action returned an error.",
      tone: "danger"
    });
  });

  it("uses explicit task event route outcome before stale replay route outcome", () => {
    const outcome = readPetRouteOutcome({
      task: {
        status: "blocked",
        message: "Blocked by current task event.",
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
      },
      turnReplay: {
        routeOutcome: {
          kind: "completed",
          title: "Route completed",
          value: "completed",
          detail: "Previous route completed.",
          tone: "success",
          source: "turn-replay",
          routeLabel: "finder",
          state: "completed"
        },
        transcript: {
          actions: []
        }
      }
    });

    expect(outcome).toEqual({
      kind: "chrome_host_policy_denied",
      title: "Chrome host policy denied route",
      value: "chrome_host_policy_denied",
      detail: "Chrome host policy blocked token=[redacted]",
      tone: "danger",
      source: "task-event",
      routeLabel: "chrome",
      state: "blocked",
      policyKind: "chrome-host-policy"
    });
    expect(getPetRouteOutcomeSignal(outcome)).toEqual({
      label: "Chrome 站点策略拒绝",
      detail: "chrome · Chrome host policy blocked token=[redacted] · 策略 chrome-host-policy",
      tone: "danger"
    });
  });

  it("keeps idle pet route signal from being overwritten by stale replay outcome", () => {
    expect(readPetRouteOutcome({
      task: {
        status: "idle",
        message: "待命中."
      },
      turnReplay: {
        routeOutcome: {
          kind: "completed",
          title: "Route completed",
          value: "completed",
          detail: "Chrome page opened.",
          tone: "success",
          source: "turn-replay",
          routeLabel: "chrome",
          state: "completed"
        },
        transcript: {
          command: "open Chrome",
          actions: [
            {
              type: "tool_result",
              route: "chrome",
              status: "completed",
              summary: "Chrome page opened."
            }
          ]
        }
      }
    })).toMatchObject({
      kind: "unknown",
      source: "pet-ui"
    });
  });

  it("keeps idle pet route signal compact", () => {
    expect(getPetRouteOutcomeSignal(readPetRouteOutcome({
      task: {
        status: "idle",
        message: "待命中."
      },
      turnReplay: null
    }))).toEqual({
      label: "路由待命",
      detail: "暂无路由活动",
      tone: "neutral"
    });
  });

  it("keeps pet clarification route signal distinct from confirmation", () => {
    expect(getPetRouteOutcomeSignal(readPetRouteOutcome({
      task: {
        status: "needs_clarification",
        message: "Generic visible-app control is not a supported product route yet. 请明确目标应用和动作。"
      },
      turnReplay: null
    }))).toEqual({
      label: "路由待澄清",
      detail: "Generic visible-app control is not a supported product route yet. 请明确目标应用和动作。",
      tone: "warning"
    });
  });

  it("derives the local replay viewer model", () => {
    expect(getLocalReplayViewModel(null)).toEqual({
      actionItems: [],
      command: "未记录",
      hasTranscript: false,
      headingOutcome: "empty",
      plannerItems: [],
      riskLevel: "unknown",
      screenshotItems: [],
      timelineItems: []
    });

    expect(getLocalReplayViewModel({
      transcript: {
        outcome: "completed",
        command: "open Finder",
        risk: { level: "low" },
        planner: {
          providerLabel: "Local",
          command: "click Downloads",
          rationale: "Need file context"
        },
        actions: [
          { type: "activate_app", appName: "Finder" },
          { type: "press_key", key: "Enter" },
          {
            type: "tool_result",
            route: "finder",
            status: "completed",
            summary: "Finder organized files with token=secret-token.",
            artifactCount: 1
          }
        ],
        screenshots: [
          { stage: "before", path: "/tmp/before.png" },
          {
            stage: "after",
            path: "/tmp/after.png",
            grounding: { recommendation: "high confidence" }
          }
        ]
      },
      timeline: [
        { status: "observing", message: "Looking at Finder" },
        { status: "executing", command: "click Downloads" }
      ]
    })).toEqual({
      actionItems: [
        "activate_app: Finder",
        "press_key: Enter",
        "tool_result: finder completed Finder organized files with token=[redacted] 1 artifacts"
      ],
      command: "open Finder",
      hasTranscript: true,
      headingOutcome: "completed",
      plannerItems: ["Local: click Downloads (Need file context)"],
      riskLevel: "low",
      screenshotItems: [
        "before: /tmp/before.png",
        "after: /tmp/after.png (high confidence)"
      ],
      timelineItems: [
        "observing: Looking at Finder",
        "executing: click Downloads"
      ]
    });
  });

  it("formats replay planner and action summaries", () => {
    expect(formatReplayPlanner({
      providerLabel: "Local",
      command: "open Finder",
      rationale: "Need file context"
    })).toBe("Local: open Finder (Need file context)");
    expect(formatReplayPlanner({
      providerLabel: "Codex",
      command: "observe"
    })).toBe("Codex: observe");

    expect(formatReplayAction({ type: "plan", providerLabel: "Local", command: "click" })).toBe("plan: Local click");
    expect(formatReplayAction({
      type: "tool_call",
      route: "chrome",
      status: "approval_required",
      command: "open https://example.test/?token=secret-token"
    })).toBe("tool_call: chrome approval_required open https://example.test/?token=[redacted]");
    expect(formatReplayAction({
      type: "approval_decision",
      route: "chrome",
      decision: "denied",
      reason: "User denied token=secret-token."
    })).toBe("approval_decision: chrome denied User denied token=[redacted]");
    expect(formatReplayAction({
      type: "tool_result",
      route: "ghostty",
      status: "blocked",
      evidenceSummary: "Ghostty blocked with Bearer abc.def.",
      artifactCount: 2
    })).toBe("tool_result: ghostty blocked Ghostty blocked with Bearer [redacted] 2 artifacts");
    expect(formatReplayAction({
      type: "switch_control",
      from: "chrome",
      to: "finder",
      stage: "route-fallback",
      reason: "Use Finder route."
    })).toBe("switch_control: chrome -> finder route-fallback Use Finder route.");
    expect(formatReplayAction({
      type: "observe_finder_selection",
      source: "finder-applescript",
      targetPath: "/tmp/skfiy-finder-smoke",
      selectedCount: 1
    })).toBe("observe_finder_selection: 1 selected finder-applescript [path]");
    expect(formatReplayAction({
      type: "preview_finder_plan",
      rootPath: "/tmp/skfiy-finder-smoke",
      operationCount: 6,
      destructiveOperationCount: 0,
      createFolderCount: 3,
      moveFileCount: 3
    })).toBe("preview_finder_plan: 6 ops 0 destructive 3 folders 3 moves [path]");
    expect(formatReplayAction({
      type: "confirm_finder_plan",
      rootPath: "/tmp/skfiy-finder-smoke",
      operationCount: 6,
      destructiveOperationCount: 0,
      reason: "Finder current-folder organization needs confirmation."
    })).toBe("confirm_finder_plan: 6 ops 0 destructive Finder current-folder organization needs confirmation. [path]");
    expect(formatReplayAction({ type: "type_text", text: "hello" })).toBe("type_text: hello");
    expect(formatReplayAction({ type: "press_key", key: "Enter" })).toBe("press_key: Enter");
    expect(formatReplayAction({ type: "activate_app", appName: "Finder" })).toBe("activate_app: Finder");
    expect(formatReplayAction({ type: "open_session", bundleId: "com.apple.finder" })).toBe("open_session: com.apple.finder");
    expect(formatReplayAction({ type: "recover", action: "retry", stage: "after" })).toBe("recover: retry after");
    expect(formatReplayAction({
      type: "verify",
      actionType: "screen",
      status: "failed",
      reason: "button missing"
    })).toBe("verify: screen failed button missing");
    expect(formatReplayAction({ type: "custom" })).toBe("custom");
  });
});
