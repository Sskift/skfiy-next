import { describe, expect, it } from "vitest";
import {
  createBrowserPageContextFromConnection,
  createBrowserPageContextPromptBlock,
  normalizeBrowserPageContext
} from "./browser-page-context";

describe("browser page context", () => {
  it("creates a bounded prompt block from a ready page observation", () => {
    const context = normalizeBrowserPageContext({
      state: "ready",
      url: "https://example.test/form",
      title: "Example Form",
      visibleText: "Name Email Submit ".repeat(200),
      observedAt: "2026-07-07T00:00:00.000Z"
    });
    const promptBlock = createBrowserPageContextPromptBlock(context);

    expect(context.state).toBe("ready");
    expect(promptBlock).toContain("Current Chrome page");
    expect(promptBlock).toContain("https://example.test/form");
    expect(promptBlock.length).toBeLessThan(3000);
  });

  it("returns a typed blocker when pageControl is not ready", () => {
    const context = normalizeBrowserPageContext({
      state: "blocked_by_chrome_host_permission",
      reason: "Chrome host permission missing",
      nextAction: "Grant site access"
    });

    expect(context.state).toBe("blocked_by_chrome_host_permission");
    expect(createBrowserPageContextPromptBlock(context)).toContain("Browser context unavailable");
  });

  it("expands pageControl machine next actions before prompt injection", () => {
    const context = createBrowserPageContextFromConnection({
      state: "connected",
      observedAt: "2026-07-07T00:00:00.000Z",
      pageControl: {
        state: "blocked_by_host_policy",
        reason: "Host policy has not allowed this page.",
        nextAction: "allow_host",
        activeTab: {
          host: "mew.bytedance.net"
        },
        chromeHostPermission: {
          state: "missing",
          origins: ["https://mew.bytedance.net/*"]
        },
        chromeCapturePermission: {
          state: "missing",
          origins: ["<all_urls>"]
        },
        blockers: [{
          code: "blocked_by_host_policy"
        }]
      }
    });

    const promptBlock = createBrowserPageContextPromptBlock(context);

    expect(context.nextAction).toContain(
      "skfiy chrome policy set --host mew.bytedance.net --action allow-current-turn"
    );
    expect(context.nextAction).toContain(
      "Open the skfiy extension popup and click Grant https://mew.bytedance.net/* + <all_urls> and observe."
    );
    expect(context.nextAction).toContain(
      "Open Dashboard > Browser and click Open access page"
    );
    expect(context.nextAction).not.toContain("Grant Chrome visible-tab capture access");
    expect(context.nextAction).not.toContain("Refresh the skfiy Chrome extension and rerun diagnostics");
    expect(promptBlock).not.toContain("allow_host");
  });

  it("reads the latest Chrome connection page observation", () => {
    const context = createBrowserPageContextFromConnection({
      state: "connected",
      observedAt: "2026-07-07T00:00:00.000Z",
      pageObservation: {
        url: "https://example.test/dashboard",
        title: "Example Dashboard",
        visibleText: "Revenue Pending Tasks",
        pageControl: {
          state: "ready"
        }
      }
    });

    expect(context).toMatchObject({
      state: "ready",
      url: "https://example.test/dashboard",
      title: "Example Dashboard",
      visibleText: "Revenue Pending Tasks",
      observedAt: "2026-07-07T00:00:00.000Z"
    });
  });

  it("does not use stale page observations as ready prompt context", () => {
    const context = createBrowserPageContextFromConnection({
      state: "stale",
      observedAt: "2026-06-22T00:00:00.000Z",
      pageObservation: {
        url: "https://example.test/old",
        title: "Old Page",
        visibleText: "Do not use this text"
      }
    });

    expect(context).toMatchObject({
      state: "stale",
      observedAt: "2026-06-22T00:00:00.000Z"
    });
    expect(context.visibleText).toBeUndefined();
    expect(createBrowserPageContextPromptBlock(context)).toContain("Browser context unavailable");
  });
});
