import { describe, expect, it } from "vitest";
import {
  boundRecoveryString,
  checkTmuxRecoveryBudget,
  createTmuxRecoveryBudget,
  createTmuxRecoveryProposals,
  DEFAULT_APPROVAL_RESPONSE_KEYS,
  DEFAULT_TMUX_RECOVERY_STEP_CATALOG,
  describeTmuxRecoveryAction,
  MAX_RECOVERY_KEYS,
  MAX_SUMMARY_CHARACTERS,
  parseTmuxRecoveryAction,
  readTmuxRecoveryRisk,
  recordTmuxRecoveryAttempt,
  type TmuxRecoveryStepCatalog
} from "./tmux-recovery";
import type { TmuxSignal } from "./tmux-supervisor";

const catalog: TmuxRecoveryStepCatalog = {
  "restart-money-run": "npm run money-run",
  "restart-money-run-worker": "npm run money-run:worker"
};

function signal(partial: Partial<TmuxSignal> & Pick<TmuxSignal, "type" | "severity">): TmuxSignal {
  return {
    message: "signal",
    ...partial
  } as TmuxSignal;
}

describe("createTmuxRecoveryProposals", () => {
  it("maps approval-needed signals to a bounded send_input proposal", () => {
    const proposals = createTmuxRecoveryProposals({
      sessionName: "money-run",
      catalog,
      signals: [
        signal({
          type: "approval-needed",
          severity: "attention",
          paneId: "%11",
          matchedText: "allow this command"
        })
      ]
    });

    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.signalType).toBe("approval-needed");
    expect(proposal.action).toEqual({
      kind: "send_input",
      actionId: "money-run:send_input:%11",
      paneId: "%11",
      keys: DEFAULT_APPROVAL_RESPONSE_KEYS
    });
    expect(proposal.mutatesSession).toBe(true);
    expect(proposal.risk.level).toBe("high");
    expect(proposal.proposalId).toBe(proposal.action.actionId);
  });

  it("maps dead-pane and no-session signals to catalog restart_step proposals", () => {
    const proposals = createTmuxRecoveryProposals({
      sessionName: "money-run",
      catalog,
      restartStepId: "restart-money-run-worker",
      signals: [
        signal({ type: "dead-pane", severity: "blocked", paneId: "%12" }),
        signal({ type: "no-session", severity: "blocked" })
      ]
    });

    expect(proposals).toHaveLength(2);
    expect(proposals[0]!.action).toEqual({
      kind: "restart_step",
      actionId: "money-run:restart_step:restart-money-run-worker",
      stepId: "restart-money-run-worker"
    });
    expect(proposals[0]!.mutatesSession).toBe(true);
    expect(proposals[0]!.risk.level).toBe("high");
    expect(proposals[1]!.action.kind).toBe("restart_step");
  });

  it("omits restart_step proposals when the stepId is not in the catalog", () => {
    const proposals = createTmuxRecoveryProposals({
      sessionName: "money-run",
      catalog,
      restartStepId: "not-registered",
      signals: [
        signal({ type: "dead-pane", severity: "blocked", paneId: "%12" })
      ]
    });

    expect(proposals).toEqual([]);
  });

  it("maps error-marker signals to a read-only collect_summary proposal", () => {
    const proposals = createTmuxRecoveryProposals({
      sessionName: "money-run",
      catalog,
      signals: [
        signal({
          type: "error-marker",
          severity: "attention",
          paneId: "%13",
          matchedText: "Traceback"
        })
      ]
    });

    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.action).toEqual({
      kind: "collect_summary",
      actionId: "money-run:collect_summary:%13",
      paneId: "%13",
      maxTailCharacters: MAX_SUMMARY_CHARACTERS
    });
    expect(proposal.mutatesSession).toBe(false);
    expect(proposal.risk.level).toBe("medium");
  });

  it("does not propose recovery for observing-only signals", () => {
    const proposals = createTmuxRecoveryProposals({
      sessionName: "money-run",
      catalog,
      signals: [
        signal({ type: "stalled", severity: "attention", paneId: "%14" }),
        signal({ type: "waiting", severity: "attention", paneId: "%14" }),
        signal({ type: "completed", severity: "attention", paneId: "%14" }),
        signal({ type: "no-active-pane", severity: "blocked" })
      ]
    });

    expect(proposals).toEqual([]);
  });

  it("caps the number of proposals per report", () => {
    const signals = Array.from({ length: 10 }, (_, index) =>
      signal({
        type: "approval-needed",
        severity: "attention",
        paneId: `%${index}`
      })
    );

    const proposals = createTmuxRecoveryProposals({
      sessionName: "money-run",
      catalog,
      signals
    });

    expect(proposals.length).toBeLessThanOrEqual(4);
  });

  it("bounds a custom approval response to the max key length", () => {
    const proposals = createTmuxRecoveryProposals({
      sessionName: "money-run",
      catalog,
      approvalResponse: "y".repeat(MAX_RECOVERY_KEYS + 50),
      signals: [
        signal({ type: "approval-needed", severity: "attention", paneId: "%11" })
      ]
    });

    const action = proposals[0]!.action;
    expect(action.kind).toBe("send_input");
    if (action.kind === "send_input") {
      expect(action.keys).toHaveLength(MAX_RECOVERY_KEYS);
    }
  });
});

