import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

export const MAX_PET_SKIN_ASSET_BYTES = 16 * 1024 * 1024;

const MAX_PET_SKIN_FRAME_DIMENSION = 4_096;
const MAX_PET_SKIN_FRAME_DURATION_MS = 60_000;
const MAX_DECODED_PET_SKIN_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_PET_SKIN_PIXELS = Math.floor(MAX_DECODED_PET_SKIN_BYTES / 4);
const MAX_PET_SKIN_ANIMATION_FRAMES = 512;
const MAX_PET_SKIN_PIXELS = MAX_PET_SKIN_FRAME_DIMENSION ** 2;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  if (sourceStats.size <= 0 || sourceStats.size > MAX_PET_SKIN_ASSET_BYTES) {
    throw new Error(`Pet skin source is empty or too large: ${sourceStats.size} bytes`);
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

export async function resetPetSkin(input: { homeDir: string }): Promise<void> {
  if (!input.homeDir) {
    return;
  }
  const skinDir = createPetSkinDirectoryPath(input.homeDir, LOCAL_ORIGIN_PET_SKIN_SLUG);
  await rm(skinDir, { recursive: true, force: true });
}

export async function readDefaultLocalOriginPetSkin(input: {
  homeDir: string;
}): Promise<PetSkinManifest | null> {
  if (!input.homeDir) {
    return null;
  }

  try {
    const skinDir = createPetSkinDirectoryPath(input.homeDir, LOCAL_ORIGIN_PET_SKIN_SLUG);
    const rawManifest = await readFile(
      createPetSkinManifestPath(input.homeDir, LOCAL_ORIGIN_PET_SKIN_SLUG),
      "utf8"
    );
    const parsed = JSON.parse(rawManifest) as unknown;
    if (!isPetSkinManifest(parsed)) {
      return null;
    }

    const assetPath = await resolveAvailableLocalPetSkinAsset(parsed.asset, skinDir);
    if (assetPath) {
      return parsed;
    }

    return await readLegacyWebpPetSkinFallback(parsed, skinDir);
  } catch {
    return null;
  }
}

async function resolveAvailableLocalPetSkinAsset(
  asset: string,
  skinDir: string
): Promise<string | null> {
  let assetPath: string;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(asset)) {
      const assetUrl = new URL(asset);
      if (assetUrl.protocol !== "file:") return null;
      assetPath = fileURLToPath(assetUrl);
    } else {
      if (path.isAbsolute(asset)) return null;
      assetPath = path.resolve(skinDir, asset);
    }

    const [resolvedSkinDir, resolvedAssetPath] = await Promise.all([
      realpath(skinDir),
      realpath(assetPath)
    ]);
    if (!isPathInside(resolvedSkinDir, resolvedAssetPath)) return null;

    const assetStats = await stat(resolvedAssetPath);
    return assetStats.isFile() ? resolvedAssetPath : null;
  } catch {
    return null;
  }
}

async function readLegacyWebpPetSkinFallback(
  manifest: PetSkinManifest,
  skinDir: string
): Promise<PetSkinManifest | null> {
  const candidates: string[] = [];
  if (readPetSkinAssetExtension(manifest.asset) === ".webp") {
    candidates.push(manifest.asset);
  }
  const legacyFramesPath = path.join(skinDir, "origin-visible.webp");
  if (!candidates.includes(legacyFramesPath)) {
    candidates.push(legacyFramesPath);
  }

  for (const candidate of candidates) {
    try {
      const assetPath = await resolveLegacyPetSkinAssetPath(candidate, skinDir);
      const [assetStats, assetBytes] = await Promise.all([
        stat(assetPath),
        readFile(assetPath)
      ]);
      const inspection = inspectLegacyAnimatedWebpContainer(assetBytes);
      if (
        !assetStats.isFile()
        || assetStats.size !== assetBytes.length
        || assetBytes.length === 0
        || assetBytes.length > MAX_PET_SKIN_ASSET_BYTES
        || !inspection
        || inspection.width !== manifest.frameWidth
        || inspection.height !== manifest.frameHeight
      ) {
        continue;
      }

      return {
        ...manifest,
        asset: pathToFileURL(assetPath).href,
        rendering: {
          mode: "animated-raster",
          ambientMotion: false,
          failureShake: manifest.rendering?.failureShake ?? false
        },
        states: cloneStates(manifest.states)
      };
    } catch {
      // Try the next legacy candidate before falling back to the transparent PNG.
    }
  }

  return readLegacyTransparentPngFallback(manifest, skinDir);
}

