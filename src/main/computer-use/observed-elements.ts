import type {
  DesktopAppState,
  DesktopWindowBounds,
  DesktopWindowInfo,
  OcrLabelObservation
} from "./types.js";

export type ObservedElementRole = "window" | "text";
export type ObservedElementSource = "window" | "ocr";

export interface ObservedElement {
  id: string;
  role: ObservedElementRole;
  source: ObservedElementSource;
  label: string;
  bounds: DesktopWindowBounds;
  confidence: number;
  metadata: {
    bundleId: string;
    pid?: number;
    layer?: number;
  };
}

export interface ClickTarget {
  elementId: string;
  x: number;
  y: number;
}

export function extractObservedElementsFromAppState(
  state: DesktopAppState
): ObservedElement[] {
  return [
    ...extractWindowElements(state),
    ...extractOcrElements(state)
  ];
}

export function findObservedElementsByLabel(
  elements: readonly ObservedElement[],
  label: string
): ObservedElement[] {
  const normalizedLabel = normalizeLabel(label);

  if (!normalizedLabel) {
    return [];
  }

  const exactMatches = elements.filter((element) => (
    normalizeLabel(element.label) === normalizedLabel
  ));
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return elements.filter((element) => {
    const candidate = normalizeLabel(element.label);
    return candidate.includes(normalizedLabel) || normalizedLabel.includes(candidate);
  });
}

function extractWindowElements(state: DesktopAppState): ObservedElement[] {
  return (state.windows ?? [])
    .filter(hasClickableBounds)
    .map((window, originalIndex) => ({ window, originalIndex }))
    .sort((left, right) => {
      const layerDelta = left.window.layer - right.window.layer;
      return layerDelta === 0 ? left.originalIndex - right.originalIndex : layerDelta;
    })
    .map(({ window }, index) => ({
      id: `window:${index}`,
      role: "window",
      source: "window",
      label: readWindowLabel(window, state.bundleId),
      bounds: { ...window.bounds },
      confidence: 1,
      metadata: {
        bundleId: state.bundleId,
        pid: state.pid,
        layer: window.layer
      }
    }));
}

function extractOcrElements(state: DesktopAppState): ObservedElement[] {
  return (state.ocrLabels ?? [])
    .filter(hasUsableOcrLabel)
    .map((label, index) => ({
      id: `ocr:${index}`,
      role: "text",
      source: "ocr",
      label: label.text.trim(),
      bounds: { ...label.bounds },
      confidence: label.confidence,
      metadata: {
        bundleId: state.bundleId,
        pid: state.pid
      }
    }));
}

export function resolveClickTarget(
  elements: readonly ObservedElement[],
  elementId: string
): ClickTarget {
  const element = elements.find((candidate) => candidate.id === elementId);

  if (!element) {
    throw new Error(`Observed element was not found: ${elementId}`);
  }

  return {
    elementId,
    x: Math.round(element.bounds.x + element.bounds.width / 2),
    y: Math.round(element.bounds.y + element.bounds.height / 2)
  };
}

function hasClickableBounds(window: DesktopWindowInfo): boolean {
  return (
    Number.isFinite(window.bounds.x)
    && Number.isFinite(window.bounds.y)
    && Number.isFinite(window.bounds.width)
    && Number.isFinite(window.bounds.height)
    && window.bounds.width > 0
    && window.bounds.height > 0
  );
}

function hasUsableOcrLabel(label: OcrLabelObservation): boolean {
  return label.text.trim().length > 0 && hasClickableBounds({
    layer: 0,
    bounds: label.bounds
  });
}

function readWindowLabel(window: DesktopWindowInfo, fallback: string): string {
  const title = window.title?.trim();
  return title && title.length > 0 ? title : fallback;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
