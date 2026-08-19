import path from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import type { TurnReplay } from "./computer-use/turn-replay-store.js";
import type {
  TurnTranscriptAction,
  TurnTranscriptScreenshot
} from "./computer-use/turn-transcript.js";
import { readRecord } from "./record-utils.js";
import {
  isRouteOutcomeKind,
  isRouteOutcomeTone,
  readRouteOutcome,
  type RouteOutcome
} from "../shared/route-outcome.js";

export const RUNTIME_SNAPSHOT_SCHEMA_VERSION = 1;
export const RUNTIME_TURN_MARKER_SCHEMA_VERSION = 1;
const MAX_RUNTIME_SNAPSHOT_ITEMS = 8;
const MAX_RUNTIME_SNAPSHOT_TEXT_LENGTH = 500;

export interface RuntimeSnapshotIo {
  mkdir: (targetPath: string) => Promise<void>;
  writeFile: (targetPath: string, content: string) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
}

export interface RuntimeSnapshotReadIo {
  exists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string;
}

export interface RuntimeSnapshotInput {
  replay: TurnReplay | null;
  currentTurn?: RuntimeSnapshotCurrentTurnInput;
  observedAt?: string;
}

export interface RuntimeSnapshotWriteInput extends RuntimeSnapshotInput {
  homeDir: string;
  io?: RuntimeSnapshotIo;
}

export interface RuntimeTurnMarkerInput {
  currentTurn: RuntimeSnapshotCurrentTurnInput;
  observedAt?: string;
}

export interface RuntimeTurnMarkerWriteInput extends RuntimeTurnMarkerInput {
  homeDir: string;
  io?: RuntimeSnapshotIo;
}

export interface RuntimeSnapshotReadInput {
  homeDir?: string;
  io: RuntimeSnapshotReadIo;
}

export interface RuntimeSnapshot {
  schemaVersion: typeof RUNTIME_SNAPSHOT_SCHEMA_VERSION;
  observedAt: string;
  currentTurn: Record<string, unknown>;
  routeOutcome: RouteOutcome;
  replay: Record<string, unknown>;
}

export interface RuntimeTurnMarker {
  schemaVersion: typeof RUNTIME_TURN_MARKER_SCHEMA_VERSION;
  observedAt: string;
  currentTurn: Record<string, unknown>;
}

export interface RuntimeSnapshotCurrentTurnInput {
  state?: string;
  status?: string;
  message?: string;
  command?: string;
  route?: string;
  routeReason?: string;
  denialKind?: string;
  policyKind?: string;
  routeOutcome?: RouteOutcome;
  stopTurnBehavior?: RuntimeSnapshotStopTurnBehaviorInput;
}

export interface RuntimeSnapshotStopTurnBehaviorInput {
  result?: string;
  source?: string;
  command?: string;
  beforeStatus?: string;
  beforeMessage?: string;
  afterStatus?: string;
  afterMessage?: string;
}

export function createRuntimeSnapshotStatePath(homeDir: string): string {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "skfiy",
    "runtime-snapshot.json"
  );
}

export function createRuntimeTurnMarkerStatePath(homeDir: string): string {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "skfiy",
    "runtime-turn-marker.json"
  );
}

