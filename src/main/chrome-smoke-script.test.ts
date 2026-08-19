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
      parseChromeSmokeArgs,
      selectInstalledExtensionChromeApp
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
      selectInstalledExtensionChromeApp: (input: Record<string, unknown>) => Record<string, unknown>;
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
    expect(parseChromeSmokeArgs(
      [
        "--extension-chrome-app",
        "Google Chrome for Testing",
        "--extension-id",
        "plcpkkhlcacihjfohlojdknnkademlno",
        "--output",
        ".skfiy-smoke/chrome-cft.json"
      ],
      createDefaultChromeSmokeOptions("/repo")
    )).toMatchObject({
      extensionChromeAppName: "Google Chrome for Testing",
      extensionId: "plcpkkhlcacihjfohlojdknnkademlno",
      outputPath: path.resolve(".skfiy-smoke/chrome-cft.json")
    });
    expect(selectInstalledExtensionChromeApp({
      chromeAppName: "Google Chrome",
      availableAppNames: ["Google Chrome for Testing", "Google Chrome"]
    })).toMatchObject({
      chromeAppName: "Google Chrome for Testing",
      source: "auto-discovered-loadable-browser",
      loadExtensionFriendly: true
    });
    expect(selectInstalledExtensionChromeApp({
      chromeAppName: "Google Chrome",
      extensionChromeAppName: "Chromium",
      availableAppNames: ["Google Chrome for Testing"]
    })).toMatchObject({
      chromeAppName: "Chromium",
      source: "explicit-extension-chrome-app"
    });
    expect(selectInstalledExtensionChromeApp({
      chromeAppName: "Google Chrome"
    })).toMatchObject({
      chromeAppName: "Google Chrome",
      source: "fallback-primary-browser",
      recommendedBrowser: "Chrome for Testing or Chromium"
    });
    expect(createHelpText(createDefaultChromeSmokeOptions("/repo"))).toContain("smoke:chrome");
    expect(createHelpText(createDefaultChromeSmokeOptions("/repo"))).toContain(
      "--current-page-endpoint"
    );
    expect(createHelpText(createDefaultChromeSmokeOptions("/repo"))).toContain(
      "--extension-chrome-app"
    );
    expect(createHelpText(createDefaultChromeSmokeOptions("/repo"))).toContain(
      "--extension-id"
    );
    expect(createHelpText(createDefaultChromeSmokeOptions("/repo"))).toContain(
      "docs/chrome-extension-setup.md"
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

  it("classifies installed Chrome extension action smoke and screenshot blocker lanes", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      INSTALLED_EXTENSION_ACTION_PRODUCT_PATH,
      classifyInstalledExtensionActionSmokeEvidence,
      readInstalledExtensionActionTargetTabs,
      selectInstalledExtensionActionTargetTab
    } = await import(pathToFileURL(modulePath).href) as {
      INSTALLED_EXTENSION_ACTION_PRODUCT_PATH: string;
      classifyInstalledExtensionActionSmokeEvidence: (input: Record<string, unknown>) => string;
      readInstalledExtensionActionTargetTabs: (tabsRun: Record<string, unknown>) => Record<string, unknown>[];
      selectInstalledExtensionActionTargetTab: (tabs: Record<string, unknown>[], fixtureUrl: string) => Record<string, unknown> | undefined;
    };
    const fixtureUrl = "http://127.0.0.1:63852/?skfiy_action_live=20260621";
    const redactedFixtureUrl = "http://127.0.0.1:63852/?skfiy_action_live=<redacted>";

    expect(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH).toBe(
      "dist/skfiy -> chrome tabs/reload-extension/observe/screenshot/fill/click/submit/scroll -> installed Chrome extension"
    );
    expect(selectInstalledExtensionActionTargetTab([
      { id: 1, url: "chrome://extensions", eligible: false, blocker: "internal_chrome_page" },
      { id: 2, url: "file:///tmp/form.html", eligible: false, blocker: "unsupported_scheme" },
      { id: 3, url: fixtureUrl, eligible: true, state: "eligible" }
    ], fixtureUrl)).toMatchObject({
      id: 3,
      url: fixtureUrl
    });
    expect(selectInstalledExtensionActionTargetTab([
      { id: 4, url: "http://127.0.0.1:60329/?skfiy_action_live=<redacted>", eligible: true, state: "eligible" },
      { id: 5, url: redactedFixtureUrl, eligible: true, state: "eligible" }
    ], fixtureUrl)).toMatchObject({
      id: 5,
      url: redactedFixtureUrl
    });
    expect(readInstalledExtensionActionTargetTabs({
      result: "verified",
      discoveryMode: "extension",
      extensionConnection: {
        latestCommand: {
          messageType: "skfiy.tabs.discover",
          pageTabs: {
            result: "passed",
            tabs: [
              { id: 6, url: redactedFixtureUrl, eligible: true, state: "eligible" }
            ]
          }
        }
      }
    })).toEqual([
      { id: 6, url: redactedFixtureUrl, eligible: true, state: "eligible" }
    ]);
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl)
    )).toBe("passed");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        selectedTargetTab: undefined,
        tabsRun: {
          result: "verified",
          discoveryMode: "extension",
          extensionConnection: {
            latestCommand: {
              messageType: "skfiy.tabs.discover",
              pageTabs: {
                result: "passed",
                tabs: [
                  { id: 7, url: redactedFixtureUrl, eligible: true, state: "eligible" }
                ]
              }
            }
          }
        }
      })
    )).toBe("passed");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        screenshotRun: {
          result: "blocked",
          reason: "chrome-capture-permission-missing",
          extensionConnection: {
            latestCommand: {
              pageScreenshot: {
                result: "blocked",
                reason: "Either the '<all_urls>' or 'activeTab' permission is required.",
                hasDataUrl: false
              }
            }
          }
        }
      })
    )).toBe("screenshot-blocked");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        reloadRun: {
          result: "blocked",
          reason: "desktop-session-locked",
          extensionConnection: {
            pageControl: {
              activeTab: {
                tabId: 3
              },
              capabilities: {
                domActions: true
              }
            }
          }
        },
        screenshotRun: {
          result: "blocked",
          reason: "chrome-capture-permission-missing",
          extensionConnection: {
            latestCommand: {
              pageScreenshot: {
                result: "blocked",
                reason: "Either the '<all_urls>' or 'activeTab' permission is required.",
                hasDataUrl: false
              }
            }
          }
        }
      })
    )).toBe("screenshot-blocked");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        reloadRun: {
          result: "blocked",
          reason: "reload-target-not-found"
        }
      })
    )).toBe("passed");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        screenshotRun: {
          result: "blocked",
          reason: "page-control-screenshot-not-verified",
          extensionConnection: {
            pageControl: {
              state: "ready",
              screenshot: {
                state: "available"
              }
            }
          }
        }
      })
    )).toBe("screenshot-blocked");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        clickRun: {
          result: "blocked",
          reason: "chrome-active-tab-unavailable"
        }
      })
    )).toBe("blocked");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        result: "blocked",
        reason: "target-tab-unavailable-after-reload",
        postReloadTabsRun: {
          result: "verified",
          tabs: [
            { id: 8, url: "chrome://extensions/", eligible: false, state: "blocked" }
          ]
        },
        observeRun: undefined,
        fillRun: undefined,
        clickRun: undefined,
        submitRun: undefined,
        scrollRun: undefined,
        finalObserveRun: undefined
      })
    )).toBe("blocked");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        clickRun: {
          result: "blocked",
          reason: "selector-not-found"
        }
      })
    )).toBe("failed");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        wakeIsolationStrategy: "request-id-during-run",
        cleanupBetweenCommands: [
          {
            commandName: "chrome click",
            phase: "between-command",
            result: "skipped",
            reason: "request-id-isolation-during-run"
          }
        ]
      })
    )).toBe("passed");
    expect(classifyInstalledExtensionActionSmokeEvidence(
      createPassingInstalledExtensionActionRun(INSTALLED_EXTENSION_ACTION_PRODUCT_PATH, fixtureUrl, {
        cleanupBeforeRun: {
          result: "blocked",
          reason: "desktop-session-locked"
        }
      })
    )).toBe("passed");
  });

  it("derives installed-extension readiness snapshots and blocker remediation", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      INSTALLED_EXTENSION_PRODUCT_PATH,
      createInstalledExtensionBlockerRemediation,
      createInstalledExtensionBlockers,
      createInstalledExtensionReadinessSnapshot
    } = await import(pathToFileURL(modulePath).href) as {
      INSTALLED_EXTENSION_PRODUCT_PATH: string;
      createInstalledExtensionBlockerRemediation: (input: Record<string, unknown>) => Record<string, unknown>;
      createInstalledExtensionBlockers: (input: Record<string, unknown>) => Record<string, unknown>[];
      createInstalledExtensionReadinessSnapshot: (input: Record<string, unknown>) => Record<string, unknown>;
    };
    const passing = createPassingInstalledExtensionRun(INSTALLED_EXTENSION_PRODUCT_PATH);

    expect(createInstalledExtensionReadinessSnapshot({
      result: "passed",
      extensionId: passing.extensionId,
      launchOrigin: passing.launchOrigin,
      extensionStatus: passing.extensionStatus,
      pageControlHealth: passing.pageControlHealth,
      response: passing.response,
      heartbeat: passing.heartbeat
    })).toMatchObject({
      schemaVersion: 1,
      state: "ready",
      extension: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        version: "0.0.1",
        manifestVersion: 3,
        capabilities: expect.objectContaining({
          nativeMessaging: true,
          scripting: true
        })
      },
      nativeHost: {
        state: "connected",
        bridgeState: "connected",
        syncState: "synced",
        launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        messageType: "skfiy.host_policy.request",
        lastError: null
      },
      handshake: {
        nativeMessage: "accepted",
        statusSync: "synced",
        heartbeat: "recorded"
      },
      protocol: {
        name: "skfiy.chrome.page-control",
        health: true,
        contentScriptFile: "content-script.js",
        hostPermissions: "optional"
      },
      contentScript: {
        state: "loaded"
      },
      pageControl: {
        state: "ready",
        capable: true,
        nextAction: "Use extension pageControl for Chrome Computer Use.",
        blockerCount: 0
      },
      blockers: [],
      remediation: null
    });

    const remediation = createInstalledExtensionBlockerRemediation({
      blockedReason: "branded_chrome_load_extension_removed",
      chromeAppName: "Google Chrome",
      chromeVersion: "Chrome/146.0.7680.80",
      recommendedBrowser: "Chrome for Testing or Chromium"
    });
    const blockers = createInstalledExtensionBlockers({
      blockedReason: "branded_chrome_load_extension_removed",
      chromeAppName: "Google Chrome",
      chromeVersion: "Chrome/146.0.7680.80",
      recommendedBrowser: "Chrome for Testing or Chromium"
    });

    expect(remediation).toMatchObject({
      schemaVersion: 1,
      code: "branded_chrome_load_extension_removed",
      docsPath: "docs/chrome-extension-setup.md",
      chromeAppName: "Google Chrome",
      chromeVersion: "Chrome/146.0.7680.80",
      recommendedBrowser: "Chrome for Testing or Chromium"
    });
    expect(String(remediation.nextAction)).toContain("--extension-chrome-app");
    expect(String((remediation.commands as string[])[0])).toContain("smoke:chrome");
    expect(blockers).toEqual([
      expect.objectContaining({
        code: "branded_chrome_load_extension_removed",
        nextAction: remediation.nextAction,
        docsPath: "docs/chrome-extension-setup.md",
        recommendedBrowser: "Chrome for Testing or Chromium"
      })
    ]);
    expect(createInstalledExtensionReadinessSnapshot({
      result: "blocked",
      blockedReason: "branded_chrome_load_extension_removed",
      blockers,
      remediation
    })).toMatchObject({
      state: "blocked",
      handshake: {
        nativeMessage: null,
        statusSync: null,
        heartbeat: "not-read"
      },
      blockers,
      remediation
    });
  });

  it("classifies a completed Chrome extraction with expected text as passed", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      INSTALLED_EXTENSION_PRODUCT_PATH,
      classifyChromeSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      INSTALLED_EXTENSION_PRODUCT_PATH: string;
      classifyChromeSmokeEvidence: (input: Record<string, unknown>) => string;
    };

    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      readinessDiagnostics: createPassingReadinessDiagnostics(),
      nativeHostBridgeRun: createPassingNativeHostBridgeRun(),
      installedExtensionRun: createPassingInstalledExtensionRun(INSTALLED_EXTENSION_PRODUCT_PATH),
      pageControl: createPassingPageControlEvidence(),
      extractedText: "skfiy chrome smoke ready",
      events: [{ status: "completed", message: "Chrome test page extracted: skfiy chrome smoke ready" }]
    })).toBe("passed");
    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      readinessDiagnostics: createPassingReadinessDiagnostics(),
      nativeHostBridgeRun: createPassingNativeHostBridgeRun(),
      installedExtensionRun: createBlockedInstalledExtensionRun(INSTALLED_EXTENSION_PRODUCT_PATH),
      pageControl: createBlockedPageControlEvidence(),
      extractedText: "skfiy chrome smoke ready",
      events: [{ status: "completed", message: "Chrome test page extracted: skfiy chrome smoke ready" }]
    })).toBe("passed");
    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      readinessDiagnostics: createPassingReadinessDiagnostics(),
      nativeHostBridgeRun: createPassingNativeHostBridgeRun(),
      installedExtensionRun: createPassingInstalledExtensionRun(INSTALLED_EXTENSION_PRODUCT_PATH),
      extractedText: "skfiy chrome smoke ready",
      events: [{ status: "completed", message: "Chrome test page extracted: skfiy chrome smoke ready" }]
    })).toBe("failed");
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
      nativeHostBridgeRun: createPassingNativeHostBridgeRun(),
      extractedText: "skfiy chrome smoke ready",
      events: [{ status: "completed", message: "Chrome test page extracted: skfiy chrome smoke ready" }]
    })).toBe("failed");
    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      nativeHostBridgeRun: createPassingNativeHostBridgeRun(),
      installedExtensionRun: createPassingInstalledExtensionRun(INSTALLED_EXTENSION_PRODUCT_PATH),
      extractedText: "skfiy chrome smoke ready",
      events: [{ status: "completed", message: "Chrome test page extracted: skfiy chrome smoke ready" }]
    })).toBe("failed");
  });

  it("classifies a completed Chrome form action with expected text as passed", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      FORM_EXPECTED_TEXT,
      INSTALLED_EXTENSION_PRODUCT_PATH,
      classifyChromeSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      FORM_EXPECTED_TEXT: string;
      INSTALLED_EXTENSION_PRODUCT_PATH: string;
      classifyChromeSmokeEvidence: (input: Record<string, unknown>) => string;
    };

    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      readinessDiagnostics: createPassingReadinessDiagnostics(),
      nativeHostBridgeRun: createPassingNativeHostBridgeRun(),
      installedExtensionRun: createPassingInstalledExtensionRun(INSTALLED_EXTENSION_PRODUCT_PATH),
      pageControl: createPassingPageControlEvidence(),
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

  it("accepts installed-extension smoke when a later host-policy heartbeat overwrites observe", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      FORM_EXPECTED_TEXT,
      INSTALLED_EXTENSION_PRODUCT_PATH,
      classifyChromeSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      FORM_EXPECTED_TEXT: string;
      INSTALLED_EXTENSION_PRODUCT_PATH: string;
      classifyChromeSmokeEvidence: (input: Record<string, unknown>) => string;
    };
    const installedExtensionRun = createPassingInstalledExtensionRun(
      INSTALLED_EXTENSION_PRODUCT_PATH
    ) as Record<string, unknown>;

    installedExtensionRun.heartbeat = {
      schemaVersion: 1,
      hostName: "com.sskift.skfiy",
      launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
      messageType: "skfiy.host_policy.request",
      requestId: "host-policy-sync-service_worker_loaded-test",
      latestCommand: {
        messageType: "skfiy.page.observe",
        requestId: "page-control-observe-cli-test"
      }
    };

    expect(classifyChromeSmokeEvidence({
      appLaunchViaOpen: true,
      chromeLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      readinessDiagnostics: createPassingReadinessDiagnostics(),
      nativeHostBridgeRun: createPassingNativeHostBridgeRun(),
      installedExtensionRun,
      pageControl: createPassingPageControlEvidence(),
      expectedText: FORM_EXPECTED_TEXT,
      extractedText: FORM_EXPECTED_TEXT,
      events: [
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
      nativeHostBridgeRun: createPassingNativeHostBridgeRun(),
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
      nativeHostBridgeRun: createPassingNativeHostBridgeRun(),
      extractedText: "",
      events: [
        {
          status: "needs_confirmation",
          message: "Verification failed (sensitive): Sensitive form input is not allowed for Chrome Computer Use."
        }
      ]
    })).toBe("sensitive-paused");
  });

  it("keeps a Chrome extension setup guide aligned with smoke diagnostics", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-chrome-plan.mjs");
    const {
      CHROME_EXTENSION_SETUP_GUIDE_PATH,
      validateChromeExtensionSetupGuide
    } = await import(pathToFileURL(modulePath).href) as {
      CHROME_EXTENSION_SETUP_GUIDE_PATH: string;
      validateChromeExtensionSetupGuide: (source: string) => {
        ok: boolean;
        missingTerms: string[];
      };
    };
    const guidePath = path.join(process.cwd(), CHROME_EXTENSION_SETUP_GUIDE_PATH);

    expect(CHROME_EXTENSION_SETUP_GUIDE_PATH).toBe("docs/chrome-extension-setup.md");
    expect(existsSync(guidePath)).toBe(true);

    const guide = readFileSync(guidePath, "utf8");

    expect(validateChromeExtensionSetupGuide(guide)).toEqual({
      ok: true,
      missingTerms: []
    });
    expect(guide).toContain("current-tab fields");
    expect(guide).toContain("extension.liveConnection: connected");
    expect(guide).toContain("Screen locked, display asleep, or `loginwindow` active");
  });
});