describe("readTmuxRecoveryRisk", () => {
  it("rates mutating actions high and collect_summary medium", () => {
    expect(readTmuxRecoveryRisk({
      kind: "send_input",
      actionId: "a",
      paneId: "%1",
      keys: "y"
    }).level).toBe("high");
    expect(readTmuxRecoveryRisk({
      kind: "restart_step",
      actionId: "a",
      stepId: "restart-money-run"
    }).level).toBe("high");
    expect(readTmuxRecoveryRisk({
      kind: "collect_summary",
      actionId: "a",
      paneId: "%1",
      maxTailCharacters: 100
    }).level).toBe("medium");
  });
});

describe("describeTmuxRecoveryAction", () => {
  it("describes each action kind", () => {
    expect(describeTmuxRecoveryAction({
      kind: "send_input",
      actionId: "a",
      paneId: "%1",
      keys: "y"
    })).toBe("send_input to %1");
    expect(describeTmuxRecoveryAction({
      kind: "restart_step",
      actionId: "a",
      stepId: "restart-money-run"
    })).toBe("restart_step restart-money-run");
    expect(describeTmuxRecoveryAction({
      kind: "collect_summary",
      actionId: "a",
      paneId: "%1",
      maxTailCharacters: 100
    })).toBe("collect_summary from %1");
  });
});

describe("checkTmuxRecoveryBudget", () => {
  it("allows the first attempt with a fresh budget", () => {
    const budget = createTmuxRecoveryBudget();
    expect(checkTmuxRecoveryBudget(budget, "money-run:send_input:%1", "2026-08-19T00:00:00.000Z"))
      .toEqual({ ok: true });
  });

  it("rejects when attempts reach maxRetriesPerAction", () => {
    const budget = createTmuxRecoveryBudget({ maxRetriesPerAction: 2 });
    const once = recordTmuxRecoveryAttempt(budget, "a", "2026-08-19T00:00:00.000Z");
    const twice = recordTmuxRecoveryAttempt(once, "a", "2026-08-19T00:00:01.000Z");

    expect(checkTmuxRecoveryBudget(twice, "a", "2026-08-19T00:00:02.000Z").ok).toBe(false);
  });

  it("tracks attempt counts independently per action", () => {
    let budget = createTmuxRecoveryBudget({ maxRetriesPerAction: 1 });
    budget = recordTmuxRecoveryAttempt(budget, "a", "2026-08-19T00:00:00.000Z");

    expect(checkTmuxRecoveryBudget(budget, "a", "2026-08-19T00:00:01.000Z").ok).toBe(false);
    expect(checkTmuxRecoveryBudget(budget, "b", "2026-08-19T00:00:01.000Z").ok).toBe(true);
  });

  it("rejects when the max duration elapsed", () => {
    const budget = createTmuxRecoveryBudget({
      maxDurationMs: 1_000,
      startedAt: "2026-08-19T00:00:00.000Z"
    });

    expect(checkTmuxRecoveryBudget(budget, "a", "2026-08-19T00:00:02.000Z").ok).toBe(false);
    expect(checkTmuxRecoveryBudget(budget, "a", "2026-08-19T00:00:00.500Z").ok).toBe(true);
  });

  it("enforces cost only when both cost fields are defined", () => {
    const withoutCost = createTmuxRecoveryBudget();
    expect(checkTmuxRecoveryBudget(withoutCost, "a", "2026-08-19T00:00:00.000Z").ok).toBe(true);

    const overCost = createTmuxRecoveryBudget({ maxCostUsd: 1, spentCostUsd: 1 });
    expect(checkTmuxRecoveryBudget(overCost, "a", "2026-08-19T00:00:00.000Z").ok).toBe(false);

    const underCost = createTmuxRecoveryBudget({ maxCostUsd: 2, spentCostUsd: 1 });
    expect(checkTmuxRecoveryBudget(underCost, "a", "2026-08-19T00:00:00.000Z").ok).toBe(true);
  });

  it("stamps startedAt on the first recorded attempt", () => {
    const budget = createTmuxRecoveryBudget();
    expect(budget.startedAt).toBeUndefined();

    const recorded = recordTmuxRecoveryAttempt(budget, "a", "2026-08-19T00:00:00.000Z");
    expect(recorded.startedAt).toBe("2026-08-19T00:00:00.000Z");
    expect(budget.startedAt).toBeUndefined();
  });
});