export function createRuntimeSnapshotFromReplay({
  replay,
  currentTurn,
  observedAt = new Date().toISOString()
}: RuntimeSnapshotInput): RuntimeSnapshot {
  const explicitRouteOutcome = readRuntimeRouteOutcomeRecord(currentTurn?.routeOutcome);

  if (!replay) {
    const snapshotCurrentTurn = createRuntimeCurrentTurnPanel(currentTurn);
    const snapshotReplay = {
      state: "empty",
      source: "runtime-snapshot"
    };

    return {
      schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      observedAt,
      currentTurn: snapshotCurrentTurn,
      routeOutcome: explicitRouteOutcome ?? createRuntimeRouteOutcome(snapshotCurrentTurn, snapshotReplay),
      replay: snapshotReplay
    };
  }

  const latestTimelineEvent = replay.timeline.at(-1);
  const latestApp = replay.transcript.apps[0];
  const screenshotSummaries = replay.transcript.screenshots
    .slice(-MAX_RUNTIME_SNAPSHOT_ITEMS)
    .map(summarizeScreenshot);
  const actionSummaries = replay.transcript.actions
    .slice(-MAX_RUNTIME_SNAPSHOT_ITEMS)
    .map(summarizeAction);
  const verificationSummaries = replay.transcript.actions
    .filter((action) => action.type === "verify")
    .slice(-MAX_RUNTIME_SNAPSHOT_ITEMS)
    .map(summarizeVerification);
  const toolCallSummaries = replay.transcript.actions
    .filter((action) => action.type === "tool_call" || action.type === "tool_result")
    .slice(-MAX_RUNTIME_SNAPSHOT_ITEMS)
    .map(summarizeAction);
  const timelineTail = replay.timeline
    .slice(-MAX_RUNTIME_SNAPSHOT_ITEMS)
    .map((event) => ({
      status: event.status,
      ...(event.message ? { message: sanitizeRuntimeSnapshotText(event.message) } : {}),
      ...(event.command ? { command: sanitizeRuntimeSnapshotText(event.command) } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.route ? { route: event.route } : {}),
      ...(event.routeReason ? { routeReason: sanitizeRuntimeSnapshotText(event.routeReason) } : {}),
      ...(event.denialKind ? { denialKind: sanitizeRuntimeSnapshotText(event.denialKind) } : {}),
      ...(event.policyKind ? { policyKind: sanitizeRuntimeSnapshotText(event.policyKind) } : {}),
      ...readRuntimeStopTurnBehaviorField(event.stopTurnBehavior)
    }));
  const verificationCount = replay.transcript.actions
    .filter((action) => action.type === "verify")
    .length;
  const state = latestTimelineEvent?.status ?? readTurnStateFromOutcome(replay.transcript.outcome);
  const latestMessage = latestTimelineEvent?.message
    ? sanitizeRuntimeSnapshotText(latestTimelineEvent.message)
    : undefined;
  const latestAction = actionSummaries.at(-1);
  const latestVerification = verificationSummaries.at(-1);
  const latestScreenshot = screenshotSummaries.at(-1);
  const latestToolCall = toolCallSummaries.at(-1);
  const approvalState = readApprovalState(replay.transcript, state);

  const snapshotCurrentTurn = mergeRuntimeCurrentTurnPanel(
    {
      state,
      ...(replay.transcript.command ? { command: sanitizeRuntimeSnapshotText(replay.transcript.command) } : {}),
      ...readLatestTimelineCurrentTurnFields(latestTimelineEvent),
      ...(latestApp?.name ? { targetApp: latestApp.name } : {}),
      ...(latestApp?.bundleId ? { targetBundleId: latestApp.bundleId } : {}),
      ...(replay.transcript.risk?.level ? { risk: replay.transcript.risk.level } : {}),
      ...(replay.transcript.planner?.providerLabel
        ? { plannerProvider: replay.transcript.planner.providerLabel }
        : {}),
      approvalRequired: replay.transcript.approvalRequired || state === "approval_required",
      approvalState,
      stopState: isActiveTurnState(state) ? "available" : "inactive",
      ...(latestMessage ? { latestMessage } : {}),
      ...(latestAction ? { latestAction } : {}),
      ...(latestVerification ? { latestVerification } : {}),
      ...(latestScreenshot ? { latestScreenshot } : {}),
      ...(latestToolCall ? createLatestToolCurrentTurnFields(latestToolCall) : {}),
      source: "runtime-snapshot"
    },
    currentTurn
  );
  const snapshotReplay = {
    state: "available",
    outcome: replay.transcript.outcome,
    screenshotCount: replay.transcript.screenshots.length,
    actionCount: replay.transcript.actions.length,
    verificationCount,
    timelineCount: replay.timeline.length,
    ...(latestMessage ? { latestMessage } : {}),
    ...(latestToolCall ? { latestToolCall } : {}),
    screenshots: screenshotSummaries,
    actions: actionSummaries,
    verifications: verificationSummaries,
    timelineTail,
    source: "runtime-snapshot"
  };

  return {
    schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    observedAt,
    currentTurn: snapshotCurrentTurn,
    routeOutcome: explicitRouteOutcome ?? createRuntimeRouteOutcome(snapshotCurrentTurn, snapshotReplay),
    replay: snapshotReplay
  };
}

export function createRuntimeTurnMarker({
  currentTurn,
  observedAt = new Date().toISOString()
}: RuntimeTurnMarkerInput): RuntimeTurnMarker {
  return {
    schemaVersion: RUNTIME_TURN_MARKER_SCHEMA_VERSION,
    observedAt,
    currentTurn: {
      ...createRuntimeCurrentTurnPanel(currentTurn),
      source: "runtime-turn-marker"
    }
  };
}

