import fs from "node:fs";

import type { TaskRecoveryPathStatus } from "./task-recovery-stage.js";

interface RecoveryPathEntry {
  isSymbolicLink: () => boolean;
  isDirectory: () => boolean;
  isFile: () => boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

type ReadRecoveryPathEntry = (candidatePath: string) => Promise<RecoveryPathEntry>;

export async function readTaskRecoveryPathStatus(
  candidatePath: string,
  readEntry: ReadRecoveryPathEntry = (path) => fs.promises.lstat(path)
): Promise<TaskRecoveryPathStatus> {
  try {
    const entry = await readEntry(candidatePath);
    if (entry.isSymbolicLink()) return { state: "indirect" };
    if (entry.isDirectory()) return { state: "directory" };
    if (entry.isFile()) {
      return {
        state: "file",
        identity: {
          device: entry.dev,
          inode: entry.ino,
          size: entry.size,
          modifiedAtMs: entry.mtimeMs,
          changedAtMs: entry.ctimeMs
        }
      };
    }
    return { state: "indirect" };
  } catch (error) {
    if (isMissingPathError(error)) return { state: "missing" };
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
