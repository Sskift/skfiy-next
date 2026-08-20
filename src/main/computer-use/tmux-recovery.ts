import type { RiskDecision } from "../../shared/types.js";
import type { TmuxSignal } from "./tmux-supervisor.js";

/**
 * tmux recovery — the pure, I/O-free layer of the recovery stack.
 *
 * Recovery is structurally separate from supervision: supervision only reads
 * (see tmux-supervisor.ts), while recovery proposes and executes a CLOSED set
 * of mutating actions. There is no arbitrary-shell path anywhere in this
 * module — send_input uses tmux literal mode, restart_step only runs commands
 * from a registered step catalog, and collect_summary is a bounded read.
 */

export const MAX_RECOVERY_KEYS = 256;
export const MAX_SUMMARY_CHARACTERS = 4_000;
export const MAX_RECOVERY_OUTCOME_LENGTH = 4_000;
export const MAX_RECOVERY_PROPOSALS = 4;
export const MAX_RECOVERY_REASON_LENGTH = 240;
export const DEFAULT_APPROVAL_RESPONSE_KEYS = "y";
export const DEFAULT_RESTART_STEP_ID = "restart-money-run";

/**
 * Registered map of known stepId -> pre-approved command line. restart_step
 * only ever executes commands looked up from this catalog; an unknown stepId
 * is rejected before any approval is requested.
 */
export type TmuxRecoveryStepCatalog = Readonly<Record<string, string>>;

export const DEFAULT_TMUX_RECOVERY_STEP_CATALOG: TmuxRecoveryStepCatalog = {
  "restart-money-run": "npm run money-run",
  "restart-money-run-worker": "npm run money-run:worker"
};

export type TmuxRecoveryAction =
  | {
      kind: "send_input";
      actionId: string;
      paneId: string;
      keys: string;
    }
  | {
      kind: "restart_step";
      actionId: string;
      stepId: string;
    }
  | {
      kind: "collect_summary";
      actionId: string;
      paneId: string;
      maxTailCharacters: number;
    };

export interface TmuxRecoveryProposal {
  proposalId: string;
  action: TmuxRecoveryAction;
  reason: string;
  signalType: TmuxSignal["type"];
  /** false only for collect_summary; every mutating action is true. */
  mutatesSession: boolean;
  risk: RiskDecision;
}

export type TmuxRecoveryOutcome =
  | {
      ok: true;
      actionId: string;
      at: string;
      result: string;
    }
  | {
      ok: false;
      actionId: string;
      at: string;
      error: string;
      retryable: boolean;
    };

/**
 * Per-session recovery budget. Cost fields are OPTIONAL because tmux itself
 * exposes no cost data — only explicitly integrated workers that report cost
 * populate spentCostUsd/maxCostUsd; for tmux sessions the budget is duration
 * + retries only.
 */
export interface TmuxRecoveryBudget {
  maxRetriesPerAction: number;
  maxDurationMs: number;
  maxCostUsd?: number;
  spentCostUsd?: number;
  attempts: Record<string, number>;
  startedAt?: string;
}

export interface CreateTmuxRecoveryBudgetOptions {
  maxRetriesPerAction?: number;
  maxDurationMs?: number;
  maxCostUsd?: number;
  spentCostUsd?: number;
  attempts?: Record<string, number>;
  startedAt?: string;
}

export function createTmuxRecoveryBudget(
  options: CreateTmuxRecoveryBudgetOptions = {}
): TmuxRecoveryBudget {
  const maxRetriesPerAction = readPositiveInteger(
    options.maxRetriesPerAction,
    1
  );
  const maxDurationMs = readPositiveInteger(options.maxDurationMs, 300_000);
  const budget: TmuxRecoveryBudget = {
    maxRetriesPerAction,
    maxDurationMs,
    attempts: { ...(options.attempts ?? {}) }
  };
  if (typeof options.maxCostUsd === "number" && Number.isFinite(options.maxCostUsd)) {
    budget.maxCostUsd = options.maxCostUsd;
  }
  if (typeof options.spentCostUsd === "number" && Number.isFinite(options.spentCostUsd)) {
    budget.spentCostUsd = options.spentCostUsd;
  }
  if (options.startedAt) {
    budget.startedAt = options.startedAt;
  }
  return budget;
}

export type TmuxRecoveryBudgetCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Budget enforcement runs inside runTmuxRecoveryTask before each attempt.
 * Retry counts accumulate across turns (the budget is persisted per session),
 * so a recovery that already used its attempts stays exhausted.
 */
