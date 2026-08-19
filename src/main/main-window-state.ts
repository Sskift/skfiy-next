import type { PetWindowMode } from "./main-ipc-payload.js";
import {
  calculatePetWindowOffsetForMode,
  resizePetWindowBoundsKeepingBottom,
  resizePetWindowBoundsKeepingPetAnchor,
  type DisplayLike,
  type PetWindowBounds,
  type Point,
  type Size
} from "./window-position.js";

export const COMPACT_WINDOW_SIZE: Size = { width: 90, height: 66 };
export const EXPANDED_WINDOW_SIZE: Size = { width: 320, height: 500 };

export type PetWindowModeTransition =
  | {
    kind: "unchanged";
  }
  | {
    kind: "set-bounds";
    bounds: PetWindowBounds;
  };

export interface CreatePetWindowModeTransitionOptions {
  mode: PetWindowMode;
  currentBounds: PetWindowBounds;
  currentPetAnchor?: Point | null;
  currentPetSize?: Size | null;
  displays: readonly DisplayLike[];
}

export function createPetWindowModeTransition({
  mode,
  currentBounds,
  currentPetAnchor,
  currentPetSize,
  displays
}: CreatePetWindowModeTransitionOptions): PetWindowModeTransition {
  const nextSize = readPetWindowSize(mode);

  if (currentBounds.width === nextSize.width && currentBounds.height === nextSize.height) {
    return { kind: "unchanged" };
  }

  if (currentPetAnchor && currentPetSize) {
    const nextOffset = calculatePetWindowOffsetForMode({
      mode,
      windowSize: nextSize,
      petSize: currentPetSize
    });

    return {
      kind: "set-bounds",
      bounds: resizePetWindowBoundsKeepingPetAnchor({
        anchor: currentPetAnchor,
        nextSize,
        nextOffset,
        displays
      })
    };
  }

  return {
    kind: "set-bounds",
    bounds: resizePetWindowBoundsKeepingBottom(currentBounds, nextSize)
  };
}

export function readPetWindowSize(mode: PetWindowMode): Size {
  return mode === "expanded" ? EXPANDED_WINDOW_SIZE : COMPACT_WINDOW_SIZE;
}
