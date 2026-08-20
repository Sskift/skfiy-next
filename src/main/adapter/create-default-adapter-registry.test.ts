import { describe, expect, it } from "vitest";
import { createDefaultAdapterRegistry } from "./create-default-adapter-registry";

describe("createDefaultAdapterRegistry", () => {
  it("registers all four shipped adapters", () => {
    const registry = createDefaultAdapterRegistry();
    const ids = registry.list().map((adapter) => adapter.id);

    expect(ids).toContain("ghostty");
    expect(ids).toContain("chrome");
    expect(ids).toContain("finder");
    expect(ids).toContain("tmux_supervision");
    expect(ids).toHaveLength(4);
  });

  it("registers adapters in route-selection priority order", () => {
    const registry = createDefaultAdapterRegistry();
    const ids = registry.list().map((adapter) => adapter.id);

    // tmux first (unambiguous money-run marker), then chrome, finder, ghostty.
    expect(ids).toEqual([
      "tmux_supervision",
      "chrome",
      "finder",
      "ghostty"
    ]);
  });

  it("enables all adapters by default", () => {
    const registry = createDefaultAdapterRegistry();

    expect(registry.isEnabled("tmux_supervision")).toBe(true);
    expect(registry.isEnabled("chrome")).toBe(true);
    expect(registry.isEnabled("finder")).toBe(true);
    expect(registry.isEnabled("ghostty")).toBe(true);
  });

  it("selects tmux for money-run supervision requests", () => {
    const registry = createDefaultAdapterRegistry();
    expect(registry.selectRoute("监督 money-run-goal tmux session")).toBe("tmux_supervision");
    expect(registry.selectRoute("monitor money-run session")).toBe("tmux_supervision");
  });

  it("selects chrome for chrome page requests", () => {
    const registry = createDefaultAdapterRegistry();
    expect(
      registry.selectRoute("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文")
    ).toBe("chrome");
    expect(registry.selectRoute("观察 Chrome 当前页面并提取正文")).toBe("chrome");
  });

  it("selects finder for finder organization requests", () => {
    const registry = createDefaultAdapterRegistry();
    expect(registry.selectRoute("整理 Finder 当前文件夹")).toBe("finder");
    expect(registry.selectRoute("整理 Finder 测试文件夹 /tmp/skfiy-test")).toBe("finder");
  });

  it("selects ghostty for explicit terminal requests", () => {
    const registry = createDefaultAdapterRegistry();
    expect(registry.selectRoute("在 Ghostty 执行 pwd")).toBe("ghostty");
    expect(registry.selectRoute("在 ghostty 终端执行 pwd")).toBe("ghostty");
  });

  it("returns undefined for bare shell commands without a terminal target", () => {
    const registry = createDefaultAdapterRegistry();
    // "pwd" parses as a terminal command but is not explicit — ghostty should
    // not claim it, leaving it to the needs_clarification fallback.
    expect(registry.selectRoute("pwd")).toBeUndefined();
    expect(registry.selectRoute("ls -la")).toBeUndefined();
  });

  it("returns undefined for conversational prompts", () => {
    const registry = createDefaultAdapterRegistry();
    expect(registry.selectRoute("你好")).toBeUndefined();
    expect(registry.selectRoute("你是谁")).toBeUndefined();
  });

  it("returns undefined for generic desktop control requests", () => {
    const registry = createDefaultAdapterRegistry();
    expect(registry.selectRoute("在 Safari 点击登录按钮")).toBeUndefined();
    expect(registry.selectRoute("用 TextEdit 输入 hello")).toBeUndefined();
  });

  it("disabling an adapter removes it from route selection without affecting others", () => {
    const registry = createDefaultAdapterRegistry();

    registry.disable("chrome");
    expect(
      registry.selectRoute("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文")
    ).toBeUndefined();

    // Other adapters are unaffected.
    expect(registry.selectRoute("整理 Finder 当前文件夹")).toBe("finder");
    expect(registry.selectRoute("在 Ghostty 执行 pwd")).toBe("ghostty");
    expect(registry.selectRoute("监督 money-run tmux session")).toBe("tmux_supervision");
  });

  it("exposes declarative metadata for each adapter", () => {
    const registry = createDefaultAdapterRegistry();

    const ghostty = registry.get("ghostty");
    expect(ghostty?.displayName).toBe("Ghostty");
    expect(ghostty?.verificationStrategy).toBe("terminal_completion_marker");
    expect(ghostty?.stopBehavior.supportsAbortSignal).toBe(true);

    const chrome = registry.get("chrome");
    expect(chrome?.displayName).toBe("Chrome");
    expect(chrome?.approvalPolicy.gates).toEqual(["action", "submit"]);
    expect(chrome?.smoke?.npmScript).toBe("smoke:chrome");

    const finder = registry.get("finder");
    expect(finder?.displayName).toBe("Finder");
    expect(finder?.approvalPolicy.gates).toEqual(["action", "plan"]);
    expect(finder?.planSchema.schemaVersion).toBe(1);

    const tmux = registry.get("tmux_supervision");
    expect(tmux?.displayName).toBe("tmux supervision");
    expect(tmux?.capabilities).toEqual(["tmux_observe"]);
    expect(tmux?.planSchema.schemaVersion).toBe(0);
  });
});
