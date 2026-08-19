import blackCatManifest from "./assets/skfiy-black-cat.pet.json";
import type { CSSProperties } from "react";

export type TaskStatusName =
  | "idle"
  | "planned"
  | "observing"
  | "executing"
  | "running"
  | "approval_required"
  | "needs_confirmation"
  | "needs_clarification"
  | "completed"
  | "denied"
  | "blocked"
  | "failed"
  | "cancelled";

export type PetAtlasState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export interface PetAnimationState {
  row: number;
  frames: number;
  frameMs: number;
}

export interface PetAtlasManifest {
  displayName: string;
  slug: string;
  asset: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  source?: "bundled-original" | "custom-user";
  rendering?: {
    mode: "sprite-atlas" | "animated-raster";
    ambientMotion?: boolean;
    failureShake?: boolean;
  };
  layout?: {
    hitboxWidth: number;
    hitboxHeight: number;
    visualScale?: number;
  };
  notes?: string;
  states: Record<PetAtlasState, PetAnimationState>;
}

export interface PetAtlas extends PetAtlasManifest {
  assetUrl: string;
}

type PetSpriteStyle = CSSProperties & Record<`--${string}`, string>;

export type BundledPetSkinId = "skfiy-black-cat";

export const DEFAULT_PET_SKIN_ID: BundledPetSkinId = "skfiy-black-cat";
export const SELECTED_PET_SKIN_STORAGE_KEY = "skfiy.petSkin.selectedId";
export const CUSTOM_PET_SKIN_STORAGE_KEY = "skfiy.petSkin.customManifest";

const PET_STATE_NAMES: PetAtlasState[] = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review"
];

function createBundledPetAtlas(manifest: PetAtlasManifest, assetUrl: string): PetAtlas {
  return {
    ...manifest,
    assetUrl
  };
}

export const BUNDLED_PET_SKINS: Record<BundledPetSkinId, PetAtlas> = {
  "skfiy-black-cat": createBundledPetAtlas(
    blackCatManifest as PetAtlasManifest,
    new URL("./assets/skfiy-black-cat-atlas.svg", import.meta.url).href
  )
};

export const PET_ATLAS = BUNDLED_PET_SKINS[DEFAULT_PET_SKIN_ID];
const PRODUCT_PET_DISPLAY_SCALE = 0.48;

export const TASK_STATUS_TO_PET_STATE: Record<TaskStatusName, PetAtlasState> = {
  idle: "idle",
  planned: "review",
  observing: "review",
  executing: "running",
  running: "running",
  approval_required: "waiting",
  needs_confirmation: "waiting",
  needs_clarification: "waiting",
  completed: "waving",
  denied: "review",
  blocked: "waiting",
  failed: "failed",
  cancelled: "waving"
};

