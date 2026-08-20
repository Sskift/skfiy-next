import { classifyTerminalCommand } from "../../shared/risk-policy.js";
import type { RiskDecision } from "../../shared/types.js";
import { parseTerminalIntent } from "../../shared/terminal-intent.js";
import { createDesktopSessionDiagnostics } from "../desktop-session-diagnostics.js";
import {
  runDesktopActionPlan,
  type DesktopActionExecutor,
  type DesktopActionPlanStepResult,
  type DesktopActionVerification
} from "../computer-use/action-runner.js";
import { decideAppRecovery } from "../computer-use/recovery-policy.js";
import type {
  DesktopAction,
  DesktopActionResult,
  DesktopAppState,
  DesktopSessionStatus,
  OcrImageResult,
  OpenGhosttySessionResult,
  PermissionSummary,
} from "../computer-use/types.js";
import { createTerminalCommandPreview } from "./terminal-command-preview.js";
import {
  GHOSTTY_SENSITIVE_TEXT_PATTERNS,
  normalizeTerminalText,
  readTerminalContext,
  type TerminalContextObservation
} from "./terminal-context.js";
import { readTerminalExitStatus } from "./terminal-exit-status.js";
import type { GhosttyTaskEvent } from "./events.js";

const GHOSTTY_APP_NAME = "Ghostty";
const GHOSTTY_BUNDLE_ID = "com.mitchellh.ghostty";
const SKFIY_GHOSTTY_SESSION_MARKER = "skfiy";
const SKFIY_GHOSTTY_SESSION_TITLE = "skfiy-shell";
const SKFIY_GHOSTTY_READY_MARKER = "SKFIY_READY";
const SKFIY_GHOSTTY_INIT_COMMAND = [
  "export SKFIY_SESSION=1",
  "PROMPT='[skfiy] %~ %# '",
  "PS1='[skfiy] \\w \\$ '",
  `printf '\\n${SKFIY_GHOSTTY_READY_MARKER}\\n'`,
  `printf '\\033]0;${SKFIY_GHOSTTY_SESSION_TITLE}\\007'`
].join("; ");
const INITIAL_INPUT_FOCUS_SETTLE_WAIT_MS = 350;
const SESSION_INIT_SETTLE_WAIT_MS = 90;
const TYPE_SETTLE_WAIT_MS = 90;
const SUBMIT_SETTLE_WAIT_MS = 300;
const OBSERVE_RETRY_WAIT_MS = 350;
export const SHELL_READY_OBSERVE_ATTEMPTS = 8;
export const COMMAND_COMPLETION_OBSERVE_ATTEMPTS = 8;
const SENSITIVE_GHOSTTY_TITLE_PATTERNS = [/password/i, /keychain/i];
const READY_MARKER_RETRY_REASON = "Shell ready marker was not observed; re-observing Ghostty.";
const COMPLETION_MARKER_RETRY_REASON =
  "Command completion marker was not observed; re-observing Ghostty output.";
const EXIT_STATUS_RETRY_REASON =
  "Exit status was not readable from the completion marker; re-observing Ghostty output.";
let completionMarkerSerial = 0;

/**
 * Degraded context used for the pre-approval preview: the terminal has not
 * been observed yet at approval time, so every context field is its honest
 * unobservable value. The observed context (and a refreshed preview) is
 * emitted after the before-screenshot passes.
 */
const UNOBSERVABLE_TERMINAL_CONTEXT: TerminalContextObservation = {
  workingDirectory: "unknown",
  promptReady: false,
  lastCommandEcho: "",
  recentOutputTail: "",
  sensitiveContentDetected: false
};

export interface DesktopApp {
  name: string;
  bundleId: string;
}

export interface DesktopClient extends DesktopActionExecutor {
  listApps(): Promise<DesktopApp[]>;
  getDesktopSessionStatus?(): Promise<DesktopSessionStatus>;
  getPermissions?(): Promise<PermissionSummary>;
  ocrImage?(inputPath: string): Promise<OcrImageResult>;
}

export interface GhosttyTaskOptions {
  approved?: boolean;
  signal?: AbortSignal;
  createScreenshotPath?: (stage: "before" | "after") => string;
}

