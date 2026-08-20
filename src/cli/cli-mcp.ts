/**
 * CLI MCP — the `skfiy mcp serve` command.
 *
 * The CLI process becomes the MCP stdio server. Providers bridge to the app
 * via the loopback control API (live state) and file reads + pure factories
 * (offline state). The server runs until stdin closes.
 */

import { runSkfiyMcpStdioServer } from "../mcp/skfiy-mcp-server.js";
import { createLoopbackMcpProviders } from "../mcp/mcp-providers.js";
import { readRuntimeSnapshotPanels } from "../main/runtime-snapshot.js";
import { runCapabilitiesCommand } from "./cli-capabilities.js";
import {
  createLoopbackControlClientFromHome,
  type ControlClient
} from "./control-client.js";
import { ControlClientError } from "./control-client.js";

export interface CliMcpServeDeps {
  readonly homeDir: string;
  readonly appSupportDir: string;
  readonly appVersion: string;
  readonly stdin: Parameters<typeof runSkfiyMcpStdioServer>[0]["stdin"];
  readonly stdout: { write: (chunk: string) => unknown };
  readonly stderr: { write: (chunk: string) => unknown };
  readonly exists: (targetPath: string) => boolean;
  readonly readFile: (targetPath: string) => string;
  readonly controlClient?: ControlClient | null;
  readonly fetchImpl?: typeof fetch;
}

export async function runMcpServeCommand(deps: CliMcpServeDeps): Promise<number> {
  const controlClient = deps.controlClient === undefined
    ? createLoopbackControlClientFromHome(deps.appSupportDir, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
      })
    : deps.controlClient;

  if (!controlClient) {
    // The MCP server still starts; live tools return app-not-running errors
    // until the app publishes a control token.
    deps.stderr.write(
      "skfiy app is not running; live MCP tools will return app-not-running errors.\n"
    );
  }

  const providers = createLoopbackMcpProviders({
    controlClient: controlClient ?? createUnavailableControlClient(),
    readRuntimePanels: () =>
      readRuntimeSnapshotPanels({
        homeDir: deps.homeDir,
        io: { exists: deps.exists, readFile: deps.readFile }
      }),
    readCapabilities: () => {
      const result = runCapabilitiesCommand({});
      return result.ok ? result.data.adapters : [];
    }
  });

  return runSkfiyMcpStdioServer({
    stdin: deps.stdin,
    stdout: deps.stdout,
    stderr: deps.stderr,
    providers,
    appVersion: deps.appVersion
  });
}

/** A control client that fails every live call with app-not-running. */
function createUnavailableControlClient(): ControlClient {
  const unavailable = async (): Promise<never> => {
    throw new ControlClientError(
      "app-not-running",
      "skfiy app is not running. Start the skfiy app and retry."
    );
  };
  return {
    readTaskControl: unavailable,
    readTurnReplay: unavailable,
    approveTask: unavailable,
    stopTask: unavailable,
    ping: async () => false
  };
}
