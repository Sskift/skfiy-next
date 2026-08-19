import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Chrome tool-scoped host grant main wiring", () => {
  it("passes the active tool identity and clears ephemeral grants on every terminal path", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const preflight = sliceSource(
      source,
      "const hostPolicyApproval = await applyApprovedChromeTaskHostPolicy({",
      "const chromeHostPolicyPreflight = createChromeHostPolicyPreflightDecision({"
    );
    const complete = sliceSource(
      source,
      "function completeComputerUseToolCall(",
      "function cancelActiveComputerUseToolCall("
    );
    const cancel = sliceSource(
      source,
      "function cancelActiveComputerUseToolCall(",
      "async function resumePendingApprovalTask("
    );
    const clear = sliceSource(
      source,
      "function clearActiveComputerUseTask()",
      "function startComputerUseTaskEpoch()"
    );

    expect(source).toContain("createChromeTurnHostGrantStore");
    expect(preflight).toContain("toolIdentity");
    expect(preflight).toContain("turnGrantStore: chromeTurnHostGrantStore");
    expect(complete).toContain("chromeTurnHostGrantStore.clear(identity)");
    expect(cancel).toContain("chromeTurnHostGrantStore.clear(identity)");
    expect(clear).toContain("chromeTurnHostGrantStore.clear(activeComputerUseToolIdentity)");
  });
});

function sliceSource(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
