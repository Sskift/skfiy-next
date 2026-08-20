/**
 * Loopback Control Contract — the shared, versioned surface between the
 * Electron main process (control server) and the standalone CLI / MCP
 * processes (control clients).
 *
 * The control API is the ONLY channel through which an external local agent
 * can influence a running skfiy app, and it is deliberately narrow:
 *
 * - Read-only projections (task control snapshot, turn replay).
 * - `approve-task` — resolves a PendingApproval the APP ITSELF raised. It
 *   cannot inject commands, plans, or actions. The request is validated
 *   against the live pending approval and task control state with the exact
 *   same checks as the `skfiy:approve-task` IPC handler.
 * - `stop-task` — cancels the active turn. Idempotent.
 *
 * Everything in this module is pure TypeScript with no Electron or Node IO
 * imports, so the CLI, the MCP server, and the Electron main process can all
 * depend on it.
 */

import type {
  TaskControlApprovalGate,
  TaskControlSnapshot
} from "./task-control.js";

export const CONTROL_CONTRACT_SCHEMA_VERSION = 1 as const;

/** Well-known token file name inside the skfiy app-support directory. */
export const CONTROL_TOKEN_FILENAME = "control-token.json";

/** Header carrying the per-launch bearer token. */
export const CONTROL_TOKEN_HEADER = "x-skfiy-control-token";

export const CONTROL_APPROVAL_MISMATCH_MESSAGE =
  "Task approval no longer matches the displayed Task Control plan.";

// ---------------------------------------------------------------------------
// Token file (written by the app, read by CLI/MCP)
// ---------------------------------------------------------------------------

export interface ControlTokenFile {
  readonly schemaVersion: typeof CONTROL_CONTRACT_SCHEMA_VERSION;
  /** Base URL of the loopback control server, e.g. http://127.0.0.1:51983. */
  readonly url: string;
  readonly token: string;
  readonly createdAt: string;
  readonly pid: number;
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

export interface ControlApproveRequest {
  readonly decision: "approve" | "deny";
  readonly executionId: string;
  readonly planId: string;
  readonly gate: TaskControlApprovalGate;
}

export interface ControlStopRequest {
  readonly reason?: string;
}

export type ControlApproveResult =
  | {
      readonly result: "resumed" | "denied";
      readonly taskControl: TaskControlSnapshot | null;
    }
  | {
      readonly result: "mismatch";
      readonly message: string;
    }
  | {
      readonly result: "no-pending-approval";
    };

export interface ControlStopDecision {
  readonly cancellationReason: string;
  readonly delivery: "turn-replay" | "transient";
  readonly route: string | null;
}

export interface ControlStopResult {
  readonly result: "stopped" | "no-active-task";
  readonly stopDecision: ControlStopDecision;
  readonly taskControl: TaskControlSnapshot | null;
}

/**
 * The live state the control server validates an approve request against.
 * The Electron main process projects its in-memory `pendingApproval` and
 * `taskControlStore` into this shape; the CLI/MCP never construct it.
 */
export interface ControlApprovalState {
  readonly pendingApproval: {
    readonly planId: string;
    readonly gate: TaskControlApprovalGate;
  } | null;
  readonly taskControl: TaskControlSnapshot | null;
}

/**
 * The single source of truth for "does this approve request still match the
 * displayed Task Control plan". The `skfiy:approve-task` / `skfiy:deny-task`
 * IPC handlers and the loopback control server MUST both pass through this
 * check so an external agent resolving an approval gets the EXACT same
 * permission boundary as the pet clicking Approve in the UI.
 *
 * Returns the mismatch message, or null when the request matches.
 */
export function readControlApprovalMismatch(
  request: Pick<ControlApproveRequest, "executionId" | "planId" | "gate"> | null | undefined,
  state: ControlApprovalState
): string | null {
  const approval = state.pendingApproval;
  const taskControl = state.taskControl;

  if (
    !request
    || !approval
    || !taskControl
    || taskControl.phase !== "approval"
    || taskControl.executionId !== request.executionId
    || approval.planId !== request.planId
    || taskControl.approval?.planId !== request.planId
    || taskControl.approval.gate !== approval.gate
    || approval.gate !== request.gate
  ) {
    return CONTROL_APPROVAL_MISMATCH_MESSAGE;
  }

  return null;
}

/**
 * Strict structural validator for an approve request arriving over HTTP.
 * Rejects extra keys so the control surface can never smuggle commands,
 * plans, or actions into the approval path.
 */
export function isControlApproveRequest(value: unknown): value is ControlApproveRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["decision", "executionId", "planId", "gate"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return false;
  }
  return (
    (record.decision === "approve" || record.decision === "deny")
    && isBoundedControlId(record.executionId)
    && isBoundedControlId(record.planId)
    && isControlApprovalGate(record.gate)
  );
}

export function isControlApprovalGate(value: unknown): value is TaskControlApprovalGate {
  return value === "action-plan"
    || value === "finder-plan"
    || value === "chrome-submit"
    || value === "chrome-workflow";
}

/**
 * Strict structural validator for a stop request arriving over HTTP.
 * Rejects extra keys so the control surface can never smuggle commands
 * or actions into the cancellation path.
 */
export function isControlStopRequest(value: unknown): value is ControlStopRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["reason"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return false;
  }
  return record.reason === undefined || typeof record.reason === "string";
}

function isBoundedControlId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}
