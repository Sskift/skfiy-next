import { describe, expect, it } from "vitest";
import type { DesktopAppState } from "./types";
import {
  extractObservedElementsFromAppState,
  findObservedElementsByLabel,
  resolveClickTarget
} from "./observed-elements";

function createState(): DesktopAppState {
  return {
    bundleId: "com.mitchellh.ghostty",
    pid: 54502,
    isRunning: true,
    isActive: true,
    screenshotPath: "/tmp/ghostty.png",
    windows: [
      {
        title: "background",
        layer: 3,
        bounds: { x: 200, y: 100, width: 300, height: 200 }
      },
      {
        title: "skfiy-shell",
        layer: 0,
        bounds: { x: 10, y: 20, width: 640, height: 480 }
      },
      {
        title: "hidden",
        layer: 0,
        bounds: { x: 0, y: 0, width: 0, height: 100 }
      }
    ]
  };
}

describe("observed elements", () => {
  it("extracts window elements from app observations in front-to-back order", () => {
    expect(extractObservedElementsFromAppState(createState())).toEqual([
      {
        id: "window:0",
        role: "window",
        source: "window",
        label: "skfiy-shell",
        bounds: { x: 10, y: 20, width: 640, height: 480 },
        confidence: 1,
        metadata: {
          bundleId: "com.mitchellh.ghostty",
          pid: 54502,
          layer: 0
        }
      },
      {
        id: "window:1",
        role: "window",
        source: "window",
        label: "background",
        bounds: { x: 200, y: 100, width: 300, height: 200 },
        confidence: 1,
        metadata: {
          bundleId: "com.mitchellh.ghostty",
          pid: 54502,
          layer: 3
        }
      }
    ]);
  });

  it("uses the bundle id when a window has no title", () => {
    const state = createState();
    state.windows = [
      {
        layer: 0,
        bounds: { x: 1, y: 2, width: 3, height: 4 }
      }
    ];

    expect(extractObservedElementsFromAppState(state)[0]).toMatchObject({
      label: "com.mitchellh.ghostty"
    });
  });

  it("extracts OCR text labels as observed elements after window elements", () => {
    const state = createState();
    state.ocrLabels = [
      {
        text: "Run",
        confidence: 0.91,
        bounds: { x: 42, y: 50, width: 80, height: 24 }
      },
      {
        text: "  ",
        confidence: 0.99,
        bounds: { x: 1, y: 1, width: 10, height: 10 }
      }
    ];

    expect(extractObservedElementsFromAppState(state)).toEqual([
      {
        id: "window:0",
        role: "window",
        source: "window",
        label: "skfiy-shell",
        bounds: { x: 10, y: 20, width: 640, height: 480 },
        confidence: 1,
        metadata: {
          bundleId: "com.mitchellh.ghostty",
          pid: 54502,
          layer: 0
        }
      },
      {
        id: "window:1",
        role: "window",
        source: "window",
        label: "background",
        bounds: { x: 200, y: 100, width: 300, height: 200 },
        confidence: 1,
        metadata: {
          bundleId: "com.mitchellh.ghostty",
          pid: 54502,
          layer: 3
        }
      },
      {
        id: "ocr:0",
        role: "text",
        source: "ocr",
        label: "Run",
        bounds: { x: 42, y: 50, width: 80, height: 24 },
        confidence: 0.91,
        metadata: {
          bundleId: "com.mitchellh.ghostty",
          pid: 54502
        }
      }
    ]);
  });

  it("resolves a click target to the center of an observed element", () => {
    const elements = extractObservedElementsFromAppState(createState());

    expect(resolveClickTarget(elements, "window:0")).toEqual({
      elementId: "window:0",
      x: 330,
      y: 260
    });
  });

  it("throws when resolving an unknown element id", () => {
    const elements = extractObservedElementsFromAppState(createState());

    expect(() => resolveClickTarget(elements, "window:missing")).toThrow(
      "Observed element was not found: window:missing"
    );
  });

  it("finds observed elements by case-insensitive exact or fuzzy label", () => {
    const state = createState();
    state.ocrLabels = [
      {
        text: "Submit Report",
        confidence: 0.94,
        bounds: { x: 20, y: 40, width: 120, height: 24 }
      },
      {
        text: "Submit Draft",
        confidence: 0.88,
        bounds: { x: 20, y: 80, width: 120, height: 24 }
      }
    ];
    const elements = extractObservedElementsFromAppState(state);

    expect(
      findObservedElementsByLabel(elements, "submit report").map((element) => element.id)
    ).toEqual(["ocr:0"]);
    expect(findObservedElementsByLabel(elements, "submit").map((element) => element.id)).toEqual([
      "ocr:0",
      "ocr:1"
    ]);
  });
});
