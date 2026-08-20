import { stat } from "node:fs/promises";
import type {
  FinderCollisionPolicy,
  FinderFileResolution
} from "./finder-task.js";

export const FINDER_TASK_RESULT_SCHEMA_VERSION = 1 as const;

export type FinderTaskErrorCode =
  | "destination-exists"
  | "source-missing"
  | "source-changed"
  | "cross-device"
  | "permission-denied"
  | "rollback-incomplete"
  | "filesystem-error"
  | "verification-failed";

/**
 * How a completed operation was resolved. Mirrors FinderFileResolution for
 * move/copy outcomes and adds "create" for folder creation.
 */
export type FinderTaskResolution = Exclude<FinderFileResolution, "unresolved"> | "create";

export interface FinderTaskCompletedItem {
  operationId: string;
  operationType: "create_folder" | "move_file" | "copy_file";
  /** Source path for move/copy; absent for create_folder. */
  from?: string;
  /** Final destination path after any collision renaming. */
  to: string;
  /** The basename of `to` — the resulting name after resolution. */
  resultingName: string;
  /** How the operation was resolved: create, move, copy, skip, rename, or replace. */
  resolution: FinderTaskResolution;
}

export interface FinderTaskFailedItem {
  operationId: string;
  operationType: "create_folder" | "move_file" | "copy_file";
  from?: string;
  to: string;
  reason: string;
  errorCode: FinderTaskErrorCode;
}

export interface FinderTaskResult {
  schemaVersion: 1;
  rootPath: string;
  /** The folder where operations landed. For organize workflows this equals rootPath; for rename/copy it is the containing folder. */
  destinationPath: string;
  collisionPolicy: FinderCollisionPolicy;
  totalOperationCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  completedItems: FinderTaskCompletedItem[];
  failedItems: FinderTaskFailedItem[];
  /** Post-execution verification: destination folder exists and is a directory. */
  destinationVerified: boolean;
  /** Post-execution verification: every completed item's `to` path exists on disk. */
  resultingNamesVerified: boolean;
}

export function createEmptyFinderTaskResult(
  rootPath: string,
  destinationPath: string,
  collisionPolicy: FinderCollisionPolicy,
  totalOperationCount: number
): FinderTaskResult {
  return {
    schemaVersion: FINDER_TASK_RESULT_SCHEMA_VERSION,
    rootPath,
    destinationPath,
    collisionPolicy,
    totalOperationCount,
    completedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    completedItems: [],
    failedItems: [],
    destinationVerified: false,
    resultingNamesVerified: false
  };
}

export function recordFinderTaskCompleted(
  result: FinderTaskResult,
  item: FinderTaskCompletedItem
): FinderTaskResult {
  return {
    ...result,
    completedCount: result.completedCount + 1,
    completedItems: [...result.completedItems, item]
  };
}

export function recordFinderTaskFailed(
  result: FinderTaskResult,
  item: FinderTaskFailedItem
): FinderTaskResult {
  return {
    ...result,
    failedCount: result.failedCount + 1,
    failedItems: [...result.failedItems, item]
  };
}

/**
 * Skipped operations are recorded as completed items with resolution "skip":
 * they are not failures, but they also did not perform a mutation.
 */
export function recordFinderTaskSkipped(
  result: FinderTaskResult,
  item: Omit<FinderTaskCompletedItem, "resolution">
): FinderTaskResult {
  return {
    ...result,
    skippedCount: result.skippedCount + 1,
    completedItems: [...result.completedItems, { ...item, resolution: "skip" as const }]
  };
}

export function formatFinderTaskResultSummary(result: FinderTaskResult): string {
  if (result.failedCount === 0 && result.skippedCount === 0) {
    return `${result.completedCount} of ${result.totalOperationCount} operations completed.`;
  }

  const parts: string[] = [];
  if (result.failedCount > 0) {
    parts.push(`${result.failedCount} failed`);
  }
  if (result.skippedCount > 0) {
    parts.push(`${result.skippedCount} skipped`);
  }

  return `${result.completedCount} of ${result.totalOperationCount} operations completed, ${parts.join(", ")}.`;
}

export async function verifyFinderTaskDestination(
  result: FinderTaskResult
): Promise<FinderTaskResult> {
  try {
    const destination = await stat(result.destinationPath);
    return { ...result, destinationVerified: destination.isDirectory() };
  } catch {
    return { ...result, destinationVerified: false };
  }
}

export async function verifyFinderTaskResultingNames(
  result: FinderTaskResult
): Promise<FinderTaskResult> {
  const checks = await Promise.all(
    result.completedItems.map(async (item) => {
      try {
        await stat(item.to);
        return true;
      } catch {
        return false;
      }
    })
  );

  return { ...result, resultingNamesVerified: checks.every(Boolean) };
}