export async function* runGhosttyCommandTask(
  client: DesktopClient,
  input: string,
  options: GhosttyTaskOptions = {}
): AsyncGenerator<GhosttyTaskEvent> {
  const planned = parseTerminalIntent(input);
  const command = planned.ok ? planned.command : input.trim();
  const completionMarker = createCommandCompletionMarker();
  const executableCommand = createVerifiableTerminalCommand(command, completionMarker);
  const effectiveRisk = readGhosttyTaskRisk(input);

  yield {
    type: "started",
    command,
    risk: effectiveRisk
  };

  if (effectiveRisk.requiresApproval) {
    if (effectiveRisk.level !== "blocked") {
      yield {
        type: "command_preview",
        preview: createTerminalCommandPreview({
          command,
          context: UNOBSERVABLE_TERMINAL_CONTEXT,
          risk: effectiveRisk
        })
      };
    }

    yield {
      type: "approval_required",
      command,
      risk: effectiveRisk
    };

    if (!options.approved || effectiveRisk.level === "blocked") {
      return;
    }
  }

  if (isAborted(options.signal)) {
    return;
  }

  const missingPermissions = await readMissingComputerUsePermissions(client);
  if (missingPermissions.length > 0) {
    yield {
      type: "verification_failed",
      stage: "permissions",
      reason: createPermissionFailureReason(missingPermissions)
    };
    return;
  }

  const desktopSessionFailure = await readDesktopSessionFailure(client);
  if (desktopSessionFailure) {
    yield {
      type: "verification_failed",
      stage: "desktop_session",
      reason: desktopSessionFailure
    };
    return;
  }

  if (isAborted(options.signal)) {
    return;
  }

  yield {
    type: "locating_app",
    appName: GHOSTTY_APP_NAME
  };

  if (isAborted(options.signal)) {
    return;
  }

  let session = await openGhosttySession(client);
  yield {
    type: "session_opened",
    appName: GHOSTTY_APP_NAME,
    title: session.title,
    pid: session.pid
  };

  if (isAborted(options.signal)) {
    return;
  }

  const activationFailure = await activateGhosttySession(client, session, options.signal);
  if (activationFailure) {
    yield {
      type: "verification_failed",
      stage: "activate",
      reason: activationFailure
    };
    return;
  }

  yield {
    type: "app_activated",
    appName: GHOSTTY_APP_NAME,
    bundleId: session.bundleId,
    pid: session.pid
  };

  if (isAborted(options.signal)) {
    return;
  }

  let sessionInitialized = false;
  const initFailure = await initializeGhosttySession(client, options.signal);
  if (initFailure) {
    yield {
      type: "verification_failed",
      stage: "initialize",
      reason: initFailure
    };
    return;
  }

  if (isAborted(options.signal)) {
    return;
  }

  let before = await observeApp(
    client,
    session.bundleId,
    createScreenshotPath("before", options),
    options.signal,
    0,
    session.pid
  );
  if (!sessionInitialized && hasTerminalTextMarker(before, SKFIY_GHOSTTY_READY_MARKER)) {
    yield createSessionInitializedEvent();
    sessionInitialized = true;
  }
  yield {
    type: "screenshot_before",
    path: before.screenshotPath,
    observation: before
  };

  if (isAborted(options.signal)) {
    return;
  }

  const beforeRecovery = decideAppRecovery(before, createGhosttyRecoveryTarget(session.pid));
  if (beforeRecovery.type === "recover") {
    yield {
      type: "recovery_attempted",
      stage: "before",
      action: beforeRecovery.action,
      reason: beforeRecovery.reason
    };

    if (beforeRecovery.action === "open") {
      session = await openGhosttySession(client);
      sessionInitialized = false;
      yield {
        type: "session_opened",
        appName: GHOSTTY_APP_NAME,
        title: session.title,
        pid: session.pid
      };

      if (isAborted(options.signal)) {
        return;
      }
    }

    const recoveryActivationFailure = await activateGhosttySession(client, session, options.signal);
    if (recoveryActivationFailure) {
      yield {
        type: "verification_failed",
        stage: "before",
        reason: recoveryActivationFailure
      };
      return;
    }

    if (beforeRecovery.action === "open") {
      yield {
        type: "app_activated",
        appName: GHOSTTY_APP_NAME,
        bundleId: session.bundleId,
        pid: session.pid
      };
    }

    if (isAborted(options.signal)) {
      return;
    }

    if (beforeRecovery.action === "open") {
      const recoveryInitFailure = await initializeGhosttySession(client, options.signal);
      if (recoveryInitFailure) {
        yield {
          type: "verification_failed",
          stage: "before",
          reason: recoveryInitFailure
        };
        return;
      }

      if (isAborted(options.signal)) {
        return;
      }
    }

    before = await observeApp(
      client,
      session.bundleId,
      createScreenshotPath("before", options),
      options.signal,
      0,
      session.pid
    );
    if (!sessionInitialized && hasTerminalTextMarker(before, SKFIY_GHOSTTY_READY_MARKER)) {
      yield createSessionInitializedEvent();
      sessionInitialized = true;
    }
    yield {
      type: "screenshot_before",
      path: before.screenshotPath,
      observation: before
    };

    const postRecovery = decideAppRecovery(before, createGhosttyRecoveryTarget(session.pid));
    if (postRecovery.type !== "continue") {
      yield {
        type: "verification_failed",
        stage: "before",
        reason: postRecovery.reason
      };
      return;
    }
  } else if (beforeRecovery.type !== "continue") {
    yield {
      type: "verification_failed",
      stage: "before",
      reason: beforeRecovery.reason
    };
    return;
  }

  if (isAborted(options.signal)) {
    return;
  }

  const beforeVerificationFailure = readOwnedGhosttySessionFailure(before, session.pid);
  if (beforeVerificationFailure) {
    yield {
      type: "verification_failed",
      stage: "before",
      reason: beforeVerificationFailure
    };
    return;
  }

  if (!hasTerminalTextMarker(before, SKFIY_GHOSTTY_READY_MARKER)) {
    const readyResult = await observeAppUntilMarker(
      client,
      session.bundleId,
      createScreenshotPath("before", options),
      options.signal,
      OBSERVE_RETRY_WAIT_MS,
      session.pid,
      SKFIY_GHOSTTY_READY_MARKER,
      SHELL_READY_OBSERVE_ATTEMPTS
    );
    yield* readRetryEvents(readyResult.retryAttempts, "observation", READY_MARKER_RETRY_REASON);
    before = readyResult.observation;

    if (readyResult.markerObserved) {
      if (!sessionInitialized) {
        yield createSessionInitializedEvent();
        sessionInitialized = true;
      }
      yield {
        type: "screenshot_before",
        path: before.screenshotPath,
        observation: before
      };

      const readyBeforeRecovery = decideAppRecovery(before, createGhosttyRecoveryTarget(session.pid));
      if (readyBeforeRecovery.type === "recover") {
        yield {
          type: "recovery_attempted",
          stage: "before",
          action: readyBeforeRecovery.action,
          reason: readyBeforeRecovery.reason
        };

        if (readyBeforeRecovery.action === "open") {
          session = await openGhosttySession(client);
          sessionInitialized = false;
          yield {
            type: "session_opened",
            appName: GHOSTTY_APP_NAME,
            title: session.title,
            pid: session.pid
          };

          if (isAborted(options.signal)) {
            return;
          }
        }

        const readyActivationFailure = await activateGhosttySession(client, session, options.signal);
        if (readyActivationFailure) {
          yield {
            type: "verification_failed",
            stage: "before",
            reason: readyActivationFailure
          };
          return;
        }

        if (readyBeforeRecovery.action === "open") {
          yield {
            type: "app_activated",
            appName: GHOSTTY_APP_NAME,
            bundleId: session.bundleId,
            pid: session.pid
          };

          const readyInitFailure = await initializeGhosttySession(client, options.signal);
          if (readyInitFailure) {
            yield {
              type: "verification_failed",
              stage: "before",
              reason: readyInitFailure
            };
            return;
          }
        }

        if (isAborted(options.signal)) {
          return;
        }

        const recoveredReadyResult = await observeAppUntilMarker(
          client,
          session.bundleId,
          createScreenshotPath("before", options),
          options.signal,
          OBSERVE_RETRY_WAIT_MS,
          session.pid,
          SKFIY_GHOSTTY_READY_MARKER,
          SHELL_READY_OBSERVE_ATTEMPTS
        );
        yield* readRetryEvents(recoveredReadyResult.retryAttempts, "observation", READY_MARKER_RETRY_REASON);
        before = recoveredReadyResult.observation;

        if (!recoveredReadyResult.markerObserved) {
          yield {
            type: "verification_failed",
            stage: "initialize",
            reason: "Ghostty shell ready marker was not observed."
          };
          return;
        }

        if (!sessionInitialized) {
          yield createSessionInitializedEvent();
          sessionInitialized = true;
        }
        yield {
          type: "screenshot_before",
          path: before.screenshotPath,
          observation: before
        };

        const recoveredBeforeRecovery = decideAppRecovery(before, createGhosttyRecoveryTarget(session.pid));
        if (recoveredBeforeRecovery.type !== "continue") {
          yield {
            type: "verification_failed",
            stage: "before",
            reason: recoveredBeforeRecovery.reason
          };
          return;
        }
      } else if (readyBeforeRecovery.type !== "continue") {
        yield {
          type: "verification_failed",
          stage: "before",
          reason: readyBeforeRecovery.reason
        };
        return;
      }

      const readyBeforeVerificationFailure = readOwnedGhosttySessionFailure(before, session.pid);
      if (readyBeforeVerificationFailure) {
        yield {
          type: "verification_failed",
          stage: "before",
          reason: readyBeforeVerificationFailure
        };
        return;
      }
    } else {
      const retryInitFailure = await initializeGhosttySession(client, options.signal);
      if (retryInitFailure) {
        yield {
          type: "verification_failed",
          stage: "initialize",
          reason: retryInitFailure
        };
        return;
      }

      if (isAborted(options.signal)) {
        return;
      }

      const retryReadyResult = await observeAppUntilMarker(
        client,
        session.bundleId,
        createScreenshotPath("before", options),
        options.signal,
        SESSION_INIT_SETTLE_WAIT_MS,
        session.pid,
        SKFIY_GHOSTTY_READY_MARKER,
        SHELL_READY_OBSERVE_ATTEMPTS
      );
      yield* readRetryEvents(retryReadyResult.retryAttempts, "observation", READY_MARKER_RETRY_REASON);
      before = retryReadyResult.observation;

      if (!retryReadyResult.markerObserved) {
        yield {
          type: "verification_failed",
          stage: "initialize",
          reason: "Ghostty shell ready marker was not observed."
        };
        return;
      }

      const retryBeforeRecovery = decideAppRecovery(before, createGhosttyRecoveryTarget(session.pid));
      if (retryBeforeRecovery.type === "recover") {
        yield {
          type: "recovery_attempted",
          stage: "before",
          action: retryBeforeRecovery.action,
          reason: retryBeforeRecovery.reason
        };

        if (retryBeforeRecovery.action === "open") {
          session = await openGhosttySession(client);
          sessionInitialized = false;
          yield {
            type: "session_opened",
            appName: GHOSTTY_APP_NAME,
            title: session.title,
            pid: session.pid
          };

          if (isAborted(options.signal)) {
            return;
          }
        }

        const retryActivationFailure = await activateGhosttySession(client, session, options.signal);
        if (retryActivationFailure) {
          yield {
            type: "verification_failed",
            stage: "before",
            reason: retryActivationFailure
          };
          return;
        }

        if (retryBeforeRecovery.action === "open") {
          yield {
            type: "app_activated",
            appName: GHOSTTY_APP_NAME,
            bundleId: session.bundleId,
            pid: session.pid
          };

          const retryOpenInitFailure = await initializeGhosttySession(client, options.signal);
          if (retryOpenInitFailure) {
            yield {
              type: "verification_failed",
              stage: "before",
              reason: retryOpenInitFailure
            };
            return;
          }
        }

        if (isAborted(options.signal)) {
          return;
        }

        const recoveredRetryReadyResult = await observeAppUntilMarker(
          client,
          session.bundleId,
          createScreenshotPath("before", options),
          options.signal,
          OBSERVE_RETRY_WAIT_MS,
          session.pid,
          SKFIY_GHOSTTY_READY_MARKER,
          SHELL_READY_OBSERVE_ATTEMPTS
        );
        yield* readRetryEvents(recoveredRetryReadyResult.retryAttempts, "observation", READY_MARKER_RETRY_REASON);
        before = recoveredRetryReadyResult.observation;

        if (!recoveredRetryReadyResult.markerObserved) {
          yield {
            type: "verification_failed",
            stage: "initialize",
            reason: "Ghostty shell ready marker was not observed."
          };
          return;
        }

        const recoveredRetryBeforeRecovery = decideAppRecovery(
          before,
          createGhosttyRecoveryTarget(session.pid)
        );
        if (recoveredRetryBeforeRecovery.type !== "continue") {
          yield {
            type: "verification_failed",
            stage: "before",
            reason: recoveredRetryBeforeRecovery.reason
          };
          return;
        }
      } else if (retryBeforeRecovery.type !== "continue") {
        yield {
          type: "verification_failed",
          stage: "before",
          reason: retryBeforeRecovery.reason
        };
        return;
      }

      const retryBeforeVerificationFailure = readOwnedGhosttySessionFailure(before, session.pid);
      if (retryBeforeVerificationFailure) {
        yield {
          type: "verification_failed",
          stage: "before",
          reason: retryBeforeVerificationFailure
        };
        return;
      }

      if (!sessionInitialized) {
        yield createSessionInitializedEvent();
        sessionInitialized = true;
      }
      yield {
        type: "screenshot_before",
        path: before.screenshotPath,
        observation: before
      };
    }
  }

  const terminalContext = readTerminalContext(before);
  yield {
    type: "terminal_context_observed",
    context: terminalContext
  };
  yield {
    type: "command_preview",
    preview: createTerminalCommandPreview({
      command,
      context: terminalContext,
      risk: effectiveRisk
    })
  };

  const typingResults = await runDesktopActionPlan(
    client,
    [
      { type: "type_text", text: executableCommand },
      { type: "wait", ms: TYPE_SETTLE_WAIT_MS }
    ],
    {
      signal: options.signal,
      verifyStep: verifyHelperAcceptedAction
    }
  );
  assertPlanSucceeded(typingResults);
  yield* readActionVerifiedEvents(typingResults);
  yield {
    type: "typing",
    command
  };

  if (isAborted(options.signal)) {
    return;
  }

  const submitResults = await runDesktopActionPlan(
    client,
    [{ type: "press_key", key: "enter" }],
    {
      signal: options.signal,
      verifyStep: verifyHelperAcceptedAction
    }
  );
  assertPlanSucceeded(submitResults);
  yield* readActionVerifiedEvents(submitResults);
  yield {
    type: "submitted",
    key: "enter"
  };

  if (isAborted(options.signal)) {
    return;
  }

  const afterResult = await observeAppUntilMarker(
    client,
    session.bundleId,
    createScreenshotPath("after", options),
    options.signal,
    SUBMIT_SETTLE_WAIT_MS,
    session.pid,
    completionMarker,
    COMMAND_COMPLETION_OBSERVE_ATTEMPTS
  );
  yield* readRetryEvents(afterResult.retryAttempts, "verification", COMPLETION_MARKER_RETRY_REASON);
  const after = afterResult.observation;
  yield {
    type: "screenshot_after",
    path: after.screenshotPath,
    observation: after
  };

  const afterVerificationFailure = readOwnedGhosttySessionFailure(after, session.pid);
  if (afterVerificationFailure) {
    yield {
      type: "verification_failed",
      stage: "after",
      reason: afterVerificationFailure
    };
    return;
  }

  const commandVerificationFailure = afterResult.markerObserved
    ? undefined
    : readCommandCompletionFailure(after, completionMarker);
  if (commandVerificationFailure) {
    yield {
      type: "verification_failed",
      stage: "after",
      reason: commandVerificationFailure
    };
    return;
  }

  const exitStatusSerial = completionMarker.replace(/^SKFIY_DONE_/, "");
  let exitStatus = readTerminalExitStatus(after, exitStatusSerial);

  if (exitStatus.code === "unknown") {
    yield {
      type: "retry_attempted",
      stage: "verification",
      attempt: 1,
      reason: EXIT_STATUS_RETRY_REASON
    };
    const retriedAfter = await observeApp(
      client,
      session.bundleId,
      createScreenshotPath("after", options),
      options.signal,
      OBSERVE_RETRY_WAIT_MS,
      session.pid
    );
    exitStatus = readTerminalExitStatus(retriedAfter, exitStatusSerial);
  }

  yield {
    type: "completed",
    command,
    summary: exitStatus.code === "unknown"
      ? "Command completed in Ghostty with exit code unknown."
      : `Command completed in Ghostty with exit code ${exitStatus.code}.`,
    exitCode: exitStatus.code
  };
}