function createPassingNativeHostBridgeRun() {
  return {
    result: "passed",
    productPath: "dist/skfiy -> Chrome Native Messaging heartbeat",
    command: [
      "/repo/dist/skfiy",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
    ],
    response: {
      schemaVersion: 1,
      type: "skfiy.native.response",
      requestId: "chrome-smoke-native-host",
      result: "accepted"
    },
    hostPolicyResponse: {
      schemaVersion: 1,
      type: "skfiy.native.response",
      requestId: "chrome-smoke-host-policy",
      result: "accepted",
      hostPolicy: {
        schemaVersion: 1,
        state: "default",
        path: "/repo/.skfiy-smoke/chrome-native-home/Library/Application Support/skfiy/chrome-host-policy.json",
        policy: {
          defaultMode: "ask",
          allowedHosts: [],
          currentTurnAllowedHosts: [],
          blockedHosts: []
        }
      }
    },
    diagnostics: {
      schemaVersion: 1,
      nativeHost: {
        name: "com.sskift.skfiy",
        heartbeatState: "recorded",
        policyState: "default",
        launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        messageType: "skfiy.page.observe",
        responseResult: "accepted",
        lastError: null
      },
      capabilities: {
        nativeMessaging: true,
        hostPolicySync: true,
        connectionHeartbeat: true
      },
      hostPolicy: {
        schemaVersion: 1,
        state: "default",
        defaultMode: "ask",
        entryCount: 0,
        allowedHosts: 0,
        currentTurnAllowedHosts: 0,
        blockedHosts: 0
      }
    },
    heartbeat: {
      schemaVersion: 1,
      hostName: "com.sskift.skfiy",
      launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
      messageType: "skfiy.page.observe",
      requestId: "chrome-smoke-native-host"
    },
    heartbeatPath: "/repo/.skfiy-smoke/chrome-native-home/Library/Application Support/skfiy/chrome-extension-connection.json"
  };
}

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

