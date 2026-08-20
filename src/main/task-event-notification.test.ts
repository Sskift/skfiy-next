import { describe, expect, it } from "vitest";
import {
  createTaskEventNotificationCoordinator,
  type TaskEventNotificationStatus
} from "./task-event-notification";

const STATUSES: TaskEventNotificationStatus[] = [
  "approval_required",
  "needs_confirmation",
  "needs_clarification",
  "completed",
  "failed",
  "blocked"
];

describe("task event notification coordinator", () => {
  it("creates status-only notices without task content", () => {
    const coordinator = createTaskEventNotificationCoordinator();

    expect(coordinator.take({
      taskId: "task-1",
      status: "approval_required"
    }, { windowFocused: false })).toEqual({
      taskId: "task-1",
      status: "approval_required",
      title: "Approval requested",
      body: "A task is waiting for your approval in skfiy."
    });
    expect(coordinator.take({
      taskId: "task-2",
      status: "needs_confirmation"
    }, { windowFocused: false })).toMatchObject({
      title: "Approval requested",
      body: "A task is waiting for your approval in skfiy."
    });
    expect(coordinator.take({
      taskId: "task-3",
      status: "needs_clarification"
    }, { windowFocused: false })).toMatchObject({
      title: "Approval requested",
      body: "A task is waiting for your approval in skfiy."
    });
    expect(coordinator.take({
      taskId: "task-4",
      status: "completed"
    }, { windowFocused: false })).toMatchObject({
      title: "Task completed",
      body: "A task finished in skfiy."
    });
    expect(coordinator.take({
      taskId: "task-5",
      status: "failed"
    }, { windowFocused: false })).toMatchObject({
      title: "Task failed",
      body: "A task failed in skfiy. Open to review."
    });
    expect(coordinator.take({
      taskId: "task-6",
      status: "blocked"
    }, { windowFocused: false })).toMatchObject({
      title: "Task blocked",
      body: "A task is blocked in skfiy. Open to review."
    });
  });

  it("suppresses focused and duplicate notices", () => {
    const coordinator = createTaskEventNotificationCoordinator();
    const event = { taskId: "task-1", status: "completed" } as const;

    expect(coordinator.take(event, { windowFocused: true })).toBeNull();
    expect(coordinator.take(event, { windowFocused: false })).not.toBeNull();
    expect(coordinator.take(event, { windowFocused: false })).toBeNull();
  });

  it("dedupes by taskId and status together", () => {
    const coordinator = createTaskEventNotificationCoordinator();

    expect(coordinator.take({
      taskId: "task-1",
      status: "completed"
    }, { windowFocused: false })).not.toBeNull();
    expect(coordinator.take({
      taskId: "task-1",
      status: "completed"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: "task-1",
      status: "failed"
    }, { windowFocused: false })).not.toBeNull();
    expect(coordinator.take({
      taskId: "task-2",
      status: "completed"
    }, { windowFocused: false })).not.toBeNull();
  });

  it("evicts oldest dedupe entries past the LRU bound", () => {
    const coordinator = createTaskEventNotificationCoordinator({ maxRemembered: 2 });

    expect(coordinator.take({
      taskId: "task-1",
      status: "completed"
    }, { windowFocused: false })).not.toBeNull();
    expect(coordinator.take({
      taskId: "task-2",
      status: "completed"
    }, { windowFocused: false })).not.toBeNull();
    expect(coordinator.take({
      taskId: "task-3",
      status: "completed"
    }, { windowFocused: false })).not.toBeNull();
    expect(coordinator.take({
      taskId: "task-1",
      status: "completed"
    }, { windowFocused: false })).not.toBeNull();
  });

  it("fails closed for arbitrary payloads", () => {
    const coordinator = createTaskEventNotificationCoordinator();

    expect(coordinator.take(null, { windowFocused: false })).toBeNull();
    expect(coordinator.take("task-1", { windowFocused: false })).toBeNull();
    expect(coordinator.take([], { windowFocused: false })).toBeNull();
    expect(coordinator.take({}, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: "task-1",
      status: "running"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: "task-1",
      status: "completed",
      message: "secret page text"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: "task-1",
      status: "completed",
      command: "rm -rf /"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: "task-1",
      status: "completed",
      route: "https://evil.example/path"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: "task-1",
      status: "completed",
      url: "https://evil.example/path"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: "task-1",
      status: "completed",
      paneOutput: "token=secret"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: 42,
      status: "completed"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: "  ",
      status: "completed"
    }, { windowFocused: false })).toBeNull();
    expect(coordinator.take({
      taskId: "x".repeat(241),
      status: "completed"
    }, { windowFocused: false })).toBeNull();
  });

  it.each(STATUSES)("never interpolates task content for %s notices", (status) => {
    const coordinator = createTaskEventNotificationCoordinator();
    const notice = coordinator.take({
      taskId: "task-content",
      status
    }, { windowFocused: false });

    expect(notice).not.toBeNull();
    const copy = `${notice?.title ?? ""} ${notice?.body ?? ""}`;
    expect(copy).not.toContain("secret page text");
    expect(copy).not.toContain("rm -rf");
    expect(copy).not.toContain("evil.example");
    expect(copy).not.toContain("token=secret");
    expect(copy).not.toContain("/Users/");
  });
});