export function readGhosttyTaskRisk(input: string): RiskDecision {
  const planned = parseTerminalIntent(input);
  return planned.ok
    ? classifyTerminalCommand(planned.command)
    : blockedDecision(planned.reason);
}

function createCommandCompletionMarker(): string {
  completionMarkerSerial += 1;
  return `SKFIY_DONE_${encodeMarkerSerial(completionMarkerSerial)}`;
}

function createVerifiableTerminalCommand(command: string, completionMarker: string): string {
  const markerSuffix = completionMarker.replace(/^SKFIY_DONE_/, "");
  return `${command}; __skfiy_status="$?"; printf '\\nSKFIY DONE %s STATUS %s\\nSKFIY DONE %s STATUS %s\\n' '${markerSuffix}' "$__skfiy_status" '${markerSuffix}' "$__skfiy_status"`;
}

function createSessionInitializedEvent(): GhosttyTaskEvent {
  return {
    type: "session_initialized",
    title: SKFIY_GHOSTTY_SESSION_TITLE,
    marker: SKFIY_GHOSTTY_SESSION_MARKER
  };
}

function encodeMarkerSerial(value: number): string {
  let n = value;
  let encoded = "";

  while (n > 0) {
    n -= 1;
    encoded = String.fromCharCode(65 + (n % 26)) + encoded;
    n = Math.floor(n / 26);
  }

  return encoded;
}

