import type { RiskDecision } from "./types.js";

/**
 * Adapter Contract — the unified surface that declares what makes an app a
 * supported route. Every orchestrator (Ghostty, Chrome, Finder, tmux
 * supervision) implements this contract so that capability, permission, risk,
 * approval, verification, stop, replay, blocker, and smoke semantics are
 * consistent across main, renderer, CLI, and MCP.
 *
 * The contract is a declarative surface over the existing orchestrator
 * engines — it does not restructure them. The four orchestrator event unions
 * stay as-is; the shared bases below document the common lifecycle shapes.
 */

// ---------------------------------------------------------------------------
// Supported adapter identifiers
// ---------------------------------------------------------------------------

export type SupportedAdapterId = "ghostty" | "chrome" | "finder" | "tmux_supervision";

// ---------------------------------------------------------------------------
// 1. Route selection and target identity
// ---------------------------------------------------------------------------

export interface AdapterTargetIdentity {
  readonly kind: "bundle_id" | "session_name" | "url" | "file_path";
  readonly value: string;
}

/**
 * The result of parsing a raw input string into an adapter-specific plan.
 * `command` is the normalized, human-readable command string; `plan` is the
 * structured data the adapter executes.
 */
export type AdapterIntent<TPlan> =
  | { ok: true; command: string; plan: TPlan }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// 2. Observable capabilities
// ---------------------------------------------------------------------------

export type AdapterCapability =
  | "desktop_action_execute"
  | "desktop_screenshot"
  | "desktop_ocr"
  | "desktop_session_status"
  | "desktop_permissions"
  | "cdp_command"
  | "finder_selection"
  | "finder_item_layout"
  | "tmux_observe"
  | "app_list";

// ---------------------------------------------------------------------------
// 3. Required permissions
// ---------------------------------------------------------------------------

export type AdapterPermissionKind = "screenRecording" | "accessibility" | "none";

export type AdapterPermissionState = "granted" | "denied" | "not-determined" | "unknown";

export interface AdapterPermission {
  readonly kind: AdapterPermissionKind;
  readonly state: AdapterPermissionState;
  readonly label: string;
}

// ---------------------------------------------------------------------------
// 4. Risk and approval policy
// ---------------------------------------------------------------------------

export type AdapterApprovalGate = "action" | "submit" | "plan";

export interface AdapterApprovalPolicy {
  /**
   * The approval gates this adapter raises, in order.
   * Ghostty: ["action"]; Chrome: ["action", "submit"];
   * Finder: ["action", "plan"]; tmux: ["action"].
   */
  readonly gates: readonly AdapterApprovalGate[];
}

// ---------------------------------------------------------------------------
// 5. Plan schema
// ---------------------------------------------------------------------------

export interface AdapterPlanSchema {
  /**
   * The schema version of the adapter's plan binding.
   * Finder: 1 (FinderExecutionPlanBinding); Chrome: 1 (ChromeSubmitConfirmationBinding);
   * Ghostty: 1 (terminal command); tmux: 0 (no plan).
   */
  readonly schemaVersion: number;
}

// ---------------------------------------------------------------------------
// 7. Verification strategy
// ---------------------------------------------------------------------------

export type AdapterVerificationStrategy =
  | "terminal_completion_marker"
  | "browser_page_identity"
  | "filesystem_post_condition"
  | "supervision_report";

// ---------------------------------------------------------------------------
// 8. Stop behavior
// ---------------------------------------------------------------------------

export interface AdapterStopBehavior {
  /**
   * Whether the adapter checks an AbortSignal mid-execution.
   * Ghostty: true; Chrome/Finder/tmux: false (generator termination only).
   */
  readonly supportsAbortSignal: boolean;
}

// ---------------------------------------------------------------------------
// 9. Replay events — shared bases
// ---------------------------------------------------------------------------

/**
 * Structural base for every replayable task event. All four orchestrator event
 * unions are discriminated on `type`, so they satisfy this constraint.
 */
export type AdapterReplayEvent = { type: string };

/** Shared lifecycle event shapes (documentation; adapters may extend). */
export interface AdapterStartedEvent {
  type: "started";
  command: string;
  risk: RiskDecision;
}

export interface AdapterApprovalRequiredEvent {
  type: "approval_required";
  command: string;
  risk: RiskDecision;
}

