import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("personal memory main-process wiring", () => {
  it("instantiates the journal, pending, and settings stores next to the durable memory store", () => {
    const source = readMainSource();

    expect(source).toContain("createPersonalMemoryJournalStore");
    expect(source).toContain("createPendingPersonalMemoryStore");
    expect(source).toContain("createPersonalMemorySettingsStore");
    expect(source).toContain("readPersonalMemoryDashboardSnapshot");
  });

  it("delegates completed assistant turns to the personalization learning loop", () => {
    const source = readMainSource();
    const scheduleIndex = source.indexOf("function schedulePersonalMemoryPostTurnReview");
    expect(scheduleIndex).toBeGreaterThan(-1);
    const scheduleBlock = source.slice(scheduleIndex, source.indexOf("function emitAssistantToolPlanTaskEvent", scheduleIndex));

    expect(source).toContain("recordCompletedAssistantTurnForPersonalization");
    expect(scheduleBlock).toContain("memoryStore: personalMemoryStore");
    expect(scheduleBlock).toContain("memoryJournalStore: personalMemoryJournalStore");
    expect(scheduleBlock).toContain("pendingMemoryStore: pendingPersonalMemoryStore");
    expect(scheduleBlock).toContain("sessionMemoryStore");
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
