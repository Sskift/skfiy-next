/**
 * skfiy MCP Server — stdio JSON-RPC 2.0, line-delimited JSON.
 *
 * Ported from the old repo's 300-line skeleton: initialize / tools-list /
 * tools-call, -32601 for unknown methods, -32602 for unknown tools. The
 * server is a thin dispatch layer over injected SkfiyMcpProviders so it is
 * testable without a live app.
 *
 * SAFETY: there is no execute/inject tool. The only mutation tools are
 * approved_action (resume an app-raised approval) and stop (cancel). Both
 * are gated by the app's own task-control state machine.
 */

import {
  SKFIY_MCP_SAFETY_INSTRUCTIONS,
  SKFIY_MCP_TOOL_NAMES,
  createSkfiyMcpToolDefinitions,
  type SkfiyMcpToolDefinition
} from "./mcp-tools.js";
import type { SkfiyMcpProviders } from "./mcp-providers.js";
import { isControlApproveRequest } from "../shared/control-contract.js";
import type { ControlApproveRequest } from "../shared/control-contract.js";

export const SKFIY_MCP_PROTOCOL_VERSION = "2024-11-05";
export const SKFIY_MCP_SERVER_NAME = "skfiy";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      result: Record<string, unknown>;
    }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string };
    };

export interface SkfiyMcpStdioServerInput {
  stdin: AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer | Uint8Array | string>;
  stdout: { write: (chunk: string) => unknown };
  stderr: { write: (chunk: string) => unknown };
  providers: SkfiyMcpProviders;
  appVersion: string;
}

export function createSkfiyMcpInitializeResult(appVersion: string) {
  return {
    protocolVersion: SKFIY_MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: SKFIY_MCP_SERVER_NAME,
      version: appVersion
    },
    instructions: SKFIY_MCP_SAFETY_INSTRUCTIONS,
    capabilities: {
      tools: {
        listChanged: false
      }
    }
  };
}

export async function handleSkfiyMcpRequest(
  request: JsonRpcRequest,
  providers: SkfiyMcpProviders,
  appVersion: string
): Promise<JsonRpcResponse> {
  const id = request.id ?? null;

  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: createSkfiyMcpInitializeResult(appVersion)
    };
  }

  if (request.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: createSkfiyMcpToolDefinitions().map((tool: SkfiyMcpToolDefinition) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations
        }))
      }
    };
  }

  if (request.method === "tools/call") {
    return handleToolCall(id, request.params, providers);
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Unsupported skfiy MCP method: ${request.method}`
    }
  };
}

async function handleToolCall(
  id: string | number | null,
  params: unknown,
  providers: SkfiyMcpProviders
): Promise<JsonRpcResponse> {
  const record = readRecord(params);
  const toolName = typeof record?.name === "string" ? record.name : "";
  const input = readRecord(record?.arguments) ?? {};

  if (!SKFIY_MCP_TOOL_NAMES.includes(toolName as (typeof SKFIY_MCP_TOOL_NAMES)[number])) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: `Unknown skfiy MCP tool: ${toolName}`
      }
    };
  }

  try {
    const structuredContent = await dispatchToolCall(toolName, input, providers);
    return createToolResult(id, structuredContent);
  } catch (error) {
    return createToolErrorResult(id, error);
  }
}

async function dispatchToolCall(
  toolName: string,
  input: Record<string, unknown>,
  providers: SkfiyMcpProviders
): Promise<unknown> {
  switch (toolName) {
    case "skfiy.status":
      return providers.readStatus({
        ...(input.includeTaskControl === true ? { includeTaskControl: true } : {})
      });
    case "skfiy.observation": {
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
        ? input.limit
        : undefined;
      return providers.readObservation({ ...(limit !== undefined ? { limit } : {}) });
    }
    case "skfiy.approved_action": {
      if (!isControlApproveRequest(input)) {
        throw new Error(
          "approved_action requires decision (approve|deny), executionId, planId, and gate."
        );
      }
      const request: ControlApproveRequest = {
        decision: input.decision,
        executionId: input.executionId,
        planId: input.planId,
        gate: input.gate
      };
      return providers.approveAction(request);
    }
    case "skfiy.stop": {
      const reason = typeof input.reason === "string" ? input.reason : undefined;
      return providers.stopTask({ ...(reason ? { reason } : {}) });
    }
    case "skfiy.replay": {
      const turnId = typeof input.turnId === "string" ? input.turnId : undefined;
      return providers.readReplay({ ...(turnId ? { turnId } : {}) });
    }
    default:
      throw new Error(`Unknown skfiy MCP tool: ${toolName}`);
  }
}

export async function runSkfiyMcpStdioServer({
  stdin,
  stdout,
  stderr,
  providers,
  appVersion
}: SkfiyMcpStdioServerInput): Promise<number> {
  let pending = "";
  let exitCode = 0;

  for await (const chunk of stdin) {
    pending += decodeStdioChunk(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines) {
      const result = await handleStdioLine(line, providers, appVersion, stdout, stderr);
      if (result !== 0) {
        exitCode = result;
      }
    }
  }

  if (pending.trim().length > 0) {
    const result = await handleStdioLine(pending, providers, appVersion, stdout, stderr);
    if (result !== 0) {
      exitCode = result;
    }
  }

  return exitCode;
}

async function handleStdioLine(
  line: string,
  providers: SkfiyMcpProviders,
  appVersion: string,
  stdout: { write: (chunk: string) => unknown },
  stderr: { write: (chunk: string) => unknown }
): Promise<number> {
  const trimmed = line.trim();
  if (!trimmed) {
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    // A malformed line is a client protocol error: log it and keep serving.
    // The server process itself stays healthy (exit 0).
    stderr.write(`Invalid MCP JSON-RPC message: ${readErrorMessage(error)}\n`);
    return 0;
  }

  const request = readJsonRpcRequest(parsed);
  if (!request) {
    stderr.write("Invalid MCP JSON-RPC message: expected a JSON-RPC 2.0 request object.\n");
    return 1;
  }

  // Notifications (no id) receive no response.
  if (request.id === undefined || request.id === null) {
    return 0;
  }

  const response = await handleSkfiyMcpRequest(request, providers, appVersion);
  stdout.write(`${JSON.stringify(response)}\n`);
  return 0;
}

function readJsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
  const record = readRecord(value);
  if (record?.jsonrpc !== "2.0" || typeof record.method !== "string") {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    id: typeof record.id === "string" || typeof record.id === "number" || record.id === null
      ? record.id
      : undefined,
    method: record.method,
    ...(Object.hasOwn(record, "params") ? { params: record.params } : {})
  };
}

function createToolResult(
  id: string | number | null,
  structuredContent: unknown
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent)
        }
      ],
      structuredContent
    }
  };
}

function createToolErrorResult(
  id: string | number | null,
  error: unknown
): JsonRpcResponse {
  const message = readErrorMessage(error);
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message })
        }
      ],
      structuredContent: { error: message }
    }
  };
}

function decodeStdioChunk(chunk: Buffer | Uint8Array | string): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
