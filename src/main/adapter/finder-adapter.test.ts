import { describe, expect, it } from "vitest";
import {
  createFinderAdapter,
  type FinderAdapter
} from "./finder-adapter";

async function collect<T>(events: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

describe("finder adapter", () => {
  const adapter: FinderAdapter = createFinderAdapter();

  it("declares its identity and target", () => {
    expect(adapter.id).toBe("finder");
    expect(adapter.displayName).toBe("Finder");
    expect(adapter.targetIdentity).toEqual({
      kind: "bundle_id",
      value: "com.apple.finder"
    });
  });

  it("declares finder capabilities", () => {
    expect(adapter.capabilities).toEqual([
      "desktop_action_execute",
      "desktop_screenshot",
      "desktop_session_status",
      "finder_selection",
      "finder_item_layout"
    ]);
  });

  it("declares action and plan approval gates", () => {
    expect(adapter.approvalPolicy.gates).toEqual(["action", "plan"]);
  });

  it("declares plan schema version 1", () => {
    expect(adapter.planSchema.schemaVersion).toBe(1);
  });

  it("declares filesystem post-condition verification", () => {
    expect(adapter.verificationStrategy).toBe("filesystem_post_condition");
  });

  it("declares no abort-signal stop support", () => {
    expect(adapter.stopBehavior.supportsAbortSignal).toBe(false);
  });

  it("declares its blocker stages", () => {
    expect(adapter.blockerStages).toEqual([
      "input",
      "file_operation",
      "desktop_session",
      "activate",
      "observe",
      "selection",
      "layout",
      "drag"
    ]);
  });

  it("does not declare a packaged smoke contract", () => {
    expect(adapter.smoke).toBeUndefined();
  });

  it("parses a current-folder organization intent", () => {
    const intent = adapter.parseInput("整理 Finder 当前文件夹");
    expect(intent.ok).toBe(true);
    if (intent.ok) {
      expect(intent.command).toBe("Finder current folder");
      expect(intent.plan.target).toEqual({ kind: "current_finder_folder" });
    }
  });

  it("parses an absolute-path organization intent", () => {
    const intent = adapter.parseInput("整理 Finder 测试文件夹 /tmp/skfiy-test");
    expect(intent.ok).toBe(true);
    if (intent.ok) {
      expect(intent.command).toBe("/tmp/skfiy-test");
      expect(intent.plan.target).toEqual({
        kind: "absolute_path",
        rootPath: "/tmp/skfiy-test"
      });
    }
  });

  it("rejects non-finder input", () => {
    const intent = adapter.parseInput("在 Ghostty 执行 pwd");
    expect(intent.ok).toBe(false);
    if (!intent.ok) {
      expect(intent.reason).toContain("Finder organization requires");
    }
  });

  it("matches finder organization requests", () => {
    expect(adapter.matchesRoute("整理 Finder 当前文件夹")).toBe(true);
    expect(adapter.matchesRoute("整理 Finder 选中文件夹")).toBe(true);
    expect(adapter.matchesRoute("整理 Finder 测试文件夹 /tmp/skfiy-test")).toBe(true);
    expect(adapter.matchesRoute("重命名 Finder 选中文件为 new-name.txt")).toBe(true);
  });

  it("does not match non-finder requests", () => {
    expect(adapter.matchesRoute("在 Ghostty 执行 pwd")).toBe(false);
    expect(adapter.matchesRoute("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文")).toBe(false);
    expect(adapter.matchesRoute("监督 money-run tmux session")).toBe(false);
  });

  it("delegates risk classification to the finder risk reader", () => {
    const risk = adapter.readRisk("整理 Finder 当前文件夹");
    expect(risk.level).toBe("medium");
    expect(risk.requiresApproval).toBe(true);
  });

  it("returns no required permissions", async () => {
    const permissions = await adapter.readRequiredPermissions(undefined);
    expect(permissions).toEqual([]);
  });

  it("delegates execution to the finder orchestrator", async () => {
    const events = await collect(
      adapter.run("整理 Finder 当前文件夹", undefined, { approved: false })
    );

    // Without approval the orchestrator yields started + approval_required and halts.
    const types = events.map((event) => event.type);
    expect(types).toContain("started");
    expect(types).toContain("approval_required");
    expect(types).not.toContain("completed");
  });

  it("yields input verification failure for unparseable input", async () => {
    const events = await collect(
      adapter.run("not a finder command", undefined, { approved: true })
    );

    const types = events.map((event) => event.type);
    expect(types).toContain("started");
    expect(types).toContain("verification_failed");
    const failed = events.find((event) => event.type === "verification_failed");
    if (failed && failed.type === "verification_failed") {
      expect(failed.stage).toBe("input");
    }
  });
});