export interface AdapterCompletedEvent {
  type: "completed";
  command: string;
  summary: string;
  /**
   * Structured terminal result for adapters that report partial outcomes
   * (e.g. Finder's completed/failed/skipped operation breakdown).
   */
  result?: unknown;
}

export interface AdapterVerificationFailedEvent {
  type: "verification_failed";
  /** Adapter-specific, constrained by the adapter's declared blocker union. */
  stage: string;
  reason: string;
  code?: string;
}

export interface AdapterActionVerifiedEvent {
  type: "action_verified";
  actionType: string;
  status: "passed" | "failed" | "needs_user_confirmation";
  message?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// 10. Typed blockers
// ---------------------------------------------------------------------------

/** The union of every blocker stage across all four adapters. */
export type AdapterBlockerStage =
  | "input"
  | "permissions"
  | "desktop_session"
  | "activate"
  | "initialize"
  | "before"
  | "after"
  | "connection"
  | "navigation"
  | "interaction"
  | "extraction"
  | "sensitive"
  | "file_operation"
  | "observe"
  | "selection"
  | "layout"
  | "drag"
  | "tmux";

export interface AdapterBlocker {
  readonly stage: AdapterBlockerStage;
  readonly reason: string;
  readonly code?: string;
}

// ---------------------------------------------------------------------------
// 11. Packaged smoke acceptance
// ---------------------------------------------------------------------------

export interface AdapterSmokeContract {
  /** e.g. "smoke:chrome" */
  readonly npmScript: string;
  /** e.g. "scripts/smoke-chrome-plan.mjs" */
  readonly planModule: string;
  /** e.g. "renderer -> preload -> main -> CDP -> Chrome" */
  readonly productPath: string;
  readonly evidenceClassifiers: readonly string[];
}

// ---------------------------------------------------------------------------
// Shared options base
// ---------------------------------------------------------------------------

export interface AdapterTaskOptions {
  approved?: boolean;
  signal?: AbortSignal;
  createScreenshotPath?(stage: string): string;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * The generic contract each adapter implements. Type parameters:
 * - `TInput`   — the raw input the adapter's `run` accepts (usually `string`).
 * - `TPlan`    — the structured plan produced by `parseInput`.
 * - `TEvent`   — the adapter's replayable event union.
 * - `TClient`  — the adapter-specific client (CDP, desktop, tmux, …).
 * - `TOptions` — the adapter's task options.
 */
export interface AdapterContract<
  TInput = string,
  TPlan = unknown,
  TEvent extends AdapterReplayEvent = AdapterReplayEvent,
  TClient = unknown,
  TOptions extends AdapterTaskOptions = AdapterTaskOptions
> {
  readonly id: SupportedAdapterId;
  readonly displayName: string;

  // 1. Route selection and target identity
  readonly targetIdentity: AdapterTargetIdentity;
  parseInput(input: string): AdapterIntent<TPlan>;
  /** Whether this adapter should handle the given raw input. */
  matchesRoute(input: string): boolean;

  // 2. Observable capabilities
  readonly capabilities: readonly AdapterCapability[];

  // 3. Required permissions
  readRequiredPermissions(client: TClient): Promise<AdapterPermission[]>;

  // 4. Risk and approval policy
  readRisk(input: string): RiskDecision;
  readonly approvalPolicy: AdapterApprovalPolicy;

  // 5. Plan schema
  readonly planSchema: AdapterPlanSchema;

  // 6. Execution hooks — the generator is the hook; main.ts iterates and dispatches
  run(input: TInput, client: TClient, options: TOptions): AsyncGenerator<TEvent>;

  // 7. Verification strategy
  readonly verificationStrategy: AdapterVerificationStrategy;

  // 8. Stop behavior
  readonly stopBehavior: AdapterStopBehavior;

  // 9. Replay events — TEvent extends AdapterReplayEvent (declared, not restructured)

  // 10. Typed blockers — the adapter's declared subset of the shared union
  readonly blockerStages: readonly AdapterBlockerStage[];

  // 11. Packaged smoke acceptance (omitted when the adapter has no packaged smoke)
  readonly smoke?: AdapterSmokeContract;
}

/**
 * Type-erased adapter for registry storage. Concrete adapters are assignable to
 * this because all contract methods use method-shorthand (bivariant) signatures.
 */
export type AnyAdapterContract = AdapterContract<
  unknown,
  unknown,
  AdapterReplayEvent,
  unknown,
  AdapterTaskOptions
>;