async function openGhosttySession(client: DesktopClient): Promise<OpenGhosttySessionResult> {
  return readOpenGhosttySessionResult(
    await client.executeAction({ type: "open_ghostty_session", title: SKFIY_GHOSTTY_SESSION_TITLE })
  );
}

async function activateGhosttySession(
  client: DesktopClient,
  session: OpenGhosttySessionResult,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  return readPlanFailure(await runDesktopActionPlan(
    client,
    [{ type: "activate_app", bundleId: session.bundleId, pid: session.pid }],
    { signal }
  ));
}

async function initializeGhosttySession(
  client: DesktopClient,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  return readPlanFailure(await runDesktopActionPlan(
    client,
    [
      { type: "wait", ms: INITIAL_INPUT_FOCUS_SETTLE_WAIT_MS },
      { type: "type_text", text: SKFIY_GHOSTTY_INIT_COMMAND },
      { type: "wait", ms: TYPE_SETTLE_WAIT_MS },
      { type: "press_key", key: "enter" },
      { type: "wait", ms: SESSION_INIT_SETTLE_WAIT_MS }
    ],
    { signal }
  ));
}

async function observeApp(
  client: DesktopClient,
  bundleId: string,
  screenshotOutputPath: string,
  signal: AbortSignal | undefined,
  waitMs = 0,
  pid?: number
): Promise<DesktopAppState> {
  const actions: DesktopAction[] = [];

  if (waitMs > 0) {
    actions.push({ type: "wait", ms: waitMs });
  }

  actions.push({
    type: "observe_app",
    bundleId,
    pid,
    screenshotOutputPath
  });

  const results = await runDesktopActionPlan(client, actions, { signal });
  const observeStep = results.find((step) => step.action.type === "observe_app");

  if (!observeStep) {
    throw new Error("Desktop observe action did not produce a result.");
  }

  const observation = readAppStateResult(observeStep);

  if (isAborted(signal) || !client.ocrImage) {
    return observation;
  }

  try {
    const ocr = await client.ocrImage(observation.screenshotPath);
    return {
      ...observation,
      ocrLabels: ocr.labels
    };
  } catch {
    return observation;
  }
}