export async function writeRuntimeSnapshot({
  homeDir,
  replay,
  currentTurn,
  observedAt,
  io = createDefaultRuntimeSnapshotIo()
}: RuntimeSnapshotWriteInput): Promise<RuntimeSnapshot> {
  const snapshot = createRuntimeSnapshotFromReplay({ replay, currentTurn, observedAt });
  const snapshotPath = createRuntimeSnapshotStatePath(homeDir);
  const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;

  await io.mkdir(path.dirname(snapshotPath));
  if (io.rename) {
    const tempPath = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
    await io.writeFile(tempPath, snapshotText);
    await io.rename(tempPath, snapshotPath);
  } else {
    await io.writeFile(snapshotPath, snapshotText);
  }

  return snapshot;
}

export async function writeRuntimeTurnMarker({
  homeDir,
  currentTurn,
  observedAt,
  io = createDefaultRuntimeSnapshotIo()
}: RuntimeTurnMarkerWriteInput): Promise<RuntimeTurnMarker> {
  const marker = createRuntimeTurnMarker({ currentTurn, observedAt });
  const markerPath = createRuntimeTurnMarkerStatePath(homeDir);
  const markerText = `${JSON.stringify(marker, null, 2)}\n`;

  await io.mkdir(path.dirname(markerPath));
  if (io.rename) {
    const tempPath = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
    await io.writeFile(tempPath, markerText);
    await io.rename(tempPath, markerPath);
  } else {
    await io.writeFile(markerPath, markerText);
  }

  return marker;
}

export function readRuntimeSnapshotPanels({
  homeDir,
  io
}: RuntimeSnapshotReadInput): {
  currentTurn: Record<string, unknown>;
  routeOutcome?: RouteOutcome;
  replay: Record<string, unknown>;
} {
  if (!homeDir) {
    return createMissingRuntimePanels("Home directory is required to locate the runtime snapshot.");
  }

  const snapshotPath = createRuntimeSnapshotStatePath(homeDir);
  if (!io.exists(snapshotPath)) {
    return createMissingRuntimePanels("Runtime snapshot has not been recorded yet.", snapshotPath);
  }

  try {
    const parsed = JSON.parse(io.readFile(snapshotPath)) as unknown;
    const snapshot = readRecord(parsed);
    const currentTurn = readRecord(snapshot?.currentTurn);
    const routeOutcome = readRuntimeRouteOutcomeRecord(snapshot?.routeOutcome);
    const replay = readRecord(snapshot?.replay);

    if (snapshot?.schemaVersion !== RUNTIME_SNAPSHOT_SCHEMA_VERSION || !currentTurn || !replay) {
      return createMissingRuntimePanels("Runtime snapshot is not a valid skfiy snapshot.", snapshotPath);
    }

    return {
      currentTurn: { ...currentTurn },
      ...(routeOutcome ? { routeOutcome } : {}),
      replay: { ...replay }
    };
  } catch (error) {
    return createMissingRuntimePanels(
      error instanceof Error ? error.message : String(error),
      snapshotPath
    );
  }
}

function readRuntimeRouteOutcomeRecord(value: unknown): RouteOutcome | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  const kind = readRuntimeRouteOutcomeKind(record.kind);
  const title = readRuntimeRouteOutcomeString(record.title);
  const outcomeValue = readRuntimeRouteOutcomeString(record.value);
  const detail = readRuntimeRouteOutcomeString(record.detail);
  const tone = readRuntimeRouteOutcomeTone(record.tone);
  const source = readRuntimeRouteOutcomeString(record.source);
  const routeLabel = readRuntimeRouteOutcomeString(record.routeLabel);
  const state = readRuntimeRouteOutcomeString(record.state);
  const denialKind = readRuntimeRouteOutcomeString(record.denialKind);
  const policyKind = readRuntimeRouteOutcomeString(record.policyKind);

  if (!kind || !title || !outcomeValue || !detail || !tone || !source || !routeLabel || !state) {
    return undefined;
  }

  return {
    kind,
    title,
    value: outcomeValue,
    detail,
    tone,
    source,
    routeLabel,
    state,
    ...(denialKind ? { denialKind } : {}),
    ...(policyKind ? { policyKind } : {})
  };
}

function readRuntimeRouteOutcomeKind(value: unknown): RouteOutcome["kind"] | undefined {
  return isRouteOutcomeKind(value) ? value : undefined;
}

