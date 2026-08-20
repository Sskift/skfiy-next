import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyFinderTaskResult,
  formatFinderTaskResultSummary,
  recordFinderTaskCompleted,
  recordFinderTaskFailed,
  recordFinderTaskSkipped,
  verifyFinderTaskDestination,
  verifyFinderTaskResultingNames,
  type FinderTaskCompletedItem,
  type FinderTaskFailedItem
} from "./finder-task-result";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "skfiy-finder-result-"));
  tempRoots.push(rootPath);
  return rootPath;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const rootPath = tempRoots.pop();
    if (rootPath) {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
});

function completedItem(overrides: Partial<FinderTaskCompletedItem> = {}): FinderTaskCompletedItem {
  return {
    operationId: "op-1",
    operationType: "move_file",
    from: "/tmp/root/photo.png",
    to: "/tmp/root/Images/photo.png",
    resultingName: "photo.png",
    resolution: "move",
    ...overrides
  };
}

function failedItem(overrides: Partial<FinderTaskFailedItem> = {}): FinderTaskFailedItem {
  return {
    operationId: "op-2",
    operationType: "move_file",
    from: "/tmp/root/notes.pdf",
    to: "/tmp/root/Documents/notes.pdf",
    reason: "Source missing: /tmp/root/notes.pdf",
    errorCode: "source-missing",
    ...overrides
  };
}

