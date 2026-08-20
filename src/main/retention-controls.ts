import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";

import {
  DEFAULT_RETENTION_SETTINGS,
  normalizeRetentionSettings,
  normalizeRetentionSettingsUpdate,
  type RetentionSettings,
  type RetentionSettingsUpdate
} from "../shared/retention.js";
import {
  createAutomationRunStatePath,
  createAutomationRunStore,
  isAutomationRunTerminal,
  type AutomationRunStoreIo
} from "./automation-run.js";

export interface RetentionSettingsIo {
  exists: (targetPath: string) => boolean;
  mkdir: (targetPath: string) => void;
  readFile: (targetPath: string) => string;
  writeFile: (targetPath: string, content: string) => void;
  rename?: (fromPath: string, toPath: string) => void;
}

export function createRetentionSettingsFilePath(baseDir: string): string {
  return path.join(baseDir, "retention-settings.json");
}

export interface RetentionSettingsStore {
  read(): RetentionSettings;
  update(update: RetentionSettingsUpdate): RetentionSettings;
  reset(): RetentionSettings;
}

export function createRetentionSettingsStore({
  baseDir,
  io = createDefaultRetentionSettingsIo(),
  now = () => new Date()
}: {
  baseDir: string;
  io?: RetentionSettingsIo;
  now?: () => Date;
}): RetentionSettingsStore {
  const filePath = createRetentionSettingsFilePath(baseDir);

  function persist(settings: RetentionSettings): void {
    io.mkdir(path.dirname(filePath));
    const content = `${JSON.stringify({ ...settings, updatedAt: now().toISOString() }, null, 2)}\n`;
    if (io.rename) {
      const tempPath = `${filePath}.tmp-${Date.now()}`;
      io.writeFile(tempPath, content);
      io.rename(tempPath, filePath);
    } else {
      io.writeFile(filePath, content);
    }
  }

  return {
    read(): RetentionSettings {
      if (!io.exists(filePath)) {
        return cloneDefaultRetentionSettings();
      }
      try {
        return normalizeRetentionSettings(JSON.parse(io.readFile(filePath)));
      } catch {
        return cloneDefaultRetentionSettings();
      }
    },
    update(update: RetentionSettingsUpdate): RetentionSettings {
      const current = this.read();
      const next = normalizeRetentionSettings({
        schemaVersion: 1,
        replay: { ...current.replay, ...(update.replay ?? {}) },
        screenshots: { ...current.screenshots, ...(update.screenshots ?? {}) },
        runHistory: { ...current.runHistory, ...(update.runHistory ?? {}) }
      });
      persist(next);
      return next;
    },
    reset(): RetentionSettings {
      const next = cloneDefaultRetentionSettings();
      persist(next);
      return next;
    }
  };
}

export interface ApplyRetentionResult {
  replay: {
    status: "applied" | "disabled" | "noop";
    note: string;
  };
  screenshots: {
    status: "applied" | "disabled";
    scanned: number;
    deleted: number;
  };
  runHistory: {
    status: "applied" | "disabled";
    before: number;
    after: number;
  };
}

/**
 * Enforces retention caps across replay (forward-looking no-op until replay
 * is persisted), screenshots in the temp dir, and automation run history.
 */
export async function applyRetention({
  homeDir,
  settings,
  io = createDefaultAutomationRunStoreIo(),
  tempDir = os.tmpdir(),
  now = () => new Date()
}: {
  homeDir: string;
  settings: RetentionSettings;
  io?: AutomationRunStoreIo;
  tempDir?: string;
  now?: () => Date;
}): Promise<ApplyRetentionResult> {
  return {
    replay: applyReplayRetention(settings),
    screenshots: await applyScreenshotRetention({ settings, tempDir, now }),
    runHistory: applyRunHistoryRetention({ homeDir, settings, io, now })
  };
}

