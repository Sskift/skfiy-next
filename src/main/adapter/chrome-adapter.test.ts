import { describe, expect, it } from "vitest";
import {
  createChromeAdapter,
  readChromePlanCommand,
  type ChromeAdapter,
  type ChromePagePlan
} from "./chrome-adapter";

async function collect<T>(events: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

describe("chrome adapter", () => {
  const adapter: ChromeAdapter = createChromeAdapter();

  it("declares its identity and target", () => {
    expect(adapter.id).toBe("chrome");
    expect(adapter.displayName).toBe("Chrome");
    expect(adapter.targetIdentity).toEqual({
      kind: "bundle_id",
      value: "com.google.Chrome"
    });
  });

  it("declares CDP and desktop capabilities", () => {
    expect(adapter.capabilities).toEqual([
      "cdp_command",
      "desktop_action_execute",
      "desktop_screenshot"
    ]);
  });

  it("declares action and submit approval gates", () => {
    expect(adapter.approvalPolicy.gates).toEqual(["action", "submit"]);
  });

  it("declares plan schema version 1", () => {
    expect(adapter.planSchema.schemaVersion).toBe(1);
  });

  it("declares browser page identity verification", () => {
    expect(adapter.verificationStrategy).toBe("browser_page_identity");
  });

  it("declares no abort-signal stop support", () => {
    expect(adapter.stopBehavior.supportsAbortSignal).toBe(false);
  });

  it("declares its blocker stages", () => {
    expect(adapter.blockerStages).toEqual([
      "input",
      "connection",
      "navigation",
      "interaction",
      "extraction",
      "sensitive"
    ]);
  });

  it("declares the chrome smoke contract", () => {
    expect(adapter.smoke).toBeDefined();
    expect(adapter.smoke?.npmScript).toBe("smoke:chrome");
    expect(adapter.smoke?.planModule).toBe("scripts/smoke-chrome-plan.mjs");
    expect(adapter.smoke?.productPath).toBe("renderer -> preload -> main -> CDP -> Chrome");
    expect(adapter.smoke?.evidenceClassifiers).toContain("classifyChromeSmokeEvidence");
    expect(adapter.smoke?.evidenceClassifiers).toContain("classifyChromeFallbackSwitchEvidence");
  });

  it("parses a test-page URL intent", () => {
    const intent = adapter.parseInput("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文");
    expect(intent.ok).toBe(true);
    if (intent.ok) {
      expect(intent.command).toBe("file:///tmp/test.html");
      expect(intent.plan).toMatchObject({ ok: true, url: "file:///tmp/test.html" });
    }
  });

  it("parses a current-page intent", () => {
    const intent = adapter.parseInput("观察 Chrome 当前页面并提取正文");
    expect(intent.ok).toBe(true);
    if (intent.ok) {
      expect(intent.command).toBe("Chrome current page");
      expect(intent.plan).toMatchObject({ ok: true, kind: "current_page" });
    }
  });

  it("rejects non-chrome input", () => {
    const intent = adapter.parseInput("在 Ghostty 执行 pwd");
    expect(intent.ok).toBe(false);
    if (!intent.ok) {
      expect(intent.reason).toContain("Chrome page control requires");
    }
  });

  it("matches chrome page requests", () => {
    expect(adapter.matchesRoute("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文")).toBe(true);
    expect(adapter.matchesRoute("观察 Chrome 当前页面并提取正文")).toBe(true);
    expect(adapter.matchesRoute(
      "填写 Chrome 测试表单 file:///tmp/form.html 字段 #name=skfiy 点击 #submit 并提取正文"
    )).toBe(true);
  });

  it("does not match non-chrome requests", () => {
    expect(adapter.matchesRoute("在 Ghostty 执行 pwd")).toBe(false);
    expect(adapter.matchesRoute("整理 Finder 当前文件夹")).toBe(false);
    expect(adapter.matchesRoute("监督 money-run tmux session")).toBe(false);
  });

  it("delegates risk classification to the chrome risk reader", () => {
    const risk = adapter.readRisk("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文");
    expect(risk.level).toBe("medium");
    expect(risk.requiresApproval).toBe(true);

    const blocked = adapter.readRisk("not a chrome command");
    expect(blocked.level).toBe("blocked");
  });

  it("returns no required permissions", async () => {
    const permissions = await adapter.readRequiredPermissions(undefined);
    expect(permissions).toEqual([]);
  });

  it("delegates execution to the chrome orchestrator", async () => {
    const events = await collect(
      adapter.run("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文", undefined, {
        approved: false
      })
    );

    // Without approval the orchestrator yields started + approval_required and halts.
    const types = events.map((event) => event.type);
    expect(types).toContain("started");
    expect(types).toContain("approval_required");
    expect(types).not.toContain("completed");
  });

  it("yields input verification failure for unparseable input", async () => {
    const events = await collect(
      adapter.run("not a chrome command", undefined, { approved: true })
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

describe("readChromePlanCommand", () => {
  it("returns a placeholder for current-page intents", () => {
    const plan = { ok: true, kind: "current_page" } as ChromePagePlan;
    expect(readChromePlanCommand(plan)).toBe("Chrome current page");
  });

  it("returns the URL for page intents", () => {
    const plan = { ok: true, url: "https://example.test" } as ChromePagePlan;
    expect(readChromePlanCommand(plan)).toBe("https://example.test");
  });
});
