import type { ObservedElement } from "./observed-elements.js";
import type { DesktopAppState, OcrLabelObservation } from "./types.js";

export type GroundingSource = "macos_accessibility" | "screenshot_ocr";
export type GroundingSourceStatus = "covered" | "partial" | "missing" | "blocked";
export type GroundingRecommendation =
  | "structured_first"
  | "ocr_fallback"
  | "coordinate_fallback_only";

export interface GroundingSourceEvaluation {
  source: GroundingSource;
  status: GroundingSourceStatus;
  observedElementCount: number;
  labelCount: number;
  notes: string[];
}

export interface GroundingCoverageEvaluation {
  bundleId: string;
  screenshotPath: string;
  recommendation: GroundingRecommendation;
  sources: GroundingSourceEvaluation[];
}

export interface GroundingCoverageInput {
  state: DesktopAppState;
  elements: readonly ObservedElement[];
  ocrLabels?: readonly OcrLabelObservation[];
}

export function evaluateGroundingCoverage({
  state,
  elements,
  ocrLabels = []
}: GroundingCoverageInput): GroundingCoverageEvaluation {
  const accessibility = evaluateAccessibilitySource(state, elements);
  const ocr = evaluateOcrSource(ocrLabels);

  return {
    bundleId: state.bundleId,
    screenshotPath: state.screenshotPath,
    recommendation: chooseGroundingRecommendation(accessibility, ocr),
    sources: [accessibility, ocr]
  };
}

function evaluateAccessibilitySource(
  state: DesktopAppState,
  elements: readonly ObservedElement[]
): GroundingSourceEvaluation {
  const labelCount = elements.filter((element) => element.label.trim().length > 0).length;

  if (state.accessibilityTrusted === false) {
    return {
      source: "macos_accessibility",
      status: "blocked",
      observedElementCount: 0,
      labelCount: 0,
      notes: ["Accessibility is not trusted for this app observation."]
    };
  }

  if (elements.length > 0 && state.accessibilityTrusted === true) {
    return {
      source: "macos_accessibility",
      status: "covered",
      observedElementCount: elements.length,
      labelCount,
      notes: [`Accessibility is trusted and produced ${elements.length} window-level element.`]
    };
  }

  if (elements.length > 0) {
    return {
      source: "macos_accessibility",
      status: "partial",
      observedElementCount: elements.length,
      labelCount,
      notes: ["Window-level elements were observed, but Accessibility trust is unknown."]
    };
  }

  return {
    source: "macos_accessibility",
    status: "missing",
    observedElementCount: 0,
    labelCount: 0,
    notes: ["No Accessibility/window elements were observed."]
  };
}

function evaluateOcrSource(
  ocrLabels: readonly OcrLabelObservation[]
): GroundingSourceEvaluation {
  const labelCount = ocrLabels.filter((label) => label.text.trim().length > 0).length;

  if (labelCount > 0) {
    return {
      source: "screenshot_ocr",
      status: "covered",
      observedElementCount: ocrLabels.length,
      labelCount,
      notes: [`OCR parsed ${labelCount} text label from the screenshot.`]
    };
  }

  return {
    source: "screenshot_ocr",
    status: "missing",
    observedElementCount: 0,
    labelCount: 0,
    notes: ["OCR labels have not been parsed for this screenshot."]
  };
}

function chooseGroundingRecommendation(
  accessibility: GroundingSourceEvaluation,
  ocr: GroundingSourceEvaluation
): GroundingRecommendation {
  if (accessibility.status === "covered" || accessibility.status === "partial") {
    return "structured_first";
  }

  if (ocr.status === "covered") {
    return "ocr_fallback";
  }

  return "coordinate_fallback_only";
}
