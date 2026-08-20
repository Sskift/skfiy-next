import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  boundRecoveryString,
  DEFAULT_TMUX_RECOVERY_STEP_CATALOG,
  MAX_RECOVERY_KEYS,
  MAX_RECOVERY_OUTCOME_LENGTH,
  MAX_SUMMARY_CHARACTERS,
  type TmuxRecoveryOutcome,
  type TmuxRecoveryStepCatalog
} from "./computer-use/tmux-recovery.js";
import type { RunTmuxCommand } from "./tmux-supervision-client.js";

const execFileAsync = promisify(execFile);

/**
 * The mutating tmux surface. Deliberately separate from
 * TmuxSupervisionClient (which only observes) so the read-only and mutating
 * paths cannot be conflated by the type system.
 */
export interface TmuxRecoveryClient {
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

export interface CreateTmuxRecoveryClientOptions {
  catalog?: TmuxRecoveryStepCatalog;
  runTmux?: RunTmuxCommand;
  tailLines?: number;
  now?: () => string;
}

export function createTmuxRecoveryClient({
  catalog = DEFAULT_TMUX_RECOVERY_STEP_CATALOG,
  runTmux = createDefaultRecoveryTmuxRunner(),
  tailLines = 200,
  now = () => new Date().toISOString()
}: CreateTmuxRecoveryClientOptions = {}): TmuxRecoveryClient {
  function failure(
    actionId: string,
    error: string,
    retryable: boolean
  ): TmuxRecoveryOutcome {
    return {
      ok: false,
      actionId,
      at: now(),
      error: boundRecoveryString(error, MAX_RECOVERY_OUTCOME_LENGTH),
      retryable
    };
  }

  function success(actionId: string, result: string): TmuxRecoveryOutcome {
    return {
      ok: true,
      actionId,
      at: now(),
      result: boundRecoveryString(result, MAX_RECOVERY_OUTCOME_LENGTH)
    };
  }

  return {
    async sendInput(actionId, paneId, keys) {
      if (keys.length === 0 || keys.length > MAX_RECOVERY_KEYS) {
        throw new Error(
          `send_input keys must be 1..${MAX_RECOVERY_KEYS} characters.`
        );
      }
      // Literal mode (-l): tmux sends the keys verbatim, no shell interpretation.
      const result = await runTmux(
        ["send-keys", "-l", "-t", paneId, "--", keys],
        { allowFailure: true }
      );
      if (result.exitCode !== 0) {
        return failure(actionId, result.stderr || "tmux send-keys failed.", true);
      }
      return success(actionId, `Sent ${keys.length} character(s) to ${paneId}.`);
    },

    async restartStep(actionId, stepId, target) {
      const command = catalog[stepId];
      if (!command) {
        // Rejected before tmux is ever invoked.
        throw new Error(`Unknown tmux recovery step: ${stepId}`);
      }
      const sessionProbe = await runTmux(
        ["has-session", "-t", target.sessionName],
        { allowFailure: true }
      );
      const argv = sessionProbe.exitCode === 0
        ? target.paneId
          ? ["respawn-pane", "-k", "-t", target.paneId, command]
          : ["respawn-pane", "-k", "-t", target.sessionName, command]
        : ["new-session", "-d", "-s", target.sessionName, command];
      const result = await runTmux(argv, { allowFailure: true });
      if (result.exitCode !== 0) {
        return failure(actionId, result.stderr || `tmux restart of ${stepId} failed.`, true);
      }
      return success(actionId, `Restarted registered step ${stepId} in ${target.sessionName}.`);
    },

    async collectSummary(actionId, paneId, maxTailCharacters) {
      if (maxTailCharacters < 1 || maxTailCharacters > MAX_SUMMARY_CHARACTERS) {
        throw new Error(
          `collect_summary maxTailCharacters must be 1..${MAX_SUMMARY_CHARACTERS}.`
        );
      }
      const result = await runTmux(
        ["capture-pane", "-p", "-t", paneId, "-S", `-${tailLines}`],
        { allowFailure: true }
      );
      if (result.exitCode !== 0) {
        return failure(actionId, result.stderr || "tmux capture-pane failed.", true);
      }
      return success(
        actionId,
        boundRecoveryString(result.stdout, maxTailCharacters)
      );
    }
  };
}

export function createDefaultRecoveryTmuxRunner(): RunTmuxCommand {
  return async (args, options = {}) => {
    try {
      const result = await execFileAsync("tmux", args, {
        maxBuffer: 4 * 1024 * 1024
      });
      return {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr
      };
    } catch (error) {
      const failure = error as {
        code?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      if (!options.allowFailure) {
        throw error;
      }
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: stringifyCommandOutput(failure.stdout),
        stderr:
          stringifyCommandOutput(failure.stderr)
          || failure.message
          || "tmux command failed."
      };
    }
  };
}

function stringifyCommandOutput(value: string | Buffer | undefined): string {
  if (!value) {
    return "";
  }
  return typeof value === "string" ? value : value.toString("utf8");
}
