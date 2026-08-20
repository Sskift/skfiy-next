import { describe, expect, it } from "vitest";
import {
  handleSkfiyMcpRequest,
  runSkfiyMcpStdioServer,
  SKFIY_MCP_PROTOCOL_VERSION,
  type JsonRpcRequest
} from "./skfiy-mcp-server.js";
import { SKFIY_MCP_TOOL_NAMES, createSkfiyMcpToolDefinitions } from "./mcp-tools.js";
import type { SkfiyMcpProviders } from "./mcp-providers.js";
import { CONTROL_APPROVAL_MISMATCH_MESSAGE } from "../shared/control-contract.js";

function createFakeProviders(overrides: Partial<SkfiyMcpProviders> = {}): SkfiyMcpProviders {
  return {
    readStatus: async () => ({
      schemaVersion: 1,
      readiness: { state: "ready" as const },
      runtime: {
        currentTurn: { state: "idle" },
        replay: { state: "empty" }
      },
      capabilities: [{ id: "ghostty", capabilityCount: 4 }]
    }),
    readObservation: async () => ({
      schemaVersion: 1,
      status: "idle",
      timelineTail: []
    }),
    approveAction: async () => ({
      schemaVersion: 1,
      result: "resumed",
      taskControl: null
    }),
    stopTask: async () => ({
      schemaVersion: 1,
      result: "no-active-task",
      stopDecision: { cancellationReason: "Task stopped.", delivery: "transient", route: null },
      taskControl: null
    }),
    readReplay: async () => ({
      schemaVersion: 1,
      replay: {
        transcript: { outcome: "idle", actions: [], screenshots: [] },
        timeline: []
      }
    }),
    ...overrides
  };
}

async function callTool(
  providers: SkfiyMcpProviders,
  name: string,
  args: Record<string, unknown>
) {
  const response = await handleSkfiyMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    providers,
    "0.1.0"
  );
  return response as unknown as { result: { structuredContent: unknown; isError: boolean } };
}

describe("skfiy MCP server", () => {
  it("initialize returns protocolVersion, serverInfo, instructions, and capabilities", async () => {
    const response = await handleSkfiyMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      createFakeProviders(),
      "0.1.0"
    );
    const result = (response as { result: Record<string, unknown> }).result;
    expect(result.protocolVersion).toBe(SKFIY_MCP_PROTOCOL_VERSION);
    expect(result.serverInfo).toEqual({ name: "skfiy", version: "0.1.0" });
    expect(typeof result.instructions).toBe("string");
    expect((result.instructions as string).length).toBeGreaterThan(0);
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it("tools/list returns exactly the 5 tools with inputSchema and annotations", async () => {
    const response = await handleSkfiyMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      createFakeProviders(),
      "0.1.0"
    );
    const result = (response as unknown as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }).result;
    expect(result.tools.map((tool) => tool.name)).toEqual([...SKFIY_MCP_TOOL_NAMES]);

    const readOnlyTools = new Set(["skfiy.status", "skfiy.observation", "skfiy.replay"]);
    for (const tool of result.tools) {
      expect(tool.annotations.readOnlyHint).toBe(readOnlyTools.has(tool.name));
    }
  });

  it("approved_action inputSchema has no command/input/action field (cannot inject commands)", () => {
    const definitions = createSkfiyMcpToolDefinitions();
    const approvedAction = definitions.find((tool) => tool.name === "skfiy.approved_action");
    expect(approvedAction).toBeDefined();
    const properties = (approvedAction!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["decision", "executionId", "gate", "planId"]);
    expect(properties).not.toHaveProperty("command");
    expect(properties).not.toHaveProperty("input");
    expect(properties).not.toHaveProperty("action");
  });

  it("tools/call skfiy.status returns the provider result", async () => {
    const response = await callTool(createFakeProviders(), "skfiy.status", {});
    const structured = response.result.structuredContent as { readiness: { state: string } };
    expect(structured.readiness.state).toBe("ready");
  });

  it("tools/call skfiy.approved_action with a mismatched planId returns the typed mismatch", async () => {
    const providers = createFakeProviders({
      approveAction: async () => ({
        schemaVersion: 1,
        result: "mismatch",
        message: CONTROL_APPROVAL_MISMATCH_MESSAGE
      })
    });
    const response = await callTool(providers, "skfiy.approved_action", {
      decision: "approve",
      executionId: "exec-stale",
      planId: "plan-stale",
      gate: "action-plan"
    });
    const structured = response.result.structuredContent as { result: string; message: string };
    expect(structured.result).toBe("mismatch");
    expect(structured.message).toBe(CONTROL_APPROVAL_MISMATCH_MESSAGE);
  });

  it("tools/call skfiy.stop with no active task returns no-active-task (idempotent, not error)", async () => {
    const response = await callTool(createFakeProviders(), "skfiy.stop", {});
    const structured = response.result.structuredContent as { result: string };
    expect(structured.result).toBe("no-active-task");
    expect(response.result.isError).toBe(false);
  });

  it("unknown tool returns -32602", async () => {
    const response = await handleSkfiyMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "skfiy.execute" } },
      createFakeProviders(),
      "0.1.0"
    );
    expect((response as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("unknown method returns -32601", async () => {
    const response = await handleSkfiyMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      createFakeProviders(),
      "0.1.0"
    );
    expect((response as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("malformed JSON line writes to stderr and the server continues", async () => {
    const stdin = (async function* () {
      yield "{ not json\n";
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n";
    })();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const exitCode = await runSkfiyMcpStdioServer({
      stdin,
      stdout: { write: (chunk: string) => { stdoutChunks.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { stderrChunks.push(chunk); return true; } },
      providers: createFakeProviders(),
      appVersion: "0.1.0"
    });

    expect(exitCode).toBe(0);
    expect(stderrChunks.join("")).toContain("Invalid MCP JSON-RPC message");
    // The valid initialize after the malformed line still got a response.
    expect(stdoutChunks.length).toBe(1);
    const response = JSON.parse(stdoutChunks[0]) as { result: { serverInfo: { name: string } } };
    expect(response.result.serverInfo.name).toBe("skfiy");
  });
});
