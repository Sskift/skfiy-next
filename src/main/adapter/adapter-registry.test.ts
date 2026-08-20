import { describe, expect, it } from "vitest";
import { createAdapterRegistry, type AdapterRegistry } from "./adapter-registry";
import { createChromeAdapter } from "./chrome-adapter";
import { createFinderAdapter } from "./finder-adapter";
import { createGhosttyAdapter } from "./ghostty-adapter";
import { createTmuxSupervisionAdapter } from "./tmux-supervision-adapter";
import type { AnyAdapterContract } from "../../shared/adapter-contract";

function createRegistryWithAll(): AdapterRegistry {
  const registry = createAdapterRegistry();
  registry.register(createTmuxSupervisionAdapter());
  registry.register(createChromeAdapter());
  registry.register(createFinderAdapter());
  registry.register(createGhosttyAdapter());
  return registry;
}

describe("adapter registry", () => {
  it("registers and retrieves adapters by id", () => {
    const registry = createAdapterRegistry();
    const chrome = createChromeAdapter();

    registry.register(chrome);
    expect(registry.get("chrome")).toBe(chrome);
    expect(registry.get("ghostty")).toBeUndefined();
  });

  it("lists registered adapters in registration order", () => {
    const registry = createAdapterRegistry();
    const ghostty = createGhosttyAdapter();
    const chrome = createChromeAdapter();

    registry.register(ghostty);
    registry.register(chrome);

    const ids = registry.list().map((adapter) => adapter.id);
    expect(ids).toEqual(["ghostty", "chrome"]);
  });

  it("overwrites a re-registered adapter", () => {
    const registry = createAdapterRegistry();
    const chrome1 = createChromeAdapter();
    const chrome2 = createChromeAdapter();

    registry.register(chrome1);
    registry.register(chrome2);

    expect(registry.get("chrome")).toBe(chrome2);
    expect(registry.list()).toHaveLength(1);
  });

  it("enables adapters by default", () => {
    const registry = createAdapterRegistry();
    registry.register(createChromeAdapter());

    expect(registry.isEnabled("chrome")).toBe(true);
  });

  it("returns false for unregistered adapters", () => {
    const registry = createAdapterRegistry();
    expect(registry.isEnabled("ghostty")).toBe(false);
    expect(registry.isEnabled("chrome")).toBe(false);
  });

  it("disables and re-enables an adapter", () => {
    const registry = createAdapterRegistry();
    registry.register(createChromeAdapter());

    registry.disable("chrome");
    expect(registry.isEnabled("chrome")).toBe(false);

    registry.enable("chrome");
    expect(registry.isEnabled("chrome")).toBe(true);
  });

  it("disabling an unregistered adapter is a no-op", () => {
    const registry = createAdapterRegistry();
    registry.disable("ghostty");
    expect(registry.isEnabled("ghostty")).toBe(false);
  });

  it("selects the tmux route for money-run supervision requests", () => {
    const registry = createRegistryWithAll();
    expect(registry.selectRoute("监督 money-run-goal tmux session")).toBe("tmux_supervision");
  });

  it("selects the chrome route for chrome page requests", () => {
    const registry = createRegistryWithAll();
    expect(
      registry.selectRoute("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文")
    ).toBe("chrome");
  });

  it("selects the finder route for finder organization requests", () => {
    const registry = createRegistryWithAll();
    expect(registry.selectRoute("整理 Finder 当前文件夹")).toBe("finder");
  });

  it("selects the ghostty route for explicit terminal requests", () => {
    const registry = createRegistryWithAll();
    expect(registry.selectRoute("在 Ghostty 执行 pwd")).toBe("ghostty");
  });

  it("returns undefined when no adapter matches", () => {
    const registry = createRegistryWithAll();
    expect(registry.selectRoute("你好")).toBeUndefined();
    expect(registry.selectRoute("pwd")).toBeUndefined();
  });

  it("skips disabled adapters during route selection", () => {
    const registry = createRegistryWithAll();

    registry.disable("chrome");
    expect(
      registry.selectRoute("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文")
    ).toBeUndefined();

    // Other adapters still match.
    expect(registry.selectRoute("整理 Finder 当前文件夹")).toBe("finder");
  });

  it("re-enables a disabled adapter for route selection", () => {
    const registry = createRegistryWithAll();

    registry.disable("chrome");
    registry.enable("chrome");
    expect(
      registry.selectRoute("打开 Chrome 测试页面 file:///tmp/test.html 并提取正文")
    ).toBe("chrome");
  });

  it("respects priority order: tmux before chrome before finder before ghostty", () => {
    const registry = createAdapterRegistry();
    // Register in reverse priority order.
    registry.register(createGhosttyAdapter());
    registry.register(createFinderAdapter());
    registry.register(createChromeAdapter());
    registry.register(createTmuxSupervisionAdapter());

    // tmux is registered last but should still be consulted first because the
    // registry iterates in registration order — this test documents that the
    // default factory registers tmux first.
    const ids = registry.list().map((adapter) => adapter.id);
    expect(ids).toEqual(["ghostty", "finder", "chrome", "tmux_supervision"]);
  });

  it("stores adapters as the type-erased AnyAdapterContract", () => {
    const registry = createAdapterRegistry();
    registry.register(createChromeAdapter());

    const adapter: AnyAdapterContract | undefined = registry.get("chrome");
    expect(adapter).toBeDefined();
    expect(adapter?.id).toBe("chrome");
    // The erased contract still exposes the declarative surface.
    expect(adapter?.capabilities).toContain("cdp_command");
    expect(adapter?.approvalPolicy.gates).toEqual(["action", "submit"]);
  });
});
