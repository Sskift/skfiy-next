import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  applyRetention,
  createRetentionSettingsFilePath,
  createRetentionSettingsStore
} from "./retention-controls";
import { DEFAULT_RETENTION_SETTINGS } from "../shared/retention";
import {
  AUTOMATION_RUN_GLOBAL_CAP,
  AUTOMATION_RUN_PER_MONITOR_CAP,
  createAutomationRunRecord,
  type AutomationRunConfig,
  type AutomationRunRecord
} from "./automation-run";
import type { RetentionSettingsIo } from "./retention-controls";

const BASE_DIR = "/app-support/skfiy";
const HOME_DIR = "/Users/tester";

function createMemoryIo(initial: Record<string, string> = {}): RetentionSettingsIo & {
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    exists: (targetPath) => Object.prototype.hasOwnProperty.call(files, targetPath),
    mkdir: () => undefined,
    readFile: (targetPath) => {
      const content = files[targetPath];
      if (content === undefined) {
        throw new Error(`Missing ${targetPath}`);
      }
      return content;
    },
    writeFile: (targetPath, content) => {
      files[targetPath] = content;
    },
    rename: (fromPath, toPath) => {
      files[toPath] = files[fromPath] ?? "";
      delete files[fromPath];
    }
  };
}

function createRunConfig(): AutomationRunConfig {
  return {
    sessionName: "work",
    timeoutMs: 30_000,
    maxAttempts: 3,
    backoffMs: 30_000,
    backoffMultiplier: 2,
    maxBackoffMs: 300_000,
    runTtlMs: 900_000,
    concurrencyPolicy: "skip",
    maxConcurrency: 1
  };
}

function createRun(
  monitorId: string,
  sequence: number,
  finishedAt: string,
  state: AutomationRunRecord["state"] = "completed"
): AutomationRunRecord {
  const record = createAutomationRunRecord({
    monitorId,
    sequence,
    trigger: "manual",
    now: finishedAt,
    config: createRunConfig()
  });
  return {
    ...record,
    state,
    finishedAt,
    updatedAt: finishedAt
  };
}

describe("retention settings store", () => {
  it("defaults match the automation run caps", () => {
    expect(DEFAULT_RETENTION_SETTINGS.runHistory.perMonitorCap).toBe(AUTOMATION_RUN_PER_MONITOR_CAP);
    expect(DEFAULT_RETENTION_SETTINGS.runHistory.globalCap).toBe(AUTOMATION_RUN_GLOBAL_CAP);
  });

  it("returns defaults when the settings file is missing", () => {
    const io = createMemoryIo();
    const store = createRetentionSettingsStore({ baseDir: BASE_DIR, io });

    expect(store.read()).toEqual(DEFAULT_RETENTION_SETTINGS);
  });

  it("persists updates and re-reads them", () => {
    const io = createMemoryIo();
    const store = createRetentionSettingsStore({ baseDir: BASE_DIR, io });

    const updated = store.update({ runHistory: { perMonitorCap: 5 } });

    expect(updated.runHistory.perMonitorCap).toBe(5);
    expect(updated.runHistory.globalCap).toBe(DEFAULT_RETENTION_SETTINGS.runHistory.globalCap);
    const filePath = createRetentionSettingsFilePath(BASE_DIR);
    expect(io.files[filePath]).toContain('"perMonitorCap": 5');

    const reRead = createRetentionSettingsStore({ baseDir: BASE_DIR, io }).read();
    expect(reRead.runHistory.perMonitorCap).toBe(5);
  });

  it("falls back to defaults when the settings file is corrupt", () => {
    const io = createMemoryIo({
      [createRetentionSettingsFilePath(BASE_DIR)]: "{ corrupt"
    });
    const store = createRetentionSettingsStore({ baseDir: BASE_DIR, io });

    expect(store.read()).toEqual(DEFAULT_RETENTION_SETTINGS);
  });

  it("resets to defaults", () => {
    const io = createMemoryIo();
    const store = createRetentionSettingsStore({ baseDir: BASE_DIR, io });
    store.update({ screenshots: { maxCount: 10 } });

    const reset = store.reset();

    expect(reset).toEqual(DEFAULT_RETENTION_SETTINGS);
    expect(store.read()).toEqual(DEFAULT_RETENTION_SETTINGS);
  });
});

