/**
 * Control Server — the token-authenticated loopback HTTP server that lets
 * the standalone CLI and MCP server reach a running skfiy app.
 *
 * PERMISSION BOUNDARY BY CONSTRUCTION:
 * - Binds 127.0.0.1 only. Never reachable from the network.
 * - Every request requires the per-launch bearer token (mode 0600 file in
 *   app-support). A missing/wrong token is a 401.
 * - `approve-task` validates the request against the live pending approval
 *   and task control state with readControlApprovalMismatch — the SAME
 *   validation as the skfiy:approve-task IPC handler. It cannot inject
 *   commands: the request only carries decision/executionId/planId/gate.
 * - `stop-task` reuses createStopTaskEventDecision (in the live closure) and
 *   is idempotent.
 * - There is no execute/inject route. The adapter run() generator is never
 *   reachable from this surface.
 *
 * This module is pure TypeScript (node:http only, no Electron imports) so it
 * is testable in isolation. The Electron main process wires the `live`
 * closures to its in-memory stores and IPC logic.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CONTROL_TOKEN_HEADER,
  isControlApproveRequest,
  isControlStopRequest,
  readControlApprovalMismatch,
  type ControlApproveRequest,
  type ControlApproveResult,
  type ControlApprovalState,
  type ControlStopResult,
  type ControlTokenFile
} from "../shared/control-contract.js";
import type { TaskControlSnapshot } from "../shared/task-control.js";
import type { TurnReplay } from "./computer-use/turn-replay-store.js";

export const CONTROL_SERVER_HOST = "127.0.0.1";

export interface ControlServerLive {
  readTaskControl(): TaskControlSnapshot | null | Promise<TaskControlSnapshot | null>;
  readTurnReplay(): TurnReplay | null | Promise<TurnReplay | null>;
  readApprovalState(): ControlApprovalState | Promise<ControlApprovalState>;
  resumeTask(request: ControlApproveRequest): Promise<TaskControlSnapshot | null>;
  denyTask(request: ControlApproveRequest): Promise<TaskControlSnapshot | null>;
  stopTask(reason?: string): Promise<ControlStopResult>;
}

export interface ControlServerDeps {
  token: string;
  live: ControlServerLive;
  logger?: (message: string) => void;
}

export interface ControlServerHandle {
  readonly server: Server;
  /** Starts listening on 127.0.0.1 with an ephemeral port. */
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  readonly port: number | null;
}

export function createControlServer(deps: ControlServerDeps): ControlServerHandle {
  const server = createServer((req, res) => {
    void handleControlRequest(req, res, deps);
  });

  let port: number | null = null;

  return {
    server,
    get port() {
      return port;
    },
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, CONTROL_SERVER_HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Control server failed to bind a TCP port.");
      }
      port = address.port;
      return { url: `http://${CONTROL_SERVER_HOST}:${address.port}`, port: address.port };
    },
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      port = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Request handling (exported for direct testing)
// ---------------------------------------------------------------------------

export async function handleControlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = `${req.method ?? "GET"} ${url.pathname}`;

  if (!isAuthorized(req, deps.token)) {
    respondJson(res, 401, { error: { code: "unauthorized", message: "Missing or invalid control token." } });
    return;
  }

  try {
    switch (route) {
      case "GET /health":
        respondJson(res, 200, { ok: true });
        return;

      case "GET /task-control": {
        const snapshot = await deps.live.readTaskControl();
        respondJson(res, 200, snapshot);
        return;
      }

      case "GET /turn-replay": {
        const replay = await deps.live.readTurnReplay();
        respondJson(res, 200, replay);
        return;
      }

      case "POST /approve-task": {
        const body = await readJsonBody(req);
        if (!isControlApproveRequest(body)) {
          respondJson(res, 400, {
            error: {
              code: "invalid-request",
              message: "approve-task requires decision, executionId, planId, and gate."
            }
          });
          return;
        }
        const state = await deps.live.readApprovalState();
        const mismatch = readControlApprovalMismatch(body, state);
        if (mismatch) {
          const result: ControlApproveResult = { result: "mismatch", message: mismatch };
          respondJson(res, 200, result);
          return;
        }
        if (!state.pendingApproval) {
          const result: ControlApproveResult = { result: "no-pending-approval" };
          respondJson(res, 200, result);
          return;
        }
        const taskControl = body.decision === "deny"
          ? await deps.live.denyTask(body)
          : await deps.live.resumeTask(body);
        const result: ControlApproveResult = { result: body.decision === "deny" ? "denied" : "resumed", taskControl };
        respondJson(res, 200, result);
        return;
      }

      case "POST /stop-task": {
        const body = await readJsonBody(req);
        const reason = isControlStopRequest(body) ? body.reason : undefined;
        const result = await deps.live.stopTask(reason);
        respondJson(res, 200, result);
        return;
      }

      default:
        respondJson(res, 404, { error: { code: "not-found", message: `Unknown control route: ${route}` } });
    }
  } catch (error) {
    deps.logger?.(error instanceof Error ? error.message : String(error));
    respondJson(res, 500, {
      error: { code: "internal", message: error instanceof Error ? error.message : String(error) }
    });
  }
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const presented = req.headers[CONTROL_TOKEN_HEADER];
  const value = Array.isArray(presented) ? presented[0] : presented;
  return typeof value === "string" && value.length > 0 && value === token;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}

// ---------------------------------------------------------------------------
// Token generation and token file IO
// ---------------------------------------------------------------------------

export function generateControlToken(): string {
  return randomBytes(32).toString("hex");
}

export function createControlTokenPath(appSupportDir: string): string {
  return path.join(appSupportDir, "control-token.json");
}

export function writeControlTokenFile(
  appSupportDir: string,
  input: { url: string; token: string; pid?: number; now?: () => Date },
  io: {
    exists?: (targetPath: string) => boolean;
    mkdir?: (targetPath: string) => void;
    writeFile?: (targetPath: string, content: string, mode?: number) => void;
  } = {}
): ControlTokenFile {
  const exists = io.exists ?? existsSync;
  const mkdir = io.mkdir ?? ((targetPath: string) => mkdirSync(targetPath, { recursive: true }));
  const writeFile = io.writeFile ?? ((targetPath: string, content: string) => {
    writeFileSync(targetPath, content, { mode: 0o600 });
  });
  if (!exists(appSupportDir)) {
    mkdir(appSupportDir);
  }
  const tokenFile: ControlTokenFile = {
    schemaVersion: 1,
    url: input.url,
    token: input.token,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    pid: input.pid ?? process.pid
  };
  writeFile(createControlTokenPath(appSupportDir), `${JSON.stringify(tokenFile, null, 2)}\n`, 0o600);
  return tokenFile;
}

export function removeControlTokenFile(
  appSupportDir: string,
  io: { exists?: (targetPath: string) => boolean; rm?: (targetPath: string) => void } = {}
): void {
  const exists = io.exists ?? existsSync;
  const rm = io.rm ?? ((targetPath: string) => rmSync(targetPath, { force: true }));
  const tokenPath = createControlTokenPath(appSupportDir);
  if (exists(tokenPath)) {
    rm(tokenPath);
  }
}