function createPassingInstalledExtensionRun(productPath: string) {
  return {
    result: "passed",
    productPath,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
    response: {
      schemaVersion: 1,
      type: "skfiy.native.response",
      requestId: "chrome-smoke-installed-extension",
      result: "accepted"
    },
    extensionStatus: {
      schemaVersion: 1,
      type: "skfiy.host_policy.response",
      requestId: "chrome-smoke-extension-status",
      policy: {
        defaultMode: "ask",
        allowedHosts: [],
        currentTurnAllowedHosts: [],
        blockedHosts: []
      },
      syncStatus: {
        schemaVersion: 1,
        state: "synced",
        source: "native_host",
        hostPolicyState: "default",
        nativeHostPolicyState: "default",
        nativeBridgeState: "connected",
        nativeLaunchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        nativeMessageType: "skfiy.host_policy.request",
        entryCount: 0,
        lastError: null,
        error: null
      },
      pageControl: createPassingPageControlEvidence(),
      diagnostics: {
        schemaVersion: 1,
        extension: {
          id: "abcdefghijklmnopabcdefghijklmnop",
          name: "skfiy Chrome Adapter",
          version: "0.0.1",
          manifestVersion: 3,
          minimumChromeVersion: "116"
        },
        capabilities: {
          activeTab: true,
          downloads: true,
          nativeMessaging: true,
          scripting: true,
          storage: true,
          tabs: true,
          optionalHostPermissions: ["http://*/*", "https://*/*"]
        },
        nativeHost: {
          name: "com.sskift.skfiy",
          bridgeState: "connected",
          syncState: "synced",
          policyState: "default",
          launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
          messageType: "skfiy.host_policy.request",
          lastError: null
        },
        hostPolicy: {
          defaultMode: "ask",
          entryCount: 0,
          allowedHosts: 0,
          currentTurnAllowedHosts: 0,
          blockedHosts: 0
        },
        session: {
          state: "loaded",
          pageControl: createPassingPageControlEvidence()
        }
      }
    },
    pageControlHealth: createPassingPageControlHealth(),
    heartbeat: {
      schemaVersion: 1,
      hostName: "com.sskift.skfiy",
      launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
      messageType: "skfiy.page.observe",
      requestId: "chrome-smoke-installed-extension"
    },
    heartbeatPath: "/tmp/skfiy-extension-home/Library/Application Support/skfiy/chrome-extension-connection.json"
  };
}

