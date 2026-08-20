import { describe, expect, it } from "vitest";
import {
  clearPetSkinPreview,
  createPetSkinState,
  importPetSkinIntoState,
  previewPetSkin,
  resetPetSkin,
  resolvePetSkinAtlas,
  selectPetSkin
} from "./app-pet-skin-state";
import { DEFAULT_PET_SKIN_ID } from "./pet-atlas";
import type { PetAtlasManifest } from "./pet-atlas";

function createValidManifest(overrides: Partial<PetAtlasManifest> = {}): PetAtlasManifest {
  return {
    displayName: "Test local skin",
    slug: "test-local-skin",
    asset: "file:///tmp/test-skin/origin.png",
    frameWidth: 192,
    frameHeight: 208,
    columns: 1,
    rows: 1,
    source: "custom-user",
    states: {
      idle: { row: 0, frames: 1, frameMs: 170 },
      "running-right": { row: 0, frames: 1, frameMs: 90 },
      "running-left": { row: 0, frames: 1, frameMs: 90 },
      waving: { row: 0, frames: 1, frameMs: 120 },
      jumping: { row: 0, frames: 1, frameMs: 95 },
      failed: { row: 0, frames: 1, frameMs: 150 },
      waiting: { row: 0, frames: 1, frameMs: 190 },
      running: { row: 0, frames: 1, frameMs: 85 },
      review: { row: 0, frames: 1, frameMs: 135 }
    },
    ...overrides
  };
}

describe("pet skin state", () => {
  it("starts with the bundled default skin when no custom manifest is loaded", () => {
    const state = createPetSkinState();

    expect(state.selectedSkinId).toBe(DEFAULT_PET_SKIN_ID);
    expect(state.customManifest).toBeNull();
    expect(state.previewSkinId).toBeNull();
    expect(state.skins).toHaveLength(1);
    expect(state.skins[0]).toMatchObject({
      id: DEFAULT_PET_SKIN_ID,
      origin: "bundled"
    });
  });

  it("selects the imported skin when a valid custom manifest is loaded", () => {
    const manifest = createValidManifest();
    const state = createPetSkinState({ customManifest: manifest });

    expect(state.selectedSkinId).toBe("test-local-skin");
    expect(state.customManifest).toEqual(manifest);
    expect(state.skins).toHaveLength(2);
    expect(state.skins[1]).toMatchObject({
      id: "test-local-skin",
      origin: "local",
      redistribution: "local-only"
    });
  });

  it("selects a bundled skin", () => {
    const state = createPetSkinState();
    const next = selectPetSkin(state, DEFAULT_PET_SKIN_ID);

    expect(next.selectedSkinId).toBe(DEFAULT_PET_SKIN_ID);
  });

  it("selects an imported skin", () => {
    const manifest = createValidManifest();
    const state = createPetSkinState({ customManifest: manifest });
    const next = selectPetSkin(state, "test-local-skin");

    expect(next.selectedSkinId).toBe("test-local-skin");
    expect(next.previewSkinId).toBeNull();
  });

  it("ignores selection of an unknown skin", () => {
    const state = createPetSkinState();
    const next = selectPetSkin(state, "nonexistent-skin");

    expect(next).toBe(state);
  });

  it("previews a skin without changing the selection", () => {
    const manifest = createValidManifest();
    const state = createPetSkinState({ customManifest: manifest });

    const previewed = previewPetSkin(state, DEFAULT_PET_SKIN_ID);
    expect(previewed.previewSkinId).toBe(DEFAULT_PET_SKIN_ID);
    expect(previewed.selectedSkinId).toBe("test-local-skin");

    const atlas = resolvePetSkinAtlas(previewed);
    expect(atlas.slug).toBe(DEFAULT_PET_SKIN_ID);
  });

  it("clears a preview and returns to the selected skin", () => {
    const manifest = createValidManifest();
    const state = createPetSkinState({ customManifest: manifest });
    const previewed = previewPetSkin(state, DEFAULT_PET_SKIN_ID);
    const cleared = clearPetSkinPreview(previewed);

    expect(cleared.previewSkinId).toBeNull();
    expect(resolvePetSkinAtlas(cleared).slug).toBe("test-local-skin");
  });

  it("ignores preview of an unknown skin", () => {
    const state = createPetSkinState();
    const next = previewPetSkin(state, "nonexistent-skin");

    expect(next).toBe(state);
  });

  it("resets to the bundled default skin", () => {
    const manifest = createValidManifest();
    const state = createPetSkinState({ customManifest: manifest });
    const previewed = previewPetSkin(state, DEFAULT_PET_SKIN_ID);
    const reset = resetPetSkin(previewed);

    expect(reset.selectedSkinId).toBe(DEFAULT_PET_SKIN_ID);
    expect(reset.customManifest).toBeNull();
    expect(reset.previewSkinId).toBeNull();
    expect(reset.skins).toHaveLength(1);
    expect(resolvePetSkinAtlas(reset).slug).toBe(DEFAULT_PET_SKIN_ID);
  });

  it("rejects an invalid manifest on import", () => {
    const state = createPetSkinState();
    const next = importPetSkinIntoState(state, { slug: "bad" });

    expect(next).toBe(state);
    expect(next.customManifest).toBeNull();
  });

  it("imports a valid manifest and selects it", () => {
    const state = createPetSkinState();
    const manifest = createValidManifest();
    const next = importPetSkinIntoState(state, manifest);

    expect(next.selectedSkinId).toBe("test-local-skin");
    expect(next.customManifest).toEqual(manifest);
    expect(next.skins).toHaveLength(2);
    expect(resolvePetSkinAtlas(next).slug).toBe("test-local-skin");
  });
});
