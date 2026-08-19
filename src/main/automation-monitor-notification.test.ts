import { describe, expect, it } from "vitest";
import { createAutomationMonitorNotificationCoordinator } from "./automation-monitor-notification";

describe("automation monitor notification coordinator", () => {
  it("creates compact outcome-specific notices without run output or errors", () => {
    const coordinator = createAutomationMonitorNotificationCoordinator();

    expect(coordinator.take({
      runId: "tmux-session:money-run-goal:run:1",
      label: "money-run goal",
      outcome: "attention"
    }, { windowFocused: false })).toEqual({
      runId: "tmux-session:money-run-goal:run:1",
      outcome: "attention",
      title: "Automation needs attention",
      body: "money-run goal found a result to review in skfiy."
    });
    expect(coordinator.take({
      runId: "tmux-session:money-run-goal:run:2",
      label: "money-run goal",
      outcome: "completed"
    }, { windowFocused: false })).toMatchObject({
      title: "Automation completed",
      body: "money-run goal completed its read-only check."
    });
    expect(coordinator.take({
      runId: "tmux-session:money-run-goal:run:3",
      label: "money-run goal",
      outcome: "failure"
    }, { windowFocused: false })).toMatchObject({
      title: "Automation check failed",
      body: "money-run goal could not complete its read-only check. Open skfiy to review."
    });
  });

  it("suppresses focused and duplicate notices", () => {
    const coordinator = createAutomationMonitorNotificationCoordinator();
    const event = {
      runId: "tmux-session:money-run-goal:run:1",
      label: "money-run goal",
      outcome: "completed"
    } as const;

    expect(coordinator.take(event, { windowFocused: true })).toBeNull();
    expect(coordinator.take(event, { windowFocused: false })).not.toBeNull();
    expect(coordinator.take(event, { windowFocused: false })).toBeNull();
  });

  it("fails closed for arbitrary payloads and bounds the displayed label", () => {
    const coordinator = createAutomationMonitorNotificationCoordinator();

    expect(coordinator.take({
      runId: "tmux-session:money-run-goal:run:1",
      label: "money-run goal",
      outcome: "failure",
      paneOutput: "token=secret"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      runId: "tmux-session:money-run-goal:run:2",
      label: `line one\n${"x".repeat(120)}`,
      outcome: "failure"
    }, { windowFocused: false })?.body).toBe(
      `${`line one ${"x".repeat(71)}`} could not complete its read-only check. Open skfiy to review.`
    );
  });
});