async function readLegacyTransparentPngFallback(
  manifest: PetSkinManifest,
  skinDir: string
): Promise<PetSkinManifest | null> {
  try {
    const fallbackPath = path.join(skinDir, "origin-transparent.png");
    const [resolvedSkinDir, resolvedFallbackPath] = await Promise.all([
      realpath(skinDir),
      realpath(fallbackPath)
    ]);
    if (!isPathInside(resolvedSkinDir, resolvedFallbackPath)) return null;

    const [fallbackStats, fallbackBytes] = await Promise.all([
      stat(resolvedFallbackPath),
      readFile(resolvedFallbackPath)
    ]);
    if (
      !fallbackStats.isFile()
      || fallbackStats.size !== fallbackBytes.length
      || fallbackBytes.length === 0
      || fallbackBytes.length > MAX_PET_SKIN_ASSET_BYTES
      || !isValidTransparentPngFallback(fallbackBytes)
    ) {
      return null;
    }

    const { rendering, ...staticManifest } = manifest;
    return {
      ...staticManifest,
      asset: pathToFileURL(resolvedFallbackPath).href,
      states: cloneStates(manifest.states)
    };
  } catch {
    return null;
  }
}

async function resolveLegacyPetSkinAssetPath(
  asset: string,
  skinDir: string
): Promise<string> {
  const assetPath = /^[a-z][a-z0-9+.-]*:/i.test(asset)
    ? fileURLToPath(new URL(asset))
    : path.resolve(skinDir, asset);
  const [resolvedSkinDir, resolvedAssetPath] = await Promise.all([
    realpath(skinDir),
    realpath(assetPath)
  ]);
  if (!isPathInside(resolvedSkinDir, resolvedAssetPath)) {
    throw new Error("Legacy pet skin asset is outside its skin directory.");
  }
  return resolvedAssetPath;
}

interface AnimatedWebpInspection {
  frameCount: number;
  height: number;
  width: number;
}

