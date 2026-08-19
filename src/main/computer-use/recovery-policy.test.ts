import { describe, expect, it } from "vitest";
import type { DesktopAppState } from "./types";
import { decideAppRecovery } from "./recovery-policy";

const TARGET = {
  bundleId: "com.mitchellh.ghostty",
  pid: 54502,
  marker: "skfiy"
};

function createState(update: Partial<DesktopAppState> = {}): DesktopAppState {
  return {
    bundleId: "com.mitchellh.ghostty",
    pid: 54502,
    isRunning: true,
    isActive: true,
    screenshotPath: "/tmp/ghostty.png",
    frontmostBundleId: "com.mitchellh.ghostty",
    windows: [
      {
        title: "skfiy-shell",
        layer: 0,
        bounds: { x: 10, y: 20, width: 640, height: 480 }
      }
    ],
    ...update
  };
}

describe("decideAppRecovery", () => {
  it("continues when the expected app, pid, and marker are observed", () => {
    expect(decideAppRecovery(createState(), TARGET)).toEqual({
      type: "continue"
    });
  });

  it("recovers by activating the app when the target is running but not frontmost", () => {
    expect(decideAppRecovery(createState({
      isActive: false,
      frontmostBundleId: "com.apple.finder"
    }), TARGET)).toEqual({
      type: "recover",
      action: "activate",
      reason: "Target app is running but not frontmost."
    });
  });

  it("recovers by opening the app when it is not running or has no windows", () => {
    expect(decideAppRecovery(createState({
      isRunning: false,
      windows: []
    }), TARGET)).toEqual({
      type: "recover",
      action: "open",
      reason: "Target app is not running or has no observable windows."
    });
  });

  it("asks the user when duplicate marked target windows are observed", () => {
    expect(decideAppRecovery(createState({
      windows: [
        {
          title: "skfiy-shell",
          layer: 0,
          bounds: { x: 10, y: 20, width: 640, height: 480 }
        },
        {
          title: "skfiy-shell",
          layer: 1,
          bounds: { x: 30, y: 40, width: 640, height: 480 }
        }
      ]
    }), TARGET)).toEqual({
      type: "ask_user",
      reason: "Multiple marked target windows were observed."
    });
  });

  it("pauses on common sensitive window titles by default", () => {
    expect(decideAppRecovery(createState({
      windows: [
        {
          title: "Keychain Access wants to use your confidential information",
          layer: 0,
          bounds: { x: 10, y: 20, width: 640, height: 480 }
        }
      ]
    }), TARGET)).toEqual({
      type: "pause",
      reason: "Sensitive UI is visible."
    });
  });

  it("pauses on common sensitive OCR labels by default", () => {
    expect(decideAppRecovery(createState({
      ocrLabels: [
        {
          text: "Enter credit card CVV",
          confidence: 0.94,
          bounds: { x: 40, y: 180, width: 220, height: 24 }
        }
      ]
    }), TARGET)).toEqual({
      type: "pause",
      reason: "Sensitive UI text is visible."
    });
  });

  it("pauses when a sensitive window title is visible", () => {
    expect(decideAppRecovery(createState({
      windows: [
        {
          title: "Password Required",
          layer: 0,
          bounds: { x: 10, y: 20, width: 640, height: 480 }
        }
      ]
    }), {
      ...TARGET,
      sensitiveTitlePatterns: [/password/i]
    })).toEqual({
      type: "pause",
      reason: "Sensitive UI is visible."
    });
  });

  it("pauses when OCR labels reveal sensitive UI content", () => {
    expect(decideAppRecovery(createState({
      ocrLabels: [
        {
          text: "Enter API token",
          confidence: 0.91,
          bounds: { x: 40, y: 180, width: 220, height: 24 }
        }
      ]
    }), {
      ...TARGET,
      sensitiveTextPatterns: [/api token/i]
    })).toEqual({
      type: "pause",
      reason: "Sensitive UI text is visible."
    });
  });
});
