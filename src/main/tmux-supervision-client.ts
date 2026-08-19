import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createTmuxSupervisionReport,
  parseTmuxPaneList,
  type TmuxSupervisionReport
} from "./computer-use/tmux-supervisor.js";

const execFileAsync = promisify(execFile);
const TMUX_WINDOW_FORMAT = [
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{window_active}",
  "#{window_panes}"
].join("\t");
const TMUX_PANE_FORMAT = [
  "#{session_name}",
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_active}",
  "#{pane_dead}",
  "#{pane_current_command}",
  "#{pane_title}"
].join("\t");

export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunTmuxCommand = (
  args: string[],
  options?: { allowFailure?: boolean }
) => Promise<TmuxCommandResult>;

export interface CreateTmuxSupervisionClientOptions {
  tailLines?: number;
  runTmux?: RunTmuxCommand;
}

export interface TmuxSupervisionClient {
  observeSession(sessionName: string): Promise<TmuxSupervisionReport>;
}

export function createTmuxSupervisionClient({
  tailLines = 120,
  runTmux = createDefaultTmuxRunner()
}: CreateTmuxSupervisionClientOptions = {}): TmuxSupervisionClient {
  return {
    async observeSession(sessionName: string): Promise<TmuxSupervisionReport> {
      const sessionProbe = await runTmux(["has-session", "-t", sessionName], {
        allowFailure: true
      });

      if (sessionProbe.exitCode !== 0) {
        return createTmuxSupervisionReport({
          sessionName,
          hasSession: false,
          commandError: sessionProbe.stderr
        });
      }

      const windows = await runTmux([
        "list-windows",
        "-t",
        sessionName,
        "-F",
        TMUX_WINDOW_FORMAT
      ]);
      const panes = await runTmux([
        "list-panes",
        "-t",
        sessionName,
        "-s",
        "-F",
        TMUX_PANE_FORMAT
      ]);
      const paneStates = parseTmuxPaneList(panes.stdout);
      const paneTails: Record<string, string | undefined> = {};

      for (const pane of paneStates) {
        const tail = await runTmux([
          "capture-pane",
          "-p",
          "-t",
          pane.id,
          "-S",
          `-${tailLines}`
        ], {
          allowFailure: true
        });
        paneTails[pane.id] = tail.exitCode === 0 ? tail.stdout : tail.stderr;
      }

      return createTmuxSupervisionReport({
        sessionName,
        hasSession: true,
        windowsOutput: windows.stdout,
        panesOutput: panes.stdout,
        paneTails
      });
    }
  };
}

function createDefaultTmuxRunner(): RunTmuxCommand {
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
        stderr: stringifyCommandOutput(failure.stderr) || failure.message || "tmux command failed."
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
