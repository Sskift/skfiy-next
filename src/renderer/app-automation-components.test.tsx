import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AutomationMonitorSnapshot, AutomationRunRecord, AutomationRunSnapshot } from "./app-types";
import {
  AutomationControlCenterPanel,
  type AutomationControlCenterPanelProps
} from "./app-automation-components";
import { createAutomationFeedback } from "./app-automation-state";
import { DEFAULT_AUTOMATION_RUN_SNAPSHOT } from "./app-automation-run-state";

function createSnapshot(
  overrides: Partial<AutomationMonitorSnapshot> = {}
): AutomationMonitorSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-20T09:00:00.000Z",
    activeCount: 1,
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
    monitors: [
      {
        id: "tmux-session:money-run-goal",
        kind: "tmux-session",
        label: "money-run goal",
        enabled: true,
        intervalMs: 600_000,
        timeoutMs: 30_000,
        triggerMode: "scheduled",
        sessionName: "money-run-goal",
        preview: {
          adapter: "tmux-supervision",
          triggerModes: ["manual", "scheduled"],
          target: { kind: "tmux-session", sessionName: "money-run-goal" },
          requiredPermissions: [],
          readWriteBehavior: "read-only",
          approvalMode: "not-required",
          timeoutMs: 30_000,
          verification: "tmux session, window, pane, and bounded recent pane-output observation",
          mutatesSession: false
        },
        status: "observing",
        checkCount: 2,
        lastCheckedAt: "2026-08-20T08:55:00.000Z",
        nextCheckAt: "2026-08-20T09:05:00.000Z",
        lastSummary: "money-run-goal has 1 window, 1 pane, and no obvious block markers.",
        lastResult: "observing",
        lastResultAt: "2026-08-20T08:55:00.000Z",
        observedSession: "money-run-goal",
        schedulerState: "inactive",
        schedulerScope: "app-process",
        mutatesSession: false
      }
    ],
    ...overrides
  };
}

function createRunRecord(
  overrides: Partial<AutomationRunRecord> = {}
): AutomationRunRecord {
  return {
    schemaVersion: 1,
    runId: "tmux-session:money-run-goal:run:1",
    monitorId: "tmux-session:money-run-goal",
    trigger: "manual",
    state: "running",
    createdAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T09:00:05.000Z",
    currentStep: "observe",
    attempt: 1,
    maxAttempts: 3,
    timeline: [
      { at: "2026-08-20T09:00:00.000Z", step: "queued" },
      { at: "2026-08-20T09:00:00.000Z", step: "started" },
      { at: "2026-08-20T09:00:05.000Z", step: "observe", detail: "第 1/3 次观察进行中。" }
    ],
    config: {
      sessionName: "money-run-goal",
      timeoutMs: 30_000,
      maxAttempts: 3,
      backoffMs: 30_000,
      backoffMultiplier: 2,
      maxBackoffMs: 300_000,
      runTtlMs: 900_000,
      concurrencyPolicy: "skip",
      maxConcurrency: 1
    },
    ...overrides
  };
}

function createRunSnapshot(
  overrides: Partial<AutomationRunSnapshot> = {}
): AutomationRunSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-20T09:00:05.000Z",
    runs: [],
    ...overrides
  };
}

function createProps(
  overrides: Partial<AutomationControlCenterPanelProps> = {}
): AutomationControlCenterPanelProps {
  return {
    snapshot: createSnapshot(),
    runs: createRunSnapshot(),
    feedback: null,
    actionPending: false,
    editor: null,
    preview: null,
    onRefresh: vi.fn(),
    onCreate: vi.fn(),
    onRunNow: vi.fn(),
    onToggleEnabled: vi.fn(),
    onDuplicate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onSubmitDefinition: vi.fn(),
    onCancelEditor: vi.fn(),
    onConfirmPreview: vi.fn(),
    onCancelPreview: vi.fn(),
    onStopRun: vi.fn(),
    ...overrides
  };
}

