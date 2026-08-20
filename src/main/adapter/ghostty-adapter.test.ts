import { describe, expect, it } from "vitest";
import {
  createGhosttyAdapter,
  isExplicitTerminalControlRequest,
  type GhosttyAdapter
} from "./ghostty-adapter";
import type { DesktopClient } from "../orchestrator/ghostty-task";
import type { PermissionSummary } from "../computer-use/types";

function createPermissionSummary(
  screenRecording: PermissionSummary["screenRecording"]["state"] = "granted",
  accessibility: PermissionSummary["accessibility"]["state"] = "granted"
): PermissionSummary {
  return {
    screenRecording: { state: screenRecording },
    accessibility: { state: accessibility }
  };
}

function createMockClient(permissions?: PermissionSummary): DesktopClient {
  return {
    listApps: async () => [],
    ...(permissions ? { getPermissions: async () => permissions } : {}),
    executeAction: async () => {
      throw new Error("should not execute actions in this test");
    }
  } as unknown as DesktopClient;
}

async function collect<T>(events: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

describe("ghostty adapter", () => {
  const adapter: GhosttyAdapter = createGhosttyAdapter();

  it("declares its identity and target", () => {
    expect(adapter.id).toBe("ghostty");
    expect(adapter.displayName).toBe("Ghostty");
    expect(adapter.targetIdentity).toEqual({
      kind: "bundle_id",
      value: "com.mitchellh.ghostty"
    });
  });

  it("declares desktop capabilities", () => {
    expect(adapter.capabilities).toEqual([
      "desktop_action_execute",
      "desktop_screenshot",
      "desktop_ocr",
      "desktop_session_status",
      "desktop_permissions",
      "app_list"
    ]);
  });

  it("declares a single action approval gate", () => {
    expect(adapter.approvalPolicy.gates).toEqual(["action"]);
  });

  it("declares plan schema version 1", () => {
    expect(adapter.planSchema.schemaVersion).toBe(1);
  });

  it("declares terminal completion marker verification", () => {
    expect(adapter.verificationStrategy).toBe("terminal_completion_marker");
  });

  it("declares abort-signal stop support", () => {
    expect(adapter.stopBehavior.supportsAbortSignal).toBe(true);
  });

  it("declares its blocker stages", () => {
    expect(adapter.blockerStages).toEqual([
      "permissions",
      "desktop_session",
      "activate",
      "initialize",
      "before",
      "after"
    ]);
  });

  it("declares the CLI smoke contract", () => {
    expect(adapter.smoke).toBeDefined();
    expect(adapter.smoke?.npmScript).toBe("smoke:cli");
    expect(adapter.smoke?.planModule).toBe("scripts/smoke-cli-plan.mjs");
    expect(adapter.smoke?.evidenceClassifiers).toContain("classifyCliSmokeEvidence");
  });

  it("parses a direct terminal command", () => {
    const intent = adapter.parseInput("pwd");
    expect(intent.ok).toBe(true);
    if (intent.ok) {
      expect(intent.command).toBe("pwd");
      expect(intent.plan).toBe("pwd");
    }
  });

  it("parses an agent-intent terminal command", () => {
    const intent = adapter.parseInput("执行 ls -la");
    expect(intent.ok).toBe(true);
    if (intent.ok) {
      expect(intent.command).toBe("ls -la");
    }
  });

  it("rejects non-terminal input", () => {
    const intent = adapter.parseInput("你好");
    expect(intent.ok).toBe(false);
    if (!intent.ok) {
      expect(intent.reason).toContain("terminal command");
    }
  });

  it("matches explicit terminal control requests", () => {
    expect(adapter.matchesRoute("在 Ghostty 执行 pwd")).toBe(true);
    expect(adapter.matchesRoute("在 ghostty 终端执行 pwd")).toBe(true);
    expect(adapter.matchesRoute("run pwd in terminal")).toBe(true);
  });

  it("does not match bare shell commands without a terminal target", () => {
    expect(adapter.matchesRoute("pwd")).toBe(false);
    expect(adapter.matchesRoute("ls -la")).toBe(false);
    expect(adapter.matchesRoute("执行 pwd")).toBe(false);
  });

  it("does not match non-terminal requests", () => {
    expect(adapter.matchesRoute("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文")).toBe(false);
    expect(adapter.matchesRoute("整理 Finder 当前文件夹")).toBe(false);
  });

  it("delegates risk classification to the ghostty risk reader", () => {
    const risk = adapter.readRisk("rm -rf /");
    expect(risk.level).toBe("high");
    expect(risk.requiresApproval).toBe(true);

    const lowRisk = adapter.readRisk("pwd");
    expect(lowRisk.level).toBe("low");
    expect(lowRisk.requiresApproval).toBe(false);
  });

  it("reads required permissions from the client", async () => {
    const client = createMockClient(createPermissionSummary("granted", "denied"));
    const permissions = await adapter.readRequiredPermissions(client);
    expect(permissions).toHaveLength(2);
    expect(permissions[0]).toEqual({
      kind: "screenRecording",
      state: "granted",
      label: "Screen Recording"
    });
    expect(permissions[1]).toEqual({
      kind: "accessibility",
      state: "denied",
      label: "Accessibility"
    });
  });

  it("returns no permissions when the client cannot report them", async () => {
    const client = createMockClient(undefined);
    const permissions = await adapter.readRequiredPermissions(client);
    expect(permissions).toEqual([]);
  });

  it("delegates execution to the ghostty orchestrator", async () => {
    const client = createMockClient(createPermissionSummary());
    const events = await collect(
      adapter.run("mkdir skfiy-test", client, { approved: false })
    );

    // Without approval the orchestrator yields started + approval_required and halts.
    const types = events.map((event) => event.type);
    expect(types).toContain("started");
    expect(types).toContain("approval_required");
    expect(types).not.toContain("completed");
  });
});

describe("isExplicitTerminalControlRequest", () => {
  it("detects terminal keywords in multiple languages", () => {
    expect(isExplicitTerminalControlRequest("在 Ghostty 执行 pwd")).toBe(true);
    expect(isExplicitTerminalControlRequest("打开终端")).toBe(true);
    expect(isExplicitTerminalControlRequest("run in terminal")).toBe(true);
    expect(isExplicitTerminalControlRequest("open shell")).toBe(true);
  });

  it("rejects non-terminal requests", () => {
    expect(isExplicitTerminalControlRequest("用 TextEdit 输入 hello")).toBe(false);
    expect(isExplicitTerminalControlRequest("在 Safari 点击登录按钮")).toBe(false);
    expect(isExplicitTerminalControlRequest("pwd")).toBe(false);
  });
});