async function observeAppUntilMarker(
  client: DesktopClient,
  bundleId: string,
  screenshotOutputPath: string,
  signal: AbortSignal | undefined,
  initialWaitMs: number,
  pid: number | undefined,
  marker: string,
  maxAttempts: number
): Promise<{ observation: DesktopAppState; markerObserved: boolean; retryAttempts: number[] }> {
  let observation = await observeApp(
    client,
    bundleId,
    screenshotOutputPath,
    signal,
    initialWaitMs,
    pid
  );

  if (hasTerminalTextMarker(observation, marker)) {
    return { observation, markerObserved: true, retryAttempts: [] };
  }

  const retryAttempts: number[] = [];
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    if (isAborted(signal)) {
      break;
    }

    retryAttempts.push(attempt);
    observation = await observeApp(
      client,
      bundleId,
      screenshotOutputPath,
      signal,
      OBSERVE_RETRY_WAIT_MS,
      pid
    );

    if (hasTerminalTextMarker(observation, marker)) {
      return { observation, markerObserved: true, retryAttempts };
    }
  }

  return { observation, markerObserved: false, retryAttempts };
}

function readAppStateResult(step: DesktopActionPlanStepResult): DesktopAppState {
  const result = step.result;

  if (isDesktopAppState(result)) {
    return result;
  }

  throw new Error("Desktop observe action returned an invalid app state.");
}

