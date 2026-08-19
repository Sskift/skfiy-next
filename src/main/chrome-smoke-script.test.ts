import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("Chrome product smoke script", () => {
  it("is exposed as an npm script and uses the product preload API", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts).toMatchObject({
      "smoke:chrome": "node scripts/smoke-chrome-product.mjs"
    });
  });

  it("defines a Chrome product path, CDP port, and output option", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");

    expect(existsSync(modulePath)).toBe(true);

    const {
      FALLBACK_PRODUCT_PATH,
      FALLBACK_SWITCH_PRODUCT_PATH,
      classifyChromeBringYourOwnCurrentPageEvidence,
      classifyChromeCurrentPageSmokeEvidence,
      classifyChromeFallbackSmokeEvidence,
      classifyChromeFallbackSwitchEvidence,
      PRODUCT_PATH,
      createDefaultChromeSmokeOptions,
      createHelpText,
      parseChromeSmokeArgs
    } = await import(pathToFileURL(modulePath).href) as {
      FALLBACK_PRODUCT_PATH: string;
      FALLBACK_SWITCH_PRODUCT_PATH: string;
      classifyChromeBringYourOwnCurrentPageEvidence: (input: Record<string, unknown>) => string;
      classifyChromeCurrentPageSmokeEvidence: (input: Record<string, unknown>) => string;
      classifyChromeFallbackSmokeEvidence: (input: Record<string, unknown>) => string;
      classifyChromeFallbackSwitchEvidence: (input: Record<string, unknown>) => string;
      PRODUCT_PATH: string;
      createDefaultChromeSmokeOptions: (rootDir: string) => Record<string, unknown>;
      createHelpText: (defaults: Record<string, unknown>) => string;
      parseChromeSmokeArgs: (
        argv: string[],
        defaults: Record<string, unknown>
      ) => Record<string, unknown>;
    };

    expect(PRODUCT_PATH).toBe("renderer -> preload -> main -> CDP -> Chrome");
    expect(FALLBACK_PRODUCT_PATH).toBe(
      "renderer -> preload -> main -> helper observe_app -> Chrome screenshot fallback"
    );
    expect(FALLBACK_SWITCH_PRODUCT_PATH).toBe(
      "renderer -> preload -> main -> CDP failure -> helper observe_app -> Chrome screenshot fallback"
    );
    expect(parseChromeSmokeArgs(
      ["--output", ".skfiy-smoke/chrome.json", "--chrome-port", "9444"],
      createDefaultChromeSmokeOptions("/repo")
    )).toMatchObject({
      outputPath: path.resolve(".skfiy-smoke/chrome.json"),
      chromePort: 9444
    });
    expect(parseChromeSmokeArgs(
      [
        "--current-page-endpoint",
        "http://127.0.0.1:9222",
        "--output",
        ".skfiy-smoke/chrome-real-page.json"
      ],
      createDefaultChromeSmokeOptions("/repo")
    )).toMatchObject({
      currentPageEndpoint: "http://127.0.0.1:9222",
      outputPath: path.resolve(".skfiy-smoke/chrome-real-page.json")
    });
    expect(createHelpText(createDefaultChromeSmokeOptions("/repo"))).toContain("smoke:chrome");
    expect(createHelpText(createDefaultChromeSmokeOptions("/repo"))).toContain(
      "--current-page-endpoint"
    );
    expect(classifyChromeFallbackSmokeEvidence({
      appLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: FALLBACK_PRODUCT_PATH,
      events: [
        { status: "executing", message: "Verified app_activated: Activated Chrome." },
        {
          status: "observing",
          message: "Captured before screenshot: /tmp/chrome-fallback.png",
          replayRecord: {
            stage: "before",
            bundleId: "com.google.Chrome",
            isRunning: true,
            isActive: true,
            screenshotPath: "/tmp/chrome-fallback.png"
          }
        },
        {
          status: "needs_confirmation",
          message: "Verification failed (connection): Chrome CDP endpoint is not configured; screenshot fallback observation captured: /tmp/chrome-fallback.png"
        }
      ]
    })).toBe("fallback-observed");
    expect(classifyChromeFallbackSmokeEvidence({
      appLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: FALLBACK_PRODUCT_PATH,
      events: [
        {
          status: "needs_confirmation",
          message: "Verification failed (connection): Chrome CDP endpoint is not configured; screenshot fallback failed: Screen Recording permission is required"
        }
      ]
    })).toBe("fallback-blocked");
    expect(classifyChromeFallbackSwitchEvidence({
      appLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: FALLBACK_SWITCH_PRODUCT_PATH,
      configuredEndpoint: "http://127.0.0.1:65530",
      events: [
        {
          status: "executing",
          message: "Switching Chrome control from CDP to screenshot_fallback (navigation): Chrome CDP navigation failed: fetch failed"
        },
        {
          status: "needs_confirmation",
          message: "Verification failed (navigation): Chrome CDP navigation failed: fetch failed screenshot fallback failed: Screen Recording permission is required"
        }
      ]
    })).toBe("fallback-switched-blocked");
    expect(classifyChromeFallbackSwitchEvidence({
      appLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: FALLBACK_SWITCH_PRODUCT_PATH,
      configuredEndpoint: "http://127.0.0.1:65530",
      events: [
        {
          status: "executing",
          message: "Switching Chrome control from cdp to screenshot_fallback (navigation): Chrome CDP navigation failed: fetch failed"
        },
        {
          status: "needs_confirmation",
          message: "Verification failed (navigation): Chrome CDP navigation failed: fetch failed screenshot fallback activation failed: Accessibility permission is required"
        }
      ]
    })).toBe("fallback-switched-blocked");
    expect(classifyChromeCurrentPageSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: PRODUCT_PATH,
      pageSnapshot: {
        url: "file:///tmp/skfiy-chrome.html",
        title: "skfiy chrome smoke",
        text: "skfiy chrome smoke ready"
      },
      events: [
        {
          status: "executing",
          message: "Verified current_page_snapshot: Observed current page: skfiy chrome smoke (file:///tmp/skfiy-chrome.html)"
        },
        {
          status: "completed",
          message: "Chrome current page extracted: skfiy chrome smoke ready"
        }
      ]
    })).toBe("passed");
    expect(classifyChromeBringYourOwnCurrentPageEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: false,
      runnerHasTmux: false,
      productPath: PRODUCT_PATH,
      chromeEndpoint: "http://127.0.0.1:9222",
      pageSnapshot: {
        url: "https://example.bytedance.net/workspace",
        title: "internal workspace",
        text: "logged in workspace ready"
      },
      events: [
        {
          status: "executing",
          message: "Verified current_page_snapshot: Observed current page: internal workspace (https://example.bytedance.net/workspace)"
        },
        {
          status: "completed",
          message: "Chrome current page extracted: logged in workspace ready"
        }
      ]
    })).toBe("passed");
    expect(classifyChromeBringYourOwnCurrentPageEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: false,
      runnerHasTmux: false,
      productPath: PRODUCT_PATH,
      chromeEndpoint: "http://127.0.0.1:9222",
      pageSnapshot: {
        url: "https://example.bytedance.net/workspace",
        title: "internal workspace",
        text: "logged in workspace ready"
      },
      events: [
        {
          status: "executing",
          message: "Verified navigate: Navigated to: https://example.bytedance.net/workspace"
        },
        {
          status: "completed",
          message: "Chrome current page extracted: logged in workspace ready"
        }
      ]
    })).toBe("failed");
    expect(classifyChromeBringYourOwnCurrentPageEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: false,
      runnerHasTmux: false,
      productPath: PRODUCT_PATH,
      chromeEndpoint: "http://127.0.0.1:65530",
      events: [
        {
          status: "needs_confirmation",
          message: "Verification failed (extraction): Chrome CDP current page snapshot failed: endpoint unavailable screenshot fallback failed: Screen Recording permission is required"
        }
      ]
    })).toBe("blocked");
    expect(classifyChromeBringYourOwnCurrentPageEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: false,
      runnerHasTmux: false,
      productPath: PRODUCT_PATH,
      chromeEndpoint: "http://127.0.0.1:65530",
      events: [
        {
          status: "needs_confirmation",
          message: "Verification failed (extraction): Chrome CDP current page snapshot failed: fetch failed screenshot fallback activation failed: Accessibility permission is required"
        }
      ]
    })).toBe("blocked");
  });

  it("classifies a completed Chrome extraction with expected text as passed", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      classifyChromeSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      classifyChromeSmokeEvidence: (input: Record<string, unknown>) => string;
    };

    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      readinessDiagnostics: createPassingReadinessDiagnostics(),
      extractedText: "skfiy chrome smoke ready",
      events: [{ status: "completed", message: "Chrome test page extracted: skfiy chrome smoke ready" }]
    })).toBe("passed");
    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      extractedText: "skfiy chrome smoke ready",
      events: [{ status: "completed", message: "Chrome test page extracted: skfiy chrome smoke ready" }]
    })).toBe("failed");
    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      readinessDiagnostics: createPassingReadinessDiagnostics(),
      extractedText: "unexpected page text",
      events: [{ status: "completed", message: "Chrome test page extracted: unexpected page text" }]
    })).toBe("failed");
    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      readinessDiagnostics: createPassingReadinessDiagnostics(),
      extractedText: "skfiy chrome smoke ready",
      events: []
    })).toBe("no-events");
  });

  it("classifies a completed Chrome form action with expected text as passed", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      FORM_EXPECTED_TEXT,
      classifyChromeSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      FORM_EXPECTED_TEXT: string;
      classifyChromeSmokeEvidence: (input: Record<string, unknown>) => string;
    };

    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      readinessDiagnostics: createPassingReadinessDiagnostics(),
      expectedText: FORM_EXPECTED_TEXT,
      extractedText: FORM_EXPECTED_TEXT,
      events: [
        { status: "executing", message: "Verified navigate: Navigated to: file:///tmp/form.html" },
        { status: "executing", message: "Verified fill_selector: Filled #name." },
        { status: "executing", message: "Verified fill_selector: Filled #email." },
        { status: "executing", message: "Verified fill_selector: Filled #role." },
        { status: "executing", message: "Verified click_selector: Clicked #submit." },
        { status: "executing", message: `Verified extract_text: Extracted text: ${FORM_EXPECTED_TEXT}` },
        { status: "completed", message: `Chrome test page extracted: ${FORM_EXPECTED_TEXT}` }
      ]
    })).toBe("passed");
  });

  it("classifies a Chrome sensitive-page pause as safety evidence", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      classifyChromeSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      classifyChromeSmokeEvidence: (input: Record<string, unknown>) => string;
    };

    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      extractedText: "",
      events: [
        {
          status: "executing",
          message: "Verified navigate: Navigated to: file:///tmp/skfiy-login.html"
        },
        {
          status: "needs_confirmation",
          message: "Verification failed (sensitive): Sensitive UI text is visible."
        }
      ]
    })).toBe("sensitive-paused");
  });

  it("classifies a Chrome sensitive-form prefill pause as safety evidence", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      classifyChromeSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      classifyChromeSmokeEvidence: (input: Record<string, unknown>) => string;
    };

    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      extractedText: "",
      events: [
        {
          status: "needs_confirmation",
          message: "Verification failed (sensitive): Sensitive form input is not allowed for Chrome Computer Use."
        }
      ]
    })).toBe("sensitive-paused");
  });

});

