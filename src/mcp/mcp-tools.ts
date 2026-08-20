/**
 * MCP Tools — the versioned tool definitions for the skfiy MCP server.
 *
 * THE PERMISSION BOUNDARY, BY CONSTRUCTION:
 * - There is NO execute/inject tool. The adapter `run()` generator — the
 *   hidden mutation primitive — is never reachable from this surface.
 * - `approved_action` only resolves a PendingApproval the APP ITSELF raised.
 *   Its inputSchema has no command/input/action field — only
 *   decision/executionId/planId/gate — so the tool cannot inject commands.
 * - `stop` only cancels the active turn. Idempotent.
 * Both mutation tools are gated by the app's own task-control state machine.
 */

export const SKFIY_MCP_TOOL_NAMES = [
  "skfiy.status",
  "skfiy.observation",
  "skfiy.approved_action",
  "skfiy.stop",
  "skfiy.replay"
] as const;

export type SkfiyMcpToolName = (typeof SKFIY_MCP_TOOL_NAMES)[number];

export const SKFIY_MCP_SAFETY_INSTRUCTIONS = [
  "Use skfiy MCP tools for read-only status, observation, and replay.",
  "approved_action and stop only act on tasks the skfiy app itself raised — they cannot start new desktop actions.",
  "Keep app policy, permission preflight, and approval prompts inside skfiy.",
  "This server is an adapter to the standalone skfiy app, not a replacement runtime."
].join(" ");

export interface SkfiyMcpToolDefinition {
  name: SkfiyMcpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint?: boolean;
  };
}

export function createSkfiyMcpToolDefinitions(): SkfiyMcpToolDefinition[] {
  return [
    {
      name: "skfiy.status",
      description:
        "Read skfiy readiness, runtime snapshot, and a compact adapter capability summary. Includes task control when the app is running and includeTaskControl is true.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          includeTaskControl: {
            type: "boolean",
            description: "Include the live task control snapshot when the app is running."
          }
        }
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    {
      name: "skfiy.observation",
      description:
        "Observe the pet's current turn: timeline tail, latest action, verification, screenshot, and route outcome.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "number",
            minimum: 1,
            maximum: 20,
            description: "Max timeline events to return (default 8, max 20)."
          }
        }
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    {
      name: "skfiy.approved_action",
      description:
        "Resolve a pending approval the skfiy app itself raised. Cannot inject commands: the request is validated against the live pending approval and task control plan. The external agent gets the SAME permission boundary as the pet clicking Approve.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "executionId", "planId", "gate"],
        properties: {
          decision: { type: "string", enum: ["approve", "deny"] },
          executionId: { type: "string", description: "The task control execution id observed via skfiy.observation." },
          planId: { type: "string", description: "The plan id observed via skfiy.observation." },
          gate: {
            type: "string",
            enum: ["action-plan", "finder-plan", "chrome-submit", "chrome-workflow"]
          }
        }
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    {
      name: "skfiy.stop",
      description:
        "Stop the active skfiy turn. Idempotent: stopping with no active task returns no-active-task, not an error.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reason: { type: "string", description: "Optional cancellation reason." }
        }
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    {
      name: "skfiy.replay",
      description:
        "Full replay evidence for the latest (or a specific) turn: transcript, timeline, and route outcome. Redacted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          turnId: { type: "string", description: "Optional turn id. Omit for the latest turn." }
        }
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    }
  ];
}