function readOpenGhosttySessionResult(result: DesktopActionResult): OpenGhosttySessionResult {
  if (isOpenGhosttySessionResult(result)) {
    if (result.bundleId !== GHOSTTY_BUNDLE_ID) {
      throw new Error("Opened Ghostty session reported an unexpected bundle id.");
    }

    return result;
  }

  if (isFailedActionResult(result)) {
    throw new Error(result.message ?? "Could not open a skfiy Ghostty session.");
  }

  throw new Error("Desktop open Ghostty action returned an invalid session.");
}

function assertPlanSucceeded(results: readonly DesktopActionPlanStepResult[]): void {
  const failure = readPlanFailure(results);
  if (failure) {
    throw new Error(failure);
  }
}

function readPlanFailure(results: readonly DesktopActionPlanStepResult[]): string | undefined {
  for (const step of results) {
    if (isFailedActionResult(step.result)) {
      return step.result.message ?? `Desktop action failed: ${step.action.type}`;
    }
  }

  return undefined;
}

function verifyHelperAcceptedAction({
  action,
  result
}: {
  action: DesktopAction;
  result: DesktopActionResult;
}): DesktopActionVerification {
  if (isFailedActionResult(result)) {
    return {
      status: "failed",
      reason: result.message ?? `Desktop action failed: ${action.type}`
    };
  }

  return {
    status: "passed",
    message: `${action.type} helper result accepted.`
  };
}

