/**
 * MCP Providers — the bridge between the MCP server and the skfiy app.
 *
 * The default factory (createLoopbackMcpProviders) bridges to the app via the
 * loopback control API for live state (task control, turn replay, approve,
 * stop) and via file reads + pure factories for offline state (runtime
 * snapshot panels, adapter capabilities).
 *
 * Providers are injected into the server so it is testable without a live
 * app (old repo pattern).
 */

import { createRuntimeSnapshotFromReplay } from "../main/runtime-snapshot.js";
import type { TurnReplay } from "../main/computer-use/turn-replay-store.js";
import type { RouteOutcome } from "../shared/route-outcome.js";
import type { TaskControlSnapshot } from "../shared/task-control.js";
import { isTaskControlSnapshot } from "../shared/task-control.js";
import type { ControlClient } from "../cli/control-client.js";
import { ControlClientError } from "../cli/control-client.js";
import type { AdapterCapabilityDto } from "../cli/cli-capabilities.js";
import type { ControlApproveRequest } from "../shared/control-contract.js";

export const MCP_RESULT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface McpCapabilitiesSummary {
  id: string;
  capabilityCount: number;
}

export interface McpStatusResult {
  schemaVersion: typeof MCP_RESULT_SCHEMA_VERSION;
  readiness: { state: "ready" | "blocked" | "app-not-running" };
  runtime: {
    currentTurn: Record<string, unknown>;
    replay: Record<string, unknown>;
    routeOutcome?: RouteOutcome;
  };
  taskControl?: TaskControlSnapshot | null;
  capabilities: McpCapabilitiesSummary[];
}

export interface McpObservationResult {
  schemaVersion: typeof MCP_RESULT_SCHEMA_VERSION;
  turnId?: string;
  status: string;
  timelineTail: unknown[];
  latestAction?: unknown;
  latestVerification?: unknown;
  latestScreenshot?: unknown;
  routeOutcome?: RouteOutcome;
}

export interface McpApproveResult {
  schemaVersion: typeof MCP_RESULT_SCHEMA_VERSION;
  result: "resumed" | "denied" | "no-pending-approval" | "mismatch";
  message?: string;
  taskControl?: TaskControlSnapshot | null;
}

export interface McpStopResult {
  schemaVersion: typeof MCP_RESULT_SCHEMA_VERSION;
  result: "stopped" | "no-active-task";
  stopDecision: {
    cancellationReason: string;
    delivery: "turn-replay" | "transient";
    route: string | null;
  };
  taskControl: TaskControlSnapshot | null;
}