function createPassingReadinessDiagnostics() {
  return {
    schemaVersion: 1,
    state: "ready",
    generatedAt: "2026-06-20T00:02:00.000Z",
    nativeHost: {
      hostName: "com.sskift.skfiy",
      state: "installed",
      manifestPath: "/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sskift.skfiy.json",
      cliShimPath: "/repo/dist/skfiy",
      allowedOrigins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
      reason: "Chrome Native Messaging host is installed."
    },
    extensionManifest: {
      state: "planned",
      manifestVersion: 3,
      hostName: "com.sskift.skfiy",
      allowedOrigins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
      nativeMessaging: true,
      optionalHostPermissions: ["http://*/*", "https://*/*"]
    },
    hostPolicy: {
      schemaVersion: 1,
      state: "configured",
      path: "/Users/tester/Library/Application Support/skfiy/chrome-host-policy.json",
      defaultMode: "ask",
      entryCount: 1
    },
    approvalPolicy: {
      state: "ready",
      host: "example.com",
      defaultAction: "allow_current_turn_after_user_approval",
      failClosed: true
    },
    liveConnection: {
      state: "connected",
      liveConnection: "connected",
      path: "/Users/tester/Library/Application Support/skfiy/chrome-extension-connection.json",
      ageSeconds: 120,
      launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
      messageType: "skfiy.page.observe",
      requestId: "request-1"
    },
    setupGuide: {
      schemaVersion: 1,
      productPath: "dist/skfiy -> Chrome MV3 extension -> Native Messaging",
      state: "ready",
      extensionIds: ["abcdefghijklmnopabcdefghijklmnop"],
      expectedAllowedOrigins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
      nativeHostManifestPath: "/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sskift.skfiy.json",
      cliShimPath: "/repo/dist/skfiy",
      connectionHeartbeatPath: "/Users/tester/Library/Application Support/skfiy/chrome-extension-connection.json",
      hostPolicyPath: "/Users/tester/Library/Application Support/skfiy/chrome-host-policy.json",
      extensionPath: "/repo/chrome-extension",
      recommendedBrowsers: [
        "Google Chrome for Testing",
        "Chromium",
        "Google Chrome with manually installed skfiy extension"
      ],
      installHostCommand: [
        "skfiy",
        "chrome",
        "install-host",
        "--cli",
        "/repo/dist/skfiy",
        "--extension-id",
        "abcdefghijklmnopabcdefghijklmnop"
      ],
      verifyStatusCommand: [
        "skfiy",
        "chrome",
        "status",
        "--cli",
        "/repo/dist/skfiy",
        "--extension-id",
        "abcdefghijklmnopabcdefghijklmnop"
      ],
      smokeCommand: [
        "skfiy",
        "smoke",
        "chrome",
        "--output",
        ".skfiy-smoke/chrome.json"
      ],
      nextActions: [
        {
          id: "verify-live-connection",
          state: "done",
          owner: "browser",
          title: "Chrome extension has recently connected to the native host."
        }
      ]
    }
  };
}

