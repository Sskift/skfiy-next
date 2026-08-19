import { describe, expect, it } from "vitest";
import {
  CUSTOM_PET_SKIN_STORAGE_KEY,
  DEFAULT_PET_SKIN_ID,
  PET_ATLAS,
  SELECTED_PET_SKIN_STORAGE_KEY,
  getConfiguredPetAtlas,
  getPetSpriteStyle,
  isPetAtlasManifest,
  resolvePetAtlas,
  type PetAtlasManifest
} from "./pet-atlas";

const CUSTOM_MANIFEST: PetAtlasManifest = {
  displayName: "licensed local cat",
  slug: "licensed-local-cat",
  asset: "file:///Users/example/Library/Application%20Support/skfiy/skins/cat/atlas.png",
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  rows: 9,
  source: "custom-user",
  states: {
    idle: { row: 0, frames: 6, frameMs: 170 },
    "running-right": { row: 1, frames: 8, frameMs: 90 },
    "running-left": { row: 2, frames: 8, frameMs: 90 },
    waving: { row: 3, frames: 6, frameMs: 120 },
    jumping: { row: 4, frames: 6, frameMs: 95 },
    failed: { row: 5, frames: 4, frameMs: 150 },
    waiting: { row: 6, frames: 6, frameMs: 190 },
    running: { row: 7, frames: 8, frameMs: 85 },
    review: { row: 8, frames: 6, frameMs: 135 }
  }
};

const ANIMATED_RASTER_MANIFEST: PetAtlasManifest = {
  ...CUSTOM_MANIFEST,
  slug: "animated-local-cat",
  asset: "file:///Users/example/Library/Application%20Support/skfiy/skins/cat/origin.webp",
  frameWidth: 144,
  frameHeight: 128,
  columns: 1,
  rows: 1,
  rendering: {
    mode: "animated-raster",
    ambientMotion: false,
    failureShake: false
  },
  layout: {
    hitboxWidth: 144,
    hitboxHeight: 128,
    visualScale: 1
  },
  states: {
    idle: { row: 0, frames: 1, frameMs: 100 },
    "running-right": { row: 0, frames: 1, frameMs: 100 },
    "running-left": { row: 0, frames: 1, frameMs: 100 },
    waving: { row: 0, frames: 1, frameMs: 100 },
    jumping: { row: 0, frames: 1, frameMs: 100 },
    failed: { row: 0, frames: 1, frameMs: 100 },
    waiting: { row: 0, frames: 1, frameMs: 100 },
    running: { row: 0, frames: 1, frameMs: 100 },
    review: { row: 0, frames: 1, frameMs: 100 }
  }
};

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    }
  };
}

describe("pet atlas", () => {
  it("uses the black cat as the default bundled skin", () => {
    expect(DEFAULT_PET_SKIN_ID).toBe("skfiy-black-cat");
    expect(PET_ATLAS.slug).toBe("skfiy-black-cat");
    expect(PET_ATLAS.assetUrl).toContain("skfiy-black-cat-atlas.svg");
  });

  it("scales pet hitbox and visual sprite for desktop use", () => {
    const style = getPetSpriteStyle("idle");

    expect(Number.parseFloat(style["--pet-visual-scale"])).toBeLessThan(0.5);
    expect(Number.parseInt(style["--pet-hitbox-width"], 10)).toBeLessThan(100);
  });

  it("turns a skin manifest into CSS variables without depending on backend state", () => {
    const atlas = resolvePetAtlas({
      selectedSkinId: CUSTOM_MANIFEST.slug,
      customManifest: CUSTOM_MANIFEST
    });
    const style = getPetSpriteStyle("review", atlas);

    expect(atlas.assetUrl).toBe(CUSTOM_MANIFEST.asset);
    expect(style["--pet-atlas-url"]).toContain(CUSTOM_MANIFEST.asset);
    expect(style["--pet-y"]).toBe("100%");
    expect(style["--pet-steps"]).toBe("5");
  });

  it("lets animated raster skins keep native image animation instead of sprite stepping", () => {
    const atlas = resolvePetAtlas({
      selectedSkinId: ANIMATED_RASTER_MANIFEST.slug,
      customManifest: ANIMATED_RASTER_MANIFEST
    });
    const style = getPetSpriteStyle("idle", atlas);

    expect(isPetAtlasManifest(ANIMATED_RASTER_MANIFEST)).toBe(true);
    expect(atlas.rendering).toEqual({
      mode: "animated-raster",
      ambientMotion: false,
      failureShake: false
    });
    expect(style["--pet-atlas-animation-name"]).toBe("none");
    expect(style["--pet-motion-animation-name"]).toBe("none");
    expect(style["--pet-failed-animation-name"]).toBe("none");
    expect(style["--pet-hitbox-width"]).toBe("69px");
    expect(style["--pet-hitbox-height"]).toBe("61px");
    expect(style["--pet-visual-scale"]).toBe("0.48");
    expect(style["--pet-bg-width"]).toBe("100%");
    expect(style["--pet-bg-height"]).toBe("100%");
  });

  it("reads a user-selected custom skin from storage when the manifest is complete", () => {
    const storage = createMemoryStorage();
    storage.setItem(SELECTED_PET_SKIN_STORAGE_KEY, CUSTOM_MANIFEST.slug);
    storage.setItem(CUSTOM_PET_SKIN_STORAGE_KEY, JSON.stringify(CUSTOM_MANIFEST));

    expect(isPetAtlasManifest(CUSTOM_MANIFEST)).toBe(true);
    expect(getConfiguredPetAtlas(storage).slug).toBe(CUSTOM_MANIFEST.slug);
  });

  it("falls back to the default skin when custom storage is incomplete", () => {
    const storage = createMemoryStorage();
    storage.setItem(SELECTED_PET_SKIN_STORAGE_KEY, "broken-skin");
    storage.setItem(CUSTOM_PET_SKIN_STORAGE_KEY, JSON.stringify({ slug: "broken-skin" }));

    expect(getConfiguredPetAtlas(storage).slug).toBe("skfiy-black-cat");
  });

  it("falls back to the default skin for removed legacy bundled skin ids", () => {
    expect(resolvePetAtlas({ selectedSkinId: "skfiy-cloudbot" }).slug).toBe("skfiy-black-cat");
  });
});