export interface McpReplayResult {
  schemaVersion: typeof MCP_RESULT_SCHEMA_VERSION;
  replay: {
    transcript: {
      outcome: string;
      command?: string;
      risk?: unknown;
      actions: unknown[];
      screenshots: unknown[];
    };
    timeline: unknown[];
    routeOutcome?: RouteOutcome;
  };
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface SkfiyMcpProviders {
  readStatus(input: { includeTaskControl?: boolean }): Promise<McpStatusResult>;
  readObservation(input: { limit?: number }): Promise<McpObservationResult>;
  approveAction(input: ControlApproveRequest): Promise<McpApproveResult>;
  stopTask(input: { reason?: string }): Promise<McpStopResult>;
  readReplay(input: { turnId?: string }): Promise<McpReplayResult>;
}

// ---------------------------------------------------------------------------
// Loopback factory
// ---------------------------------------------------------------------------

export interface LoopbackMcpProvidersDeps {
  controlClient: ControlClient;
  readRuntimePanels: () => {
    currentTurn: Record<string, unknown>;
    replay: Record<string, unknown>;
    routeOutcome?: RouteOutcome;
  };
  readCapabilities: () => readonly AdapterCapabilityDto[];
}

export function createLoopbackMcpProviders(
  deps: LoopbackMcpProvidersDeps
): SkfiyMcpProviders {
  return {
    async readStatus(input): Promise<McpStatusResult> {
      const runtime = deps.readRuntimePanels();
      const capabilities = deps.readCapabilities().map((adapter) => ({
        id: adapter.id,
        capabilityCount: adapter.capabilities.length
      }));

      const result: McpStatusResult = {
        schemaVersion: MCP_RESULT_SCHEMA_VERSION,
        readiness: { state: "app-not-running" },
        runtime: {
          currentTurn: runtime.currentTurn,
          replay: runtime.replay,
          ...(runtime.routeOutcome ? { routeOutcome: runtime.routeOutcome } : {})
        },
        capabilities
      };

      if (input.includeTaskControl === true) {
        try {
          const snapshot = await deps.controlClient.readTaskControl();
          result.taskControl = snapshot && isTaskControlSnapshot(snapshot) ? snapshot : null;
          result.readiness = { state: "ready" };
        } catch (error) {
          if (error instanceof ControlClientError && error.code === "unauthorized") {
            throw error;
          }
          result.taskControl = null;
          result.readiness = { state: "app-not-running" };
        }
      }

      return result;
    },

    async readObservation(input): Promise<McpObservationResult> {
      const replay = await deps.controlClient.readTurnReplay();
      if (!replay) {
        return {
          schemaVersion: MCP_RESULT_SCHEMA_VERSION,
          status: "idle",
          timelineTail: []
        };
      }
      return projectObservation(replay, input.limit ?? 8);
    },

    async approveAction(input): Promise<McpApproveResult> {
      const control = await deps.controlClient.approveTask(input);
      switch (control.result) {
        case "resumed":
        case "denied":
          return {
            schemaVersion: MCP_RESULT_SCHEMA_VERSION,
            result: control.result,
            taskControl: control.taskControl
          };
        case "mismatch":
          return {
            schemaVersion: MCP_RESULT_SCHEMA_VERSION,
            result: "mismatch",
            message: control.message
          };
        case "no-pending-approval":
          return {
            schemaVersion: MCP_RESULT_SCHEMA_VERSION,
            result: "no-pending-approval"
          };
      }
    },

    async stopTask(input): Promise<McpStopResult> {
      const control = await deps.controlClient.stopTask(input.reason);
      return {
        schemaVersion: MCP_RESULT_SCHEMA_VERSION,
        result: control.result,
        stopDecision: control.stopDecision,
        taskControl: control.taskControl
      };
    },

    async readReplay(input): Promise<McpReplayResult> {
      const replay = await deps.controlClient.readTurnReplay();
      if (!replay) {
        return {
          schemaVersion: MCP_RESULT_SCHEMA_VERSION,
          replay: {
            transcript: { outcome: "idle", actions: [], screenshots: [] },
            timeline: []
          }
        };
      }
      if (input.turnId !== undefined) {
        const replayTurnId = readReplayTurnId(replay);
        if (replayTurnId !== undefined && replayTurnId !== input.turnId) {
          return {
            schemaVersion: MCP_RESULT_SCHEMA_VERSION,
            replay: {
              transcript: { outcome: "idle", actions: [], screenshots: [] },
              timeline: []
            }
          };
        }
      }
      return {
        schemaVersion: MCP_RESULT_SCHEMA_VERSION,
        replay: {
          transcript: {
            outcome: replay.transcript.outcome,
            ...(replay.transcript.command ? { command: replay.transcript.command } : {}),
            ...(replay.transcript.risk ? { risk: replay.transcript.risk } : {}),
            actions: replay.transcript.actions,
            screenshots: replay.transcript.screenshots
          },
          timeline: replay.timeline,
          ...(replay.routeOutcome ? { routeOutcome: replay.routeOutcome } : {})
        }
      };
    }
  };
}

/**
 * Projects a TurnReplay into the observation result, reusing the same
 * summarize* functions runtime-snapshot.ts uses (via
 * createRuntimeSnapshotFromReplay) so the MCP observation matches the
 * runtime snapshot panels exactly.
 */
export function projectObservation(
  replay: TurnReplay,
  limit: number
): McpObservationResult {
  const snapshot = createRuntimeSnapshotFromReplay({ replay });
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit) || 8));
  const timelineTail = replay.timeline.slice(-boundedLimit).map((event) => ({
    status: event.status,
    ...(event.message ? { message: event.message } : {}),
    ...(event.command ? { command: event.command } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.route ? { route: event.route } : {})
  }));
  const currentTurn = snapshot.currentTurn;
  const turnId = readReplayTurnId(replay);

  return {
    schemaVersion: MCP_RESULT_SCHEMA_VERSION,
    ...(turnId ? { turnId } : {}),
    status: readObservationStatus(currentTurn, replay),
    timelineTail,
    ...(currentTurn.latestAction !== undefined ? { latestAction: currentTurn.latestAction } : {}),
    ...(currentTurn.latestVerification !== undefined
      ? { latestVerification: currentTurn.latestVerification }
      : {}),
    ...(currentTurn.latestScreenshot !== undefined
      ? { latestScreenshot: currentTurn.latestScreenshot }
      : {}),
    ...(snapshot.routeOutcome ? { routeOutcome: snapshot.routeOutcome } : {})
  };
}

function readObservationStatus(
  currentTurn: Record<string, unknown>,
  replay: TurnReplay
): string {
  const state = currentTurn.state;
  if (typeof state === "string" && state.length > 0) {
    return state;
  }
  return replay.timeline.at(-1)?.status ?? replay.transcript.outcome;
}

function readReplayTurnId(replay: TurnReplay): string | undefined {
  const fromTimeline = replay.timeline.find((event) => event.turnId)?.turnId;
  if (fromTimeline) {
    return fromTimeline;
  }
  const fromAction = replay.transcript.actions.find((action) =>
    typeof action === "object" && action !== null && "turnId" in action
  ) as { turnId?: unknown } | undefined;
  return typeof fromAction?.turnId === "string" ? fromAction.turnId : undefined;
}