export function getPetStateForTask(status: TaskStatusName): PetAtlasState {
  return TASK_STATUS_TO_PET_STATE[status];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPetAnimationState(value: unknown): value is PetAnimationState {
  return (
    isRecord(value)
    && isNonNegativeInteger(value.row)
    && isPositiveInteger(value.frames)
    && isPositiveInteger(value.frameMs)
  );
}

function hasCompleteStateMap(value: unknown): value is Record<PetAtlasState, PetAnimationState> {
  if (!isRecord(value)) {
    return false;
  }

  return PET_STATE_NAMES.every((state) => isPetAnimationState(value[state]));
}

export function isPetAtlasManifest(value: unknown): value is PetAtlasManifest {
  const rendering = isRecord(value) && isRecord(value.rendering)
    ? value.rendering
    : undefined;
  const layout = isRecord(value) && isRecord(value.layout)
    ? value.layout
    : undefined;

  return (
    isRecord(value)
    && typeof value.displayName === "string"
    && value.displayName.trim().length > 0
    && typeof value.slug === "string"
    && value.slug.trim().length > 0
    && typeof value.asset === "string"
    && value.asset.trim().length > 0
    && isPositiveInteger(value.frameWidth)
    && isPositiveInteger(value.frameHeight)
    && isPositiveInteger(value.columns)
    && isPositiveInteger(value.rows)
    && (
      rendering === undefined
      || rendering.mode === "sprite-atlas"
      || rendering.mode === "animated-raster"
    )
    && (
      rendering === undefined
      || (rendering.ambientMotion === undefined || typeof rendering.ambientMotion === "boolean")
    )
    && (
      rendering === undefined
      || (rendering.failureShake === undefined || typeof rendering.failureShake === "boolean")
    )
    && (
      layout === undefined
      || (
        isPositiveInteger(layout.hitboxWidth)
        && isPositiveInteger(layout.hitboxHeight)
        && (layout.visualScale === undefined || isPositiveNumber(layout.visualScale))
      )
    )
    && hasCompleteStateMap(value.states)
  );
}

export function resolvePetAtlas(input?: {
  selectedSkinId?: string | null;
  customManifest?: PetAtlasManifest | null;
}): PetAtlas {
  const selectedSkinId = input?.selectedSkinId ?? DEFAULT_PET_SKIN_ID;
  const customManifest = input?.customManifest;

  if (customManifest && selectedSkinId === customManifest.slug) {
    return {
      ...customManifest,
      assetUrl: customManifest.asset,
      source: "custom-user"
    };
  }

  if (selectedSkinId in BUNDLED_PET_SKINS) {
    return BUNDLED_PET_SKINS[selectedSkinId as BundledPetSkinId];
  }

  return PET_ATLAS;
}

function readJsonStorageValue(storage: Storage, key: string): unknown {
  const rawValue = storage.getItem(key);
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
}

function hasStorageApi(value: unknown): value is Storage {
  return (
    isRecord(value)
    && typeof value.getItem === "function"
    && typeof value.setItem === "function"
    && typeof value.removeItem === "function"
  );
}

export function getConfiguredPetAtlas(storage?: Storage): PetAtlas {
  const targetStorage =
    storage ?? (typeof window === "undefined" ? undefined : window.localStorage);

  if (!hasStorageApi(targetStorage)) {
    return PET_ATLAS;
  }

  const selectedSkinId = targetStorage.getItem(SELECTED_PET_SKIN_STORAGE_KEY);
  const customValue = readJsonStorageValue(targetStorage, CUSTOM_PET_SKIN_STORAGE_KEY);
  const customManifest = isPetAtlasManifest(customValue) ? customValue : null;

  return resolvePetAtlas({ selectedSkinId, customManifest });
}

export function getPetSpriteStyle(
  state: PetAtlasState,
  atlas: PetAtlas = PET_ATLAS
): PetSpriteStyle {
  const animation = atlas.states[state];
  const animatedRaster = atlas.rendering?.mode === "animated-raster";
  const sourceVisualScale = atlas.layout?.visualScale ?? 0.82;
  const visualScale = sourceVisualScale * PRODUCT_PET_DISPLAY_SCALE;
  const sourceHitboxWidth = atlas.layout?.hitboxWidth ?? Math.round(atlas.frameWidth * sourceVisualScale);
  const sourceHitboxHeight = atlas.layout?.hitboxHeight ?? Math.round(atlas.frameHeight * sourceVisualScale);
  const hitboxWidth = Math.round(sourceHitboxWidth * PRODUCT_PET_DISPLAY_SCALE);
  const hitboxHeight = Math.round(sourceHitboxHeight * PRODUCT_PET_DISPLAY_SCALE);
  const lastColumn = Math.max(1, atlas.columns - 1);
  const lastRow = Math.max(1, atlas.rows - 1);
  const finalColumn = Math.max(0, Math.min(animation.frames - 1, lastColumn));

  return {
    "--pet-atlas-url": `url(${atlas.assetUrl})`,
    "--pet-frame-width": `${atlas.frameWidth}px`,
    "--pet-frame-height": `${atlas.frameHeight}px`,
    "--pet-bg-width": `${atlas.columns * 100}%`,
    "--pet-bg-height": `${atlas.rows * 100}%`,
    "--pet-y": `${(animation.row / lastRow) * 100}%`,
    "--pet-x-end": `${(finalColumn / lastColumn) * 100}%`,
    "--pet-steps": String(Math.max(1, animation.frames - 1)),
    "--pet-duration": `${animation.frames * animation.frameMs}ms`,
    "--pet-atlas-animation-name": animatedRaster ? "none" : "pet-atlas-play",
    "--pet-motion-animation-name": atlas.rendering?.ambientMotion === false ? "none" : "pet-bob",
    "--pet-failed-animation-name": atlas.rendering?.failureShake === false ? "none" : "pet-error-shake",
    "--pet-hitbox-width": `${hitboxWidth}px`,
    "--pet-hitbox-height": `${hitboxHeight}px`,
    "--pet-visual-scale": String(visualScale)
  };
}
