import {
  readFiniteNumber,
  readPetWindowMode,
  readVisiblePetRect
} from "./main-ipc-payload.js";
import { createPetWindowModeTransition } from "./main-window-state.js";
import {
  calculatePetWindowDragMove,
  type DisplayLike,
  type PetWindowBounds,
  type Point,
  type Size
} from "./window-position.js";

export interface PetWindowControlTarget {
  getBounds: () => PetWindowBounds;
  isDestroyed: () => boolean;
  setBounds: (bounds: PetWindowBounds) => void;
  setPosition: (x: number, y: number) => void;
}

export interface PetWindowAnchorState {
  currentPetAnchor: Point | null;
  currentPetSize: Size | null;
}

export interface ApplyPetWindowDragMoveOptions extends PetWindowAnchorState {
  deltaX: unknown;
  deltaY: unknown;
  displays: readonly DisplayLike[];
  visibleRectValue: unknown;
  window: PetWindowControlTarget | null;
}

export interface ApplyPetWindowModeOptions extends PetWindowAnchorState {
  displays: readonly DisplayLike[];
  mode: unknown;
  window: PetWindowControlTarget | null;
}

export function applyPetWindowDragMove({
  currentPetAnchor,
  currentPetSize,
  deltaX,
  deltaY,
  displays,
  visibleRectValue,
  window
}: ApplyPetWindowDragMoveOptions): PetWindowAnchorState {
  const x = readFiniteNumber(deltaX);
  const y = readFiniteNumber(deltaY);

  if (!window || window.isDestroyed() || x === undefined || y === undefined) {
    return { currentPetAnchor, currentPetSize };
  }

  const visiblePetRect = readVisiblePetRect(visibleRectValue);
  const move = calculatePetWindowDragMove({
    currentBounds: window.getBounds(),
    delta: { x, y },
    displays,
    ...(visiblePetRect ? { visiblePetRect } : {})
  });

  if (move.kind === "visible-pet-bounds") {
    window.setBounds(move.bounds);
    return {
      currentPetAnchor: move.petAnchor,
      currentPetSize: move.petSize
    };
  }

  window.setPosition(move.position.x, move.position.y);
  return { currentPetAnchor, currentPetSize };
}

export function applyPetWindowMode({
  currentPetAnchor,
  currentPetSize,
  displays,
  mode,
  window
}: ApplyPetWindowModeOptions): boolean {
  const nextMode = readPetWindowMode(mode);

  if (!window || window.isDestroyed() || !nextMode) {
    return false;
  }

  const transition = createPetWindowModeTransition({
    mode: nextMode,
    currentBounds: window.getBounds(),
    currentPetAnchor,
    currentPetSize,
    displays
  });

  if (transition.kind === "set-bounds") {
    window.setBounds(transition.bounds);
  }

  return true;
}
