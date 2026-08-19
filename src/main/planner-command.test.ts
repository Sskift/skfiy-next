import { describe, expect, it, vi } from "vitest";
import { resolvePlannerCommand } from "./planner-command";

describe("resolvePlannerCommand", () => {
  it("keeps the original command for the local deterministic runtime", async () => {
    await expect(resolvePlannerCommand({
      input: "打开 Ghostty 执行 pwd 并截图",
      runtime: { decision: "run-local-deterministic" },
      createExternalPlanner: () => {
        throw new Error("should not create external planner");
      }
    })).resolves.toEqual({
      command: "打开 Ghostty 执行 pwd 并截图"
    });
  });

  it("uses the external CUA planner when that runtime is selected", async () => {
    const planTerminalCommand = vi.fn(async () => ({
      command: "pwd",
      rationale: "Read current directory."
    }));

    await expect(resolvePlannerCommand({
      input: "打开 Ghostty 执行 pwd 并截图",
      runtime: {
        decision: "run-external-cua",
        label: "External CUA",
        endpoint: "https://cua.example.test/plan"
      },
      createExternalPlanner: () => ({ planTerminalCommand })
    })).resolves.toEqual({
      command: "pwd",
      providerLabel: "External CUA",
      rationale: "Read current directory."
    });
    expect(planTerminalCommand).toHaveBeenCalledWith({
      input: "打开 Ghostty 执行 pwd 并截图",
      signal: undefined
    });
  });
});
