import { describe, expect, it, vi } from "vitest";

import {
  createUnknownFinderAutomationReadiness,
  testFinderAutomationReadiness
} from "./main-finder-automation-readiness";

describe("main Finder Automation readiness", () => {
  it("keeps untested Automation unknown instead of claiming permission", () => {
    expect(createUnknownFinderAutomationReadiness()).toEqual({
      state: "unknown",
      code: "finder-automation-not-tested",
      reason: "Finder Automation has not been tested from the pet yet.",
      nextAction: "Run the read-only Finder test. No files will be changed.",
      evidenceSource: "not-tested"
    });
  });

  it("proves Automation with a read-only Finder selection test", async () => {
    const getFinderSelection = vi.fn().mockResolvedValue({
      source: "finder-applescript",
      targetPath: "/Users/tester/Desktop",
      selection: []
    });

    await expect(testFinderAutomationReadiness({
      getFinderSelection,
      now: () => new Date("2026-07-11T00:00:00.000Z")
    })).resolves.toEqual({
      state: "proven-by-test",
      code: "finder-automation-ready",
      reason: "skfiy read Finder selection without changing files.",
      nextAction: "Finder workflows are ready for planning and approval.",
      evidenceSource: "finder-selection-test",
      testedAt: "2026-07-11T00:00:00.000Z"
    });
    expect(getFinderSelection).toHaveBeenCalledTimes(1);
  });

  it("maps Apple Events denial to one actionable permission blocker", async () => {
    const getFinderSelection = vi.fn().mockRejectedValue(
      new Error("Not authorized to send Apple events to Finder. (-1743)")
    );

    await expect(testFinderAutomationReadiness({ getFinderSelection })).resolves.toMatchObject({
      state: "blocked",
      code: "finder-automation-denied",
      reason: "macOS denied skfiy permission to control Finder.",
      nextAction: "Open Privacy & Security > Automation and allow skfiy to control Finder.",
      evidenceSource: "finder-selection-test"
    });
  });

  it("does not mislabel unrelated Finder failures as permission denial or leak paths", async () => {
    const getFinderSelection = vi.fn().mockRejectedValue(
      new Error("helper failed at /Users/tester/Secret/project token=abc")
    );

    const result = await testFinderAutomationReadiness({ getFinderSelection });

    expect(result).toMatchObject({
      state: "unknown",
      code: "finder-automation-test-failed",
      reason: "The read-only Finder Automation test did not complete.",
      nextAction: "Make sure Finder is available, then retry the read-only test."
    });
    expect(JSON.stringify(result)).not.toContain("/Users/tester");
    expect(JSON.stringify(result)).not.toContain("token=abc");
  });
});