function inspectLegacyAnimatedWebpContainer(bytes: Buffer): AnimatedWebpInspection | null {
  if (
    bytes.length < 30
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.readUInt32LE(4) + 8 !== bytes.length
    || bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  let offset = 12;
  let canvas: { width: number; height: number } | null = null;
  let frameCount = 0;
  let decodedPixels = 0;
  let sawAnimationHeader = false;
  while (offset < bytes.length) {
    const chunk = readWebpChunk(bytes, offset, bytes.length);
    if (!chunk) return null;

    if (chunk.type === "VP8X") {
      if (canvas || chunk.size !== 10 || bytes[chunk.dataStart + 1] !== 0
        || bytes[chunk.dataStart + 2] !== 0 || bytes[chunk.dataStart + 3] !== 0) {
        return null;
      }
      const width = readUint24Le(bytes, chunk.dataStart + 4) + 1;
      const height = readUint24Le(bytes, chunk.dataStart + 7) + 1;
      if (
        (bytes[chunk.dataStart] & 0x02) === 0
        || !hasBoundedImageDimensions(width, height)
      ) {
        return null;
      }
      canvas = { width, height };
    } else if (chunk.type === "ANIM") {
      if (!canvas || sawAnimationHeader || chunk.size !== 6) return null;
      sawAnimationHeader = true;
    } else if (chunk.type === "ANMF") {
      if (!canvas || !sawAnimationHeader || chunk.size < 29) return null;
      const frame = readAnimatedWebpFrame(bytes, chunk.dataStart, chunk.dataEnd, canvas);
      if (!frame) return null;
      frameCount += 1;
      decodedPixels += frame.width * frame.height;
      if (
        frameCount > MAX_PET_SKIN_ANIMATION_FRAMES
        || decodedPixels > MAX_DECODED_PET_SKIN_PIXELS
      ) {
        return null;
      }
    }

    offset = chunk.nextOffset;
  }

  return offset === bytes.length && canvas && sawAnimationHeader && frameCount > 0
    ? { ...canvas, frameCount }
    : null;
}

function readAnimatedWebpFrame(
  bytes: Buffer,
  start: number,
  end: number,
  canvas: { width: number; height: number }
): { width: number; height: number } | null {
  const x = readUint24Le(bytes, start) * 2;
  const y = readUint24Le(bytes, start + 3) * 2;
  const width = readUint24Le(bytes, start + 6) + 1;
  const height = readUint24Le(bytes, start + 9) + 1;
  const duration = readUint24Le(bytes, start + 12);
  if (
    !hasBoundedImageDimensions(width, height)
    || duration === 0
    || duration > MAX_PET_SKIN_FRAME_DURATION_MS
    || (bytes[start + 15] & 0xfc) !== 0
    || x + width > canvas.width
    || y + height > canvas.height
  ) {
    return null;
  }

  let offset = start + 16;
  let imageDimensions: { width: number; height: number } | null = null;
  while (offset < end) {
    const chunk = readWebpChunk(bytes, offset, end);
    if (!chunk) return null;
    if (chunk.type === "VP8L" || chunk.type === "VP8 ") {
      if (imageDimensions) return null;
      imageDimensions = readWebpFrameImageDimensions(bytes, chunk);
      if (!imageDimensions) return null;
    } else if (chunk.type !== "ALPH") {
      return null;
    }
    offset = chunk.nextOffset;
  }

  return offset === end
    && imageDimensions?.width === width
    && imageDimensions.height === height
    ? { width, height }
    : null;
}

interface WebpChunk {
  dataEnd: number;
  dataStart: number;
  nextOffset: number;
  size: number;
  type: string;
}

function readWebpChunk(bytes: Buffer, offset: number, boundary: number): WebpChunk | null {
  if (offset + 8 > boundary) return null;
  const size = bytes.readUInt32LE(offset + 4);
  const dataStart = offset + 8;
  const dataEnd = dataStart + size;
  const nextOffset = dataEnd + (size % 2);
  if (dataEnd < dataStart || nextOffset > boundary) return null;
  return {
    dataEnd,
    dataStart,
    nextOffset,
    size,
    type: bytes.toString("ascii", offset, offset + 4)
  };
}

function readWebpFrameImageDimensions(
  bytes: Buffer,
  chunk: WebpChunk
): { width: number; height: number } | null {
  if (chunk.type === "VP8L") {
    if (chunk.size < 5 || bytes[chunk.dataStart] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(chunk.dataStart + 1);
    if ((bits >>> 29) !== 0) return null;
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1
    };
  }
  if (
    chunk.size < 10
    || bytes[chunk.dataStart + 3] !== 0x9d
    || bytes[chunk.dataStart + 4] !== 0x01
    || bytes[chunk.dataStart + 5] !== 0x2a
  ) {
    return null;
  }
  return {
    width: bytes.readUInt16LE(chunk.dataStart + 6) & 0x3fff,
    height: bytes.readUInt16LE(chunk.dataStart + 8) & 0x3fff
  };
}

function readUint24Le(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readPetSkinAssetExtension(asset: string): string {
  try {
    return path.extname(/^[a-z][a-z0-9+.-]*:/i.test(asset)
      ? fileURLToPath(new URL(asset))
      : asset).toLowerCase();
  } catch {
    return "";
  }
}

function isValidTransparentPngFallback(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return false;
  }
  if (
    bytes.readUInt32BE(8) !== 13
    || bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return false;
  }
  return hasBoundedImageDimensions(
    bytes.readUInt32BE(16),
    bytes.readUInt32BE(20)
  );
}

function hasBoundedImageDimensions(width: number, height: number): boolean {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= MAX_PET_SKIN_FRAME_DIMENSION
    && height <= MAX_PET_SKIN_FRAME_DIMENSION
    && width * height <= MAX_PET_SKIN_PIXELS;
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath.length > 0
    && !relativePath.startsWith(`..${path.sep}`)
    && relativePath !== ".."
    && !path.isAbsolute(relativePath);
}

function cloneStates(
  states: Record<PetAtlasState, PetAnimationState>
): Record<PetAtlasState, PetAnimationState> {
  return Object.fromEntries(
    Object.entries(states).map(([state, animation]) => [state, { ...animation }])
  ) as Record<PetAtlasState, PetAnimationState>;
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