function readRuntimeRouteOutcomeTone(value: unknown): RouteOutcome["tone"] | undefined {
  return isRouteOutcomeTone(value) ? value : undefined;
}

function readRuntimeRouteOutcomeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? sanitizeRuntimeSnapshotText(value)
    : undefined;
}

function createMissingRuntimePanels(
  reason: string,
  pathValue?: string
): {
  currentTurn: Record<string, unknown>;
  replay: Record<string, unknown>;
} {
  return {
    currentTurn: {
      state: "idle",
      source: "runtime-snapshot",
      reason,
      ...(pathValue ? { path: pathValue } : {})
    },
    replay: {
      state: "empty",
      source: "runtime-snapshot",
      reason,
      ...(pathValue ? { path: pathValue } : {})
    }
  };
}

function readTurnStateFromOutcome(outcome: string): string {
  switch (outcome) {
    case "approval_required":
      return "approval_required";
    case "needs_confirmation":
      return "needs_confirmation";
    case "needs_clarification":
      return "needs_clarification";
    case "verification_failed":
      return "needs_confirmation";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "denied":
      return "denied";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    default:
      return "executing";
  }
}

function isActiveTurnState(state: string): boolean {
  return state === "planned"
    || state === "observing"
    || state === "executing"
    || state === "running"
    || state === "approval_required";
}

function createRuntimeCurrentTurnPanel(
  currentTurn?: RuntimeSnapshotCurrentTurnInput
): Record<string, unknown> {
  const state = readRuntimeCurrentTurnState(currentTurn) ?? "idle";
  const message = readRuntimeCurrentTurnMessage(currentTurn);
  const command = readRuntimeCurrentTurnCommand(currentTurn);

  return {
    state,
    ...(command ? { command } : {}),
    ...readRuntimeCurrentTurnRouteMetadata(currentTurn),
    ...readRuntimeStopTurnBehaviorField(currentTurn?.stopTurnBehavior),
    approvalRequired: state === "approval_required",
    approvalState: state === "approval_required" ? "required" : "not-required",
    stopState: isActiveTurnState(state) ? "available" : "inactive",
    ...(message ? { latestMessage: message } : {}),
    source: "runtime-snapshot",
    ...(currentTurn ? { updateSource: "live-task-event" } : {})
  };
}

function mergeRuntimeCurrentTurnPanel(
  base: Record<string, unknown>,
  currentTurn?: RuntimeSnapshotCurrentTurnInput
): Record<string, unknown> {
  if (!currentTurn) {
    return base;
  }

  const state = readRuntimeCurrentTurnState(currentTurn);
  const message = readRuntimeCurrentTurnMessage(currentTurn);
  const command = readRuntimeCurrentTurnCommand(currentTurn);
  const nextState = state ?? String(base.state ?? "idle");

  return {
    ...base,
    ...(state ? { state } : {}),
    ...(command ? { command } : {}),
    ...readRuntimeCurrentTurnRouteMetadata(currentTurn),
    ...readRuntimeStopTurnBehaviorField(currentTurn.stopTurnBehavior),
    ...(message ? { latestMessage: message } : {}),
    approvalRequired: base.approvalRequired === true || nextState === "approval_required",
    approvalState: base.approvalRequired === true || nextState === "approval_required"
      ? "required"
      : "not-required",
    stopState: isActiveTurnState(nextState) ? "available" : "inactive",
    updateSource: "live-task-event"
  };
}

function readRuntimeCurrentTurnState(
  currentTurn?: RuntimeSnapshotCurrentTurnInput
): string | undefined {
  const state = currentTurn?.state ?? currentTurn?.status;
  return state ? sanitizeRuntimeSnapshotText(state) : undefined;
}

function readRuntimeCurrentTurnMessage(
  currentTurn?: RuntimeSnapshotCurrentTurnInput
): string | undefined {
  return currentTurn?.message ? sanitizeRuntimeSnapshotText(currentTurn.message) : undefined;
}

function readRuntimeCurrentTurnCommand(
  currentTurn?: RuntimeSnapshotCurrentTurnInput
): string | undefined {
  return currentTurn?.command ? sanitizeRuntimeSnapshotText(currentTurn.command) : undefined;
}