export function checkTmuxRecoveryBudget(
  budget: TmuxRecoveryBudget,
  actionId: string,
  now: string
): TmuxRecoveryBudgetCheck {
  const attempts = budget.attempts[actionId] ?? 0;
  if (attempts >= budget.maxRetriesPerAction) {
    return {
      ok: false,
      reason: `Recovery budget exhausted: action ${actionId} used ${attempts}/${budget.maxRetriesPerAction} attempts.`
    };
  }
  if (budget.startedAt) {
    const elapsedMs = Date.parse(now) - Date.parse(budget.startedAt);
    if (Number.isFinite(elapsedMs) && elapsedMs >= budget.maxDurationMs) {
      return {
        ok: false,
        reason: `Recovery budget exhausted: max duration ${budget.maxDurationMs}ms elapsed.`
      };
    }
  }
  if (
    typeof budget.maxCostUsd === "number"
    && typeof budget.spentCostUsd === "number"
    && budget.spentCostUsd >= budget.maxCostUsd
  ) {
    return {
      ok: false,
      reason: `Recovery budget exhausted: spent ${budget.spentCostUsd} >= max ${budget.maxCostUsd} USD.`
    };
  }
  return { ok: true };
}

/** Immutable attempt recording; stamps startedAt on the first attempt. */
export function recordTmuxRecoveryAttempt(
  budget: TmuxRecoveryBudget,
  actionId: string,
  now: string
): TmuxRecoveryBudget {
  const attempts = {
    ...budget.attempts,
    [actionId]: (budget.attempts[actionId] ?? 0) + 1
  };
  return {
    ...budget,
    attempts,
    ...(budget.startedAt ? {} : { startedAt: now })
  };
}

export function readTmuxRecoveryRisk(action: TmuxRecoveryAction): RiskDecision {
  switch (action.kind) {
    case "send_input":
      return {
        level: "high",
        reason: `Sending keystrokes to tmux pane ${action.paneId} mutates the supervised session.`,
        requiresApproval: true
      };
    case "restart_step":
      return {
        level: "high",
        reason: `Restarting registered step ${action.stepId} mutates the supervised session.`,
        requiresApproval: true
      };
    case "collect_summary":
      return {
        level: "medium",
        reason: `Collecting a bounded summary from tmux pane ${action.paneId} is read-only.`,
        requiresApproval: true
      };
  }
}

export function describeTmuxRecoveryAction(action: TmuxRecoveryAction): string {
  switch (action.kind) {
    case "send_input":
      return `send_input to ${action.paneId}`;
    case "restart_step":
      return `restart_step ${action.stepId}`;
    case "collect_summary":
      return `collect_summary from ${action.paneId}`;
  }
}

export interface CreateTmuxRecoveryProposalsInput {
  sessionName: string;
  signals: readonly TmuxSignal[];
  catalog?: TmuxRecoveryStepCatalog;
  restartStepId?: string;
  approvalResponse?: string;
  maxTailCharacters?: number;
}

/**
 * Derive recovery proposals from supervision signals. This is the ONLY place
 * recovery actions are minted: the agent never supplies a free-form command.
 *
 * - approval-needed -> send_input (the bounded approval response text)
 * - dead-pane / no-session / no-panes -> restart_step (catalog lookup)
 * - error-marker -> collect_summary (read-only bounded capture)
 */
export function createTmuxRecoveryProposals(
  input: CreateTmuxRecoveryProposalsInput
): TmuxRecoveryProposal[] {
  const catalog = input.catalog ?? DEFAULT_TMUX_RECOVERY_STEP_CATALOG;
  const restartStepId = input.restartStepId ?? DEFAULT_RESTART_STEP_ID;
  const approvalResponse = readBoundedKeys(
    input.approvalResponse ?? DEFAULT_APPROVAL_RESPONSE_KEYS
  );
  const maxTailCharacters = readPositiveInteger(
    input.maxTailCharacters,
    MAX_SUMMARY_CHARACTERS
  );
  const proposals: TmuxRecoveryProposal[] = [];

  for (const signal of input.signals) {
    if (proposals.length >= MAX_RECOVERY_PROPOSALS) {
      break;
    }
    const proposal = createProposalForSignal({
      signal,
      sessionName: input.sessionName,
      catalog,
      restartStepId,
      approvalResponse,
      maxTailCharacters
    });
    if (proposal) {
      proposals.push(proposal);
    }
  }

  return proposals;
}

