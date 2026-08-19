import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("product smoke lock", () => {
  it("prevents concurrent packaged-app smoke runs and releases cleanly", async () => {
    const modulePath = path.join(process.cwd(), "scripts", "smoke-lock.mjs");
    const { acquireSmokeLock } = await import(pathToFileURL(modulePath).href) as {
      acquireSmokeLock: (input: {
        rootDir: string;
        scriptName: string;
      }) => Promise<{ lockPath: string; release: () => Promise<void> }>;
    };
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "skfiy-smoke-lock-"));

    try {
      const first = await acquireSmokeLock({ rootDir, scriptName: "ghostty" });

      await expect(
        acquireSmokeLock({ rootDir, scriptName: "finder" })
      ).rejects.toThrow(/Another packaged-app smoke run is already active/);

      await first.release();
      await expect(
        acquireSmokeLock({ rootDir, scriptName: "finder" })
      ).resolves.toMatchObject({
        lockPath: path.join(rootDir, ".skfiy-smoke", "product-smoke.lock")
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("reclaims a stale lock when the recorded owner process is no longer running", async () => {
    const modulePath = path.join(process.cwd(), "scripts", "smoke-lock.mjs");
    const { acquireSmokeLock } = await import(pathToFileURL(modulePath).href) as {
      acquireSmokeLock: (input: {
        rootDir: string;
        scriptName: string;
        isPidRunning?: (pid: number) => boolean;
      }) => Promise<{ lockPath: string; release: () => Promise<void> }>;
    };
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "skfiy-smoke-lock-"));
    const lockPath = path.join(rootDir, ".skfiy-smoke", "product-smoke.lock");

    try {
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          scriptName: "finder",
          pid: 999_999,
          acquiredAt: "2026-06-16T00:00:00.000Z"
        })}\n`
      );

      await expect(acquireSmokeLock({
        rootDir,
        scriptName: "finder",
        isPidRunning: () => false
      })).resolves.toMatchObject({ lockPath });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
