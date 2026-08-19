import { describe, expect, it } from "vitest";
import { extractObservedElementsFromAppState } from "./observed-elements";
import type { DesktopAppState } from "./types";
import { evaluateGroundingCoverage } from "./grounding-evaluation";

function createState(overrides: Partial<DesktopAppState> = {}): DesktopAppState {
  return {
    bundleId: "com.mitchellh.ghostty",
    pid: 54502,
    isRunning: true,
    isActive: true,
    screenshotPath: "/tmp/ghostty.png",
    accessibilityTrusted: true,
    windows: [
      {
        title: "skfiy-shell",
        layer: 0,
        bounds: { x: 10, y: 20, width: 640, height: 480 }
      }
    ],
    ...overrides
  };
}

describe("evaluateGroundingCoverage", () => {
  it("prefers macOS accessibility when trusted windows are observable", () => {
    const state = createState();
    const elements = extractObservedElementsFromAppState(state);

    expect(evaluateGroundingCoverage({ state, elements })).toEqual({
      bundleId: "com.mitchellh.ghostty",
      screenshotPath: "/tmp/ghostty.png",
      recommendation: "structured_first",
      sources: [
        {
          source: "macos_accessibility",
          status: "covered",
          observedElementCount: 1,
          labelCount: 1,
          notes: ["Accessibility is trusted and produced 1 window-level element."]
        },
        {
          source: "screenshot_ocr",
          status: "missing",
          observedElementCount: 0,
          labelCount: 0,
          notes: ["OCR labels have not been parsed for this screenshot."]
        }
      ]
    });
  });

  it("recommends OCR fallback when accessibility is blocked but screenshot labels exist", () => {
    const state = createState({
      accessibilityTrusted: false,
      windows: []
    });

    expect(evaluateGroundingCoverage({
      state,
      elements: [],
      ocrLabels: [
        { text: "New Tab", confidence: 0.91, bounds: { x: 20, y: 40, width: 80, height: 24 } }
      ]
    })).toMatchObject({
      recommendation: "ocr_fallback",
      sources: [
        {
          source: "macos_accessibility",
          status: "blocked",
          observedElementCount: 0,
          labelCount: 0
        },
        {
          source: "screenshot_ocr",
          status: "covered",
          observedElementCount: 1,
          labelCount: 1
        }
      ]
    });
  });

  it("reports coordinate fallback only when neither accessibility nor OCR labels can ground actions", () => {
    const state = createState({
      accessibilityTrusted: false,
      windows: []
    });

    expect(evaluateGroundingCoverage({ state, elements: [] })).toMatchObject({
      recommendation: "coordinate_fallback_only",
      sources: [
        { source: "macos_accessibility", status: "blocked" },
        { source: "screenshot_ocr", status: "missing" }
      ]
    });
  });
});
