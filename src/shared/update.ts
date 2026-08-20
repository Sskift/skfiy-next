/**
 * App Update contract — shared types and guards for the custom GitHub
 * Releases updater (Phase 1, see docs/decisions/0002-update-mechanism.md).
 *
 * The update feed is the GitHub Releases API of the origin remote
 * (Sskift/skfiy-next). Main owns check/download/verify/install; preload
 * validates every payload with the guards below before it reaches the
 * renderer; the renderer keeps a pure reducer mirror in app-update-state.ts.
 */

export type UpdateChannel = "stable" | "beta";

export interface UpdateSettings {
  autoCheck: boolean;
  channel: UpdateChannel;
  skippedVersion?: string;
  lastCheckAt?: string;
  lastNotifiedVersion?: string;
}

export interface UpdateSettingsUpdate {
  autoCheck?: boolean;
  channel?: UpdateChannel;
  /** null clears the skipped version. */
  skippedVersion?: string | null;
  lastCheckAt?: string;
  lastNotifiedVersion?: string;
}

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | {
      status: "available";
      version: string;
      releaseNotes: string;
      releaseUrl: string;
      publishedAt: string;
    }
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string; releaseUrl?: string }
  | { status: "unsupported" };

export interface UpdateRollbackStatus {
  available: boolean;
  version?: string;
}

export interface UpdateStatusSummary {
  supported: boolean;
  channel: UpdateChannel;
  autoCheck: boolean;
  currentVersion: string;
  skippedVersion?: string;
  lastCheckAt?: string;
  rollback: UpdateRollbackStatus;
}

export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "beta"];

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "beta";
}

export function isUpdateSettings(value: unknown): value is UpdateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const settings = value as Record<string, unknown>;
  if (typeof settings.autoCheck !== "boolean" || !isUpdateChannel(settings.channel)) {
    return false;
  }
  if (settings.skippedVersion !== undefined && typeof settings.skippedVersion !== "string") {
    return false;
  }
  if (settings.lastCheckAt !== undefined && typeof settings.lastCheckAt !== "string") {
    return false;
  }
  if (
    settings.lastNotifiedVersion !== undefined
    && typeof settings.lastNotifiedVersion !== "string"
  ) {
    return false;
  }
  return true;
}

export function isUpdateState(value: unknown): value is UpdateState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  switch (state.status) {
    case "idle":
    case "checking":
    case "unsupported":
      return true;
    case "available":
      return (
        typeof state.version === "string"
        && typeof state.releaseNotes === "string"
        && typeof state.releaseUrl === "string"
        && typeof state.publishedAt === "string"
      );
    case "downloading":
      return typeof state.version === "string" && typeof state.percent === "number";
    case "ready":
      return typeof state.version === "string";
    case "error":
      return (
        typeof state.message === "string"
        && (state.releaseUrl === undefined || typeof state.releaseUrl === "string")
      );
    default:
      return false;
  }
}

export function isUpdateStatusSummary(value: unknown): value is UpdateStatusSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const summary = value as Record<string, unknown>;
  if (
    typeof summary.supported !== "boolean"
    || !isUpdateChannel(summary.channel)
    || typeof summary.autoCheck !== "boolean"
    || typeof summary.currentVersion !== "string"
  ) {
    return false;
  }
  if (summary.skippedVersion !== undefined && typeof summary.skippedVersion !== "string") {
    return false;
  }
  if (summary.lastCheckAt !== undefined && typeof summary.lastCheckAt !== "string") {
    return false;
  }
  if (!summary.rollback || typeof summary.rollback !== "object" || Array.isArray(summary.rollback)) {
    return false;
  }
  const rollback = summary.rollback as Record<string, unknown>;
  return (
    typeof rollback.available === "boolean"
    && (rollback.version === undefined || typeof rollback.version === "string")
  );
}