function readRuntimeCurrentTurnRouteMetadata(
  currentTurn?: RuntimeSnapshotCurrentTurnInput
): Record<string, string> {
  return {
    ...(currentTurn?.route ? { route: sanitizeRuntimeSnapshotText(currentTurn.route) } : {}),
    ...(currentTurn?.routeReason ? { routeReason: sanitizeRuntimeSnapshotText(currentTurn.routeReason) } : {}),
    ...(currentTurn?.denialKind ? { denialKind: sanitizeRuntimeSnapshotText(currentTurn.denialKind) } : {}),
    ...(currentTurn?.policyKind ? { policyKind: sanitizeRuntimeSnapshotText(currentTurn.policyKind) } : {})
  };
}

function readRuntimeStopTurnBehaviorField(
  stopTurnBehavior?: RuntimeSnapshotStopTurnBehaviorInput
): Record<string, Record<string, string>> {
  if (!stopTurnBehavior) {
    return {};
  }

  const behavior = {
    ...(stopTurnBehavior.result ? { result: sanitizeRuntimeSnapshotText(stopTurnBehavior.result) } : {}),
    ...(stopTurnBehavior.source ? { source: sanitizeRuntimeSnapshotText(stopTurnBehavior.source) } : {}),
    ...(stopTurnBehavior.command ? { command: sanitizeRuntimeSnapshotText(stopTurnBehavior.command) } : {}),
    ...(stopTurnBehavior.beforeStatus ? { beforeStatus: sanitizeRuntimeSnapshotText(stopTurnBehavior.beforeStatus) } : {}),
    ...(stopTurnBehavior.beforeMessage ? { beforeMessage: sanitizeRuntimeSnapshotText(stopTurnBehavior.beforeMessage) } : {}),
    ...(stopTurnBehavior.afterStatus ? { afterStatus: sanitizeRuntimeSnapshotText(stopTurnBehavior.afterStatus) } : {}),
    ...(stopTurnBehavior.afterMessage ? { afterMessage: sanitizeRuntimeSnapshotText(stopTurnBehavior.afterMessage) } : {})
  };

  return Object.keys(behavior).length > 0
    ? { stopTurnBehavior: behavior }
    : {};
}

function summarizeScreenshot(screenshot: TurnTranscriptScreenshot): Record<string, unknown> {
  return {
    stage: screenshot.stage,
    path: sanitizeRuntimeSnapshotText(screenshot.path),
    bundleId: screenshot.bundleId,
    ...(screenshot.pid ? { pid: screenshot.pid } : {}),
    ...(screenshot.accessibilityTrusted !== undefined
      ? { accessibilityTrusted: screenshot.accessibilityTrusted }
      : {}),
    recommendation: screenshot.grounding.recommendation,
    sourceCount: screenshot.grounding.sources.length
  };
}

function summarizeAction(action: TurnTranscriptAction): Record<string, unknown> {
  switch (action.type) {
    case "tool_call":
      return {
        type: action.type,
        turnId: action.turnId,
        toolCallId: action.toolCallId,
        route: action.route,
        status: action.status,
        command: sanitizeRuntimeSnapshotText(action.command)
      };
    case "approval_decision":
      return {
        type: action.type,
        turnId: action.turnId,
        toolCallId: action.toolCallId,
        route: action.route,
        decision: action.decision,
        ...(action.reason ? { reason: sanitizeRuntimeSnapshotText(action.reason) } : {})
      };
    case "tool_result":
      return {
        type: action.type,
        turnId: action.turnId,
        toolCallId: action.toolCallId,
        route: action.route,
        status: action.status,
        ...(action.summary ? { summary: sanitizeRuntimeSnapshotText(action.summary) } : {}),
        ...(action.evidenceSummary
          ? { evidenceSummary: sanitizeRuntimeSnapshotText(action.evidenceSummary) }
          : {}),
        artifactCount: action.artifactCount
      };
    case "plan":
      return {
        type: action.type,
        providerLabel: action.providerLabel,
        command: sanitizeRuntimeSnapshotText(action.command),
        ...(action.rationale ? { rationale: sanitizeRuntimeSnapshotText(action.rationale) } : {})
      };
    case "open_session":
      return { type: action.type, appName: action.appName, pid: action.pid };
    case "activate_app":
      return {
        type: action.type,
        appName: action.appName,
        bundleId: action.bundleId,
        ...(action.pid ? { pid: action.pid } : {})
      };
    case "type_text":
      return {
        type: action.type,
        textLength: action.text.length
      };
    case "press_key":
      return { type: action.type, key: action.key };
    case "observe_finder_selection":
      return {
        type: action.type,
        source: action.source,
        ...(action.frontmostBundleId ? { frontmostBundleId: action.frontmostBundleId } : {}),
        ...(action.targetPath ? { targetPath: sanitizeRuntimeSnapshotText(action.targetPath) } : {}),
        selectedCount: action.selectedCount
      };
    case "preview_finder_plan":
      return {
        type: action.type,
        rootPath: sanitizeRuntimeSnapshotText(action.rootPath),
        operationCount: action.operationCount,
        destructiveOperationCount: action.destructiveOperationCount,
        createFolderCount: action.createFolderCount,
        moveFileCount: action.moveFileCount
      };
    case "confirm_finder_plan":
      return {
        type: action.type,
        rootPath: sanitizeRuntimeSnapshotText(action.rootPath),
        operationCount: action.operationCount,
        destructiveOperationCount: action.destructiveOperationCount,
        reason: sanitizeRuntimeSnapshotText(action.reason)
      };
    case "recover":
      return {
        type: action.type,
        action: action.action,
        stage: action.stage,
        reason: sanitizeRuntimeSnapshotText(action.reason)
      };
    case "verify":
      return summarizeVerification(action);
    case "switch_control":
      return {
        type: action.type,
        from: action.from,
        to: action.to,
        stage: action.stage,
        reason: sanitizeRuntimeSnapshotText(action.reason)
      };
  }
}

