import type {
  DesktopAppState,
  DesktopAction,
  DesktopActionResult,
  DesktopExecutableAction,
  DesktopSessionStatus,
  OpenGhosttySessionResult,
  WaitAction,
  WaitResult
} from "./types.js";

export interface DesktopActionExecutor {
  executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult>;
}

export interface RunDesktopActionPlanOptions {
  signal?: AbortSignal;
  verifyStep?: DesktopActionStepVerifier;
  collectEvidence?: boolean;
}

export interface DesktopActionPlanStepResult {
  action: DesktopAction;
  result: DesktopActionResult;
  evidence?: DesktopActionResultEvidence;
  verification?: DesktopActionVerification;
}

export interface DesktopActionResultEvidence {
  actionType: DesktopAction["type"];
  target?: {
    bundleId: string;
    pid?: number;
  };
  ok?: boolean;
  message?: string;
  screenshotPath?: string;
  observed?: {
    isRunning: boolean;
    isActive: boolean;
    frontmostBundleId?: string;
    windowCount: number;
    ocrLabelCount: number;
  };
  desktopSession?: {
    controllable: boolean;
    frontmostBundleId?: string;
    frontmostProcessIdentifier?: number;
    mainDisplayAsleep?: boolean;
  };
}

export type DesktopActionVerification =
  | { status: "passed"; message?: string }
  | { status: "failed"; reason: string }
  | { status: "needs_user_confirmation"; reason: string };

export interface DesktopActionVerificationContext {
  action: DesktopExecutableAction;
  result: DesktopActionResult;
  stepIndex: number;
  previousResults: readonly DesktopActionPlanStepResult[];
}

export type DesktopActionStepVerifier = (
  context: DesktopActionVerificationContext
) => DesktopActionVerification | Promise<DesktopActionVerification>;

export class DesktopActionVerificationError extends Error {
  readonly stepIndex: number;
  readonly action: DesktopExecutableAction;
  readonly verification: Exclude<DesktopActionVerification, { status: "passed" }>;
  readonly partialResults: DesktopActionPlanStepResult[];

  constructor(options: {
    stepIndex: number;
    action: DesktopExecutableAction;
    verification: Exclude<DesktopActionVerification, { status: "passed" }>;
    partialResults: DesktopActionPlanStepResult[];
  }) {
    super(createVerificationFailureMessage(options.action, options.verification));
    this.name = "DesktopActionVerificationError";
    this.stepIndex = options.stepIndex;
    this.action = options.action;
    this.verification = options.verification;
    this.partialResults = options.partialResults;
  }
}

const MAX_WAIT_MS = 30_000;

export async function runDesktopActionPlan(
  executor: DesktopActionExecutor,
  actions: readonly DesktopAction[],
  options: RunDesktopActionPlanOptions = {}
): Promise<DesktopActionPlanStepResult[]> {
  const results: DesktopActionPlanStepResult[] = [];

  for (const [stepIndex, action] of actions.entries()) {
    throwIfAborted(options.signal);

    if (isWaitAction(action)) {
      results.push({
        action,
        result: await waitForAction(action, options.signal)
      });
      continue;
    }

    const result = await executor.executeAction(action);
    const stepResult: DesktopActionPlanStepResult = {
      action,
      result
    };
    if (options.collectEvidence) {
      stepResult.evidence = createDesktopActionResultEvidence(action, result);
    }

    if (options.verifyStep) {
      const verification = await options.verifyStep({
        action,
        result,
        stepIndex,
        previousResults: [...results]
      });
      stepResult.verification = verification;
      results.push(stepResult);

      if (verification.status !== "passed") {
        throw new DesktopActionVerificationError({
          stepIndex,
          action,
          verification,
          partialResults: [...results]
        });
      }

      continue;
    }

    results.push(stepResult);
  }

  return results;
}

