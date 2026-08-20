import type {
  AutomationRunCancellationSource,
  AutomationRunRecord,
  AutomationRunSnapshot,
  AutomationRunState,
  AutomationRunTimelineEntry,
  AutomationRunVerification
} from "./app-types";

export const DEFAULT_AUTOMATION_RUN_SNAPSHOT: AutomationRunSnapshot = {
  schemaVersion: 1,
  generatedAt: new Date(0).toISOString(),
  runs: []
};

export type AutomationRunStatusTone = "neutral" | "success" | "warning" | "danger";

const AUTOMATION_RUN_STATE_LABELS: Record<AutomationRunState, string> = {
  queued: "排队中",
  running: "运行中",
  waiting: "等待中",
  attention: "待处理",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已取消",
  expired: "已过期"
};

const AUTOMATION_RUN_STATE_TONES: Record<AutomationRunState, AutomationRunStatusTone> = {
  queued: "neutral",
  running: "success",
  waiting: "warning",
  attention: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  expired: "danger"
};

export function readAutomationRunStateLabel(state: AutomationRunState): string {
  return AUTOMATION_RUN_STATE_LABELS[state] ?? state;
}

export function readAutomationRunStateTone(state: AutomationRunState): AutomationRunStatusTone {
  return AUTOMATION_RUN_STATE_TONES[state] ?? "neutral";
}

export function isAutomationRunTerminal(state: AutomationRunState): boolean {
  return (
    state === "attention"
    || state === "completed"
    || state === "failed"
    || state === "cancelled"
    || state === "expired"
  );
}

const AUTOMATION_RUN_TRIGGER_LABELS: Record<AutomationRunRecord["trigger"], string> = {
  manual: "手动",
  scheduled: "定时",
  "local-state": "本地状态",
  cli: "CLI",
  mcp: "MCP"
};

export function readAutomationRunTriggerLabel(
  trigger: AutomationRunRecord["trigger"]
): string {
  return AUTOMATION_RUN_TRIGGER_LABELS[trigger] ?? trigger;
}

const AUTOMATION_RUN_STEP_LABELS: Record<string, string> = {
  queued: "排队",
  started: "开始",
  observe: "观察",
  "retry-backoff": "退避重试",
  "retry-scheduled": "重试已安排",
  "retry-attempt": "重试",
  "approval-gate": "等待审批",
  completed: "完成",
  attention: "待处理",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期"
};

export function readAutomationRunStepLabel(step: string): string {
  return AUTOMATION_RUN_STEP_LABELS[step] ?? step;
}

const MAX_AUTOMATION_RUN_TIMELINE_DETAIL_LENGTH = 120;

export function formatAutomationRunTimelineEntry(entry: AutomationRunTimelineEntry): string {
  const label = readAutomationRunStepLabel(entry.step);
  if (!entry.detail) {
    return label;
  }
  const detail = entry.detail.length > MAX_AUTOMATION_RUN_TIMELINE_DETAIL_LENGTH
    ? `${entry.detail.slice(0, MAX_AUTOMATION_RUN_TIMELINE_DETAIL_LENGTH)}…`
    : entry.detail;
  return `${label} · ${detail}`;
}

export function formatAutomationRunTimestamp(value: string | undefined): string {
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
    minute: "2-digit",
    second: "2-digit"
  });
}

export function describeAutomationRunOutcome(record: AutomationRunRecord): string {
  if (record.error) {
    return record.error;
  }
  if (record.latestVerification?.summary) {
    const proposalSuffix = readRecoveryProposalSuffix(record.latestVerification);
    return proposalSuffix
      ? `${record.latestVerification.summary}${proposalSuffix}`
      : record.latestVerification.summary;
  }
  if (record.state === "queued") {
    return "等待并发槽位。";
  }
  if (record.state === "running") {
    return `第 ${record.attempt}/${record.maxAttempts} 次观察进行中。`;
  }
  if (record.state === "waiting") {
    return record.nextAction === "wait-for-approval"
      ? "等待审批。"
      : `第 ${record.attempt}/${record.maxAttempts} 次尝试失败，等待重试。`;
  }
  if (record.state === "attention") {
    return "需要人工复核。";
  }
  if (record.state === "completed") {
    return "只读观察完成。";
  }
  if (record.state === "cancelled") {
    return record.cancellation
      ? `已被${readAutomationRunCancellationSourceLabel(record.cancellation.requestedBy)}停止。`
      : "已停止。";
  }
  if (record.state === "expired") {
    return "运行超时未完成。";
  }
  return "—";
}

function readRecoveryProposalSuffix(
  verification: AutomationRunVerification
): string {
  const proposals = verification.recoveryProposals;
  if (!proposals || proposals.length === 0) {
    return "";
  }
  const mutatingCount = proposals.filter((proposal) => proposal.mutatesSession).length;
  return ` · ${proposals.length} 个恢复建议待审批（${mutatingCount} 个会修改会话）。`;
}

function readAutomationRunCancellationSourceLabel(
  source: AutomationRunCancellationSource
): string {
  switch (source) {
    case "pet":
      return "桌宠";
    case "dashboard":
      return "面板";
    case "cli":
      return "CLI";
    case "mcp":
      return "MCP";
    default:
      return source;
  }
}
