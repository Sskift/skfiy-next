import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("preload personal memory contract", () => {
  it("validates dashboard snapshots, settings, pending writes, and journal entries fail closed", () => {
    const source = readPreloadSource();

    for (const validator of [
      "function isPersonalMemoryDashboardSnapshot",
      "function isPersonalMemorySettings",
      "function isPendingPersonalMemoryWrite",
      "function isPersonalMemoryJournalEntry",
      "function isPersonalMemoryForgetResult",
      "function isPersonalMemoryPendingApprovalResult",
      "function isPersonalMemoryPendingRejectResult"
    ]) {
      expect(source).toContain(validator);
    }
    expect(source).toContain("function createDefaultPersonalMemoryDashboardSnapshot");
    expect(source).toContain("function createDefaultPersonalMemorySettings");
  });

  it("exposes every personal memory IPC channel with fallback defaults", () => {
    const source = readPreloadSource();

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

    for (const method of [
      "async getPersonalMemory()",
      "async setPersonalMemorySettings(update)",
      "async forgetPersonalMemory(input)",
      "async approvePendingMemory(pendingId)",
      "async rejectPendingMemory(pendingId)",
      "onPersonalMemoryChanged(callback)"
    ]) {
      expect(source).toContain(method);
    }
  });
});

function readPreloadSource(): string {
  return readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");
}
