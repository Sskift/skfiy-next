import { describe, expect, it } from "vitest";
import {
  createTmuxSupervisionAdapter,
  readMoneyRunSupervisionSessionName,
  type TmuxSupervisionAdapter
} from "./tmux-supervision-adapter";
import type { TmuxSupervisionTaskClient } from "../orchestrator/tmux-supervision-task";

function createMockClient(): TmuxSupervisionTaskClient {
  return {
    observeSession: async () => {
      throw new Error("should not observe before approval");
    }
  };
}

async function collect<T>(events: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

describe("tmux supervision adapter", () => {
  const adapter: TmuxSupervisionAdapter = createTmuxSupervisionAdapter();

  it("declares its identity and target", () => {
    expect(adapter.id).toBe("tmux_supervision");
    expect(adapter.displayName).toBe("tmux supervision");
    expect(adapter.targetIdentity).toEqual({
      kind: "session_name",
      value: "money-run"
    });
  });

  it("declares tmux observe capability", () => {
    expect(adapter.capabilities).toEqual(["tmux_observe"]);
  });

  it("declares action and recovery approval gates", () => {
    expect(adapter.approvalPolicy.gates).toEqual(["action", "recovery"]);
  });

  it("declares no plan schema", () => {
    expect(adapter.planSchema.schemaVersion).toBe(0);
  });

  it("declares supervision report verification", () => {
    expect(adapter.verificationStrategy).toBe("supervision_report");
  });

  it("declares no abort-signal stop support", () => {
    expect(adapter.stopBehavior.supportsAbortSignal).toBe(false);
  });

  it("declares its blocker stages", () => {
    expect(adapter.blockerStages).toEqual(["tmux"]);
  });

  it("does not declare a packaged smoke contract", () => {
    expect(adapter.smoke).toBeUndefined();
  });

  it("parses a money-run supervision intent", () => {
    const intent = adapter.parseInput("监督 money-run-goal tmux session");
    expect(intent.ok).toBe(true);
    if (intent.ok) {
      expect(intent.command).toBe("money-run-goal");
      expect(intent.plan).toBe("money-run-goal");
    }
  });

  it("defaults to the money-run session name when no specific name is given", () => {
    const intent = adapter.parseInput("监督 money-run tmux session");
    expect(intent.ok).toBe(true);
    if (intent.ok) {
      expect(intent.plan).toBe("money-run");
    }
  });

  it("rejects non-supervision input", () => {
    const intent = adapter.parseInput("在 Ghostty 执行 pwd");
    expect(intent.ok).toBe(false);
    if (!intent.ok) {
      expect(intent.reason).toContain("money-run");
    }
  });

  it("rejects money-run input without supervision intent", () => {
    expect(adapter.parseInput("money-run is doing well")).toMatchObject({ ok: false });
    expect(adapter.parseInput("check money-run status")).toMatchObject({ ok: false });
  });

  it("matches tmux supervision requests", () => {
    expect(adapter.matchesRoute("监督 money-run-goal tmux session")).toBe(true);
    expect(adapter.matchesRoute("monitor money-run session")).toBe(true);
    expect(adapter.matchesRoute("watch money-run tmux")).toBe(true);
  });

  it("does not match non-supervision requests", () => {
    expect(adapter.matchesRoute("在 Ghostty 执行 pwd")).toBe(false);
    expect(adapter.matchesRoute("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文")).toBe(false);
    expect(adapter.matchesRoute("整理 Finder 当前文件夹")).toBe(false);
  });

  it("delegates risk classification to the tmux risk reader", () => {
    const risk = adapter.readRisk("监督 money-run tmux session");
    expect(risk.level).toBe("medium");
    expect(risk.requiresApproval).toBe(true);
    expect(risk.reason).toContain("tmux supervision");
  });

  it("returns no required permissions", async () => {
    const permissions = await adapter.readRequiredPermissions(createMockClient());
    expect(permissions).toEqual([]);
  });

  it("delegates execution to the tmux orchestrator with the parsed session name", async () => {
    const events = await collect(
      adapter.run("监督 money-run-goal tmux session", createMockClient(), { approved: false })
    );

    // Without approval the orchestrator yields started + approval_required and halts.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "started",
      sessionName: "money-run-goal"
    });
    expect(events[1]).toMatchObject({
      type: "approval_required",
      sessionName: "money-run-goal"
    });
  });

  it("yields a tmux verification failure when the input has no session name", async () => {
    const events = await collect(
      adapter.run("not a supervision request", createMockClient(), { approved: true })
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "verification_failed",
      stage: "tmux"
    });
  });
});

describe("readMoneyRunSupervisionSessionName", () => {
  it("extracts an explicit money-run session name", () => {
    expect(readMoneyRunSupervisionSessionName("监督 money-run-goal tmux session"))
      .toBe("money-run-goal");
  });

  it("defaults to money-run when no suffix is present", () => {
    expect(readMoneyRunSupervisionSessionName("monitor money-run tmux session"))
      .toBe("money-run");
  });

  it("requires tmux or session context", () => {
    expect(readMoneyRunSupervisionSessionName("监督 money-run")).toBeUndefined();
  });

  it("requires a supervision verb", () => {
    expect(readMoneyRunSupervisionSessionName("money-run tmux session")).toBeUndefined();
  });

  it("requires the money-run marker", () => {
    expect(readMoneyRunSupervisionSessionName("监督 other-goal tmux session")).toBeUndefined();
  });
});