describe("AutomationControlCenterPanel", () => {
  it("lists monitors with status, trigger mode, and next check time", () => {
    render(<AutomationControlCenterPanel {...createProps()} />);

    expect(screen.getByText("money-run goal")).toBeTruthy();
    expect(screen.getByText("tmux: money-run-goal")).toBeTruthy();
    expect(screen.getByText("观察中")).toBeTruthy();
    expect(screen.getByText("定时")).toBeTruthy();
    expect(screen.getByText(/下次检查/)).toBeTruthy();
    expect(screen.getByText(/money-run-goal has 1 window/)).toBeTruthy();
  });

  it("wires all five row actions", () => {
    const onRunNow = vi.fn();
    const onToggleEnabled = vi.fn();
    const onDuplicate = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <AutomationControlCenterPanel
        {...createProps({ onRunNow, onToggleEnabled, onDuplicate, onEdit, onDelete })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "立即运行：money-run goal" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停：money-run goal" }));
    fireEvent.click(screen.getByRole("button", { name: "复制：money-run goal" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑：money-run goal" }));
    fireEvent.click(screen.getByRole("button", { name: "删除：money-run goal" }));

    expect(onRunNow).toHaveBeenCalledWith("tmux-session:money-run-goal");
    expect(onToggleEnabled).toHaveBeenCalledWith("tmux-session:money-run-goal", false);
    expect(onDuplicate).toHaveBeenCalledWith("tmux-session:money-run-goal");
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({
      id: "tmux-session:money-run-goal"
    }));
    expect(onDelete).toHaveBeenCalledWith("tmux-session:money-run-goal");
  });

  it("shows an inert disabled badge and keeps run-now inert for disabled monitors", () => {
    const onRunNow = vi.fn();
    render(
      <AutomationControlCenterPanel
        {...createProps({
          onRunNow,
          snapshot: createSnapshot({
            activeCount: 0,
            monitors: [
              {
                ...createSnapshot().monitors[0]!,
                enabled: false,
                status: "disabled",
                triggerMode: "manual",
                nextCheckAt: undefined
              }
            ]
          })
        })}
      />
    );

    expect(screen.getByText("已停用")).toBeTruthy();
    const runNow = screen.getByRole("button", { name: "立即运行：money-run goal" });
    expect(runNow.hasAttribute("disabled")).toBe(true);
    fireEvent.click(runNow);
    expect(onRunNow).not.toHaveBeenCalled();
  });

  it("renders an empty state and opens the creator", () => {
    const onCreate = vi.fn();
    render(
      <AutomationControlCenterPanel
        {...createProps({
          onCreate,
          snapshot: createSnapshot({ activeCount: 0, monitors: [] })
        })}
      />
    );

    expect(screen.getByText("暂无自动化监控")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建自动化监控" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("mirrors feedback through an aria-live line", () => {
    const { container, rerender } = render(<AutomationControlCenterPanel {...createProps()} />);

    const feedbackLine = container.querySelector(".automation-feedback-line");
    expect(feedbackLine?.getAttribute("aria-live")).toBe("polite");
    expect(feedbackLine?.textContent).toBe("");

    rerender(
      <AutomationControlCenterPanel
        {...createProps({
          feedback: createAutomationFeedback("success", "已删除该监控。")
        })}
      />
    );

    expect(screen.getByText("已删除该监控。")).toBeTruthy();
  });

  it("refreshes the snapshot on demand", () => {
    const onRefresh = vi.fn();
    render(<AutomationControlCenterPanel {...createProps({ onRefresh })} />);

    fireEvent.click(screen.getByRole("button", { name: "刷新自动化监控" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("AutomationDefinitionForm", () => {
  it("blocks submission while the tmux session name is empty", () => {
    const onSubmit = vi.fn();
    render(
      <AutomationControlCenterPanel
        {...createProps({
          editor: { mode: "create" },
          onSubmitDefinition: onSubmit
        })}
      />
    );

    const submit = screen.getByRole("button", { name: "预览安全边界" });
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("tmux 会话名"), {
      target: { value: "money-run-goal" }
    });
    expect(submit.hasAttribute("disabled")).toBe(false);

    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: "money-run-goal",
      triggerMode: "scheduled"
    }));
  });

  it("locks the tmux session name when editing and submits the monitor id", () => {
    const onSubmit = vi.fn();
    const monitor = createSnapshot().monitors[0]!;
    render(
      <AutomationControlCenterPanel
        {...createProps({
          editor: { mode: "edit", monitor },
          onSubmitDefinition: onSubmit
        })}
      />
    );

    const sessionInput = screen.getByLabelText("tmux 会话名") as HTMLInputElement;
    expect(sessionInput.readOnly).toBe(true);
    expect(sessionInput.value).toBe("money-run-goal");

    fireEvent.change(screen.getByLabelText("触发方式"), {
      target: { value: "manual" }
    });
    fireEvent.click(screen.getByRole("button", { name: "预览安全边界" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      monitorId: "tmux-session:money-run-goal",
      sessionName: "money-run-goal",
      triggerMode: "manual"
    }));
  });
});

describe("AutomationPreviewCard", () => {
  it("renders every safety row and the policy note before enabling", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const monitor = createSnapshot().monitors[0]!;
    render(
      <AutomationControlCenterPanel
        {...createProps({
          editor: { mode: "edit", monitor },
          preview: {
            preview: monitor.preview,
            draft: {
              monitorId: monitor.id,
              label: monitor.label,
              sessionName: monitor.sessionName,
              triggerMode: "scheduled",
              intervalMs: 600_000,
              timeoutMs: 30_000
            }
          },
          onConfirmPreview: onConfirm,
          onCancelPreview: onCancel
        })}
      />
    );

    const card = screen.getByLabelText("自动化安全边界预览");
    expect(card.textContent).toContain("tmux 会话 money-run-goal");
    expect(card.textContent).toContain("无");
    expect(card.textContent).toContain("只读");
    expect(card.textContent).toContain("无需审批");
    expect(card.textContent).toContain("30 秒");
    expect(card.textContent).toContain(
      "tmux session, window, pane, and bounded recent pane-output observation"
    );
    expect(card.textContent).toContain("启用监控不会扩大 macOS、Chrome、应用或主机策略权限。");

    fireEvent.click(screen.getByRole("button", { name: "保存并启用" }));
    expect(onConfirm).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "仅保存（停用）" }));
    expect(onConfirm).toHaveBeenCalledWith(false);
    fireEvent.click(within(card).getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("AutomationRunPanel", () => {
  it("renders nothing when there are no runs", () => {
    const { container } = render(<AutomationControlCenterPanel {...createProps()} />);
    expect(container.querySelector(".automation-run-panel")).toBeNull();
  });

  it("renders a run chip with the state tone and Chinese label", () => {
    render(
      <AutomationControlCenterPanel
        {...createProps({
          runs: createRunSnapshot({
            runs: [
              createRunRecord({ state: "running" }),
              createRunRecord({
                runId: "tmux-session:money-run-goal:run:2",
                state: "failed",
                error: "tmux unavailable"
              })
            ]
          })
        })}
      />
    );

    const runningChip = screen.getByText("运行中");
    expect(runningChip.getAttribute("data-tone")).toBe("success");
    const failedChip = screen.getByText("已失败");
    expect(failedChip.getAttribute("data-tone")).toBe("danger");
    expect(screen.getAllByText("第 1/3 次")).toHaveLength(2);
    expect(screen.getByText("tmux unavailable")).toBeTruthy();
  });

  it("disables the stop button for terminal runs and wires it for active runs", () => {
    const onStopRun = vi.fn();
    render(
      <AutomationControlCenterPanel
        {...createProps({
          onStopRun,
          runs: createRunSnapshot({
            runs: [
              createRunRecord({ state: "running" }),
              createRunRecord({
                runId: "tmux-session:money-run-goal:run:2",
                state: "completed"
              })
            ]
          })
        })}
      />
    );

    const stopButtons = screen.getAllByRole("button", { name: /停止运行：/ });
    expect(stopButtons).toHaveLength(2);
    expect(stopButtons[0]?.hasAttribute("disabled")).toBe(false);
    expect(stopButtons[1]?.hasAttribute("disabled")).toBe(true);

    fireEvent.click(stopButtons[0]!);
    expect(onStopRun).toHaveBeenCalledWith("tmux-session:money-run-goal:run:1");
  });

  it("opens a bounded timeline drawer with formatted entries", () => {
    render(
      <AutomationControlCenterPanel
        {...createProps({
          runs: createRunSnapshot({
            runs: [createRunRecord()]
          })
        })}
      />
    );

    expect(screen.queryByLabelText("tmux-session:money-run-goal:run:1 时间线")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看时间线：tmux-session:money-run-goal:run:1" }));

    const drawer = screen.getByLabelText("tmux-session:money-run-goal:run:1 时间线");
    const entries = within(drawer).getAllByText(/排队|开始|观察/);
    expect(entries.length).toBeGreaterThan(0);
    expect(drawer.textContent).toContain("第 1/3 次观察进行中。");
  });

  it("keeps the timeline button inert when a run has no timeline entries", () => {
    render(
      <AutomationControlCenterPanel
        {...createProps({
          runs: createRunSnapshot({
            runs: [createRunRecord({ timeline: [] })]
          })
        })}
      />
    );

    const timelineButton = screen.getByRole("button", {
      name: "查看时间线：tmux-session:money-run-goal:run:1"
    });
    expect(timelineButton.hasAttribute("disabled")).toBe(true);
  });
});