function readApprovalState(transcript: {
  approvalRequired: boolean;
  actions: TurnTranscriptAction[];
}, state: string): string {
  const latestDecision = transcript.actions
    .filter((action) => action.type === "approval_decision")
    .at(-1);

  if (latestDecision?.type === "approval_decision") {
    return latestDecision.decision === "bypassed" ? "bypassed" : latestDecision.decision;
  }

  if (transcript.approvalRequired || state === "approval_required") {
    return "required";
  }

  return "not-required";
}

function createLatestToolCurrentTurnFields(
  latestToolCall: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(typeof latestToolCall.turnId === "string" ? { turnId: latestToolCall.turnId } : {}),
    ...(typeof latestToolCall.toolCallId === "string" ? { toolCallId: latestToolCall.toolCallId } : {}),
    ...(typeof latestToolCall.route === "string" ? { route: latestToolCall.route } : {}),
    ...(typeof latestToolCall.status === "string" ? { latestToolStatus: latestToolCall.status } : {})
  };
}

function summarizeVerification(
  action: Extract<TurnTranscriptAction, { type: "verify" }>
): Record<string, unknown> {
  return {
    type: action.type,
    actionType: action.actionType,
    status: action.status,
    ...(action.message ? { message: sanitizeRuntimeSnapshotText(action.message) } : {}),
    ...(action.reason ? { reason: sanitizeRuntimeSnapshotText(action.reason) } : {})
  };
}

function readLatestTimelineCurrentTurnFields(
  event: TurnReplay["timeline"][number] | undefined
): Record<string, unknown> {
  if (!event) {
    return {};
  }

  return {
    ...(event.command ? { command: sanitizeRuntimeSnapshotText(event.command) } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.route ? { route: event.route } : {}),
    ...(event.routeReason ? { routeReason: sanitizeRuntimeSnapshotText(event.routeReason) } : {}),
    ...(event.denialKind ? { denialKind: sanitizeRuntimeSnapshotText(event.denialKind) } : {}),
    ...(event.policyKind ? { policyKind: sanitizeRuntimeSnapshotText(event.policyKind) } : {})
  };
}

function sanitizeRuntimeSnapshotText(value: string): string {
  const redacted = value
    .replace(/\b(token|password|secret|api[_-]?key)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");

  return redacted.length > MAX_RUNTIME_SNAPSHOT_TEXT_LENGTH
    ? `${redacted.slice(0, MAX_RUNTIME_SNAPSHOT_TEXT_LENGTH - 1)}...`
    : redacted;
}

function createRuntimeRouteOutcome(
  currentTurn: Record<string, unknown>,
  replay: Record<string, unknown>
): RouteOutcome {
  return readRouteOutcome({
    currentTurn,
    replay,
    defaultSource: "runtime-snapshot",
    includeCommandDetail: false,
    sanitizeString: sanitizeRuntimeSnapshotText
  });
}

function createDefaultRuntimeSnapshotIo(): RuntimeSnapshotIo {
  return {
    mkdir: async (targetPath) => {
      await mkdir(targetPath, { recursive: true });
    },
    writeFile,
    rename
  };
}
