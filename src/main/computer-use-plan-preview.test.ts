import { describe, expect, it } from "vitest";

import {
  createAppPolicyBoundComputerUsePlanPreview,
  createComputerUsePlanPreview,
  createDerivedComputerUsePlanId
} from "./computer-use-plan-preview";
import {
  CHROME_BUNDLE_ID,
  FINDER_BUNDLE_ID,
  GHOSTTY_BUNDLE_ID,
  type ExecutableCommandRoute
} from "./task-routing";

describe("Computer Use plan preview", () => {
  it("builds a bounded Ghostty mutation plan with risk and verification", () => {
    const preview = createComputerUsePlanPreview({
      command: "在 Ghostty 执行 mkdir skfiy-preview-test",
      route: route("ghostty")
    });

    expect(preview).toMatchObject({
      route: "ghostty",
      appName: "Ghostty",
      target: "skfiy-shell · 在 Ghostty 执行 mkdir skfiy-preview-test",
      risk: {
        level: "medium",
        requiresApproval: true
      },
      approvalRequired: true,
      mutating: true
    });
    expect(preview.expectedVerification).toContain("completion marker");
    expect(preview.planId).toMatch(/^task-plan-[a-f0-9]{20}$/u);
  });

  it("rechecks route policy against a concrete planner command before approval", () => {
    expect(createComputerUsePlanPreview({
      command: "rm -rf ~/Desktop/demo",
      route: route("ghostty")
    })).toMatchObject({
      risk: {
        level: "blocked",
        reason: "Route policy blocks destructive or sensitive terminal commands before Computer Use."
      },
      approvalRequired: false,
      mutating: false
    });
  });

  it("keeps a read-only Ghostty plan non-mutating and approval-free", () => {
    expect(createComputerUsePlanPreview({
      command: "在 Ghostty 执行 pwd",
      route: route("ghostty")
    })).toMatchObject({
      risk: { level: "low", requiresApproval: false },
      approvalRequired: false,
      mutating: false
    });

    expect(createComputerUsePlanPreview({
      command: "在 Ghostty 执行 pwd",
      route: route("ghostty"),
      forceApproval: true
    })).toMatchObject({
      risk: { level: "low", requiresApproval: false },
      approvalRequired: true,
      mutating: false
    });
  });

  it("includes the observed cwd in the Ghostty target when context is available", () => {
    expect(createComputerUsePlanPreview({
      command: "在 Ghostty 执行 pwd",
      route: route("ghostty"),
      workingDirectory: "/Users/foo"
    })).toMatchObject({
      target: "skfiy-shell · /Users/foo · 在 Ghostty 执行 pwd"
    });
  });

  it("falls back to the session label in the Ghostty target when cwd is unobservable", () => {
    expect(createComputerUsePlanPreview({
      command: "在 Ghostty 执行 pwd",
      route: route("ghostty"),
      workingDirectory: "unknown"
    })).toMatchObject({
      target: "skfiy-shell · 在 Ghostty 执行 pwd"
    });

    expect(createComputerUsePlanPreview({
      command: "在 Ghostty 执行 pwd",
      route: route("ghostty")
    })).toMatchObject({
      target: "skfiy-shell · 在 Ghostty 执行 pwd"
    });
  });

  it("binds a delayed planner result against the latest app policy", async () => {
    let policy: "allow" | "ask" = "allow";
    let resolvePlanner: (command: string) => void = () => undefined;
    const planner = new Promise<string>((resolve) => {
      resolvePlanner = resolve;
    });
    const binding = (async () => {
      const command = await planner;
      return createAppPolicyBoundComputerUsePlanPreview({
        appPolicy: policy,
        command,
        route: route("ghostty")
      });
    })();

    policy = "ask";
    resolvePlanner("pwd");

    await expect(binding).resolves.toMatchObject({
      risk: { level: "low", requiresApproval: false },
      approvalRequired: true,
      mutating: false
    });
  });

  it("summarizes Chrome URL and current-page targets without exposing a full URL", () => {
    const navigation = createComputerUsePlanPreview({
      command: "打开 Chrome 测试页面 https://example.test/private?token=secret 并提取正文",
      route: route("chrome")
    });
    const currentPage = createComputerUsePlanPreview({
      command: "观察 Chrome 当前页面并提取正文",
      route: route("chrome")
    });

    expect(navigation).toMatchObject({
      appName: "Chrome",
      target: "example.test",
      mutating: true,
      approvalRequired: true
    });
    expect(JSON.stringify(navigation)).not.toContain("token=secret");
    expect(currentPage).toMatchObject({
      target: "Current approved tab",
      mutating: false
    });
  });

  it("keeps an explicit Chrome port in the approval target scope", () => {
    const preview = createComputerUsePlanPreview({
      command: "打开 Chrome 测试页面 https://example.test:8443/private?token=secret 并提取正文",
      route: route("chrome")
    });

    expect(preview.target).toBe("example.test:8443");
    expect(JSON.stringify(preview)).not.toContain("/private");
    expect(JSON.stringify(preview)).not.toContain("token=secret");
  });

  it("summarizes Finder semantic and absolute targets without exposing local paths", () => {
    const semantic = createComputerUsePlanPreview({
      command: "整理 Finder 选中文件夹",
      route: route("finder")
    });
    const selectedItems = createComputerUsePlanPreview({
      command: "整理 Finder 选中项目",
      route: route("finder")
    });
    const rename = createComputerUsePlanPreview({
      command: "重命名 Finder 选中文件为 holiday-photo.png",
      route: route("finder")
    });
    const copy = createComputerUsePlanPreview({
      command: "复制 Finder 选中文件为 holiday-photo.png",
      route: route("finder")
    });
    const absolute = createComputerUsePlanPreview({
      command: "整理 Finder 测试文件夹 /Users/tester/Private/skfiy-fixture",
      route: route("finder")
    });

    expect(semantic.target).toBe("Selected Finder folder");
    expect(selectedItems.target).toBe("Selected Finder items");
    expect(rename.target).toBe("Selected Finder file rename");
    expect(copy.target).toBe("Selected Finder file copy");
    expect(absolute.target).toBe("Folder skfiy-fixture");
    expect(JSON.stringify(absolute)).not.toContain("/Users/tester");
    expect(absolute.expectedVerification).toContain("file operation");
  });

  it("describes tmux supervision as read-only but approval-bound", () => {
    expect(createComputerUsePlanPreview({
      command: "监督 tmux money-run 会话",
      route: { kind: "tmux_supervision", sessionName: "money-run" }
    })).toMatchObject({
      route: "tmux_supervision",
      appName: "tmux",
      target: "Session money-run",
      risk: { level: "medium", requiresApproval: true },
      approvalRequired: true,
      mutating: false
    });
  });

  it("never asks approval for a blocked plan and binds approvals to a stable digest", () => {
    const input = {
      command: "在 Ghostty 执行 ",
      route: route("ghostty"),
      forceApproval: true
    } as const;
    const first = createComputerUsePlanPreview(input);
    const second = createComputerUsePlanPreview(input);
    const changed = createComputerUsePlanPreview({
      ...input,
      command: "在 Ghostty 执行 mkdir changed"
    });

    expect(first).toMatchObject({
      risk: { level: "blocked", requiresApproval: true },
      approvalRequired: false,
      mutating: false
    });
    expect(second.planId).toBe(first.planId);
    expect(changed.planId).not.toBe(first.planId);
    expect(createDerivedComputerUsePlanId(first.planId, { moves: ["a", "b"] }))
      .toBe(createDerivedComputerUsePlanId(first.planId, { moves: ["a", "b"] }));
    expect(createDerivedComputerUsePlanId(first.planId, { moves: ["a", "c"] }))
      .not.toBe(createDerivedComputerUsePlanId(first.planId, { moves: ["a", "b"] }));
  });
});

function route(kind: "ghostty" | "chrome" | "finder"): ExecutableCommandRoute {
  if (kind === "ghostty") return { kind, bundleId: GHOSTTY_BUNDLE_ID };
  if (kind === "chrome") return { kind, bundleId: CHROME_BUNDLE_ID };
  return { kind, bundleId: FINDER_BUNDLE_ID };
}
