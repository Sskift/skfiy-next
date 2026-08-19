import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Task Control preload contract", () => {
  it("validates and clones Task Control snapshots for hydration, events, and replay", () => {
    const preload = readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");

    expect(preload).toContain("isTaskControlSnapshot");
    expect(preload).toContain("cloneTaskControlSnapshot");
    expect(preload).toContain('ipcRenderer.invoke("skfiy:get-task-control")');
    expect(preload).toContain("getTaskControl: () => Promise<TaskControlSnapshot | null>");
    expect(preload).toContain("taskControl?: TaskControlSnapshot");
    expect(preload).toContain("candidate.taskControl === undefined");
    expect(preload).toContain("event.taskControl === undefined");
    expect(preload).toContain('"approval"');
    expect(preload).toContain("isTaskControlApproval");
    expect(preload).toContain("isTaskControlFinderPlanPreview");
    expect(preload).toContain("cloneTaskControlApproval");
    expect(preload).toContain("createFolders: [...approval.finderPlanPreview.createFolders]");
    expect(preload).toContain("moveFiles: approval.finderPlanPreview.moveFiles.map");
  });

  it("requires exact plan-bound approval decision payloads at the IPC boundary", () => {
    const preload = readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");

    expect(preload).toContain("approveTask: (input: TaskApprovalDecisionInput) => Promise<void>");
    expect(preload).toContain("denyTask: (input: TaskApprovalDecisionInput) => Promise<void>");
    expect(preload).toContain("requireTaskApprovalDecisionInput(input)");
    expect(preload).toContain('ipcRenderer.invoke("skfiy:approve-task", decision)');
    expect(preload).toContain('ipcRenderer.invoke("skfiy:deny-task", decision)');
  });
});