function applyReplayRetention(settings: RetentionSettings): ApplyRetentionResult["replay"] {
  if (!settings.replay.enabled) {
    return { status: "disabled", note: "Replay retention is disabled." };
  }
  // Turn replay is in-memory only; the runtime-snapshot persists a summary.
  // When replay persistence lands, prune turns beyond maxTurns or older than
  // maxAgeDays here.
  return {
    status: "noop",
    note: `Replay retention is forward-looking: keeping the last ${settings.replay.maxTurns} turns, ${settings.replay.maxAgeDays} days.`
  };
}

async function applyScreenshotRetention({
  settings,
  tempDir,
  now
}: {
  settings: RetentionSettings;
  tempDir: string;
  now: () => Date;
}): Promise<ApplyRetentionResult["screenshots"]> {
  if (!settings.screenshots.enabled) {
    return { status: "disabled", scanned: 0, deleted: 0 };
  }

  const screenshotDir = path.join(tempDir, "skfiy");
  let entries: string[];
  try {
    entries = await readdir(screenshotDir);
  } catch {
    return { status: "applied", scanned: 0, deleted: 0 };
  }

  const cutoffMs = now().getTime() - settings.screenshots.maxAgeDays * 24 * 60 * 60 * 1_000;
  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".png"))
      .map(async (entry) => {
        const filePath = path.join(screenshotDir, entry);
        try {
          const stats = await stat(filePath);
          return { filePath, mtimeMs: stats.mtimeMs };
        } catch {
          return undefined;
        }
      })
  ).then((results) =>
    results.filter((file): file is { filePath: string; mtimeMs: number } => Boolean(file))
  );

  const sorted = files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let deleted = 0;
  for (const [index, file] of sorted.entries()) {
    if (index >= settings.screenshots.maxCount || file.mtimeMs < cutoffMs) {
      try {
        await rm(file.filePath, { force: true });
        deleted += 1;
      } catch {
        // A failed screenshot deletion is non-fatal; the next run retries.
      }
    }
  }

  return { status: "applied", scanned: sorted.length, deleted };
}

function applyRunHistoryRetention({
  homeDir,
  settings,
  io,
  now
}: {
  homeDir: string;
  settings: RetentionSettings;
  io: AutomationRunStoreIo;
  now: () => Date;
}): ApplyRetentionResult["runHistory"] {
  const filePath = createAutomationRunStatePath(homeDir);
  if (!io.exists(filePath)) {
    return {
      status: settings.runHistory.enabled ? "applied" : "disabled",
      before: 0,
      after: 0
    };
  }
  const store = createAutomationRunStore({
    filePath,
    io,
    caps: {
      perMonitorCap: settings.runHistory.perMonitorCap,
      globalCap: settings.runHistory.globalCap
    }
  });
  const snapshot = store.read();
  const before = snapshot.runs.length;

  if (!settings.runHistory.enabled) {
    return { status: "disabled", before, after: before };
  }

  const cutoffMs = now().getTime() - settings.runHistory.maxAgeDays * 24 * 60 * 60 * 1_000;
  const agedOut = (runFinishedAt: string | undefined): boolean => {
    if (!runFinishedAt) {
      return false;
    }
    const finishedMs = Date.parse(runFinishedAt);
    return Number.isFinite(finishedMs) && finishedMs < cutoffMs;
  };
  const retained = snapshot.runs.filter(
    (run) => !isAutomationRunTerminal(run.state)
      || !agedOut(run.finishedAt ?? run.updatedAt ?? run.createdAt)
  );
  store.write({ ...snapshot, runs: retained });
  return { status: "applied", before, after: store.read().runs.length };
}

function cloneDefaultRetentionSettings(): RetentionSettings {
  return JSON.parse(JSON.stringify(DEFAULT_RETENTION_SETTINGS)) as RetentionSettings;
}

function createDefaultRetentionSettingsIo(): RetentionSettingsIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8"),
    rename: renameSync
  };
}

function createDefaultAutomationRunStoreIo(): AutomationRunStoreIo {
  return {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8"),
    rename: renameSync
  };
}

export { normalizeRetentionSettingsUpdate };
