import type {
  PersonalMemoryDashboardSnapshot,
  PersonalMemorySettings
} from "./app-types";

export const DEFAULT_PERSONAL_MEMORY_SETTINGS: PersonalMemorySettings = {
  postTurnLearningEnabled: true,
  writeApprovalEnabled: false
};

export const DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT: PersonalMemoryDashboardSnapshot = {
  schemaVersion: 1,
  userEntries: [],
  agentEntries: [],
  usage: {
    user: { usedChars: 0, limitChars: 1375, percent: 0 },
    agent: { usedChars: 0, limitChars: 2200, percent: 0 }
  },
  pendingWrites: [],
  journal: [],
  sessionCount: 0,
  settings: DEFAULT_PERSONAL_MEMORY_SETTINGS
};

export type PersonalMemoryFeedbackTone = "neutral" | "success" | "danger";

export interface PersonalMemoryFeedback {
  tone: PersonalMemoryFeedbackTone;
  message: string;
}

export function createPersonalMemoryFeedback(
  tone: PersonalMemoryFeedbackTone,
  message: string
): PersonalMemoryFeedback {
  return { tone, message };
}

export function readMemoryUsageTone(percent: number): "success" | "warning" | "danger" {
  if (percent >= 90) {
    return "danger";
  }
  if (percent >= 70) {
    return "warning";
  }
  return "success";
}

export function formatMemoryUsage(bucket: { usedChars: number; limitChars: number }): string {
  return `${formatInteger(bucket.usedChars)}/${formatInteger(bucket.limitChars)} chars`;
}

export function formatPersonalMemoryTimestamp(value: string | undefined): string {
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

export function describePersonalMemoryAction(
  action: "add" | "replace" | "remove",
  target: "user" | "agent"
): string {
  const actionLabel = action === "add"
    ? "添加"
    : action === "replace"
      ? "替换"
      : "移除";
  const targetLabel = target === "user" ? "用户偏好" : "Agent 备注";
  return `${actionLabel}${targetLabel}`;
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}