export function createDesktopActionResultEvidence(
  action: DesktopAction,
  result: DesktopActionResult
): DesktopActionResultEvidence {
  const evidence: DesktopActionResultEvidence = {
    actionType: action.type
  };

  const target = readActionTarget(action) ?? readResultTarget(result);
  if (target) {
    evidence.target = target;
  }

  if (isHelperActionResult(result)) {
    evidence.ok = result.ok;
    evidence.message = result.message;
  }

  const screenshotPath = readScreenshotPath(result);
  if (screenshotPath) {
    evidence.screenshotPath = screenshotPath;
  }

  if (isDesktopAppState(result)) {
    evidence.observed = {
      isRunning: result.isRunning,
      isActive: result.isActive,
      frontmostBundleId: result.frontmostBundleId,
      windowCount: result.windows?.length ?? 0,
      ocrLabelCount: result.ocrLabels?.length ?? 0
    };
  }

  if (isDesktopSessionStatus(result)) {
    evidence.desktopSession = {
      controllable: result.controllable,
      frontmostBundleId: result.frontmostBundleId,
      frontmostProcessIdentifier: result.frontmostProcessIdentifier,
      mainDisplayAsleep: result.mainDisplayAsleep
    };
  }

  return evidence;
}

function createVerificationFailureMessage(
  action: DesktopExecutableAction,
  verification: Exclude<DesktopActionVerification, { status: "passed" }>
): string {
  const prefix = verification.status === "needs_user_confirmation"
    ? "Desktop action verification needs user confirmation"
    : "Desktop action verification failed";

  return `${prefix} after ${action.type}: ${verification.reason}`;
}

function isWaitAction(action: DesktopAction): action is WaitAction {
  return action.type === "wait";
}

function readActionTarget(action: DesktopAction): { bundleId: string; pid?: number } | undefined {
  if (
    action.type === "activate_app"
    || action.type === "observe_app"
  ) {
    return {
      bundleId: action.bundleId,
      pid: action.pid
    };
  }

  return undefined;
}

function readResultTarget(result: DesktopActionResult): { bundleId: string; pid?: number } | undefined {
  if (isDesktopAppState(result) || isOpenGhosttySessionResult(result)) {
    return {
      bundleId: result.bundleId,
      pid: result.pid
    };
  }

  return undefined;
}

function readScreenshotPath(result: DesktopActionResult): string | undefined {
  if ("outputPath" in result && typeof result.outputPath === "string") {
    return result.outputPath;
  }

  if (isDesktopAppState(result)) {
    return result.screenshotPath;
  }

  return undefined;
}

function isHelperActionResult(result: DesktopActionResult): result is { ok: boolean; message?: string } {
  return "ok" in result && typeof result.ok === "boolean";
}

function isDesktopAppState(result: DesktopActionResult): result is DesktopAppState {
  return (
    "bundleId" in result
    && "isRunning" in result
    && "isActive" in result
    && "screenshotPath" in result
    && typeof result.bundleId === "string"
  );
}

function isOpenGhosttySessionResult(
  result: DesktopActionResult
): result is OpenGhosttySessionResult {
  return (
    "opened" in result
    && result.opened === true
    && "bundleId" in result
    && typeof result.bundleId === "string"
    && "pid" in result
    && typeof result.pid === "number"
  );
}

function isDesktopSessionStatus(result: DesktopActionResult): result is DesktopSessionStatus {
  return "controllable" in result && typeof result.controllable === "boolean";
}

function waitForAction(action: WaitAction, signal: AbortSignal | undefined): Promise<WaitResult> {
  const ms = readWaitMs(action.ms);

  if (ms === 0) {
    return Promise.resolve({ ok: true, waitedMs: ms });
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ ok: true, waitedMs: ms });
    }, ms);

    const abort = () => {
      cleanup();
      reject(createAbortError(signal));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function readWaitMs(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("wait.ms must be a finite number.");
  }

  if (value < 0) {
    throw new Error("wait.ms must be greater than or equal to 0.");
  }

  if (value > MAX_WAIT_MS) {
    throw new Error(`wait.ms must be less than or equal to ${MAX_WAIT_MS}.`);
  }

  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function createAbortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;

  if (isDefaultAbortReason(reason)) {
    return new Error("Desktop action plan aborted.");
  }

  if (reason instanceof Error && reason.message.length > 0) {
    return new Error(`Desktop action plan aborted: ${reason.message}`);
  }

  if (typeof reason === "string" && reason.length > 0) {
    return new Error(`Desktop action plan aborted: ${reason}`);
  }

  return new Error("Desktop action plan aborted.");
}

function isDefaultAbortReason(reason: unknown): boolean {
  return (
    typeof reason === "object"
    && reason !== null
    && "name" in reason
    && "message" in reason
    && reason.name === "AbortError"
    && reason.message === "This operation was aborted"
  );
}
