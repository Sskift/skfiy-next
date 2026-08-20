/**
 * Loopback Control Client — the HTTP client the CLI and MCP server use to
 * reach a running skfiy app's token-authenticated loopback control server.
 *
 * Live commands (status task control, observation, replay, approve, stop)
 * require this channel because taskControlStore and turnReplayStore are
 * in-memory. Read-only commands (doctor/export/capabilities/restore-preview)
 * work offline via file reads and never touch this client.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CONTROL_CONTRACT_SCHEMA_VERSION,
  CONTROL_TOKEN_FILENAME,
  CONTROL_TOKEN_HEADER,
  type ControlApproveRequest,
  type ControlApproveResult,
  type ControlStopResult,
  type ControlTokenFile
} from "../shared/control-contract.js";
import type { TaskControlSnapshot } from "../shared/task-control.js";
import type { TurnReplay } from "../main/computer-use/turn-replay-store.js";

export class ControlClientError extends Error {
  readonly code: "app-not-running" | "unauthorized" | "internal";
  readonly status?: number;

  constructor(
    code: "app-not-running" | "unauthorized" | "internal",
    message: string,
    status?: number
  ) {
    super(message);
    this.name = "ControlClientError";
    this.code = code;
    this.status = status;
  }
}

export interface ControlClient {
  /** Throws ControlClientError("app-not-running") when the app is unreachable. */
  readTaskControl(): Promise<TaskControlSnapshot | null>;
  readTurnReplay(): Promise<TurnReplay | null>;
  approveTask(request: ControlApproveRequest): Promise<ControlApproveResult>;
  stopTask(reason?: string): Promise<ControlStopResult>;
  /** Lightweight reachability check used by status/readiness. */
  ping(): Promise<boolean>;
}

export interface LoopbackControlClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createLoopbackControlClient({
  baseUrl,
  token,
  fetchImpl,
  timeoutMs = 3_000
}: LoopbackControlClientOptions): ControlClient {
  const doFetch = fetchImpl ?? fetch;

  async function request<T>(
    method: "GET" | "POST",
    route: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${route}`, {
        method,
        headers: {
          [CONTROL_TOKEN_HEADER]: token,
          ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
    } catch (error) {
      throw new ControlClientError(
        "app-not-running",
        `skfiy app is not reachable at ${baseUrl}: ${readErrorMessage(error)}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      throw new ControlClientError(
        "unauthorized",
        "skfiy control token was rejected. Restart the skfiy app and retry.",
        response.status
      );
    }
    if (!response.ok) {
      throw new ControlClientError(
        "internal",
        `skfiy control server returned HTTP ${response.status}.`,
        response.status
      );
    }
    return (await response.json()) as T;
  }

  return {
    readTaskControl: () => request<TaskControlSnapshot | null>("GET", "/task-control"),
    readTurnReplay: () => request<TurnReplay | null>("GET", "/turn-replay"),
    approveTask: (approval) =>
      request<ControlApproveResult>("POST", "/approve-task", approval),
    stopTask: (reason) =>
      request<ControlStopResult>("POST", "/stop-task", { ...(reason ? { reason } : {}) }),
    async ping(): Promise<boolean> {
      try {
        await request("GET", "/health");
        return true;
      } catch {
        return false;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Token file discovery
// ---------------------------------------------------------------------------

export function createControlTokenPath(appSupportDir: string): string {
  return path.join(appSupportDir, CONTROL_TOKEN_FILENAME);
}

/**
 * Reads the per-launch control token file the app writes to app-support.
 * Returns null when the file is absent or malformed (app not running, or an
 * older app that does not publish a control server).
 */
export function readControlTokenFile(
  appSupportDir: string,
  io: { exists?: (targetPath: string) => boolean; readFile?: (targetPath: string) => string } = {}
): ControlTokenFile | null {
  const exists = io.exists ?? ((targetPath: string) => fs.existsSync(targetPath));
  const readFile = io.readFile ?? ((targetPath: string) => fs.readFileSync(targetPath, "utf8"));
  const tokenPath = createControlTokenPath(appSupportDir);
  if (!exists(tokenPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFile(tokenPath)) as unknown;
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.schemaVersion !== CONTROL_CONTRACT_SCHEMA_VERSION
      || typeof record.url !== "string"
      || record.url.length === 0
      || typeof record.token !== "string"
      || record.token.length === 0
      || typeof record.createdAt !== "string"
      || typeof record.pid !== "number"
    ) {
      return null;
    }
    return {
      schemaVersion: CONTROL_CONTRACT_SCHEMA_VERSION,
      url: record.url,
      token: record.token,
      createdAt: record.createdAt,
      pid: record.pid
    };
  } catch {
    return null;
  }
}

/**
 * Builds a loopback client from the well-known token file, honoring
 * --control-url/--control-token overrides for testing. Returns null when no
 * token file exists (the app is not running).
 */
export function createLoopbackControlClientFromHome(
  appSupportDir: string,
  overrides: {
    controlUrl?: string;
    controlToken?: string;
    fetchImpl?: typeof fetch;
  } = {}
): ControlClient | null {
  if (overrides.controlUrl && overrides.controlToken) {
    return createLoopbackControlClient({
      baseUrl: overrides.controlUrl,
      token: overrides.controlToken,
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {})
    });
  }
  const tokenFile = readControlTokenFile(appSupportDir);
  if (!tokenFile) {
    return null;
  }
  return createLoopbackControlClient({
    baseUrl: overrides.controlUrl ?? tokenFile.url,
    token: overrides.controlToken ?? tokenFile.token,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {})
  });
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
