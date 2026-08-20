import type { RiskDecision } from "../../shared/types.js";
import {
  readNextBackoffDelayMs,
  type AutomationRunConfig
} from "../automation-run.js";
import {
  checkTmuxRecoveryBudget,
  createTmuxRecoveryBudget,
  describeTmuxRecoveryAction,
  readTmuxRecoveryRisk,
  recordTmuxRecoveryAttempt,
  type TmuxRecoveryAction,
  type TmuxRecoveryBudget,
  type TmuxRecoveryOutcome
} from "../computer-use/tmux-recovery.js";
import type { TmuxSupervisionReport } from "../computer-use/tmux-supervisor.js";

/**
 * tmux recovery orchestrator task. Mirrors the supervision task lifecycle
 * (started -> approval_required -> executing -> terminal) but is a SEPARATE
 * task with its own approval gate: observation approval never implies
 * recovery approval.
 */

export interface TmuxRecoveryTaskClient {
  sendInput(actionId: string, paneId: string, keys: string): Promise<TmuxRecoveryOutcome>;
  restartStep(
    actionId: string,
    stepId: string,
    target: { sessionName: string; paneId?: string }
  ): Promise<TmuxRecoveryOutcome>;
  collectSummary(
    actionId: string,
    paneId: string,
    maxTailCharacters: number
  ): Promise<TmuxRecoveryOutcome>;
}

export type TmuxRecoveryTaskEvent =
  | {
      type: "recovery_started";
      action: TmuxRecoveryAction;
      risk: RiskDecision;
    }
  | {
      type: "approval_required";
      action: TmuxRecoveryAction;
      risk: RiskDecision;
    }
  | {
      type: "executing";
      action: TmuxRecoveryAction;
      attempt: number;
    }
  | {
      type: "completed";
      action: TmuxRecoveryAction;
      outcome: TmuxRecoveryOutcome;
      summary: string;
      budget: TmuxRecoveryBudget;
    }
  | {
      type: "failed";
      action: TmuxRecoveryAction;
      outcome: TmuxRecoveryOutcome;
      summary: string;
      budget: TmuxRecoveryBudget;
    }
  | {
      type: "budget_exhausted";
      action: TmuxRecoveryAction;
      reason: string;
      budget: TmuxRecoveryBudget;
    }
  | {
      type: "verification_failed";
      stage: "tmux-recovery";
      reason: string;
    };

export type TmuxRecoveryBackoffConfig = Pick<
  AutomationRunConfig,
  "backoffMs" | "backoffMultiplier" | "maxBackoffMs"
>;

export interface TmuxRecoveryTaskOptions {
  approved?: boolean;
  budget?: TmuxRecoveryBudget;
  /** Session target for restart_step (the action itself only carries a stepId). */
  sessionName?: string;
  now?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  backoff?: TmuxRecoveryBackoffConfig;
  prng?: () => number;
}

const DEFAULT_BACKOFF: TmuxRecoveryBackoffConfig = {
  backoffMs: 1_000,
  backoffMultiplier: 2,
  maxBackoffMs: 30_000
};

export async function* runTmuxRecoveryTask(
  action: TmuxRecoveryAction,
  client: TmuxRecoveryTaskClient,
  options: TmuxRecoveryTaskOptions = {}
): AsyncGenerator<TmuxRecoveryTaskEvent> {
  const risk = readTmuxRecoveryRisk(action);

  yield {
    type: "recovery_started",
    action,
    risk
  };

  if (!options.approved) {
    yield {
      type: "approval_required",
      action,
      risk
    };
    return;
  }

  const now = options.now ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? (async (delayMs: number) => {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  });
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let budget = options.budget ?? createTmuxRecoveryBudget();

  while (true) {
    const budgetCheck = checkTmuxRecoveryBudget(budget, action.actionId, now());
    if (!budgetCheck.ok) {
      yield {
        type: "budget_exhausted",
        action,
        reason: budgetCheck.reason,
        budget
      };
      return;
    }

    const attempt = (budget.attempts[action.actionId] ?? 0) + 1;
    yield {
      type: "executing",
      action,
      attempt
    };

    let outcome: TmuxRecoveryOutcome;
    try {
      outcome = await executeRecoveryAction(action, client, options.sessionName);
    } catch (error) {
      yield {
        type: "verification_failed",
        stage: "tmux-recovery",
        reason: error instanceof Error ? error.message : "tmux recovery failed."
      };
      return;
    }

    budget = recordTmuxRecoveryAttempt(budget, action.actionId, now());

    if (outcome.ok) {
      yield {
        type: "completed",
        action,
        outcome,
        summary: `tmux recovery ${describeTmuxRecoveryAction(action)} completed.`,
        budget
      };
      return;
    }

    if (!outcome.retryable) {
      yield {
        type: "failed",
        action,
        outcome,
        summary: `tmux recovery ${describeTmuxRecoveryAction(action)} failed: ${outcome.error}`,
        budget
      };
      return;
    }

    // Retryable failure: reuses the automation-run backoff semantics, then
    // loops so the budget check emits budget_exhausted once attempts run out.
    const delayMs = readNextBackoffDelayMs(
      budget.attempts[action.actionId] ?? 1,
      backoff,
      options.prng
    );
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

async function executeRecoveryAction(
  action: TmuxRecoveryAction,
  client: TmuxRecoveryTaskClient,
  sessionName: string | undefined
): Promise<TmuxRecoveryOutcome> {
  switch (action.kind) {
    case "send_input":
      return client.sendInput(action.actionId, action.paneId, action.keys);
    case "restart_step":
      return client.restartStep(action.actionId, action.stepId, {
        sessionName: sessionName ?? "money-run"
      });
    case "collect_summary":
      return client.collectSummary(
        action.actionId,
        action.paneId,
        action.maxTailCharacters
      );
  }
}

/**
 * Render the recovery proposals carried by a read-only supervision report.
 * Used by the task-event view so proposals are surfaced where the report is
 * shown, without the observation path gaining any mutating capability.
 */
export function formatTmuxRecoveryProposals(report: TmuxSupervisionReport): string {
  if (report.recoveryProposals.length === 0) {
    return "";
  }
  const lines = report.recoveryProposals.map(
    (proposal) =>
      `${proposal.proposalId}: ${describeTmuxRecoveryAction(proposal.action)} (${proposal.risk.level}) — ${proposal.reason}`
  );
  return [
    `${report.recoveryProposals.length} recovery proposal(s) available (explicit approval required):`,
    ...lines
  ].join("\n");
}