function readActionVerifiedEvents(
  results: readonly DesktopActionPlanStepResult[]
): GhosttyTaskEvent[] {
  return results.flatMap((step) => {
    if (!step.verification || step.action.type === "wait") {
      return [];
    }

    return [{
      type: "action_verified",
      actionType: step.action.type,
      status: step.verification.status,
      message: step.verification.status === "passed" ? step.verification.message : undefined,
      reason: step.verification.status === "passed" ? undefined : step.verification.reason
    }];
  });
}

function* readRetryEvents(
  retryAttempts: readonly number[],
  stage: "observation" | "verification",
  reason: string
): Generator<GhosttyTaskEvent> {
  for (const attempt of retryAttempts) {
    yield { type: "retry_attempted", stage, attempt, reason };
  }
}

function isOpenGhosttySessionResult(
  result: DesktopActionResult
): result is OpenGhosttySessionResult {
  return (
    typeof result === "object"
    && result !== null
    && "opened" in result
    && result.opened === true
    && "bundleId" in result
    && typeof result.bundleId === "string"
    && "title" in result
    && typeof result.title === "string"
    && "pid" in result
    && typeof result.pid === "number"
  );
}

function readOwnedGhosttySessionFailure(
  observation: DesktopAppState,
  expectedPid: number
): string | undefined {
  if (observation.frontmostBundleId && observation.frontmostBundleId !== GHOSTTY_BUNDLE_ID) {
    return "Observed Ghostty window is not frontmost.";
  }

  const windows = observation.windows ?? [];
  const hasUnsafeWindow = windows.some((window) => {
    const title = window.title?.toLowerCase() ?? "";
    return title.includes("codex");
  });

  if (hasUnsafeWindow) {
    return "Observed Ghostty window is not a skfiy-owned session.";
  }

  if (observation.pid === expectedPid) {
    return undefined;
  }

  const hasMarkedWindow = windows.some((window) => {
    const title = window.title?.toLowerCase() ?? "";
    return title.includes(SKFIY_GHOSTTY_SESSION_MARKER);
  });

  if (!hasMarkedWindow) {
    return "Observed Ghostty window is not a skfiy-owned session.";
  }

  return undefined;
}

