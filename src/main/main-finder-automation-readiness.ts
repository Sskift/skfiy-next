export type FinderAutomationReadinessState = "proven-by-test" | "blocked" | "unknown";

export interface FinderAutomationReadiness {
  state: FinderAutomationReadinessState;
  code:
    | "finder-automation-ready"
    | "finder-automation-denied"
    | "finder-automation-not-tested"
    | "finder-automation-test-failed";
  reason: string;
  nextAction: string;
  evidenceSource: "finder-selection-test" | "not-tested";
  testedAt?: string;
}

export function createUnknownFinderAutomationReadiness(): FinderAutomationReadiness {
  return {
    state: "unknown",
    code: "finder-automation-not-tested",
    reason: "Finder Automation has not been tested from the pet yet.",
    nextAction: "Run the read-only Finder test. No files will be changed.",
    evidenceSource: "not-tested"
  };
}

export async function testFinderAutomationReadiness({
  getFinderSelection,
  now = () => new Date()
}: {
  getFinderSelection: () => Promise<unknown>;
  now?: () => Date;
}): Promise<FinderAutomationReadiness> {
  try {
    await getFinderSelection();

    return {
      state: "proven-by-test",
      code: "finder-automation-ready",
      reason: "skfiy read Finder selection without changing files.",
      nextAction: "Finder workflows are ready for planning and approval.",
      evidenceSource: "finder-selection-test",
      testedAt: now().toISOString()
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isFinderAutomationPermissionError(message)) {
      return {
        state: "blocked",
        code: "finder-automation-denied",
        reason: "macOS denied skfiy permission to control Finder.",
        nextAction: "Open Privacy & Security > Automation and allow skfiy to control Finder.",
        evidenceSource: "finder-selection-test",
        testedAt: now().toISOString()
      };
    }

    return {
      state: "unknown",
      code: "finder-automation-test-failed",
      reason: "The read-only Finder Automation test did not complete.",
      nextAction: "Make sure Finder is available, then retry the read-only test.",
      evidenceSource: "finder-selection-test",
      testedAt: now().toISOString()
    };
  }
}

function isFinderAutomationPermissionError(message: string): boolean {
  return /(?:-1743|apple events?|automation permission|not authorized|not permitted).*(?:finder|apple events?)|(?:finder).*(?:-1743|not authorized|not permitted|automation permission)/i
    .test(message);
}
