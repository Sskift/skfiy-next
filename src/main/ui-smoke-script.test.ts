import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("packaged UI product smoke script", () => {
  it("is exposed as an npm script for packaged-app UI smoke", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts).toMatchObject({
      "smoke:ui": "node scripts/smoke-ui-product.mjs"
    });
  });

  it("parses product-path UI smoke options", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-ui-plan.mjs");

    expect(existsSync(modulePath)).toBe(true);

    const {
      createDefaultUiSmokeOptions,
      formatUiLaunchCommand,
      parseUiSmokeArgs
    } = await import(pathToFileURL(modulePath).href) as {
      createDefaultUiSmokeOptions: (rootDir: string) => Record<string, unknown>;
      formatUiLaunchCommand: (options: Record<string, unknown>) => string;
      parseUiSmokeArgs: (
        argv: string[],
        defaults: Record<string, unknown>
      ) => Record<string, unknown>;
    };
    const defaults = createDefaultUiSmokeOptions("/repo");

    expect(defaults).toMatchObject({
      appPath: path.join("/repo", "dist", "skfiy.app"),
      outputPath: undefined,
      productPath: "LaunchServices -> renderer DOM -> React permission onboarding",
      requiredPermissionLabels: ["屏幕录制", "辅助功能"],
      launchMode: "hidden",
      stealsFocus: false,
      smokeAssistantPrompt: "你好 skfiy，请用一句话回复。",
      smokeAssistantReply: "你好，我是 skfiy。"
    });
    expect(parseUiSmokeArgs([], defaults)).toMatchObject({
      outputPath: undefined,
      requirePassed: false
    });
    expect(parseUiSmokeArgs([
      "--app",
      "dist/skfiy.app",
      "--output",
      "artifacts/ui.json",
      "--settle-ms",
      "1500",
      "--require-passed"
    ], defaults)).toMatchObject({
      appPath: path.resolve("dist/skfiy.app"),
      outputPath: path.resolve("artifacts/ui.json"),
      settleMs: 1500,
      requirePassed: true
    });
    expect(formatUiLaunchCommand(defaults)).toContain("--env SKFIY_BYPASS_APPROVAL=strict");
    expect(formatUiLaunchCommand(defaults)).toContain("open -n -g -a");
    expect(formatUiLaunchCommand(defaults)).toContain("--env SKFIY_SMOKE_WINDOW_MODE=hidden");
    expect(formatUiLaunchCommand(defaults)).toContain("--env SKFIY_SMOKE_ASSISTANT_PROMPT=");
    expect(formatUiLaunchCommand(defaults)).toContain("--env SKFIY_SMOKE_ASSISTANT_REPLY=");
    expect(parseUiSmokeArgs(["--visible"], defaults)).toMatchObject({
      launchMode: "visible",
      stealsFocus: true
    });
    expect(formatUiLaunchCommand(parseUiSmokeArgs(["--visible"], defaults))).toContain("open -n -a");
    expect(formatUiLaunchCommand(parseUiSmokeArgs(["--visible"], defaults))).not.toContain("-g -a");
    expect(formatUiLaunchCommand(parseUiSmokeArgs(["--visible"], defaults))).not.toContain("SKFIY_SMOKE_WINDOW_MODE=hidden");
  });

  it("lets packaged UI smoke launch the app hidden without focusing the user's desktop", () => {
    const mainSource = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const smokeSource = readFileSync(path.join(process.cwd(), "scripts/smoke-ui-product.mjs"), "utf8");
    const planSource = readFileSync(path.join(process.cwd(), "scripts/smoke-ui-plan.mjs"), "utf8");

    expect(mainSource).toContain("SKFIY_SMOKE_WINDOW_MODE");
    expect(mainSource).toContain("show: !smokeWindowHidden");
    expect(mainSource).toContain("focusable: !smokeWindowHidden");
    expect(mainSource).toContain("paintWhenInitiallyHidden: true");
    expect(planSource).toContain("SKFIY_SMOKE_WINDOW_MODE=hidden");
    expect(smokeSource).toContain("options.launchMode === \"hidden\"");
    expect(smokeSource).toContain("\"-g\"");
    expect(smokeSource).toContain("HIDDEN_WINDOW_ENV");
  });

  it("keeps hidden UI smoke independent from live Background Agent quota", () => {
    const mainSource = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const helperSource = readFileSync(path.join(process.cwd(), "src/main/main-smoke-assistant-turn.ts"), "utf8");
    const smokeSource = readFileSync(path.join(process.cwd(), "scripts/smoke-ui-product.mjs"), "utf8");
    const planSource = readFileSync(path.join(process.cwd(), "scripts/smoke-ui-plan.mjs"), "utf8");

    expect(planSource).toContain("SKFIY_SMOKE_ASSISTANT_REPLY");
    expect(smokeSource).toContain("SMOKE_ASSISTANT_REPLY_ENV");
    expect(smokeSource).toContain("options.smokeAssistantReply");
    expect(helperSource).toContain("SKFIY_SMOKE_ASSISTANT_REPLY");
    expect(mainSource).toContain("createSmokeAssistantAgentTaskTurn");
  });

  it("limits deterministic UI smoke replies to the assistant chat prompt", () => {
    const helperSource = readFileSync(path.join(process.cwd(), "src/main/main-smoke-assistant-turn.ts"), "utf8");
    const smokeSource = readFileSync(path.join(process.cwd(), "scripts/smoke-ui-product.mjs"), "utf8");
    const planSource = readFileSync(path.join(process.cwd(), "scripts/smoke-ui-plan.mjs"), "utf8");

    expect(planSource).toContain("SKFIY_SMOKE_ASSISTANT_PROMPT");
    expect(smokeSource).toContain("SMOKE_ASSISTANT_PROMPT_ENV");
    expect(smokeSource).toContain("options.smokeAssistantPrompt");
    expect(helperSource).toContain("SKFIY_SMOKE_ASSISTANT_PROMPT");
    expect(helperSource).toContain("input.trim() !== smokePrompt");
  });

  it("records stop-turn task event summaries for product smoke diagnosis", () => {
    const smokeSource = readFileSync(path.join(process.cwd(), "scripts/smoke-ui-product.mjs"), "utf8");

    expect(smokeSource).toContain("summarizeTaskEvents.toString()");
    expect(smokeSource).toContain("taskEvents: summarizeTaskEvents(events)");
  });

  it("classifies a real permission onboarding click as passed only with product-path evidence", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-ui-plan.mjs");
    const {
      classifyUiSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      classifyUiSmokeEvidence: (input: Record<string, unknown>) => string;
    };
    const passedEvidence = {
      appLaunchViaOpen: true,
      runnerHasTmux: false,
      productPath: "LaunchServices -> renderer DOM -> React permission onboarding",
      petClicked: true,
      petDrag: {
        result: "passed",
        source: "renderer-pointer-events-window-bounds",
        beforeBounds: { x: 1200, y: 820, width: 320, height: 224 },
        afterBounds: { x: 1212, y: 732, width: 320, height: 224 },
        visibleEdgeChecks: [
          {
            edge: "top",
            passed: true,
            visiblePet: { x: 1212, y: 0, width: 90, height: 66, top: 0, right: 1302, bottom: 66, left: 1212 },
            displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
            usableBounds: { x: 0, y: 25, width: 1440, height: 875 }
          },
          {
            edge: "bottom",
            passed: true,
            visiblePet: { x: 1212, y: 834, width: 90, height: 66, top: 834, right: 1302, bottom: 900, left: 1212 },
            displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
            usableBounds: { x: 0, y: 25, width: 1440, height: 875 }
          },
          {
            edge: "left",
            passed: true,
            visiblePet: { x: 0, y: 732, width: 90, height: 66, top: 732, right: 90, bottom: 798, left: 0 },
            displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
            usableBounds: { x: 0, y: 25, width: 1440, height: 875 }
          },
          {
            edge: "right",
            passed: true,
            visiblePet: { x: 1350, y: 732, width: 90, height: 66, top: 732, right: 1440, bottom: 798, left: 1350 },
            displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
            usableBounds: { x: 0, y: 25, width: 1440, height: 875 }
          }
        ],
        moveEvents: [
          { deltaX: 12, deltaY: -58 },
          { deltaX: 0, deltaY: -30 }
        ],
        totalDeltaX: 12,
        totalDeltaY: -88,
        upwardMovement: true,
        suppressedClickAfterDrag: true
      },
      onboardingVisible: true,
      permissionRows: [
        { label: "屏幕录制", stateText: "未授权" },
        { label: "辅助功能", stateText: "未授权" }
      ],
      permissionSettingTargets: [
        { label: "屏幕录制", target: "screen-recording", buttonLabel: "打开屏幕录制设置" },
        { label: "辅助功能", target: "accessibility", buttonLabel: "打开辅助功能设置" }
      ],
      requiredPermissionLabels: ["屏幕录制", "辅助功能"],
      stopTurnBehavior: {
        result: "passed",
        source: "renderer-escape-key-product-path",
        command: "在 Ghostty 执行 mkdir skfiy-stop-smoke",
        beforeStatus: "approval_required",
        afterStatus: "cancelled",
        afterMessage: "Task stopped."
      },
      assistantConversation: {
        result: "passed",
        source: "renderer-assistant-conversation-product-path",
        prompt: "你好 skfiy",
        eventStatus: "completed",
        panelVisibleAfterReply: true,
        inputReadyAfterReply: true,
        replyVisible: true,
        replyText: "你好，我在。"
      }
    };

    expect(classifyUiSmokeEvidence(passedEvidence)).toBe("passed");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      runnerHasTmux: true
    })).toBe("failed");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      petDrag: undefined
    })).toBe("missing-pet-drag");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      petDrag: {
        ...(passedEvidence.petDrag as Record<string, unknown>),
        visibleEdgeChecks: []
      }
    })).toBe("missing-pet-drag");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      stopTurnBehavior: undefined
    })).toBe("missing-stop-turn-behavior");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      desktopSessionDiagnostics: {
        state: "blocked",
        reason: "Desktop session is locked by loginwindow",
        frontmostBundleId: "com.apple.loginwindow",
        mainDisplayAsleep: true
      },
      stopTurnBehavior: undefined
    })).toBe("desktop-session-blocked");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      assistantConversation: undefined
    })).toBe("missing-assistant-conversation");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      petDrag: {
        result: "passed",
        source: "renderer-pointer-events-window-bounds",
        beforeBounds: { x: 1200, y: 820, width: 320, height: 224 },
        afterBounds: { x: 1212, y: 844, width: 320, height: 224 },
        visibleEdgeChecks: (passedEvidence.petDrag as { visibleEdgeChecks: unknown }).visibleEdgeChecks,
        moveEvents: [{ deltaX: 12, deltaY: 24 }],
        totalDeltaX: 12,
        totalDeltaY: 24,
        upwardMovement: false,
        suppressedClickAfterDrag: true
      }
    })).toBe("missing-pet-drag");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      permissionRows: [
        { label: "屏幕录制", stateText: "未授权" }
      ]
    })).toBe("missing-permission-rows");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      permissionSettingTargets: [
        { label: "屏幕录制", target: "screen-recording", buttonLabel: "打开屏幕录制设置" }
      ]
    })).toBe("missing-permission-settings");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      onboardingVisible: false,
      permissions: {
        screenRecording: { state: "granted" },
        accessibility: { state: "granted" }
      }
    })).toBe("no-onboarding");
    expect(classifyUiSmokeEvidence({
      ...passedEvidence,
      onboardingVisible: false,
      permissions: {
        screenRecording: { state: "granted" },
        accessibility: { state: "denied" }
      }
    })).toBe("missing-onboarding");
  });

  it("infers full display origin from inset available screen bounds", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-ui-product.mjs");
    const source = readFileSync(modulePath, "utf8");
    const {
      inferDisplayOrigin
    } = await import(pathToFileURL(modulePath).href) as {
      inferDisplayOrigin: (usableStart: number, usableSize: number, displaySize: number) => number;
    };

    expect(inferDisplayOrigin(30, 1410, 1440)).toBe(0);
    expect(inferDisplayOrigin(0, 2504, 2560)).toBe(0);
    expect(inferDisplayOrigin(1473, 949, 982)).toBe(1440);
    expect(inferDisplayOrigin(-1512, 949, 982)).toBe(-1545);
    expect(source).toContain("inferDisplayOrigin.toString()");
  });
});
