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
  sessionName: string;
  label?: string;
  intervalMs: number;
  enabled?: boolean;
}

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

export function readTmuxMonitorInput(input: unknown): TmuxMonitorInput {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const sessionName = typeof record.sessionName === "string" ? record.sessionName : "";
  const intervalMs = typeof record.intervalMs === "number" && Number.isFinite(record.intervalMs)
    ? record.intervalMs
    : 300_000;
  const label = typeof record.label === "string" ? record.label : undefined;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : undefined;

  return {
    sessionName,
    ...(label ? { label } : {}),
    intervalMs,
    ...(enabled === undefined ? {} : { enabled })
  };
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
