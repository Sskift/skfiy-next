import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  createAutomationFeedback,
  createDefaultAutomationMonitorPreview,
  describeAutomationMonitorOutcome,
  formatAutomationInterval,
  formatAutomationTimeout,
  formatAutomationTimestamp,
  readAutomationPreviewRows,
  readAutomationStatusLabel,
  readAutomationStatusTone,
  readAutomationTriggerModeLabel
} from "./app-automation-state";

describe("app automation state", () => {
  it("exposes a stable empty monitor snapshot", () => {
    expect(DEFAULT_AUTOMATION_MONITOR_SNAPSHOT).toEqual({
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
    });
  });

  it("maps monitor statuses to Chinese labels and tones", () => {
    expect(readAutomationStatusLabel("observing")).toBe("观察中");
    expect(readAutomationStatusLabel("needs_attention")).toBe("需要关注");
    expect(readAutomationStatusLabel("blocked")).toBe("已阻塞");
    expect(readAutomationStatusLabel("idle")).toBe("空闲");
    expect(readAutomationStatusLabel("disabled")).toBe("已停用");
    expect(readAutomationStatusLabel("error")).toBe("错误");
    expect(readAutomationStatusLabel("scheduler_inactive")).toBe("调度未启动");

    expect(readAutomationStatusTone("observing")).toBe("success");
    expect(readAutomationStatusTone("needs_attention")).toBe("warning");
    expect(readAutomationStatusTone("blocked")).toBe("danger");
    expect(readAutomationStatusTone("idle")).toBe("neutral");
    expect(readAutomationStatusTone("disabled")).toBe("neutral");
    expect(readAutomationStatusTone("error")).toBe("danger");
    expect(readAutomationStatusTone("scheduler_inactive")).toBe("warning");
  });

  it("labels trigger modes in the panel language", () => {
    expect(readAutomationTriggerModeLabel("manual")).toBe("手动");
    expect(readAutomationTriggerModeLabel("scheduled")).toBe("定时");
    expect(readAutomationTriggerModeLabel("local-state")).toBe("本地状态");
  });

  it("formats intervals, timeouts, and timestamps", () => {
    expect(formatAutomationInterval(30_000)).toBe("30 秒");
    expect(formatAutomationInterval(600_000)).toBe("10 分钟");
    expect(formatAutomationInterval(3_600_000)).toBe("1 小时");
    expect(formatAutomationInterval(5_400_000)).toBe("1.5 小时");
    expect(formatAutomationInterval(0)).toBe("—");
    expect(formatAutomationTimeout(12_000)).toBe("12 秒");
    expect(formatAutomationTimeout(60_000)).toBe("1 分钟");
    expect(formatAutomationTimestamp(undefined)).toBe("—");
    expect(formatAutomationTimestamp("not-a-date")).toBe("—");
    expect(formatAutomationTimestamp("2026-08-20T09:00:00.000Z")).toMatch(/08\/20/);
  });

  it("extracts read-only safety rows from a definition preview", () => {
    const preview = createDefaultAutomationMonitorPreview("money-run-goal");
    preview.timeoutMs = 12_000;

    const rows = readAutomationPreviewRows(preview);

    expect(rows).toEqual([
      { label: "目标", value: "tmux 会话 money-run-goal" },
      { label: "所需权限", value: "无" },
      { label: "读写行为", value: "只读" },
      { label: "审批模式", value: "无需审批" },
      { label: "超时", value: "12 秒" },
      {
        label: "验证方式",
        value: "tmux session, window, pane, and bounded recent pane-output observation"
      }
    ]);
  });

  it("creates feedback with a tone and describes monitor outcomes", () => {
    expect(createAutomationFeedback("success", "已删除该监控。")).toEqual({
      tone: "success",
      message: "已删除该监控。"
    });
    expect(describeAutomationMonitorOutcome({
      lastError: "tmux unavailable"
    })).toBe("tmux unavailable");
    expect(describeAutomationMonitorOutcome({
      lastSummary: "money-run-goal has 1 window, 1 pane, and no obvious block markers."
    })).toBe("money-run-goal has 1 window, 1 pane, and no obvious block markers.");
    expect(describeAutomationMonitorOutcome({})).toBe("尚未执行检查。");
  });
});