function createPassingInstalledExtensionActionRun(
  productPath: string,
  fixtureUrl: string,
  overrides: Record<string, unknown> = {}
) {
  const selectedTargetTab = {
    id: 3,
    windowId: 9,
    url: fixtureUrl,
    host: "127.0.0.1",
    eligible: true,
    state: "eligible"
  };
  const verifiedAction = (action: string) => ({
    result: "verified",
    action,
    extensionConnection: {
      latestCommand: {
        pageActionResult: {
          action,
          result: "verified"
        }
      }
    }
  });

  return {
    result: "passed",
    productPath,
    runnerHasTmux: false,
    extensionId: "plcpkkhlcacihjfohlojdknnkademlno",
    fixtureUrl,
    selectedTargetTab,
    tabsRun: {
      result: "verified",
      discoveryMode: "chrome-apple-events",
      tabs: [
        { id: 1, url: "chrome://extensions", eligible: false, blocker: "internal_chrome_page" },
        selectedTargetTab
      ]
    },
    reloadRun: {
      result: "verified",
      reloadStrategy: "extension-context-wake",
      extensionConnection: {
        pageControl: {
          activeTab: {
            tabId: 3
          },
          capabilities: {
            domActions: true
          }
        }
      }
    },
    observeRun: {
      result: "verified",
      extensionConnection: {
        pageObservation: {
          visibleText: "skfiy action smoke ready"
        }
      }
    },
    screenshotRun: {
      result: "verified",
      extensionConnection: {
        latestCommand: {
          pageScreenshot: {
            result: "verified",
            hasDataUrl: true,
            dataUrlBytes: 1024
          }
        }
      }
    },
    fillRun: verifiedAction("fill"),
    clickRun: verifiedAction("click"),
    submitRun: verifiedAction("submit"),
    scrollRun: verifiedAction("scroll"),
    finalObserveRun: {
      result: "verified",
      extensionConnection: {
        pageObservation: {
          visibleText: "clicked 1 submitted skfiy #2"
        }
      }
    },
    finalVisibleText: "clicked 1 submitted skfiy #2",
    ...overrides
  };
}

