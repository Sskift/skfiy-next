import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importPetSkin, readDefaultLocalOriginPetSkin } from "./pet-skin";

const tempRoots: string[] = [];
const VALID_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",
  "base64"
);

function createTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "skfiy-pet-skin-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("pet skin storage boundary", () => {
  it("returns the imported manifest while its origin asset is available", async () => {
    const homeDir = createTempRoot();
    const sourcePath = path.join(createTempRoot(), "seed.png");
    writeFileSync(sourcePath, VALID_PNG_BYTES);
    const imported = await importPetSkin({ homeDir, sourcePath });

    const loaded = await readDefaultLocalOriginPetSkin({ homeDir });

    expect(loaded).toMatchObject({
      slug: "luoxiaohei-local",
      asset: imported.manifest.asset,
      frameWidth: 192,
      frameHeight: 208,
      origin: { redistribution: "local-only" }
    });
  });

  it("restores a bounded legacy animated WebP without replacing its frame animation", async () => {
    const homeDir = createTempRoot();
    const sourcePath = path.join(createTempRoot(), "seed.png");
    writeFileSync(sourcePath, VALID_PNG_BYTES);
    const imported = await importPetSkin({ homeDir, sourcePath });
    const legacyWebpPath = path.join(imported.skinDir, "origin-visible.webp");
    const transparentPngPath = path.join(imported.skinDir, "origin-transparent.png");
    const storedManifest = JSON.parse(readFileSync(imported.manifestPath, "utf8"));
    writeFileSync(legacyWebpPath, createAnimatedWebpFixture({
      frameCount: 2,
      height: 2,
      width: 2
    }));
    writeFileSync(transparentPngPath, VALID_PNG_BYTES);
    storedManifest.asset = pathToFileURL(
      path.join(imported.skinDir, "origin-missing.png")
    ).href;
    storedManifest.frameWidth = 2;
    storedManifest.frameHeight = 2;
    storedManifest.rendering = {
      mode: "animated-raster",
      ambientMotion: false,
      failureShake: false
    };
    writeFileSync(imported.manifestPath, `${JSON.stringify(storedManifest, null, 2)}\n`);

    const loaded = await readDefaultLocalOriginPetSkin({ homeDir });

    expect(loaded).toMatchObject({
      slug: "luoxiaohei-local",
      asset: pathToFileURL(realpathSync(legacyWebpPath)).href,
      frameWidth: 2,
      frameHeight: 2,
      rendering: {
        mode: "animated-raster",
        ambientMotion: false,
        failureShake: false
      },
      origin: { redistribution: "local-only" }
    });
  });

  it("uses the validated transparent PNG when a legacy animated WebP container is corrupt", async () => {
    const homeDir = createTempRoot();
    const sourcePath = path.join(createTempRoot(), "seed.png");
    writeFileSync(sourcePath, VALID_PNG_BYTES);
    const imported = await importPetSkin({ homeDir, sourcePath });
    const legacyWebpPath = path.join(imported.skinDir, "origin-visible.webp");
    const transparentPngPath = path.join(imported.skinDir, "origin-transparent.png");
    const storedManifest = JSON.parse(readFileSync(imported.manifestPath, "utf8"));
    writeFileSync(legacyWebpPath, Buffer.from("RIFF-corrupt-WEBP"));
    writeFileSync(transparentPngPath, VALID_PNG_BYTES);
    storedManifest.asset = pathToFileURL(
      path.join(imported.skinDir, "origin-missing.png")
    ).href;
    writeFileSync(imported.manifestPath, `${JSON.stringify(storedManifest, null, 2)}\n`);

    const loaded = await readDefaultLocalOriginPetSkin({ homeDir });

    expect(loaded?.asset).toBe(pathToFileURL(realpathSync(transparentPngPath)).href);
  });

  it("returns null when the origin asset and every legacy fallback are unavailable", async () => {
    const homeDir = createTempRoot();
    const sourcePath = path.join(createTempRoot(), "seed.png");
    writeFileSync(sourcePath, VALID_PNG_BYTES);
    const imported = await importPetSkin({ homeDir, sourcePath });
    const storedManifest = JSON.parse(readFileSync(imported.manifestPath, "utf8"));
    storedManifest.asset = pathToFileURL(
      path.join(imported.skinDir, "origin-missing.png")
    ).href;
    writeFileSync(imported.manifestPath, `${JSON.stringify(storedManifest, null, 2)}\n`);

    const loaded = await readDefaultLocalOriginPetSkin({ homeDir });

    expect(loaded).toBeNull();
  });
});

function createAnimatedWebpFixture(input: {
  frameCount: number;
  height: number;
  width: number;
}): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02;
  writeUint24Le(vp8x, input.width - 1, 4);
  writeUint24Le(vp8x, input.height - 1, 7);
  const animation = Buffer.alloc(6);
  const frames = Array.from({ length: input.frameCount }, () => {
    const header = Buffer.alloc(16);
    writeUint24Le(header, input.width - 1, 6);
    writeUint24Le(header, input.height - 1, 9);
    writeUint24Le(header, 100, 12);
    const dimensions = (input.width - 1) | ((input.height - 1) << 14);
    const vp8l = Buffer.alloc(5);
    vp8l[0] = 0x2f;
    vp8l.writeUInt32LE(dimensions, 1);
    return createWebpChunk("ANMF", Buffer.concat([
      header,
      createWebpChunk("VP8L", vp8l)
    ]));
  });
  const payload = Buffer.concat([
    Buffer.from("WEBP", "ascii"),
    createWebpChunk("VP8X", vp8x),
    createWebpChunk("ANIM", animation),
    ...frames
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(payload.length, 4);
  return Buffer.concat([riff, payload]);
}

function createWebpChunk(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([
    header,
    payload,
    ...(payload.length % 2 === 1 ? [Buffer.alloc(1)] : [])
  ]);
}

function writeUint24Le(buffer: Buffer, value: number, offset: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
}
