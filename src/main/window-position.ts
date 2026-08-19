export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface WorkArea extends Point, Size {}

export interface DisplayLike {
  bounds?: WorkArea;
  workArea: WorkArea;
}

export interface CalculatePetWindowBoundsOptions {
  cursorPoint: Point;
  displays: readonly DisplayLike[];
  windowSize: Size;
  margin: number;
  positionOverride?: Point;
}

export interface PetWindowBounds extends Point, Size {}

export interface VisiblePetRect extends Point, Size {}

export interface PetAnchorMoveOptions {
  anchor: Point;
  delta: Point;
  petSize: Size;
  displays: readonly DisplayLike[];
}

export interface CalculatePetWindowDragMoveOptions {
  currentBounds: PetWindowBounds;
  delta: Point;
  visiblePetRect?: VisiblePetRect;
  displays: readonly DisplayLike[];
}

export type PetWindowDragMove =
  | {
    kind: "window-position";
    position: Point;
  }
  | {
    kind: "visible-pet-bounds";
    bounds: PetWindowBounds;
    petAnchor: Point;
    petSize: Size;
  };

export type PetWindowOffsetMode = "compact" | "expanded";

export interface CalculatePetWindowOffsetForModeOptions {
  mode: PetWindowOffsetMode;
  windowSize: Size;
  petSize: Size;
  margin?: number;
}

export interface ResizePetWindowBoundsKeepingPetAnchorOptions {
  anchor: Point;
  nextSize: Size;
  nextOffset: Point;
  displays: readonly DisplayLike[];
}

export function resizePetWindowBoundsKeepingBottom(
  currentBounds: PetWindowBounds,
  nextSize: Size
): PetWindowBounds {
  return {
    x: currentBounds.x,
    y: currentBounds.y + currentBounds.height - nextSize.height,
    ...nextSize
  };
}

export function calculatePetWindowOffsetForMode({
  margin = 1
}: CalculatePetWindowOffsetForModeOptions): Point {
  return { x: margin, y: margin };
}

export function resizePetWindowBoundsKeepingPetAnchor({
  anchor,
  nextSize,
  nextOffset,
  displays
}: ResizePetWindowBoundsKeepingPetAnchorOptions): PetWindowBounds {
  return clampWindowBoundsToNearestDisplay({
    x: Math.round(anchor.x - nextOffset.x),
    y: Math.round(anchor.y - nextOffset.y),
    ...nextSize
  }, displays);
}

export function calculatePetWindowBounds({
  cursorPoint,
  displays,
  windowSize,
  margin,
  positionOverride
}: CalculatePetWindowBoundsOptions): PetWindowBounds {
  if (positionOverride) {
    return {
      ...positionOverride,
      ...windowSize
    };
  }

  const display = findDisplayContainingPoint(displays, cursorPoint) ?? findNearestDisplay(displays, cursorPoint);
  const workArea = display?.workArea ?? { x: 0, y: 0, width: windowSize.width, height: windowSize.height };

  return {
    x: workArea.x + Math.max(margin, workArea.width - windowSize.width - margin),
    y: workArea.y + Math.max(margin, workArea.height - windowSize.height - margin),
    ...windowSize
  };
}

export function movePetAnchorByDelta({
  anchor,
  delta,
  petSize,
  displays
}: PetAnchorMoveOptions): Point {
  const requestedAnchor = {
    x: anchor.x + delta.x,
    y: anchor.y + delta.y
  };
  const display = findDisplayContainingPoint(displays, requestedAnchor)
    ?? findNearestDisplay(displays, requestedAnchor);
  const area = readDisplayBounds(display) ?? {
    x: 0,
    y: 0,
    width: petSize.width,
    height: petSize.height
  };

  return {
    x: clamp(requestedAnchor.x, area.x, area.x + area.width - petSize.width),
    y: clamp(requestedAnchor.y, area.y, area.y + area.height - petSize.height)
  };
}

export function calculatePetWindowDragMove({
  currentBounds,
  delta,
  visiblePetRect,
  displays
}: CalculatePetWindowDragMoveOptions): PetWindowDragMove {
  if (!visiblePetRect) {
    return {
      kind: "window-position",
      position: {
        x: Math.round(currentBounds.x + delta.x),
        y: Math.round(currentBounds.y + delta.y)
      }
    };
  }

  const petSize = {
    width: visiblePetRect.width,
    height: visiblePetRect.height
  };
  const petAnchor = movePetAnchorByDelta({
    anchor: {
      x: currentBounds.x + visiblePetRect.x,
      y: currentBounds.y + visiblePetRect.y
    },
    delta,
    petSize,
    displays
  });

  return {
    kind: "visible-pet-bounds",
    bounds: {
      ...currentBounds,
      x: Math.round(petAnchor.x - visiblePetRect.x),
      y: Math.round(petAnchor.y - visiblePetRect.y)
    },
    petAnchor,
    petSize
  };
}

export function readWindowPositionOverride(env: Record<string, string | undefined>): Point | undefined {
  const x = readFiniteEnvNumber(env.SKFIY_WINDOW_X);
  const y = readFiniteEnvNumber(env.SKFIY_WINDOW_Y);

  return x === undefined || y === undefined ? undefined : { x, y };
}

function findDisplayContainingPoint(
  displays: readonly DisplayLike[],
  point: Point
): DisplayLike | undefined {
  return displays.find((display) => {
    const area = readDisplayBounds(display);

    if (!area) {
      return false;
    }

    return (
      point.x >= area.x
      && point.x < area.x + area.width
      && point.y >= area.y
      && point.y < area.y + area.height
    );
  });
}

function findNearestDisplay(
  displays: readonly DisplayLike[],
  point: Point
): DisplayLike | undefined {
  return displays.reduce<DisplayLike | undefined>((nearest, display) => {
    if (!nearest) {
      return display;
    }

    const displayArea = readDisplayBounds(display);
    const nearestArea = readDisplayBounds(nearest);

    if (!displayArea) {
      return nearest;
    }

    if (!nearestArea) {
      return display;
    }

    return distanceToCenter(displayArea, point) < distanceToCenter(nearestArea, point)
      ? display
      : nearest;
  }, undefined);
}

function readDisplayBounds(display: DisplayLike | undefined): WorkArea | undefined {
  return display?.bounds ?? display?.workArea;
}

function clampWindowBoundsToNearestDisplay(
  bounds: PetWindowBounds,
  displays: readonly DisplayLike[]
): PetWindowBounds {
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
  const display = findDisplayContainingPoint(displays, center) ?? findNearestDisplay(displays, center);
  const area = readDisplayBounds(display);

  if (!area) {
    return bounds;
  }

  return {
    ...bounds,
    x: Math.round(clamp(bounds.x, area.x, area.x + area.width - bounds.width)),
    y: Math.round(clamp(bounds.y, area.y, area.y + area.height - bounds.height))
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function distanceToCenter(workArea: WorkArea, point: Point): number {
  const centerX = workArea.x + workArea.width / 2;
  const centerY = workArea.y + workArea.height / 2;
  return Math.hypot(point.x - centerX, point.y - centerY);
}

function readFiniteEnvNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
