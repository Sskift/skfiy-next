import { describe, expect, it } from "vitest";
import type { AutomationRunRecord } from "./app-types";
import {
  DEFAULT_AUTOMATION_RUN_SNAPSHOT,
  describeAutomationRunOutcome,
  formatAutomationRunTimelineEntry,
  formatAutomationRunTimestamp,
  isAutomationRunTerminal,
  readAutomationRunStateLabel,
  readAutomationRunStateTone,
  readAutomationRunStepLabel,
  readAutomationRunTriggerLabel
} from "./app-automation-run-state";

function createRecord(overrides: Partial<AutomationRunRecord> = {}): AutomationRunRecord {
  return {
    schemaVersion: 1,
    runId: "tmux-session:money-run-goal:run:1",
    monitorId: "tmux-session:money-run-goal",
    trigger: "manual",
    state: "running",
    createdAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T09:00:00.000Z",
    currentStep: "observe",
    attempt: 1,
    maxAttempts: 3,
    timeline: [],
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

describe("automation run state labels", () => {
  it("maps all eight states to Chinese labels", () => {
    expect(readAutomationRunStateLabel("queued")).toBe("排队中");
    expect(readAutomationRunStateLabel("running")).toBe("运行中");
    expect(readAutomationRunStateLabel("waiting")).toBe("等待中");
    expect(readAutomationRunStateLabel("attention")).toBe("待处理");
    expect(readAutomationRunStateLabel("completed")).toBe("已完成");
    expect(readAutomationRunStateLabel("failed")).toBe("已失败");
    expect(readAutomationRunStateLabel("cancelled")).toBe("已取消");
    expect(readAutomationRunStateLabel("expired")).toBe("已过期");
  });

  it("maps states to the neutral/success/warning/danger tone scale", () => {
    expect(readAutomationRunStateTone("queued")).toBe("neutral");
    expect(readAutomationRunStateTone("running")).toBe("success");
    expect(readAutomationRunStateTone("waiting")).toBe("warning");
    expect(readAutomationRunStateTone("attention")).toBe("warning");
    expect(readAutomationRunStateTone("completed")).toBe("success");
    expect(readAutomationRunStateTone("failed")).toBe("danger");
    expect(readAutomationRunStateTone("cancelled")).toBe("neutral");
    expect(readAutomationRunStateTone("expired")).toBe("danger");
  });

  it("classifies terminal states", () => {
    expect(isAutomationRunTerminal("queued")).toBe(false);
    expect(isAutomationRunTerminal("running")).toBe(false);
    expect(isAutomationRunTerminal("waiting")).toBe(false);
    for (const state of ["attention", "completed", "failed", "cancelled", "expired"] as const) {
      expect(isAutomationRunTerminal(state)).toBe(true);
    }
  });

  it("labels every trigger source", () => {
    expect(readAutomationRunTriggerLabel("manual")).toBe("手动");
    expect(readAutomationRunTriggerLabel("scheduled")).toBe("定时");
    expect(readAutomationRunTriggerLabel("local-state")).toBe("本地状态");
    expect(readAutomationRunTriggerLabel("cli")).toBe("CLI");
    expect(readAutomationRunTriggerLabel("mcp")).toBe("MCP");
  });
});

describe("automation run timeline formatting", () => {
  it("formats known steps in Chinese and falls back to the raw step id", () => {
    expect(readAutomationRunStepLabel("observe")).toBe("观察");
    expect(readAutomationRunStepLabel("retry-attempt")).toBe("重试");
    expect(readAutomationRunStepLabel("approval-gate")).toBe("等待审批");
    expect(readAutomationRunStepLabel("custom-step")).toBe("custom-step");
  });

  it("renders timeline entries with bounded detail", () => {
    expect(formatAutomationRunTimelineEntry({
      at: "2026-08-20T09:00:00.000Z",
      step: "started"
    })).toBe("开始");
    expect(formatAutomationRunTimelineEntry({
      at: "2026-08-20T09:00:00.000Z",
      step: "retry-scheduled",
      detail: "tmux unavailable; retry in 30000ms"
    })).toBe("重试已安排 · tmux unavailable; retry in 30000ms");

    const longDetail = "x".repeat(200);
    const formatted = formatAutomationRunTimelineEntry({
      at: "2026-08-20T09:00:00.000Z",
      step: "observe",
      detail: longDetail
    });
    expect(formatted.length).toBeLessThan(140);
    expect(formatted.endsWith("…")).toBe(true);
  });

  it("formats timestamps in zh-CN and rejects garbage", () => {
    expect(formatAutomationRunTimestamp("2026-08-20T09:00:00.000Z")).not.toBe("—");
    expect(formatAutomationRunTimestamp("not-a-date")).toBe("—");
    expect(formatAutomationRunTimestamp(undefined)).toBe("—");
  });
});

describe("automation run outcome descriptions", () => {
  it("prefers the bounded error, then the verification summary", () => {
    expect(describeAutomationRunOutcome(createRecord({
      state: "failed",
      error: "tmux unavailable"
    }))).toBe("tmux unavailable");
    expect(describeAutomationRunOutcome(createRecord({
      state: "completed",
      latestVerification: {
        at: "2026-08-20T09:00:00.000Z",
        kind: "tmux-observation",
        status: "observing",
        summary: "money-run-goal has 1 window, 1 pane."
      }
    }))).toBe("money-run-goal has 1 window, 1 pane.");
  });

  it("describes active and terminal states in Chinese", () => {
    expect(describeAutomationRunOutcome(createRecord({ state: "queued" }))).toBe("等待并发槽位。");
    expect(describeAutomationRunOutcome(createRecord({ state: "running", attempt: 2 })))
      .toBe("第 2/3 次观察进行中。");
    expect(describeAutomationRunOutcome(createRecord({
      state: "waiting",
      attempt: 1,
      nextAction: "retry-after-30000ms"
    }))).toBe("第 1/3 次尝试失败，等待重试。");
    expect(describeAutomationRunOutcome(createRecord({ state: "attention" }))).toBe("需要人工复核。");
    expect(describeAutomationRunOutcome(createRecord({ state: "expired" }))).toBe("运行超时未完成。");
  });

  it("records which surface cancelled a run", () => {
    expect(describeAutomationRunOutcome(createRecord({
      state: "cancelled",
      cancellation: { requestedBy: "dashboard", at: "2026-08-20T09:00:00.000Z" }
    }))).toBe("已被面板停止。");
    expect(describeAutomationRunOutcome(createRecord({
      state: "cancelled",
      cancellation: { requestedBy: "cli", at: "2026-08-20T09:00:00.000Z" }
    }))).toBe("已被CLI停止。");
  });
});

describe("default automation run snapshot", () => {
  it("is an empty fail-closed snapshot", () => {
    expect(DEFAULT_AUTOMATION_RUN_SNAPSHOT).toEqual({
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      runs: []
    });
  });
});
