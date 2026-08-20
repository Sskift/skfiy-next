import { describe, expect, it } from "vitest";
import {
  runTmuxRecoveryTask,
  type TmuxRecoveryTaskClient
} from "./tmux-recovery-task";
import {
  createTmuxRecoveryBudget,
  type TmuxRecoveryAction,
  type TmuxRecoveryOutcome
} from "../computer-use/tmux-recovery";

const SEND_INPUT: TmuxRecoveryAction = {
  kind: "send_input",
  actionId: "money-run:send_input:%11",
  paneId: "%11",
  keys: "y"
};

const COLLECT_SUMMARY: TmuxRecoveryAction = {
  kind: "collect_summary",
  actionId: "money-run:collect_summary:%11",
  paneId: "%11",
  maxTailCharacters: 100
};

function outcome(fields: {
  ok: true;
  result?: string;
  actionId?: string;
} | {
  ok: false;
  error?: string;
  retryable?: boolean;
  actionId?: string;
}): TmuxRecoveryOutcome {
  const at = "2026-08-19T00:00:00.000Z";
  if (fields.ok) {
    return {
      ok: true,
      actionId: fields.actionId ?? "a",
      at,
      result: fields.result ?? "done"
    };
  }
  return {
    ok: false,
    actionId: fields.actionId ?? "a",
    at,
    error: fields.error ?? "failed",
    retryable: fields.retryable ?? false
  };
}

function createClient(
  impl: Partial<TmuxRecoveryTaskClient>
): TmuxRecoveryTaskClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sendInput: async (actionId) => {
      calls.push(`sendInput:${actionId}`);
      return impl.sendInput?.(actionId, "%11", "y") ?? outcome({ ok: true });
    },
    restartStep: async (actionId) => {
      calls.push(`restartStep:${actionId}`);
      return impl.restartStep?.(actionId, "restart-money-run", { sessionName: "money-run" })
        ?? outcome({ ok: true });
    },
    collectSummary: async (actionId) => {
      calls.push(`collectSummary:${actionId}`);
      return impl.collectSummary?.(actionId, "%11", 100) ?? outcome({ ok: true });
    }
  };
}

async function collect<T>(events: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

describe("runTmuxRecoveryTask", () => {
  it("requests approval before any client call", async () => {
    const client = createClient({
      sendInput: async () => {
        throw new Error("should not send input before approval");
      }
    });

    const events = await collect(runTmuxRecoveryTask(SEND_INPUT, client));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "recovery_started" });
    expect(events[1]).toMatchObject({ type: "approval_required" });
    expect(client.calls).toEqual([]);
  });

  it("executes and completes on approval", async () => {
    const client = createClient({
      sendInput: async () => outcome({ ok: true, result: "sent" })
    });

    const events = await collect(runTmuxRecoveryTask(SEND_INPUT, client, {
      approved: true,
      now: () => "2026-08-19T00:00:00.000Z",
      sleep: async () => undefined
    }));

    expect(events.map((event) => event.type)).toEqual([
      "recovery_started",
      "executing",
      "completed"
    ]);
    expect(events[0]).toMatchObject({
      type: "recovery_started",
      risk: { level: "high", requiresApproval: true }
    });
    expect(events[1]).toMatchObject({ type: "executing", attempt: 1 });
    const completed = events[2];
    expect(completed).toMatchObject({
      type: "completed",
      outcome: { ok: true, result: "sent" }
    });
    if (completed?.type === "completed") {
      expect(completed.budget.attempts[SEND_INPUT.actionId]).toBe(1);
    }
    expect(client.calls).toEqual([`sendInput:${SEND_INPUT.actionId}`]);
  });

  it("emits budget_exhausted after maxRetriesPerAction attempts", async () => {
    const client = createClient({
      sendInput: async () => outcome({ ok: false, error: "transient", retryable: true })
    });

    const events = await collect(runTmuxRecoveryTask(SEND_INPUT, client, {
      approved: true,
      budget: createTmuxRecoveryBudget({ maxRetriesPerAction: 2 }),
      now: () => "2026-08-19T00:00:00.000Z",
      sleep: async () => undefined,
      prng: () => 0.5
    }));

    expect(events.map((event) => event.type)).toEqual([
      "recovery_started",
      "executing",
      "executing",
      "budget_exhausted"
    ]);
    expect(events[3]).toMatchObject({ type: "budget_exhausted" });
    expect(client.calls).toHaveLength(2);
  });

  it("emits failed for non-retryable outcomes without retrying", async () => {
    const client = createClient({
      sendInput: async () => outcome({ ok: false, error: "fatal", retryable: false })
    });

    const events = await collect(runTmuxRecoveryTask(SEND_INPUT, client, {
      approved: true,
      now: () => "2026-08-19T00:00:00.000Z",
      sleep: async () => undefined
    }));

    expect(events.map((event) => event.type)).toEqual([
      "recovery_started",
      "executing",
      "failed"
    ]);
    expect(client.calls).toHaveLength(1);
  });

  it("emits verification_failed when the client throws", async () => {
    const client = createClient({
      sendInput: async () => {
        throw new Error("tmux binary missing");
      }
    });

    const events = await collect(runTmuxRecoveryTask(SEND_INPUT, client, {
      approved: true,
      now: () => "2026-08-19T00:00:00.000Z",
      sleep: async () => undefined
    }));

    expect(events.map((event) => event.type)).toEqual([
      "recovery_started",
      "executing",
      "verification_failed"
    ]);
    expect(events[2]).toMatchObject({
      type: "verification_failed",
      stage: "tmux-recovery",
      reason: "tmux binary missing"
    });
  });

  it("completes the collect_summary path with a bounded result", async () => {
    const client = createClient({
      collectSummary: async () => outcome({ ok: true, result: "x".repeat(100) })
    });

    const events = await collect(runTmuxRecoveryTask(COLLECT_SUMMARY, client, {
      approved: true,
      now: () => "2026-08-19T00:00:00.000Z",
      sleep: async () => undefined
    }));

    expect(events.map((event) => event.type)).toEqual([
      "recovery_started",
      "executing",
      "completed"
    ]);
    expect(events[0]).toMatchObject({
      type: "recovery_started",
      risk: { level: "medium" }
    });
    const completed = events[2];
    if (completed?.type === "completed") {
      expect(completed.outcome).toMatchObject({ ok: true });
      if (completed.outcome.ok) {
        expect(completed.outcome.result).toHaveLength(100);
      }
    }
    expect(client.calls).toEqual([`collectSummary:${COLLECT_SUMMARY.actionId}`]);
  });

  it("passes the session name to restart_step", async () => {
    const restart: TmuxRecoveryAction = {
      kind: "restart_step",
      actionId: "money-run:restart_step:restart-money-run",
      stepId: "restart-money-run"
    };
    const seenTargets: string[] = [];
    const client: TmuxRecoveryTaskClient = {
      sendInput: async () => outcome({ ok: true }),
      restartStep: async (_actionId, _stepId, target) => {
        seenTargets.push(target.sessionName);
        return outcome({ ok: true });
      },
      collectSummary: async () => outcome({ ok: true })
    };

    const events = await collect(runTmuxRecoveryTask(restart, client, {
      approved: true,
      sessionName: "money-run-goal",
      now: () => "2026-08-19T00:00:00.000Z",
      sleep: async () => undefined
    }));

    expect(events.map((event) => event.type)).toEqual([
      "recovery_started",
      "executing",
      "completed"
    ]);
    expect(seenTargets).toEqual(["money-run-goal"]);
  });
});
