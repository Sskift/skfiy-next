import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("personal memory main-process wiring", () => {
  it("instantiates the journal, pending, and settings stores through the memory bundle factory", () => {
    const source = readMainSource();
    const bundleSource = readMemoryStoresSource();

    // main.ts rebuilds the bundle (including for isolated profiles) and reads
    // the dashboard through the active bundle's base dir.
    expect(source).toContain("createMemoryStores");
    expect(source).toContain("let memoryStores = createMemoryStores");
    expect(source).toContain("readPersonalMemoryDashboardSnapshot");

    // The six memory stores are constructed together in the bundle factory.
    expect(bundleSource).toContain("createPersonalMemoryJournalStore");
    expect(bundleSource).toContain("createPendingPersonalMemoryStore");
    expect(bundleSource).toContain("createPersonalMemorySettingsStore");
    expect(bundleSource).toContain("createPersonalMemoryStore");
    expect(bundleSource).toContain("createSessionMemoryStore");
    expect(bundleSource).toContain("createPersonalSkillSettingsStore");
  });

  it("delegates completed assistant turns to the personalization learning loop", () => {
    const source = readMainSource();
    const scheduleIndex = source.indexOf("function schedulePersonalMemoryPostTurnReview");
    expect(scheduleIndex).toBeGreaterThan(-1);
    const scheduleBlock = source.slice(scheduleIndex, source.indexOf("function emitAssistantToolPlanTaskEvent", scheduleIndex));

    expect(source).toContain("recordCompletedAssistantTurnForPersonalization");
    expect(scheduleBlock).toContain("memoryStore: memoryStores.personalMemory");
    expect(scheduleBlock).toContain("memoryJournalStore: memoryStores.personalMemoryJournal");
    expect(scheduleBlock).toContain("pendingMemoryStore: memoryStores.pendingPersonalMemory");
    expect(scheduleBlock).toContain("sessionMemoryStore: memoryStores.sessionMemory");
    expect(scheduleBlock).toContain("memoryWriteApprovalEnabled: settings.writeApprovalEnabled");
    expect(scheduleBlock).toContain("postTurnLearningEnabled");
    expect(scheduleBlock).toContain("runReviewTurn: (reviewPrompt, { personalMemory }) => runAssistantAgentTurn(reviewPrompt");
    expect(scheduleBlock).toContain("timeoutMs: Math.min(assistantSettings.timeoutMs, PERSONAL_MEMORY_REVIEW_TIMEOUT_MS)");
  });

  it("registers the personal memory IPC channels and pushes change events to the renderer", () => {
    const source = readMainSource();

    for (const channel of [
      "skfiy:get-personal-memory",
      "skfiy:set-personal-memory-settings",
      "skfiy:forget-personal-memory",
      "skfiy:approve-pending-memory",
      "skfiy:reject-pending-memory",
      "skfiy:personal-memory-changed"
    ]) {
      expect(source).toContain(channel);
    }
    expect(source).toContain("emitPersonalMemoryChanged()");
  });
});

function readMainSource(): string {
  return readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
}

function readMemoryStoresSource(): string {
  return readFileSync(path.join(process.cwd(), "src/main/memory-stores.ts"), "utf8");
}
