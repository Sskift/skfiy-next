import type {
  AutomationMonitorDefinitionPreview,
  AutomationMonitorSnapshot,
  AutomationMonitorStatus,
  AutomationMonitorTriggerMode
} from "./app-types";

export const DEFAULT_AUTOMATION_MONITOR_SNAPSHOT: AutomationMonitorSnapshot = {
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
};

export function createDefaultAutomationMonitorPreview(
  sessionName = ""
): AutomationMonitorDefinitionPreview {
  return {
    adapter: "tmux-supervision",
    triggerModes: ["manual", "scheduled"],
    target: {
      kind: "tmux-session",
      sessionName
    },
    requiredPermissions: [],
    readWriteBehavior: "read-only",
    approvalMode: "not-required",
    timeoutMs: 30_000,
    verification: "tmux session, window, pane, and bounded recent pane-output observation",
    mutatesSession: false
  };
}

export type AutomationFeedbackTone = "neutral" | "success" | "danger";

export interface AutomationFeedback {
  tone: AutomationFeedbackTone;
  message: string;
}

export function createAutomationFeedback(
  tone: AutomationFeedbackTone,
  message: string
): AutomationFeedback {
  return { tone, message };
}

export type AutomationStatusTone = "neutral" | "success" | "warning" | "danger";

const AUTOMATION_STATUS_LABELS: Record<AutomationMonitorStatus, string> = {
  observing: "观察中",
  needs_attention: "需要关注",
  blocked: "已阻塞",
  idle: "空闲",
  disabled: "已停用",
  error: "错误",
  scheduler_inactive: "调度未启动"
};

const AUTOMATION_STATUS_TONES: Record<AutomationMonitorStatus, AutomationStatusTone> = {
  observing: "success",
  needs_attention: "warning",
  blocked: "danger",
  idle: "neutral",
  disabled: "neutral",
  error: "danger",
  scheduler_inactive: "warning"
};

export function readAutomationStatusLabel(status: AutomationMonitorStatus): string {
  return AUTOMATION_STATUS_LABELS[status] ?? status;
}

export function readAutomationStatusTone(status: AutomationMonitorStatus): AutomationStatusTone {
  return AUTOMATION_STATUS_TONES[status] ?? "neutral";
}

const AUTOMATION_TRIGGER_MODE_LABELS: Record<AutomationMonitorTriggerMode, string> = {
  manual: "手动",
  scheduled: "定时",
  "local-state": "本地状态"
};

export function readAutomationTriggerModeLabel(mode: AutomationMonitorTriggerMode): string {
  return AUTOMATION_TRIGGER_MODE_LABELS[mode] ?? mode;
}

export function formatAutomationInterval(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return "—";
  }
  if (intervalMs < 60_000) {
    return `${Math.round(intervalMs / 1_000)} 秒`;
  }
  if (intervalMs < 3_600_000) {
    return `${Math.round(intervalMs / 60_000)} 分钟`;
  }
  return `${(intervalMs / 3_600_000).toFixed(1).replace(/\.0$/u, "")} 小时`;
}

export function formatAutomationTimeout(timeoutMs: number): string {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return "—";
  }
  if (timeoutMs < 60_000) {
    return `${Math.round(timeoutMs / 1_000)} 秒`;
  }
  return `${Math.round(timeoutMs / 60_000)} 分钟`;
}

export function formatAutomationTimestamp(value: string | undefined): string {
  if (!value) {
    return "—";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "—";
  }

  return parsed.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export interface AutomationPreviewRow {
  label: string;
  value: string;
}

export function readAutomationPreviewRows(
  preview: AutomationMonitorDefinitionPreview
): AutomationPreviewRow[] {
  return [
    {
      label: "目标",
      value: `tmux 会话 ${preview.target.sessionName}`
    },
    {
      label: "所需权限",
      value: preview.requiredPermissions.length === 0 ? "无" : "受限"
    },
    {
      label: "读写行为",
      value: preview.readWriteBehavior === "read-only" ? "只读" : preview.readWriteBehavior
    },
    {
      label: "审批模式",
      value: preview.approvalMode === "not-required" ? "无需审批" : preview.approvalMode
    },
    {
      label: "超时",
      value: formatAutomationTimeout(preview.timeoutMs)
    },
    {
      label: "验证方式",
      value: preview.verification
    }
  ];
}

export function describeAutomationMonitorOutcome(input: {
  lastError?: string;
  lastSummary?: string;
}): string {
  if (input.lastError) {
    return input.lastError;
  }
  if (input.lastSummary) {
    return input.lastSummary;
  }
  return "尚未执行检查。";
}
