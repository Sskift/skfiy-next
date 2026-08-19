import { describe, expect, it } from "vitest";

import { readTaskRecoveryPathStatus } from "./task-recovery-stage-runtime.js";

describe("Task Control recovery stage runtime", () => {
  it("reads direct file identity without following links", async () => {
    await expect(readTaskRecoveryPathStatus("/tmp/file", async () => ({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true,
      dev: 1,
      ino: 2,
      size: 3,
      mtimeMs: 4,
      ctimeMs: 5
    }))).resolves.toEqual({
      state: "file",
      identity: {
        device: 1,
        inode: 2,
        size: 3,
        modifiedAtMs: 4,
        changedAtMs: 5
      }
    });
  });

  it("distinguishes direct folders, indirect paths, and missing paths", async () => {
    await expect(readTaskRecoveryPathStatus("/tmp/folder", async () => ({
      isSymbolicLink: () => false,
      isDirectory: () => true,
      isFile: () => false,
      dev: 1,
      ino: 2,
      size: 3,
      mtimeMs: 4,
      ctimeMs: 5
    }))).resolves.toEqual({ state: "directory" });
    await expect(readTaskRecoveryPathStatus("/tmp/link", async () => ({
      isSymbolicLink: () => true,
      isDirectory: () => false,
      isFile: () => false,
      dev: 1,
      ino: 2,
      size: 3,
      mtimeMs: 4,
      ctimeMs: 5
    }))).resolves.toEqual({ state: "indirect" });
    await expect(readTaskRecoveryPathStatus("/tmp/missing", async () => {
      throw Object.assign(new Error("private path missing"), { code: "ENOENT" });
    })).resolves.toEqual({ state: "missing" });
  });

  it("does not convert permission failures into missing evidence", async () => {
    await expect(readTaskRecoveryPathStatus("/private", async () => {
      throw Object.assign(new Error("token=private"), { code: "EACCES" });
    })).rejects.toThrow("token=private");
  });
});