function createPassingPageControlHealth() {
  return {
    type: "skfiy.page_control.health_result",
    schemaVersion: 1,
    requestId: "chrome-smoke-page-control-health",
    protocol: {
      schemaVersion: 1,
      name: "skfiy.chrome.page-control",
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      nativeHostName: "com.sskift.skfiy",
      contentScriptFile: "content-script.js",
      messageTypes: {
        health: "skfiy.page_control.health",
        healthResult: "skfiy.page_control.health_result",
        diagnostics: "skfiy.page.diagnostics",
        observe: "skfiy.page.observe",
        action: "skfiy.page.action",
        screenshot: "skfiy.page.screenshot"
      },
      permissionModel: {
        requiredPermissions: ["activeTab", "downloads", "nativeMessaging", "scripting", "storage", "tabs"],
        hostPermissions: "optional",
        optionalHostPermissions: ["http://*/*", "https://*/*"]
      }
    },
    pageControl: createPassingPageControlEvidence(),
    readiness: createPassingPageControlEvidence(),
    blockers: [],
    diagnostics: {
      extension: {
        id: "abcdefghijklmnopabcdefghijklmnop"
      },
      nativeHost: {
        name: "com.sskift.skfiy"
      },
      session: {
        state: "loaded",
        pageControl: createPassingPageControlEvidence()
      }
    }
  };
}

