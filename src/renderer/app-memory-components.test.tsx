import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PersonalMemoryDashboardSnapshot } from "./app-types";
import { MemoryControlCenterPanel } from "./app-memory-components";
import { createPersonalMemoryFeedback } from "./app-memory-state";

function createSnapshot(
  overrides: Partial<PersonalMemoryDashboardSnapshot> = {}
): PersonalMemoryDashboardSnapshot {
  return {
    schemaVersion: 1,
    userEntries: ["User prefers concise Chinese progress updates."],
    agentEntries: ["Verify packaged app smoke evidence."],
    usage: {
      user: { usedChars: 46, limitChars: 1375, percent: 3 },
      agent: { usedChars: 35, limitChars: 2200, percent: 1 }
    },
    pendingWrites: [
      {
        id: "pmw-1",
        createdAt: "2026-08-20T09:05:00.000Z",
        source: "post-turn-review",
        action: "add",
        target: "user",
        content: "User prefers dense dashboard surfaces."
      }
    ],
    journal: [
      {
        id: "pmj-1",
        createdAt: "2026-08-20T09:06:00.000Z",
        source: "post-turn-review",
        stage: "durable",
        turnId: "turn-1",
        providerLabel: "Codex",
        userInput: "以后进度短一点",
        action: "add",
        target: "user",
        content: "User prefers concise Chinese progress updates."
      }
    ],
    sessionCount: 4,
    latestUpdatedAt: "2026-08-20T09:06:00.000Z",
    settings: {
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    },
    ...overrides
  };
}

function createProps(
  overrides: Partial<Parameters<typeof MemoryControlCenterPanel>[0]> = {}
): Parameters<typeof MemoryControlCenterPanel>[0] {
  return {
    snapshot: createSnapshot(),
    feedback: null,
    actionPending: false,
    onRefresh: vi.fn(),
    onForget: vi.fn(),
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onUpdateSettings: vi.fn(),
    ...overrides
  };
}

describe("MemoryControlCenterPanel", () => {
  it("renders status chips with entry, session, and pending counts", () => {
    render(<MemoryControlCenterPanel {...createProps()} />);

    expect(screen.getByText(/用户偏好 1/)).toBeTruthy();
    expect(screen.getByText(/Agent 备注 1/)).toBeTruthy();
    expect(screen.getByText(/会话 4/)).toBeTruthy();
    expect(screen.getByText(/待审批 1/)).toBeTruthy();
    expect(screen.getByLabelText("记忆状态")).toBeTruthy();
  });

  it("renders both entry lists and forgets an entry on click", () => {
    const onForget = vi.fn();
    render(<MemoryControlCenterPanel {...createProps({ onForget })} />);

    fireEvent.click(screen.getByRole("button", {
      name: "忘记：User prefers concise Chinese progress updates."
    }));

    expect(onForget).toHaveBeenCalledWith("user", "User prefers concise Chinese progress updates.");
  });

  it("approves and rejects staged pending writes", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <MemoryControlCenterPanel {...createProps({ onApprove, onReject })} />
    );

    fireEvent.click(screen.getByRole("button", {
      name: "批准：User prefers dense dashboard surfaces."
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "拒绝：User prefers dense dashboard surfaces."
    }));

    expect(onApprove).toHaveBeenCalledWith("pmw-1");
    expect(onReject).toHaveBeenCalledWith("pmw-1");
  });

  it("hides the pending write list when there is nothing staged", () => {
    render(
      <MemoryControlCenterPanel
        {...createProps({ snapshot: createSnapshot({ pendingWrites: [] }) })}
      />
    );

    expect(screen.queryByLabelText("待审批记忆写入")).toBeNull();
  });

  it("toggles post-turn learning and write approval settings", () => {
    const onUpdateSettings = vi.fn();
    render(
      <MemoryControlCenterPanel {...createProps({ onUpdateSettings })} />
    );

    fireEvent.click(screen.getByRole("button", { name: "回合后学习开关" }));
    fireEvent.click(screen.getByRole("button", { name: "写入审批模式开关" }));

    expect(onUpdateSettings).toHaveBeenCalledWith({ postTurnLearningEnabled: false });
    expect(onUpdateSettings).toHaveBeenCalledWith({ writeApprovalEnabled: true });
  });

  it("renders the journal trail with stage and provider", () => {
    render(<MemoryControlCenterPanel {...createProps()} />);

    const trail = screen.getByLabelText("记忆变更记录");
    expect(trail.textContent).toContain("添加用户偏好");
    expect(trail.textContent).toContain("Codex");
    expect(trail.textContent).toContain("已写入");
    expect(trail.textContent).toContain("turn-1");
  });

  it("mirrors feedback through an aria-live line", () => {
    const { rerender } = render(<MemoryControlCenterPanel {...createProps()} />);

    const feedbackLine = screen.getByRole("paragraph");
    expect(feedbackLine.getAttribute("aria-live")).toBe("polite");
    expect(feedbackLine.textContent).toBe("");

    rerender(
      <MemoryControlCenterPanel
        {...createProps({
          feedback: createPersonalMemoryFeedback("success", "已忘记该条记忆。")
        })}
      />
    );

    expect(screen.getByText("已忘记该条记忆。")).toBeTruthy();
  });

  it("refreshes the snapshot on demand", () => {
    const onRefresh = vi.fn();
    render(<MemoryControlCenterPanel {...createProps({ onRefresh })} />);

    fireEvent.click(screen.getByRole("button", { name: "刷新记忆状态" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