describe("applyRetention", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "skfiy-retention-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prunes screenshots beyond maxCount and older than maxAgeDays", async () => {
    const screenshotDir = path.join(tempDir, "skfiy");
    await mkdir(screenshotDir, { recursive: true });
    const now = new Date("2026-08-20T12:00:00.000Z");
    // 5 screenshots, all created now; maxCount=2 keeps the 2 newest
    for (let index = 0; index < 5; index += 1) {
      await writeFile(path.join(screenshotDir, `shot-${index}.png`), "png");
    }

    const settings = {
      ...DEFAULT_RETENTION_SETTINGS,
      screenshots: { enabled: true, maxCount: 2, maxAgeDays: 14 }
    };
    const result = await applyRetention({
      homeDir: HOME_DIR,
      settings,
      tempDir,
      now: () => now
    });

    expect(result.screenshots.status).toBe("applied");
    expect(result.screenshots.scanned).toBe(5);
    expect(result.screenshots.deleted).toBe(3);
  });

  it("prunes screenshots older than maxAgeDays even when under maxCount", async () => {
    const screenshotDir = path.join(tempDir, "skfiy");
    await mkdir(screenshotDir, { recursive: true });
    const now = new Date("2026-08-20T12:00:00.000Z");
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(path.join(screenshotDir, "recent.png"), "png");
    await writeFile(path.join(screenshotDir, "old.png"), "png");
    await utimes(path.join(screenshotDir, "old.png"), oldDate, oldDate);

    const settings = {
      ...DEFAULT_RETENTION_SETTINGS,
      screenshots: { enabled: true, maxCount: 200, maxAgeDays: 14 }
    };
    const result = await applyRetention({
      homeDir: HOME_DIR,
      settings,
      tempDir,
      now: () => now
    });

    expect(result.screenshots.deleted).toBe(1);
  });

  it("prunes run history beyond the configured caps and maxAgeDays", async () => {
    const io = createMemoryIo();
    const now = new Date("2026-08-20T12:00:00.000Z");
    const runs: AutomationRunRecord[] = [];
    // 25 runs for one monitor (perMonitorCap default 20) — the 5 oldest terminal runs go
    for (let i = 0; i < 25; i += 1) {
      runs.push(createRun(
        "tmux-session:work",
        i,
        new Date(Date.UTC(2026, 7, 1, i)).toISOString()
      ));
    }
    // One very old run for a second monitor (age pruning)
    runs.push(createRun(
      "tmux-session:old",
      0,
      new Date("2026-01-01T00:00:00.000Z").toISOString()
    ));
    io.files[`${HOME_DIR}/Library/Application Support/skfiy/automation-runs.json`] =
      JSON.stringify({ schemaVersion: 1, sequences: {}, runs });

    const settings = {
      ...DEFAULT_RETENTION_SETTINGS,
      runHistory: { enabled: true, perMonitorCap: 20, globalCap: 200, maxAgeDays: 90 }
    };
    const result = await applyRetention({
      homeDir: HOME_DIR,
      settings,
      io,
      now: () => now
    });

    expect(result.runHistory.status).toBe("applied");
    expect(result.runHistory.before).toBe(26);
    // 25 for work → 20 kept; the old run for "old" is aged out
    expect(result.runHistory.after).toBe(20);
  });

  it("is a no-op for disabled categories", async () => {
    const io = createMemoryIo();
    const runs = [
      createRun("tmux-session:work", 0, "2026-01-01T00:00:00.000Z"),
      createRun("tmux-session:work", 1, "2026-01-02T00:00:00.000Z")
    ];
    io.files[`${HOME_DIR}/Library/Application Support/skfiy/automation-runs.json`] =
      JSON.stringify({ schemaVersion: 1, sequences: {}, runs });

    const settings = {
      ...DEFAULT_RETENTION_SETTINGS,
      replay: { enabled: false, maxTurns: 50, maxAgeDays: 30 },
      screenshots: { enabled: false, maxCount: 1, maxAgeDays: 1 },
      runHistory: { enabled: false, perMonitorCap: 1, globalCap: 1, maxAgeDays: 1 }
    };
    const result = await applyRetention({
      homeDir: HOME_DIR,
      settings,
      io,
      now: () => new Date("2026-08-20T12:00:00.000Z")
    });

    expect(result.runHistory.status).toBe("disabled");
    expect(result.runHistory.before).toBe(2);
    expect(result.runHistory.after).toBe(2);
    expect(result.screenshots.status).toBe("disabled");
    expect(result.replay.status).toBe("disabled");
  });

  it("reports replay retention as a forward-looking no-op", async () => {
    const result = await applyRetention({
      homeDir: HOME_DIR,
      settings: DEFAULT_RETENTION_SETTINGS,
      now: () => new Date("2026-08-20T12:00:00.000Z")
    });

    expect(result.replay.status).toBe("noop");
    expect(result.replay.note).toContain("50");
  });
});
