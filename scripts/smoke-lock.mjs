import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function acquireSmokeLock({
  rootDir,
  scriptName,
  isPidRunning = defaultIsPidRunning
}) {
  const lockDir = path.join(rootDir, ".skfiy-smoke", "product-smoke.lock");

  await mkdir(path.dirname(lockDir), { recursive: true });
  await createLockDir(lockDir, isPidRunning);

  await writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({
      scriptName,
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    }, null, 2)}\n`
  );

  return {
    lockPath: lockDir,
    async release() {
      await rm(lockDir, { force: true, recursive: true });
    }
  };
}

async function createLockDir(lockDir, isPidRunning) {
  try {
    await mkdir(lockDir, { recursive: false });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      if (await canReclaimStaleLock(lockDir, isPidRunning)) {
        await rm(lockDir, { force: true, recursive: true });
        await mkdir(lockDir, { recursive: false });
        return;
      }

      throw createActiveLockError(lockDir);
    }

    throw error;
  }
}

async function canReclaimStaleLock(lockDir, isPidRunning) {
  try {
    const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
    const pid = Number(owner.pid);

    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }

    return !isPidRunning(pid);
  } catch {
    return false;
  }
}

function defaultIsPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

function createActiveLockError(lockDir) {
  return new Error(
    `Another packaged-app smoke run is already active at ${lockDir}. `
      + "Run product smokes sequentially so cleanup evidence cannot be contaminated."
  );
}
