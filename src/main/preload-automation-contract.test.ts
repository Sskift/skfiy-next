import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("preload automation contract", () => {
  it("validates monitor snapshots, runtimes, and previews fail closed", () => {
    const source = readPreloadSource();

    for (const validator of [
      "function isAutomationMonitorSnapshot",
      "function isAutomationMonitorRuntime",
      "function isAutomationMonitorDefinitionPreview",
      "function isAutomationRunSnapshot",
      "function isAutomationRunRecord",
      "function isAutomationRunState"
    ]) {
      expect(source).toContain(validator);
    }
    expect(source).toContain("function createDefaultAutomationMonitorSnapshot");
    expect(source).toContain("function createDefaultAutomationMonitorDefinitionPreview");
    expect(source).toContain("function createDefaultAutomationRunSnapshot");
  });

  it("exposes every automation IPC channel with fallback defaults", () => {
    const source = readPreloadSource();

    for (const channel of [
      "skfiy:get-automation-monitors",
      "skfiy:upsert-tmux-monitor",
      "skfiy:run-automation-monitor-now",
      "skfiy:duplicate-automation-monitor",
      "skfiy:set-automation-monitor-enabled",
      "skfiy:delete-automation-monitor",
      "skfiy:preview-tmux-automation",
      "skfiy:get-automation-runs",
      "skfiy:stop-automation-run"
    ]) {
      expect(source).toContain(channel);
    }

    for (const method of [
      "async getAutomationMonitors()",
      "async upsertTmuxMonitor(input)",
      "async duplicateAutomationMonitor(id)",
      "async runAutomationMonitorNow(id)",
      "async setAutomationMonitorEnabled(id, enabled)",
      "async deleteAutomationMonitor(id)",
      "async previewTmuxAutomation(input)",
      "async getAutomationRuns()",
      "async stopAutomationRun(runId)"
    ]) {
      expect(source).toContain(method);
    }
  });
});

function readPreloadSource(): string {
  return readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");
}