describe("finder-task-result", () => {
  it("initializes an empty result with zeroed counts and empty arrays", () => {
    const result = createEmptyFinderTaskResult(
      "/tmp/root",
      "/tmp/root",
      "cancel",
      6
    );

    expect(result).toEqual({
      schemaVersion: 1,
      rootPath: "/tmp/root",
      destinationPath: "/tmp/root",
      collisionPolicy: "cancel",
      totalOperationCount: 6,
      completedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      completedItems: [],
      failedItems: [],
      destinationVerified: false,
      resultingNamesVerified: false
    });
  });

  it("records a completed item immutably", () => {
    const initial = createEmptyFinderTaskResult("/tmp/root", "/tmp/root", "cancel", 6);
    const item = completedItem();

    const next = recordFinderTaskCompleted(initial, item);

    expect(next.completedCount).toBe(1);
    expect(next.completedItems).toEqual([item]);
    expect(initial.completedCount).toBe(0);
    expect(initial.completedItems).toEqual([]);
  });

  it("records a failed item with its error code immutably", () => {
    const initial = createEmptyFinderTaskResult("/tmp/root", "/tmp/root", "cancel", 6);
    const item = failedItem();

    const next = recordFinderTaskFailed(initial, item);

    expect(next.failedCount).toBe(1);
    expect(next.failedItems).toEqual([item]);
    expect(initial.failedCount).toBe(0);
    expect(initial.failedItems).toEqual([]);
  });

  it("records a skipped item with resolution skip and a separate count", () => {
    const initial = createEmptyFinderTaskResult("/tmp/root", "/tmp/root", "skip", 6);

    const next = recordFinderTaskSkipped(initial, {
      operationId: "op-3",
      operationType: "move_file",
      from: "/tmp/root/photo.png",
      to: "/tmp/root/Images/photo.png",
      resultingName: "photo.png"
    });

    expect(next.skippedCount).toBe(1);
    expect(next.completedCount).toBe(0);
    expect(next.completedItems).toEqual([
      expect.objectContaining({
        operationId: "op-3",
        resolution: "skip"
      })
    ]);
  });

  it("formats an all-completed summary", () => {
    let result = createEmptyFinderTaskResult("/tmp/root", "/tmp/root", "cancel", 5);
    for (const operationId of ["op-1", "op-2", "op-3", "op-4", "op-5"]) {
      result = recordFinderTaskCompleted(result, completedItem({ operationId }));
    }

    expect(formatFinderTaskResultSummary(result)).toBe("5 of 5 operations completed.");
  });

  it("formats a partial-failure summary", () => {
    let result = createEmptyFinderTaskResult("/tmp/root", "/tmp/root", "cancel", 5);
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-1" }));
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-2" }));
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-3" }));
    result = recordFinderTaskFailed(result, failedItem({ operationId: "op-4" }));
    result = recordFinderTaskFailed(result, failedItem({ operationId: "op-5" }));

    expect(formatFinderTaskResultSummary(result)).toBe("3 of 5 operations completed, 2 failed.");
  });

  it("formats a summary with skipped operations", () => {
    let result = createEmptyFinderTaskResult("/tmp/root", "/tmp/root", "skip", 5);
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-1" }));
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-2" }));
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-3" }));
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-4" }));
    result = recordFinderTaskSkipped(result, {
      operationId: "op-5",
      operationType: "move_file",
      from: "/tmp/root/photo.png",
      to: "/tmp/root/Images/photo.png",
      resultingName: "photo.png"
    });

    expect(formatFinderTaskResultSummary(result)).toBe("4 of 5 operations completed, 1 skipped.");
  });

  it("formats a summary with both failed and skipped operations", () => {
    let result = createEmptyFinderTaskResult("/tmp/root", "/tmp/root", "skip", 5);
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-1" }));
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-2" }));
    result = recordFinderTaskCompleted(result, completedItem({ operationId: "op-3" }));
    result = recordFinderTaskFailed(result, failedItem({ operationId: "op-4" }));
    result = recordFinderTaskSkipped(result, {
      operationId: "op-5",
      operationType: "move_file",
      from: "/tmp/root/photo.png",
      to: "/tmp/root/Images/photo.png",
      resultingName: "photo.png"
    });

    expect(formatFinderTaskResultSummary(result)).toBe("3 of 5 operations completed, 1 failed, 1 skipped.");
  });

  it("verifies the destination when it is a directory", async () => {
    const rootPath = await createTempRoot();
    const result = createEmptyFinderTaskResult(rootPath, rootPath, "cancel", 1);

    await expect(verifyFinderTaskDestination(result)).resolves.toMatchObject({
      destinationVerified: true
    });
  });

  it("fails destination verification when the destination is missing", async () => {
    const rootPath = await createTempRoot();
    const missing = path.join(rootPath, "missing");
    const result = createEmptyFinderTaskResult(rootPath, missing, "cancel", 1);

    await expect(verifyFinderTaskDestination(result)).resolves.toMatchObject({
      destinationVerified: false
    });
  });

  it("fails destination verification when the destination is a file", async () => {
    const rootPath = await createTempRoot();
    const filePath = path.join(rootPath, "photo.png");
    await writeFile(filePath, "image");
    const result = createEmptyFinderTaskResult(rootPath, filePath, "cancel", 1);

    await expect(verifyFinderTaskDestination(result)).resolves.toMatchObject({
      destinationVerified: false
    });
  });

  it("verifies resulting names when every completed item exists on disk", async () => {
    const rootPath = await createTempRoot();
    const imagesPath = path.join(rootPath, "Images");
    await mkdir(imagesPath, { recursive: true });
    const photoPath = path.join(imagesPath, "photo.png");
    await writeFile(photoPath, "image");

    let result = createEmptyFinderTaskResult(rootPath, rootPath, "cancel", 1);
    result = recordFinderTaskCompleted(result, {
      operationId: "op-1",
      operationType: "move_file",
      from: path.join(rootPath, "photo.png"),
      to: photoPath,
      resultingName: "photo.png",
      resolution: "move"
    });

    await expect(verifyFinderTaskResultingNames(result)).resolves.toMatchObject({
      resultingNamesVerified: true
    });
  });

  it("fails resulting names verification when a completed item is missing on disk", async () => {
    const rootPath = await createTempRoot();
    let result = createEmptyFinderTaskResult(rootPath, rootPath, "cancel", 2);
    result = recordFinderTaskCompleted(result, {
      operationId: "op-1",
      operationType: "move_file",
      from: path.join(rootPath, "photo.png"),
      to: path.join(rootPath, "Images", "photo.png"),
      resultingName: "photo.png",
      resolution: "move"
    });

    await expect(verifyFinderTaskResultingNames(result)).resolves.toMatchObject({
      resultingNamesVerified: false
    });
  });

  it("passes resulting names verification when there are no completed items", async () => {
    const rootPath = await createTempRoot();
    const result = createEmptyFinderTaskResult(rootPath, rootPath, "cancel", 0);

    await expect(verifyFinderTaskResultingNames(result)).resolves.toMatchObject({
      resultingNamesVerified: true
    });
  });
});