function readCommandCompletionFailure(
  observation: DesktopAppState,
  completionMarker: string
): string | undefined {
  if (hasTerminalTextMarker(observation, completionMarker)) {
    return undefined;
  }

  return "Command completion marker was not observed in Ghostty output.";
}

function hasTerminalTextMarker(observation: DesktopAppState, marker: string): boolean {
  const normalizedMarker = normalizeTerminalText(marker);

  return (observation.ocrLabels ?? []).some((label) =>
    isTerminalMarkerLabel(label.text, normalizedMarker)
  );
}

function isTerminalMarkerLabel(text: string, normalizedMarker: string): boolean {
  const normalizedText = normalizeTerminalText(text);
  if (normalizedText.length === 0) {
    return false;
  }

  return normalizedText === normalizedMarker || normalizedText.startsWith(normalizedMarker);
}

function isFailedActionResult(
  result: DesktopActionResult
): result is { ok: false; message?: string } {
  return (
    typeof result === "object"
    && result !== null
    && "ok" in result
    && result.ok === false
  );
}

function isDesktopAppState(result: DesktopActionResult): result is DesktopAppState {
  return (
    typeof result === "object"
    && result !== null
    && "bundleId" in result
    && "isRunning" in result
    && "isActive" in result
    && "screenshotPath" in result
  );
}

function createGhosttyRecoveryTarget(pid: number | undefined) {
  return {
    bundleId: GHOSTTY_BUNDLE_ID,
    pid,
    marker: SKFIY_GHOSTTY_SESSION_MARKER,
    sensitiveTitlePatterns: SENSITIVE_GHOSTTY_TITLE_PATTERNS,
    sensitiveTextPatterns: GHOSTTY_SENSITIVE_TEXT_PATTERNS
  };
}

function createScreenshotPath(stage: "before" | "after", options: GhosttyTaskOptions): string {
  return options.createScreenshotPath?.(stage) ?? `/tmp/skfiy-ghostty-${stage}.png`;
}

type RequiredComputerUsePermission = "screenRecording" | "accessibility";

interface MissingComputerUsePermission {
  permission: RequiredComputerUsePermission;
  label: string;
  state: PermissionSummary[RequiredComputerUsePermission]["state"];
}

async function readMissingComputerUsePermissions(
  client: DesktopClient
): Promise<MissingComputerUsePermission[]> {
  if (!client.getPermissions) {
    return [];
  }

  const permissions = await client.getPermissions();
  return REQUIRED_COMPUTER_USE_PERMISSIONS.flatMap((permission) => {
    const state = permissions[permission].state;
    if (state === "granted") {
      return [];
    }

    return [{
      permission,
      label: COMPUTER_USE_PERMISSION_LABELS[permission],
      state
    }];
  });
}

const REQUIRED_COMPUTER_USE_PERMISSIONS: readonly RequiredComputerUsePermission[] = [
  "screenRecording",
  "accessibility"
];

const COMPUTER_USE_PERMISSION_LABELS: Record<RequiredComputerUsePermission, string> = {
  screenRecording: "Screen Recording",
  accessibility: "Accessibility"
};

function createPermissionFailureReason(
  missingPermissions: readonly MissingComputerUsePermission[]
): string {
  const details = missingPermissions
    .map((permission) => `${permission.label} is ${permission.state}`)
    .join("; ");

  return `Computer Use permissions required: ${details}. Grant them to skfiy.app in System Settings, then retry.`;
}

async function readDesktopSessionFailure(client: DesktopClient): Promise<string | undefined> {
  if (!client.getDesktopSessionStatus) {
    return undefined;
  }

  const diagnostics = createDesktopSessionDiagnostics(await client.getDesktopSessionStatus());
  return diagnostics.state === "blocked" ? diagnostics.reason : undefined;
}

function blockedDecision(reason: string): RiskDecision {
  return {
    level: "blocked",
    reason,
    requiresApproval: true
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
