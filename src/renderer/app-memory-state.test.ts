import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT,
  DEFAULT_PERSONAL_MEMORY_SETTINGS,
  createPersonalMemoryFeedback,
  describePersonalMemoryAction,
  formatMemoryUsage,
  formatPersonalMemoryTimestamp,
  readMemoryUsageTone
} from "./app-memory-state";

describe("app memory state", () => {
  it("exposes a stable empty dashboard snapshot", () => {
    expect(DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT).toEqual({
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
    });
    expect(DEFAULT_PERSONAL_MEMORY_SETTINGS).toEqual({
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    });
  });

  it("creates feedback with a tone", () => {
    expect(createPersonalMemoryFeedback("success", "已忘记该条记忆。")).toEqual({
      tone: "success",
      message: "已忘记该条记忆。"
    });
  });

  it("classifies memory usage by percent thresholds", () => {
    expect(readMemoryUsageTone(0)).toBe("success");
    expect(readMemoryUsageTone(69)).toBe("success");
    expect(readMemoryUsageTone(70)).toBe("warning");
    expect(readMemoryUsageTone(89)).toBe("warning");
    expect(readMemoryUsageTone(90)).toBe("danger");
    expect(readMemoryUsageTone(100)).toBe("danger");
  });

  it("formats memory usage and timestamps", () => {
    expect(formatMemoryUsage({ usedChars: 46, limitChars: 1375 })).toBe("46/1,375 chars");
    expect(formatPersonalMemoryTimestamp(undefined)).toBe("—");
    expect(formatPersonalMemoryTimestamp("not-a-date")).toBe("—");
    expect(formatPersonalMemoryTimestamp("2026-08-20T09:00:00.000Z")).toMatch(/08\/20/);
  });

  it("describes memory actions in the panel language", () => {
    expect(describePersonalMemoryAction("add", "user")).toBe("添加用户偏好");
    expect(describePersonalMemoryAction("replace", "agent")).toBe("替换Agent 备注");
    expect(describePersonalMemoryAction("remove", "user")).toBe("移除用户偏好");
  });
});
