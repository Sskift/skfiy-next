import type {
  PermissionSettingsTarget
} from "./computer-use/types.js";
import type { ManualMode } from "./task-event-view.js";

export type PetWindowMode = "compact" | "expanded";

export interface VisiblePetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TmuxMonitorInput {
  monitorId?: string;
  sessionName: string;
  label?: string;
  intervalMs: number;
  timeoutMs?: number;
  triggerMode?: "manual" | "scheduled" | "local-state";
  enabled?: boolean;
}

export interface TmuxAutomationPreviewInput {
  sessionName: string;
  timeoutMs?: number;
  triggerMode?: "manual" | "scheduled" | "local-state";
}

export interface ConversationRenameRequest {
  sessionId: string;
  title: string;
}

export interface ConversationRetryRequest {
  sessionId: string;
  turnId: string;
  requestId: string;
}

export interface TaskApprovalDecisionRequest {
  executionId: string;
  planId: string;
}

const MAX_CONVERSATION_ID_LENGTH = 200;
const MAX_CONVERSATION_TITLE_LENGTH = 120;
const MAX_TASK_CONTROL_ID_LENGTH = 160;
const MAX_AUTOMATION_MONITOR_ID_LENGTH = 200;

export type RunCommandRequest =
  | {
    ok: true;
    command: string;
    mode: ManualMode;
  }
  | {
    ok: false;
    message: string;
  };

export function readMode(value: unknown): ManualMode {
  return value === "quiet" || value === "active" ? value : "active";
}

export function readRunCommandRequest(command: unknown, options: unknown): RunCommandRequest {
  if (typeof command !== "string") {
    return {
      ok: false,
      message: "Command must be text."
    };
  }

  const trimmed = command.trim();

  if (!trimmed) {
    return {
      ok: false,
      message: "No command was provided."
    };
  }

  const record = options && typeof options === "object"
    ? options as { mode?: unknown }
    : {};

  return {
    ok: true,
    command: trimmed,
    mode: readMode(record.mode)
  };
}

export function readConversationSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_CONVERSATION_ID_LENGTH
    ? normalized
    : undefined;
}

export function readConversationRenameRequest(value: unknown): ConversationRenameRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const sessionId = readConversationSessionId(record.sessionId);
  const title = typeof record.title === "string"
    ? record.title.trim().replace(/\s+/gu, " ")
    : "";

  if (!sessionId || !title || title.length > MAX_CONVERSATION_TITLE_LENGTH) {
    return undefined;
  }

  return { sessionId, title };
}

export function readConversationRetryRequest(value: unknown): ConversationRetryRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const sessionId = readConversationSessionId(record.sessionId);
  const turnId = readConversationSessionId(record.turnId);
  const requestId = readConversationSessionId(record.requestId);

  return sessionId && turnId && requestId
    ? { sessionId, turnId, requestId }
    : undefined;
}

export function readTaskApprovalDecisionRequest(
  value: unknown
): TaskApprovalDecisionRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "executionId" && key !== "planId")
    || !Object.hasOwn(record, "executionId")
    || !Object.hasOwn(record, "planId")
  ) {
    return undefined;
  }
  const executionId = readTaskControlId(record.executionId);
  const planId = readTaskControlId(record.planId);
  return executionId && planId ? { executionId, planId } : undefined;
}

function readTaskControlId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= MAX_TASK_CONTROL_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)
    ? normalized
    : undefined;
}

export function readTmuxMonitorInput(input: unknown): TmuxMonitorInput {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const sessionName = typeof record.sessionName === "string" ? record.sessionName : "";
  const intervalMs = typeof record.intervalMs === "number" && Number.isFinite(record.intervalMs)
    ? record.intervalMs
    : 300_000;
  const label = typeof record.label === "string" ? record.label : undefined;
  const timeoutMs = typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
    ? record.timeoutMs
    : undefined;
  const triggerMode = readAutomationMonitorTriggerMode(record.triggerMode);
  const enabled = typeof record.enabled === "boolean" ? record.enabled : undefined;
  const monitorId = readAutomationMonitorId(record.monitorId);

  return {
    ...(monitorId ? { monitorId } : {}),
    sessionName,
    ...(label ? { label } : {}),
    intervalMs,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(triggerMode === undefined ? {} : { triggerMode }),
    ...(enabled === undefined ? {} : { enabled })
  };
}

export function readTmuxAutomationPreviewInput(input: unknown): TmuxAutomationPreviewInput {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const sessionName = typeof record.sessionName === "string" ? record.sessionName : "";
  const timeoutMs = typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
    ? record.timeoutMs
    : undefined;
  const triggerMode = readAutomationMonitorTriggerMode(record.triggerMode);

  return {
    sessionName,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(triggerMode === undefined ? {} : { triggerMode })
  };
}

export function readAutomationMonitorId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= MAX_AUTOMATION_MONITOR_ID_LENGTH
    && /^tmux-session:[A-Za-z0-9_.:-]+$/u.test(normalized)
    ? normalized
    : undefined;
}

function readAutomationMonitorTriggerMode(
  value: unknown
): TmuxMonitorInput["triggerMode"] | undefined {
  return value === "manual" || value === "scheduled" || value === "local-state"
    ? value
    : undefined;
}

export function isEnabledEnvFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "on";
}

export function readPetWindowMode(value: unknown): PetWindowMode | undefined {
  return value === "compact" || value === "expanded" ? value : undefined;
}

export function readPermissionSettingsTarget(value: unknown): PermissionSettingsTarget | undefined {
  return value === "screen-recording"
    || value === "accessibility"
    ? value
    : undefined;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readVisiblePetRect(value: unknown): VisiblePetRect | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const rect = value as Partial<VisiblePetRect>;
  const x = readFiniteNumber(rect.x);
  const y = readFiniteNumber(rect.y);
  const width = readFiniteNumber(rect.width);
  const height = readFiniteNumber(rect.height);

  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }

  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return { x, y, width, height };
}
