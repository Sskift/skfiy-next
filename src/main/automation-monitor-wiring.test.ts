import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("automation monitor main-process wiring", () => {
  it("registers every automation IPC channel", () => {
    const source = readMainSource();

    for (const channel of [
      "skfiy:get-automation-monitors",
      "skfiy:upsert-tmux-monitor",
      "skfiy:run-automation-monitor-now",
      "skfiy:duplicate-automation-monitor",
      "skfiy:set-automation-monitor-enabled",
      "skfiy:delete-automation-monitor",
      "skfiy:preview-tmux-automation"
    ]) {
      expect(source).toContain(channel);
    }
  });

  it("generates the safety preview main-side and never accepts a renderer-supplied preview", () => {
    const source = readMainSource();
    const payloadSource = readPayloadSource();

    expect(source).toContain("createTmuxAutomationMonitorPreview");
    expect(source).toContain("normalizeMonitorTimeoutMs");
    // The upsert path normalizes through the payload reader, which must not
    // read a "preview" field from the renderer.
    expect(payloadSource).not.toContain("record.preview");
    expect(payloadSource).not.toContain("preview:");
  });

  it("starts the manager when the app is ready and stops it before quit", () => {
    const source = readMainSource();

    const readyIndex = source.indexOf("app.whenReady()");
    expect(readyIndex).toBeGreaterThan(-1);
    const readyBlock = source.slice(readyIndex, source.indexOf("app.on(\"activate\"", readyIndex));
    expect(readyBlock).toContain("automationMonitorManager.start()");

    const quitIndex = source.indexOf("app.on(\"before-quit\"");
    expect(quitIndex).toBeGreaterThan(-1);
    const quitBlock = source.slice(quitIndex, source.indexOf("app.on(\"window-all-closed\"", quitIndex));
    expect(quitBlock).toContain("automationMonitorManager.stop()");
  });
});

function readMainSource(): string {
  return readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
}

function readPayloadSource(): string {
  return readFileSync(path.join(process.cwd(), "src/main/main-ipc-payload.ts"), "utf8");
}