function createPassingPageControlEvidence() {
  return {
    schemaVersion: 1,
    capability: "chrome-extension-page-control",
    state: "ready",
    capable: true,
    reason: "Current page is ready for Computer Use controls.",
    nextAction: "Use extension pageControl for Chrome Computer Use.",
    source: "extensionStatus.pageControl",
    capabilities: {
      diagnostics: true,
      observe: true,
      domActions: true,
      click: true,
      fill: true,
      submit: true,
      scroll: true,
      screenshot: true
    },
    activeTab: {
      state: "available",
      tabId: 1,
      windowId: 1,
      host: "example.com"
    },
    contentScript: {
      state: "loaded"
    }
  };
}

function createBlockedPageControlEvidence() {
  return {
    schemaVersion: 1,
    capability: "chrome-extension-page-control",
    state: "unavailable",
    capable: false,
    reason: "Installed Chrome extension pageControl could not be probed because branded Chrome blocked automated unpacked extension loading.",
    nextAction: "Use Chrome for Testing, Chromium, or a manually installed skfiy extension, then rerun `npm run smoke:chrome`.",
    source: "installed-extension-run",
    capabilities: {},
    blockers: [
      {
        code: "branded_chrome_load_extension_removed",
        message: "Google Chrome 137+ branded builds remove automated --load-extension support for this proof path.",
        recommendedBrowser: "Chrome for Testing or Chromium"
      }
    ]
  };
}

function createBlockedInstalledExtensionRun(productPath: string) {
  return {
    result: "blocked",
    productPath,
    blockedReason: "branded_chrome_load_extension_removed",
    chromeVersion: "Chrome/146.0.7680.80",
    extensionPath: "/repo/chrome-extension",
    recommendedBrowser: "Chrome for Testing or Chromium"
  };
}
