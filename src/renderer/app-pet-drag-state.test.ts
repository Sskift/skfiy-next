import { describe, expect, it } from "vitest";

import {
  createPetDragMoveTransition,
  createPetDragState,
  isMatchingPetDragPointer,
  readVisiblePetRect,
  shouldStartPetDrag,
  shouldSuppressPetClickAfterDrag,
  updatePetDragStateForPointerMove
} from "./app-pet-drag-state";

const visibleRect = {
  x: 16,
  y: 24,
  width: 96,
  height: 96
};

describe("app pet drag state", () => {
  it("creates drag state from the first pointer position and visible rect", () => {
    expect(readVisiblePetRect({
      x: 10,
      y: 20,
      width: 80,
      height: 90
    })).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 90
    });

    expect(createPetDragState({
      pointerId: 7,
      screenX: 100,
      screenY: 120
    }, visibleRect)).toEqual({
      pointerId: 7,
      lastScreenX: 100,
      lastScreenY: 120,
      moved: false,
      visibleRect
    });
  });

  it("derives drag start and pointer matching without React event objects", () => {
    const drag = createPetDragState({
      pointerId: 7,
      screenX: 100,
      screenY: 120
    }, visibleRect);

    expect(shouldStartPetDrag({ button: 0 })).toBe(true);
    expect(shouldStartPetDrag({ button: 1 })).toBe(false);
    expect(shouldStartPetDrag({ button: 2 })).toBe(false);
    expect(isMatchingPetDragPointer(drag, 7)).toBe(true);
    expect(isMatchingPetDragPointer(drag, 8)).toBe(false);
    expect(isMatchingPetDragPointer(null, 7)).toBe(false);
  });

  it("ignores moves from other pointers and zero-delta moves", () => {
    const drag = createPetDragState({
      pointerId: 7,
      screenX: 100,
      screenY: 120
    }, visibleRect);

    expect(updatePetDragStateForPointerMove(drag, {
      pointerId: 8,
      screenX: 130,
      screenY: 140
    })).toBeNull();
    expect(updatePetDragStateForPointerMove(drag, {
      pointerId: 7,
      screenX: 100,
      screenY: 120
    })).toBeNull();
  });

  it("returns movement delta and marks the first move separately", () => {
    const drag = createPetDragState({
      pointerId: 7,
      screenX: 100,
      screenY: 120
    }, visibleRect);

    const firstMove = updatePetDragStateForPointerMove(drag, {
      pointerId: 7,
      screenX: 112,
      screenY: 95
    });

    expect(firstMove).toEqual({
      deltaX: 12,
      deltaY: -25,
      nextDrag: {
        pointerId: 7,
        lastScreenX: 112,
        lastScreenY: 95,
        moved: true,
        visibleRect
      },
      startedMoving: true
    });

    expect(updatePetDragStateForPointerMove(firstMove!.nextDrag, {
      pointerId: 7,
      screenX: 112,
      screenY: 90
    })).toMatchObject({
      deltaX: 0,
      deltaY: -5,
      startedMoving: false
    });
  });

  it("creates the UI transition for the first drag move", () => {
    const drag = createPetDragState({
      pointerId: 7,
      screenX: 100,
      screenY: 120
    }, visibleRect);

    expect(createPetDragMoveTransition({
      drag,
      pointer: {
        pointerId: 7,
        screenX: 112,
        screenY: 95
      },
      taskStatus: "completed"
    })).toEqual({
      deltaX: 12,
      deltaY: -25,
      nextDrag: {
        pointerId: 7,
        lastScreenX: 112,
        lastScreenY: 95,
        moved: true,
        visibleRect
      },
      startedMoving: true,
      panelTransition: {
        resetTaskBubble: true,
        clearReplayRecords: true,
        compactWindow: true,
        panelAction: { type: "close-for-drag" }
      }
    });
  });

  it("recaptures the visible pet rect on the first move from an open panel", () => {
    const compactRect = {
      x: 114,
      y: 15,
      width: 90,
      height: 66
    };

    expect(createPetDragMoveTransition({
      drag: createPetDragState({
        pointerId: 7,
        screenX: 100,
        screenY: 120
      }, visibleRect),
      pointer: {
        pointerId: 7,
        screenX: 112,
        screenY: 95
      },
      taskStatus: "running",
      visibleRectOnStart: compactRect
    })?.nextDrag.visibleRect).toEqual(compactRect);
  });

  it("keeps follow-up drag moves as movement-only transitions", () => {
    const firstMove = createPetDragMoveTransition({
      drag: createPetDragState({
        pointerId: 7,
        screenX: 100,
        screenY: 120
      }, visibleRect),
      pointer: {
        pointerId: 7,
        screenX: 112,
        screenY: 95
      },
      taskStatus: "running"
    });

    expect(createPetDragMoveTransition({
      drag: firstMove!.nextDrag,
      pointer: {
        pointerId: 7,
        screenX: 118,
        screenY: 95
      },
      taskStatus: "running"
    })).toEqual({
      deltaX: 6,
      deltaY: 0,
      nextDrag: {
        pointerId: 7,
        lastScreenX: 118,
        lastScreenY: 95,
        moved: true,
        visibleRect
      },
      startedMoving: false
    });
  });

  it("suppresses the next click only after movement happened", () => {
    const drag = createPetDragState({
      pointerId: 7,
      screenX: 100,
      screenY: 120
    }, visibleRect);

    expect(shouldSuppressPetClickAfterDrag(drag)).toBe(false);

    const move = updatePetDragStateForPointerMove(drag, {
      pointerId: 7,
      screenX: 101,
      screenY: 120
    });

    expect(shouldSuppressPetClickAfterDrag(move!.nextDrag)).toBe(true);
  });
});
