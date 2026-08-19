import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LOCAL_ORIGIN_PET_SKIN_SLUG = "luoxiaohei-local";
export const LOCAL_ORIGIN_PET_SKIN_DISPLAY_NAME = "Luo Xiaohei local";

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

export interface PetSkinManifest {
  displayName: string;
  slug: string;
  asset: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  source: "custom-user";
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
  states: Record<PetAtlasState, PetAnimationState>;
  origin?: {
    sourcePath: string;
    licenseSource: string;
    redistribution: "local-only";
    importedAt: string;
  };
}

export interface ImportPetSkinInput {
  homeDir: string;
  sourcePath: string;
  slug?: string;
  displayName?: string;
  licenseSource?: string;
  importedAt?: string;
}

export interface ImportPetSkinResult {
  result: "imported";
  skin: {
    slug: string;
    displayName: string;
    licenseSource: string;
    redistribution: "local-only";
  };
  skinDir: string;
  manifestPath: string;
  assetPath: string;
  manifest: PetSkinManifest;
}

const SINGLE_FRAME_STATES: Record<PetAtlasState, PetAnimationState> = {
  idle: { row: 0, frames: 1, frameMs: 170 },
  "running-right": { row: 0, frames: 1, frameMs: 90 },
  "running-left": { row: 0, frames: 1, frameMs: 90 },
  waving: { row: 0, frames: 1, frameMs: 120 },
  jumping: { row: 0, frames: 1, frameMs: 95 },
  failed: { row: 0, frames: 1, frameMs: 150 },
  waiting: { row: 0, frames: 1, frameMs: 190 },
  running: { row: 0, frames: 1, frameMs: 85 },
  review: { row: 0, frames: 1, frameMs: 135 }
};

const SUPPORTED_ORIGIN_ASSET_EXTENSIONS = new Set([
  ".gif",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".webp"
]);

const ANIMATED_RASTER_EXTENSIONS = new Set([
  ".gif",
  ".webp"
]);

export function createPetSkinsRootPath(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", "skfiy", "skins");
}

export function createPetSkinDirectoryPath(homeDir: string, slug: string): string {
  return path.join(createPetSkinsRootPath(homeDir), sanitizePetSkinSlug(slug));
}

export function createPetSkinManifestPath(homeDir: string, slug = LOCAL_ORIGIN_PET_SKIN_SLUG): string {
  return path.join(createPetSkinDirectoryPath(homeDir, slug), "skin.pet.json");
}

export async function importPetSkin(input: ImportPetSkinInput): Promise<ImportPetSkinResult> {
  if (!input.homeDir) {
    throw new Error("Home directory is required to import a pet skin.");
  }

  const sourcePath = path.resolve(input.sourcePath);
  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error(`Pet skin source is not a file: ${sourcePath}`);
  }

  const extension = path.extname(sourcePath).toLowerCase();
  if (!SUPPORTED_ORIGIN_ASSET_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported pet skin source extension: ${extension || "(none)"}`);
  }

  const slug = sanitizePetSkinSlug(input.slug ?? LOCAL_ORIGIN_PET_SKIN_SLUG);
  const displayName = readDisplayName(input.displayName) ?? LOCAL_ORIGIN_PET_SKIN_DISPLAY_NAME;
  const licenseSource = readDisplayName(input.licenseSource) ?? "local-user-provided";
  const skinDir = createPetSkinDirectoryPath(input.homeDir, slug);
  const assetPath = path.join(skinDir, `origin${extension}`);
  const manifestPath = path.join(skinDir, "skin.pet.json");
  const importedAt = input.importedAt ?? new Date().toISOString();

  await mkdir(skinDir, { recursive: true });
  await copyFile(sourcePath, assetPath);

  const manifest: PetSkinManifest = {
    displayName,
    slug,
    asset: pathToFileURL(assetPath).href,
    frameWidth: 192,
    frameHeight: 208,
    columns: 1,
    rows: 1,
    source: "custom-user",
    ...(ANIMATED_RASTER_EXTENSIONS.has(extension)
      ? {
          rendering: {
            mode: "animated-raster" as const,
            ambientMotion: false,
            failureShake: false
          }
        }
      : {}),
    origin: {
      sourcePath,
      licenseSource,
      redistribution: "local-only",
      importedAt
    },
    states: SINGLE_FRAME_STATES
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    result: "imported",
    skin: {
      slug,
      displayName,
      licenseSource,
      redistribution: "local-only"
    },
    skinDir,
    manifestPath,
    assetPath,
    manifest
  };
}

export async function readDefaultLocalOriginPetSkin(input: {
  homeDir: string;
}): Promise<PetSkinManifest | null> {
  if (!input.homeDir) {
    return null;
  }

  try {
    const rawManifest = await readFile(
      createPetSkinManifestPath(input.homeDir, LOCAL_ORIGIN_PET_SKIN_SLUG),
      "utf8"
    );
    const parsed = JSON.parse(rawManifest) as unknown;
    return isPetSkinManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sanitizePetSkinSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || LOCAL_ORIGIN_PET_SKIN_SLUG;
}

function readDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
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

function isPetSkinManifest(value: unknown): value is PetSkinManifest {
  if (!isRecord(value)) {
    return false;
  }

  const states = isRecord(value.states) ? value.states : {};
  const rendering = isRecord(value.rendering) ? value.rendering : undefined;
  const layout = isRecord(value.layout) ? value.layout : undefined;
  return (
    typeof value.displayName === "string"
    && typeof value.slug === "string"
    && typeof value.asset === "string"
    && isPositiveInteger(value.frameWidth)
    && isPositiveInteger(value.frameHeight)
    && isPositiveInteger(value.columns)
    && isPositiveInteger(value.rows)
    && value.source === "custom-user"
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
    && Object.keys(SINGLE_FRAME_STATES).every((state) => isPetAnimationState(states[state]))
  );
}
