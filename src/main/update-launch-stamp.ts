/**
 * Update launch stamp — the crash-loop guard for auto-rollback.
 *
 * main.ts writes <appSupport>/update-launch.json very early at startup and
 * clears it on clean will-quit. If a launch exits within the quick-exit
 * window (crash, or a broken update that cannot stay up), the stamp survives
 * and the next launch increments quickExitCount. Once the count crosses the
 * threshold on the just-updated version and a rollback copy exists, main
 * swaps the previous bundle back and relaunches — recovery that works
 * without the settings UI.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const QUICK_EXIT_WINDOW_MS = 30_000;
export const AUTO_ROLLBACK_THRESHOLD = 3;

export interface UpdateLaunchStamp {
  installedVersion: string;
  lastLaunchedVersion: string;
  launchedAt: string;
  quickExitCount: number;
}

export interface UpdateLaunchIo {
  exists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string;
  writeFile: (targetPath: string, content: string) => void;
  rename: (fromPath: string, toPath: string) => void;
  remove: (targetPath: string) => void;
  mkdir: (targetPath: string) => void;
}

export interface LaunchStartResult {
  stamp: UpdateLaunchStamp;
  /** The previous launch of this version exited within the quick-exit window. */
  quickExitDetected: boolean;
  /** The installed version changed since the last launch (an update landed). */
  newInstallDetected: boolean;
  /** quickExitCount crossed the auto-rollback threshold. */
  autoRollbackRecommended: boolean;
}

export function createDefaultUpdateLaunchIo(): UpdateLaunchIo {
  return {
    exists: (targetPath: string) => existsSync(targetPath),
    readFile: (targetPath: string) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath: string, content: string) => {
      writeFileSync(targetPath, content, "utf8");
    },
    rename: (fromPath: string, toPath: string) => renameSync(fromPath, toPath),
    remove: (targetPath: string) => {
      rmSync(targetPath, { force: true });
    },
    mkdir: (targetPath: string) => {
      mkdirSync(targetPath, { recursive: true });
    }
  };
}

export function readUpdateLaunchStamp(
  filePath: string,
  io: UpdateLaunchIo = createDefaultUpdateLaunchIo()
): UpdateLaunchStamp | null {
  if (!io.exists(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(io.readFile(filePath)) as unknown;
    return coerceUpdateLaunchStamp(parsed);
  } catch {
    return null;
  }
}

function coerceUpdateLaunchStamp(value: unknown): UpdateLaunchStamp | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.installedVersion !== "string"
    || typeof record.lastLaunchedVersion !== "string"
    || typeof record.launchedAt !== "string"
    || typeof record.quickExitCount !== "number"
    || !Number.isSafeInteger(record.quickExitCount)
    || record.quickExitCount < 0
  ) {
    return null;
  }
  return {
    installedVersion: record.installedVersion,
    lastLaunchedVersion: record.lastLaunchedVersion,
    launchedAt: record.launchedAt,
    quickExitCount: record.quickExitCount
  };
}

export function writeUpdateLaunchStamp(
  filePath: string,
  stamp: UpdateLaunchStamp,
  io: UpdateLaunchIo = createDefaultUpdateLaunchIo()
): void {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash > 0) {
    io.mkdir(filePath.slice(0, lastSlash));
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  io.writeFile(tmpPath, `${JSON.stringify(stamp, null, 2)}\n`);
  io.rename(tmpPath, filePath);
}

export function clearUpdateLaunchStamp(
  filePath: string,
  io: UpdateLaunchIo = createDefaultUpdateLaunchIo()
): void {
  io.remove(filePath);
}

/**
 * Record a launch start. Call this as early as possible in main startup.
 * A clean process calls clearUpdateLaunchStamp on will-quit, so a surviving
 * stamp means the previous launch did not quit cleanly.
 */
export function recordUpdateLaunchStart(input: {
  filePath: string;
  currentVersion: string;
  now: Date;
  io?: UpdateLaunchIo;
}): LaunchStartResult {
  const io = input.io ?? createDefaultUpdateLaunchIo();
  const previous = readUpdateLaunchStamp(input.filePath, io);
  const newInstallDetected =
    previous !== null && previous.installedVersion !== input.currentVersion;
  const previousLaunchedAt = previous ? Date.parse(previous.launchedAt) : Number.NaN;
  const quickExitDetected =
    previous !== null
    && !newInstallDetected
    && previous.lastLaunchedVersion === input.currentVersion
    && !Number.isNaN(previousLaunchedAt)
    && input.now.getTime() - previousLaunchedAt <= QUICK_EXIT_WINDOW_MS;

  const quickExitCount = newInstallDetected
    ? 0
    : quickExitDetected
      ? previous.quickExitCount + 1
      : previous?.quickExitCount ?? 0;

  const stamp: UpdateLaunchStamp = {
    installedVersion: input.currentVersion,
    lastLaunchedVersion: input.currentVersion,
    launchedAt: input.now.toISOString(),
    quickExitCount
  };
  writeUpdateLaunchStamp(input.filePath, stamp, io);

  return {
    stamp,
    quickExitDetected,
    newInstallDetected,
    autoRollbackRecommended: quickExitCount >= AUTO_ROLLBACK_THRESHOLD
  };
}

export function shouldAutoRollback(stamp: UpdateLaunchStamp): boolean {
  return stamp.quickExitCount >= AUTO_ROLLBACK_THRESHOLD;
}