function createProposalForSignal(context: {
  signal: TmuxSignal;
  sessionName: string;
  catalog: TmuxRecoveryStepCatalog;
  restartStepId: string;
  approvalResponse: string;
  maxTailCharacters: number;
}): TmuxRecoveryProposal | undefined {
  const { signal, sessionName } = context;

  switch (signal.type) {
    case "approval-needed": {
      const action: TmuxRecoveryAction = {
        kind: "send_input",
        actionId: `${sessionName}:send_input:${signal.paneId}`,
        paneId: signal.paneId,
        keys: context.approvalResponse
      };
      return {
        proposalId: action.actionId,
        action,
        reason: boundReason(
          `Pane ${signal.paneId} is waiting for approval; respond with the bounded approval text.`
        ),
        signalType: signal.type,
        mutatesSession: true,
        risk: readTmuxRecoveryRisk(action)
      };
    }
    case "dead-pane":
    case "active-pane-dead":
    case "no-session":
    case "no-panes": {
      if (!Object.prototype.hasOwnProperty.call(context.catalog, context.restartStepId)) {
        return undefined;
      }
      const action: TmuxRecoveryAction = {
        kind: "restart_step",
        actionId: `${sessionName}:restart_step:${context.restartStepId}`,
        stepId: context.restartStepId
      };
      return {
        proposalId: action.actionId,
        action,
        reason: boundReason(
          `Signal ${signal.type} blocks ${sessionName}; restart registered step ${context.restartStepId}.`
        ),
        signalType: signal.type,
        mutatesSession: true,
        risk: readTmuxRecoveryRisk(action)
      };
    }
    case "error-marker": {
      const action: TmuxRecoveryAction = {
        kind: "collect_summary",
        actionId: `${sessionName}:collect_summary:${signal.paneId}`,
        paneId: signal.paneId,
        maxTailCharacters: context.maxTailCharacters
      };
      return {
        proposalId: action.actionId,
        action,
        reason: boundReason(
          `Pane ${signal.paneId} shows an error marker; collect a bounded summary for review.`
        ),
        signalType: signal.type,
        mutatesSession: false,
        risk: readTmuxRecoveryRisk(action)
      };
    }
    case "no-active-pane":
    case "stalled":
    case "waiting":
    case "completed":
      return undefined;
  }
}

/**
 * Strict parser for untrusted IPC input (the approval token from the
 * renderer/CLI). Returns undefined for anything that is not a closed,
 * bounded recovery action. restart_step additionally requires the stepId to
 * exist in the (optionally injected) catalog.
 */
export function parseTmuxRecoveryAction(
  input: unknown,
  catalog: TmuxRecoveryStepCatalog = DEFAULT_TMUX_RECOVERY_STEP_CATALOG
): TmuxRecoveryAction | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const actionId = readNonEmptyString(record.actionId);
  if (!actionId) {
    return undefined;
  }

  switch (record.kind) {
    case "send_input": {
      const paneId = readNonEmptyString(record.paneId);
      const keys = readNonEmptyString(record.keys);
      if (!paneId || !keys) {
        return undefined;
      }
      if (keys.length > MAX_RECOVERY_KEYS) {
        return undefined;
      }
      return { kind: "send_input", actionId, paneId, keys };
    }
    case "restart_step": {
      const stepId = readNonEmptyString(record.stepId);
      if (!stepId || !Object.prototype.hasOwnProperty.call(catalog, stepId)) {
        return undefined;
      }
      return { kind: "restart_step", actionId, stepId };
    }
    case "collect_summary": {
      const paneId = readNonEmptyString(record.paneId);
      const maxTailCharacters = readFinitePositiveInteger(record.maxTailCharacters);
      if (!paneId || maxTailCharacters === undefined) {
        return undefined;
      }
      if (maxTailCharacters > MAX_SUMMARY_CHARACTERS) {
        return undefined;
      }
      return { kind: "collect_summary", actionId, paneId, maxTailCharacters };
    }
    default:
      return undefined;
  }
}

export function boundRecoveryString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(value.length - maxLength);
}

function readBoundedKeys(keys: string): string {
  if (keys.length <= MAX_RECOVERY_KEYS) {
    return keys;
  }
  return keys.slice(0, MAX_RECOVERY_KEYS);
}

function boundReason(reason: string): string {
  return reason.length <= MAX_RECOVERY_REASON_LENGTH
    ? reason
    : reason.slice(0, MAX_RECOVERY_REASON_LENGTH);
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const integer = Math.floor(value);
  return integer >= 1 ? integer : fallback;
}

function readFinitePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(value);
  return integer >= 1 ? integer : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
