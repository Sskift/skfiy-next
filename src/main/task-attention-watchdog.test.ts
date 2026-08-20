import { describe, expect, it, vi } from "vitest";
import {
  createTaskAttentionWatchdog,
  isTaskAttentionActiveStatus,
  isTaskAttentionTerminalStatus,
  type TaskAttentionScheduler
} from "./task-attention-watchdog";

interface FakeTimer {
  callback: () => void;
  ms: number;
}

function createFakeScheduler(): TaskAttentionScheduler & {
  timers: FakeTimer[];
  runNext: () => void;
  pendingCount: () => number;
} {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimeout(callback, ms) {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout(handle) {
      const index = timers.indexOf(handle as FakeTimer);
      if (index >= 0) timers.splice(index, 1);
    },
    runNext() {
      const timer = timers.shift();
      if (timer) timer.callback();
    },
    pendingCount() {
      return timers.length;
    }
  };
}

describe("task attention watchdog", () => {
  it("fires exactly one notice after the threshold for a long-running task", () => {
    const scheduler = createFakeScheduler();
    const onAttention = vi.fn();
    const watchdog = createTaskAttentionWatchdog({
      thresholdMs: 300_000,
      scheduler,
      onAttention
    });

    watchdog.start("task-1");
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.timers[0]?.ms).toBe(300_000);

    scheduler.runNext();
    expect(onAttention).toHaveBeenCalledTimes(1);
    expect(onAttention).toHaveBeenCalledWith("task-1");

    scheduler.runNext();
    expect(onAttention).toHaveBeenCalledTimes(1);
  });

  it("does not fire for tasks that terminate before the threshold", () => {
    const scheduler = createFakeScheduler();
    const onAttention = vi.fn();
    const watchdog = createTaskAttentionWatchdog({
      thresholdMs: 300_000,
      scheduler,
      onAttention
    });

    watchdog.start("task-1");
    watchdog.reset();
    expect(scheduler.pendingCount()).toBe(0);

    scheduler.runNext();
    expect(onAttention).not.toHaveBeenCalled();
  });

  it("resets on terminal event", () => {
    const scheduler = createFakeScheduler();
    const onAttention = vi.fn();
    const watchdog = createTaskAttentionWatchdog({
      thresholdMs: 300_000,
      scheduler,
      onAttention
    });

    watchdog.start("task-1");
    watchdog.reset();
    watchdog.start("task-1");
    expect(scheduler.pendingCount()).toBe(1);

    watchdog.reset();
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.runNext();
    expect(onAttention).not.toHaveBeenCalled();
  });

  it("resets on new task start", () => {
    const scheduler = createFakeScheduler();
    const onAttention = vi.fn();
    const watchdog = createTaskAttentionWatchdog({
      thresholdMs: 300_000,
      scheduler,
      onAttention
    });

    watchdog.start("task-1");
    const firstTimer = scheduler.timers[0];
    watchdog.start("task-2");
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.timers[0]).not.toBe(firstTimer);

    scheduler.runNext();
    expect(onAttention).toHaveBeenCalledTimes(1);
    expect(onAttention).toHaveBeenCalledWith("task-2");
  });

  it("never fires more than once per task id", () => {
    const scheduler = createFakeScheduler();
    const onAttention = vi.fn();
    const watchdog = createTaskAttentionWatchdog({
      thresholdMs: 300_000,
      scheduler,
      onAttention
    });

    watchdog.start("task-1");
    scheduler.runNext();
    expect(onAttention).toHaveBeenCalledTimes(1);

    watchdog.start("task-1");
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.runNext();
    expect(onAttention).toHaveBeenCalledTimes(1);
  });

  it("stop clears the timer and disarms the watchdog", () => {
    const scheduler = createFakeScheduler();
    const onAttention = vi.fn();
    const watchdog = createTaskAttentionWatchdog({
      thresholdMs: 300_000,
      scheduler,
      onAttention
    });

    watchdog.start("task-1");
    watchdog.stop();
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.runNext();
    expect(onAttention).not.toHaveBeenCalled();

    watchdog.start("task-2");
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("ignores invalid task ids", () => {
    const scheduler = createFakeScheduler();
    const onAttention = vi.fn();
    const watchdog = createTaskAttentionWatchdog({
      thresholdMs: 300_000,
      scheduler,
      onAttention
    });

    watchdog.start("");
    watchdog.start("   ");
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("classifies active and terminal statuses", () => {
    expect(isTaskAttentionActiveStatus("waiting")).toBe(true);
    expect(isTaskAttentionActiveStatus("running")).toBe(true);
    expect(isTaskAttentionActiveStatus("executing")).toBe(true);
    expect(isTaskAttentionActiveStatus("completed")).toBe(false);
    expect(isTaskAttentionTerminalStatus("completed")).toBe(true);
    expect(isTaskAttentionTerminalStatus("failed")).toBe(true);
    expect(isTaskAttentionTerminalStatus("blocked")).toBe(true);
    expect(isTaskAttentionTerminalStatus("cancelled")).toBe(true);
    expect(isTaskAttentionTerminalStatus("denied")).toBe(true);
    expect(isTaskAttentionTerminalStatus("running")).toBe(false);
  });
});