describe("parseTmuxRecoveryAction", () => {
  it("accepts a bounded send_input action", () => {
    expect(parseTmuxRecoveryAction({
      kind: "send_input",
      actionId: "a",
      paneId: "%1",
      keys: "y"
    }, catalog)).toEqual({
      kind: "send_input",
      actionId: "a",
      paneId: "%1",
      keys: "y"
    });
  });

  it("rejects over-long keys", () => {
    expect(parseTmuxRecoveryAction({
      kind: "send_input",
      actionId: "a",
      paneId: "%1",
      keys: "y".repeat(MAX_RECOVERY_KEYS + 1)
    }, catalog)).toBeUndefined();
  });

  it("rejects restart_step for unknown stepIds", () => {
    expect(parseTmuxRecoveryAction({
      kind: "restart_step",
      actionId: "a",
      stepId: "rm -rf /"
    }, catalog)).toBeUndefined();
  });

  it("accepts restart_step for catalog stepIds", () => {
    expect(parseTmuxRecoveryAction({
      kind: "restart_step",
      actionId: "a",
      stepId: "restart-money-run"
    }, catalog)).toEqual({
      kind: "restart_step",
      actionId: "a",
      stepId: "restart-money-run"
    });
  });

  it("rejects collect_summary beyond the max tail", () => {
    expect(parseTmuxRecoveryAction({
      kind: "collect_summary",
      actionId: "a",
      paneId: "%1",
      maxTailCharacters: MAX_SUMMARY_CHARACTERS + 1
    }, catalog)).toBeUndefined();
  });

  it("rejects malformed input", () => {
    expect(parseTmuxRecoveryAction(null, catalog)).toBeUndefined();
    expect(parseTmuxRecoveryAction("send_input", catalog)).toBeUndefined();
    expect(parseTmuxRecoveryAction({ kind: "send_input" }, catalog)).toBeUndefined();
    expect(parseTmuxRecoveryAction({
      kind: "exec",
      actionId: "a",
      command: "echo hi"
    }, catalog)).toBeUndefined();
  });
});

describe("boundRecoveryString", () => {
  it("keeps the tail when truncating", () => {
    expect(boundRecoveryString("abcdef", 3)).toBe("def");
    expect(boundRecoveryString("abc", 10)).toBe("abc");
  });
});

describe("DEFAULT_TMUX_RECOVERY_STEP_CATALOG", () => {
  it("registers the default money-run restart steps", () => {
    expect(DEFAULT_TMUX_RECOVERY_STEP_CATALOG["restart-money-run"]).toBe("npm run money-run");
  });
});
