import { copyFile, mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  createFinderOrganizationPlan,
  isSafeFinderEntryName,
  type FinderEntry,
  type FinderOrganizationOperation
} from "../computer-use/finder-organizer.js";
import { createDesktopSessionDiagnostics } from "../desktop-session-diagnostics.js";
import type {
  AtomicCopyFileNoReplaceRequest,
  AtomicCopyFileNoReplaceResult,
  AtomicFileIdentity,
  AtomicMoveFileNoReplaceRequest,
  AtomicMoveFileNoReplaceResult,
  DesktopActionResult,
  DesktopExecutableAction,
  DesktopAppState,
  DesktopSessionStatus,
  FinderItemLayoutResult,
  FinderSelectionResult
} from "../computer-use/types.js";
import type { RiskDecision } from "../../shared/types.js";
import {
  createEmptyFinderTaskResult,
  formatFinderTaskResultSummary,
  recordFinderTaskCompleted,
  recordFinderTaskFailed,
  recordFinderTaskSkipped,
  verifyFinderTaskDestination,
  verifyFinderTaskResultingNames,
  type FinderTaskErrorCode,
  type FinderTaskResult
} from "./finder-task-result.js";

const FINDER_APP_NAME = "Finder";
const FINDER_BUNDLE_ID = "com.apple.finder";
const FINDER_ORGANIZE_PREFIX = "整理 Finder 测试文件夹 ";
const FINDER_ORGANIZE_CURRENT_FOLDER = "整理 Finder 当前文件夹";
const FINDER_ORGANIZE_SELECTED_FOLDER = "整理 Finder 选中文件夹";
const FINDER_ORGANIZE_SELECTED_ITEMS = "整理 Finder 选中项目";
const FINDER_RENAME_SELECTED_FILE_PREFIX = "重命名 Finder 选中文件为 ";
const FINDER_COPY_SELECTED_FILE_PREFIX = "复制 Finder 选中文件为 ";
const FINDER_DRAG_PROBE_PREFIX = "探测 Finder 拖拽测试文件夹 ";
const FINDER_ITEM_DRAG_DROP_PREFIX = "拖放 Finder 测试文件夹 ";
const FINDER_CURRENT_FOLDER_COMMAND = "Finder current folder";
const FINDER_SELECTED_FOLDER_COMMAND = "Finder selected folder";
const FINDER_SELECTED_ITEMS_COMMAND = "Finder selected items";
const FINDER_RENAME_SELECTED_FILE_COMMAND = "Finder selected file rename";
const FINDER_COPY_SELECTED_FILE_COMMAND = "Finder selected file copy";
const FINDER_DRAG_PROBE_COMMAND = "Finder drag probe";
const FINDER_ITEM_DRAG_DROP_COMMAND = "Finder item drag/drop";
const FINDER_DRAG_PROBE_DURATION_MS = 300;
const FINDER_ITEM_DRAG_DROP_DURATION_MS = 300;
const FINDER_ITEM_DRAG_DROP_SOURCE_ITEM = "photo.png";
const FINDER_ITEM_DRAG_DROP_TARGET_ITEM = "Images";

export const FINDER_ORGANIZATION_RISK: RiskDecision = {
  level: "medium",
  reason: "Finder organization moves files inside a user-approved folder.",
  requiresApproval: true
};

export type FinderOrganizationTarget =
  | { kind: "absolute_path"; rootPath: string }
  | { kind: "current_finder_folder" }
  | { kind: "selected_finder_folder" }
  | { kind: "selected_finder_items" }
  | { kind: "rename_selected_finder_file"; newName: string }
  | { kind: "copy_selected_finder_file"; newName: string }
  | { kind: "drag_probe"; rootPath: string }
  | { kind: "item_drag_drop"; rootPath: string };

type FinderObservationOutcome =
  | { ok: true; appState?: DesktopAppState; selection?: FinderSelectionResult }
  | { ok: false };

export type FinderTaskEvent =
  | {
      type: "started";
      command: string;
      risk: RiskDecision;
    }
  | {
      type: "approval_required";
      command: string;
      risk: RiskDecision;
    }
  | {
      type: "locating_app";
      appName: string;
    }
  | {
      type: "app_activated";
      appName: string;
      bundleId: string;
    }
  | {
      type: "screenshot_before";
      path: string;
      observation: DesktopAppState;
    }
  | {
      type: "finder_selection_observed";
      context: FinderSelectionResult;
    }
  | {
      type: "plan_preview";
      preview: FinderPlanPreview;
    }
  | {
      type: "plan_confirmation_required";
      command: string;
      preview: FinderPlanPreview;
      reason: string;
    }
  | {
      type: "action_verified";
      actionType: "create_folder" | "move_file" | "copy_file" | "drag" | "item_drag_drop";
      status: "passed";
      message: string;
      /** Correlates the verification with a completedItems entry in the terminal result. */
      operationId?: string;
    }
  | {
      type: "verification_failed";
      stage: "input" | "file_operation" | "desktop_session" | "activate" | "observe" | "selection" | "layout" | "drag";
      reason: string;
    }
  | {
      type: "completed";
      command: string;
      summary: string;
      result: FinderTaskResult;
    };

export interface FinderTaskOptions {
  approved?: boolean;
  planApproved?: boolean;
  approvedPlanPreview?: FinderPlanPreview;
  desktopClient?: FinderDesktopClient;
  /**
   * How to resolve destination collisions. Defaults to "cancel" (fail closed)
   * to preserve the historical hard-stop behavior. "replace" is only honored
   * when planApproved is also true.
   */
  collisionPolicy?: FinderCollisionPolicy;
  /**
   * Atomic file operations with structured error states. When absent, the
   * task falls back to node:fs copyFile/rename (test compatibility).
   */
  fileClient?: FinderFileClient;
  createScreenshotPath?: (stage: "before") => string;
}

export interface FinderPlanPreview {
  rootPath: string;
  operationCount: number;
  destructiveOperationCount: number;
  createFolders: string[];
  moveFiles: Array<{ from: string; to: string }>;
  copyFiles?: Array<{ from: string; to: string }>;
}

export type FinderCollisionPolicy = "cancel" | "skip" | "rename" | "replace";
export type FinderFileResolution = "move" | "copy" | "unresolved" | "skip" | "rename" | "replace";

export interface FinderFileIdentityBinding {
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

export type FinderExecutionPlanOperation =
  | {
      operationId: string;
      type: "create_folder";
      path: string;
    }
  | {
      operationId: string;
      type: "move_file";
      from: string;
      requestedTo: string;
      to: string;
      resolution: FinderFileResolution;
      replaceEligible: boolean;
      expectedSourceIdentity?: FinderFileIdentityBinding;
      expectedDestinationIdentity?: FinderFileIdentityBinding;
    }
  | {
      operationId: string;
      type: "copy_file";
      from: string;
      requestedTo: string;
      to: string;
      resolution: FinderFileResolution;
      replaceEligible: boolean;
      expectedSourceIdentity?: FinderFileIdentityBinding;
      expectedDestinationIdentity?: FinderFileIdentityBinding;
    };

export interface FinderExecutionPlanBinding {
  schemaVersion: 1;
  targetKind: FinderOrganizationTarget["kind"];
  rootPath: string;
  collisionPolicy: FinderCollisionPolicy;
  operations: FinderExecutionPlanOperation[];
}

export interface FinderDesktopClient {
  executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult>;
  getDesktopSessionStatus?(): Promise<DesktopSessionStatus>;
  getFinderSelection?(): Promise<FinderSelectionResult>;
  getFinderItemLayout?(folderPath: string, itemNames: readonly string[]): Promise<FinderItemLayoutResult>;
}

export interface FinderFileClient {
  atomicCopyFileNoReplace(
    request: AtomicCopyFileNoReplaceRequest
  ): Promise<AtomicCopyFileNoReplaceResult>;
  atomicMoveFileNoReplace(
    request: AtomicMoveFileNoReplaceRequest
  ): Promise<AtomicMoveFileNoReplaceResult>;
}

export async function* runFinderOrganizationTask(
  input: string,
  options: FinderTaskOptions = {}
): AsyncGenerator<FinderTaskEvent> {
  const parsed = parseFinderOrganizationIntent(input);
  const command = parsed.ok ? parsed.command : input.trim();

  yield {
    type: "started",
    command,
    risk: readFinderTaskRisk(input)
  };

  if (!parsed.ok) {
    yield {
      type: "verification_failed",
      stage: "input",
      reason: parsed.reason
    };
    return;
  }

  if (!options.approved) {
    yield {
      type: "approval_required",
      command: parsed.command,
      risk: FINDER_ORGANIZATION_RISK
    };
    return;
  }

  let rootPath: string;

  let selectedEntries: FinderEntry[] | undefined;
  let explicitOperations: Array<Extract<FinderOrganizationOperation, { type: "move_file" | "copy_file" }>> | undefined;

  let observation: FinderObservationOutcome | undefined;

  if (
    parsed.target.kind === "current_finder_folder"
    || parsed.target.kind === "selected_finder_folder"
    || parsed.target.kind === "selected_finder_items"
    || parsed.target.kind === "rename_selected_finder_file"
    || parsed.target.kind === "copy_selected_finder_file"
  ) {
    yield {
      type: "locating_app",
      appName: FINDER_APP_NAME
    };

    const finderObservation = yield* observeFinder(options);
    if (!finderObservation.ok) {
      return;
    }
    observation = finderObservation;

    if (
      parsed.target.kind === "rename_selected_finder_file"
      || parsed.target.kind === "copy_selected_finder_file"
    ) {
      const selectedFile = resolveSelectedFinderFile(finderObservation.selection);
      if (!selectedFile.ok || selectedFile.entry.name === parsed.target.newName) {
        yield {
          type: "verification_failed",
          stage: "selection",
          reason: selectedFile.ok
            ? `Finder selected-file ${parsed.target.kind === "copy_selected_finder_file" ? "copy" : "rename"} needs a different destination name.`
            : selectedFile.reason
        };
        return;
      }
      rootPath = selectedFile.rootPath;
      selectedEntries = [selectedFile.entry];
      explicitOperations = [{
        type: parsed.target.kind === "rename_selected_finder_file" ? "move_file" : "copy_file",
        from: selectedFile.path,
        to: path.join(selectedFile.rootPath, parsed.target.newName)
      }];
    } else if (parsed.target.kind === "selected_finder_items") {
      const semanticItems = resolveSelectedFinderItems(finderObservation.selection);
      if (!semanticItems.ok) {
        yield {
          type: "verification_failed",
          stage: "selection",
          reason: semanticItems.reason
        };
        return;
      }
      rootPath = semanticItems.rootPath;
      selectedEntries = semanticItems.entries;
    } else {
      const semanticFolder = resolveSemanticFinderFolder(parsed.target.kind, finderObservation.selection);
      if (!semanticFolder.ok) {
        yield {
          type: "verification_failed",
          stage: "selection",
          reason: semanticFolder.reason
        };
        return;
      }

      rootPath = semanticFolder.rootPath;
    }
  } else {
    rootPath = parsed.target.rootPath;
  }

  const rootStatus = await readDirectoryStatus(rootPath);
  if (!rootStatus.ok) {
    yield {
      type: "verification_failed",
      stage: "file_operation",
      reason: rootStatus.reason
    };
    return;
  }

  const entries = selectedEntries ?? (await readdir(rootPath, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" as const : "file" as const
    }));
  const plan = explicitOperations
    ? {
        risk: "medium" as const,
        requiresApproval: true,
        operations: explicitOperations
      }
    : createFinderOrganizationPlan({
        rootPath,
        entries
      });

  const preview = createFinderPlanPreview(rootPath, plan.operations);

  yield {
    type: "plan_preview",
    preview
  };

  if (
    needsFinderPlanConfirmation(parsed.target)
    && options.planApproved
    && options.approvedPlanPreview
    && !areFinderPlanPreviewsEquivalent(preview, options.approvedPlanPreview)
  ) {
    yield {
      type: "verification_failed",
      stage: "selection",
      reason: "Finder approved plan no longer matches the current Finder target."
    };
    return;
  }

  if (needsFinderPlanConfirmation(parsed.target) && !options.planApproved) {
    yield {
      type: "plan_confirmation_required",
      command: parsed.command,
      preview,
      reason: readFinderPlanConfirmationReason(parsed.target)
    };
    return;
  }

  if (
    parsed.target.kind === "absolute_path"
    || parsed.target.kind === "drag_probe"
    || parsed.target.kind === "item_drag_drop"
  ) {
    yield {
      type: "locating_app",
      appName: FINDER_APP_NAME
    };

    observation = yield* observeFinder(options);
    if (!observation.ok) {
      return;
    }
  }

  if (parsed.target.kind === "drag_probe") {
    yield* performFinderDragProbe(options, observation);
  }

  const precreatedFolders = new Set<string>();
  const draggedMoveSources = new Set<string>();
  if (parsed.target.kind === "item_drag_drop") {
    const itemDragDrop = yield* performFinderItemDragDrop(rootPath, plan.operations, options, observation);
    for (const folderPath of itemDragDrop.precreatedFolders) {
      precreatedFolders.add(path.resolve(folderPath));
    }
    if (!itemDragDrop.ok) {
      return;
    }
    if (itemDragDrop.ok) {
      draggedMoveSources.add(path.resolve(itemDragDrop.skippedMoveFrom));
    }
  }

  const collisionPolicy = options.collisionPolicy ?? "cancel";
  const destinationPath = explicitOperations
    ? path.dirname(explicitOperations[0].to)
    : rootPath;
  let result = createEmptyFinderTaskResult(
    rootPath,
    destinationPath,
    collisionPolicy,
    plan.operations.length
  );
  const replaceApproved = collisionPolicy === "replace" && options.planApproved === true;

  for (const [index, operation] of plan.operations.entries()) {
    const operationId = `op-${index + 1}`;

    if (operation.type === "create_folder") {
      if (precreatedFolders.has(path.resolve(operation.path))) {
        result = recordFinderTaskCompleted(result, {
          operationId,
          operationType: "create_folder",
          to: operation.path,
          resultingName: path.basename(operation.path),
          resolution: "create"
        });
        continue;
      }

      try {
        await mkdir(operation.path, { recursive: true });
      } catch (error) {
        result = recordFinderTaskFailed(result, {
          operationId,
          operationType: "create_folder",
          to: operation.path,
          reason: readErrorMessage(error),
          errorCode: "filesystem-error"
        });
        continue;
      }

      result = recordFinderTaskCompleted(result, {
        operationId,
        operationType: "create_folder",
        to: operation.path,
        resultingName: path.basename(operation.path),
        resolution: "create"
      });
      yield {
        type: "action_verified",
        actionType: "create_folder",
        status: "passed",
        message: `Created folder: ${operation.path}`,
        operationId
      };
      continue;
    }

    if (draggedMoveSources.has(path.resolve(operation.from))) {
      result = recordFinderTaskCompleted(result, {
        operationId,
        operationType: operation.type,
        from: operation.from,
        to: operation.to,
        resultingName: path.basename(operation.to),
        resolution: operation.type === "copy_file" ? "copy" : "move"
      });
      continue;
    }

    if (await pathExists(operation.to) && !replaceApproved) {
      if (collisionPolicy === "skip") {
        result = recordFinderTaskSkipped(result, {
          operationId,
          operationType: operation.type,
          from: operation.from,
          to: operation.to,
          resultingName: path.basename(operation.to)
        });
        continue;
      }

      if (collisionPolicy === "rename") {
        const renamedTo = await createRenamedDestination(operation.to);
        const outcome = await executeFinderFileOperation(operation, renamedTo, options.fileClient);
        if (!outcome.ok) {
          result = recordFinderTaskFailed(result, {
            operationId,
            operationType: operation.type,
            from: operation.from,
            to: renamedTo,
            reason: outcome.reason,
            errorCode: outcome.errorCode
          });
          continue;
        }

        result = recordFinderTaskCompleted(result, {
          operationId,
          operationType: operation.type,
          from: operation.from,
          to: renamedTo,
          resultingName: path.basename(renamedTo),
          resolution: "rename"
        });
        yield {
          type: "action_verified",
          actionType: operation.type,
          status: "passed",
          message: operation.type === "copy_file"
            ? `Copied file: ${operation.from} -> ${renamedTo}`
            : `Moved file: ${operation.from} -> ${renamedTo}`,
          operationId
        };
        continue;
      }

      // "cancel" (default) or "replace" without plan approval: fail closed and
      // stop attempting further operations.
      result = recordFinderTaskFailed(result, {
        operationId,
        operationType: operation.type,
        from: operation.from,
        to: operation.to,
        reason: `Destination already exists: ${operation.to}`,
        errorCode: "destination-exists"
      });
      break;
    }

    // The atomic no-replace client cannot honor an approved overwrite.
    const fileClient = replaceApproved ? undefined : options.fileClient;
    const outcome = await executeFinderFileOperation(operation, operation.to, fileClient);
    if (!outcome.ok) {
      result = recordFinderTaskFailed(result, {
        operationId,
        operationType: operation.type,
        from: operation.from,
        to: operation.to,
        reason: outcome.reason,
        errorCode: outcome.errorCode
      });
      continue;
    }

    result = recordFinderTaskCompleted(result, {
      operationId,
      operationType: operation.type,
      from: operation.from,
      to: operation.to,
      resultingName: path.basename(operation.to),
      resolution: replaceApproved
        ? "replace"
        : operation.type === "copy_file" ? "copy" : "move"
    });
    yield {
      type: "action_verified",
      actionType: operation.type,
      status: "passed",
      message: operation.type === "copy_file"
        ? `Copied file: ${operation.from} -> ${operation.to}`
        : `Moved file: ${operation.from} -> ${operation.to}`,
      operationId
    };
  }

  result = await verifyFinderTaskDestination(result);
  result = await verifyFinderTaskResultingNames(result);

  yield {
    type: "completed",
    command: rootPath,
    summary: formatFinderTaskResultSummary(result),
    result
  };
}

export function readFinderTaskRisk(input: string): RiskDecision {
  const parsed = parseFinderOrganizationIntent(input);
  return parsed.ok ? { ...FINDER_ORGANIZATION_RISK } : blockedDecision(parsed.reason);
}

export function requiresFinderPlanConfirmation(input: string): boolean {
  const parsed = parseFinderOrganizationIntent(input);
  return parsed.ok && needsFinderPlanConfirmation(parsed.target);
}

function needsFinderPlanConfirmation(target: FinderOrganizationTarget): boolean {
  return target.kind === "current_finder_folder"
    || target.kind === "selected_finder_folder"
    || target.kind === "selected_finder_items"
    || target.kind === "rename_selected_finder_file"
    || target.kind === "copy_selected_finder_file";
}

function readFinderPlanConfirmationReason(target: FinderOrganizationTarget): string {
  if (target.kind === "copy_selected_finder_file") {
    return "Finder selected-file copy needs confirmation after exact source and destination preview.";
  }
  if (target.kind === "rename_selected_finder_file") {
    return "Finder selected-file rename needs confirmation after exact source and destination preview.";
  }
  if (target.kind === "selected_finder_items") {
    return "Finder selected-item organization needs confirmation after exact selection preview.";
  }
  if (target.kind === "selected_finder_folder") {
    return "Finder selected-folder organization needs confirmation after plan preview.";
  }

  return "Finder current-folder organization needs confirmation after plan preview.";
}

function createFinderPlanPreview(
  rootPath: string,
  operations: FinderOrganizationOperation[]
): FinderPlanPreview {
  return {
    rootPath,
    operationCount: operations.length,
    destructiveOperationCount: operations.filter((operation) =>
      !["create_folder", "move_file"].includes(operation.type)
    ).length,
    createFolders: operations
      .filter((operation): operation is Extract<FinderOrganizationOperation, { type: "create_folder" }> =>
        operation.type === "create_folder"
      )
      .map((operation) => operation.path),
    moveFiles: operations
      .filter((operation): operation is Extract<FinderOrganizationOperation, { type: "move_file" }> =>
        operation.type === "move_file"
      )
      .map((operation) => ({
        from: operation.from,
        to: operation.to
      })),
    ...(operations.some((operation) => operation.type === "copy_file") ? {
      copyFiles: operations
        .filter((operation): operation is Extract<FinderOrganizationOperation, { type: "copy_file" }> =>
          operation.type === "copy_file"
        )
        .map((operation) => ({
          from: operation.from,
          to: operation.to
        }))
    } : {})
  };
}

export function areFinderPlanPreviewsEquivalent(left: FinderPlanPreview, right: FinderPlanPreview): boolean {
  return path.resolve(left.rootPath) === path.resolve(right.rootPath)
    && left.operationCount === right.operationCount
    && left.destructiveOperationCount === right.destructiveOperationCount
    && haveSamePathSet(left.createFolders, right.createFolders)
    && haveSameMoveSet(left.moveFiles, right.moveFiles)
    && haveSameMoveSet(left.copyFiles ?? [], right.copyFiles ?? []);
}

function haveSamePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const rightPaths = new Set(right.map((entry) => path.resolve(entry)));
  return left.every((entry) => rightPaths.has(path.resolve(entry)));
}

function haveSameMoveSet(
  left: ReadonlyArray<{ from: string; to: string }>,
  right: ReadonlyArray<{ from: string; to: string }>
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const rightMoves = new Set(right.map((move) => `${path.resolve(move.from)}\0${path.resolve(move.to)}`));
  return left.every((move) => rightMoves.has(`${path.resolve(move.from)}\0${path.resolve(move.to)}`));
}

async function* observeFinder(
  options: FinderTaskOptions
): AsyncGenerator<FinderTaskEvent, FinderObservationOutcome, unknown> {
  if (!options.desktopClient) {
    return { ok: true };
  }

  const desktopSessionFailure = await readDesktopSessionFailure(options.desktopClient);
  if (desktopSessionFailure) {
    yield {
      type: "verification_failed",
      stage: "desktop_session",
      reason: desktopSessionFailure
    };
    return { ok: false };
  }

  const activationResult = await executeFinderAction(
    options.desktopClient,
    { type: "activate_app", bundleId: FINDER_BUNDLE_ID }
  );

  if (!activationResult.ok) {
    yield {
      type: "verification_failed",
      stage: "activate",
      reason: activationResult.reason
    };
    return { ok: false };
  }

  yield {
    type: "app_activated",
    appName: FINDER_APP_NAME,
    bundleId: FINDER_BUNDLE_ID
  };

  const screenshotOutputPath = options.createScreenshotPath?.("before")
    ?? defaultFinderScreenshotPath();
  const observationResult = await executeFinderAction(
    options.desktopClient,
    {
      type: "observe_app",
      bundleId: FINDER_BUNDLE_ID,
      screenshotOutputPath
    }
  );

  if (!observationResult.ok) {
    yield {
      type: "verification_failed",
      stage: "observe",
      reason: observationResult.reason
    };
    return { ok: false };
  }

  if (!isDesktopAppState(observationResult.result)) {
    yield {
      type: "verification_failed",
      stage: "observe",
      reason: "Finder observation did not return app state."
    };
    return { ok: false };
  }

  yield {
    type: "screenshot_before",
    path: observationResult.result.screenshotPath,
    observation: observationResult.result
  };

  const selection = yield* observeFinderSelection(options.desktopClient);
  return { ok: true, appState: observationResult.result, selection };
}

async function readDesktopSessionFailure(client: FinderDesktopClient): Promise<string | undefined> {
  if (!client.getDesktopSessionStatus) {
    return undefined;
  }

  const diagnostics = createDesktopSessionDiagnostics(await client.getDesktopSessionStatus());
  return diagnostics.state === "blocked" ? diagnostics.reason : undefined;
}

async function* performFinderDragProbe(
  options: FinderTaskOptions,
  observation: FinderObservationOutcome | undefined
): AsyncGenerator<FinderTaskEvent> {
  if (!options.desktopClient) {
    yield {
      type: "verification_failed",
      stage: "drag",
      reason: "Finder drag probe requires a desktop client."
    };
    return;
  }

  if (!observation?.ok || !observation.appState) {
    yield {
      type: "verification_failed",
      stage: "drag",
      reason: "Finder drag probe needs a passed Finder observation."
    };
    return;
  }

  const dragAction = createFinderDragProbeAction(observation.appState);
  if (!dragAction.ok) {
    yield {
      type: "verification_failed",
      stage: "drag",
      reason: dragAction.reason
    };
    return;
  }

  const dragResult = await executeFinderAction(options.desktopClient, dragAction.action);
  if (!dragResult.ok) {
    yield {
      type: "verification_failed",
      stage: "drag",
      reason: dragResult.reason
    };
    return;
  }

  yield {
    type: "action_verified",
    actionType: "drag",
    status: "passed",
    message: formatFinderDragProbeMessage(dragAction.action)
  };
}

function createFinderDragProbeAction(appState: DesktopAppState):
  | { ok: true; action: Extract<DesktopExecutableAction, { type: "drag" }> }
  | { ok: false; reason: string } {
  const window = appState.windows?.find((candidate) => (
    candidate.layer === 0
    && candidate.bounds.width >= 180
    && candidate.bounds.height >= 120
  ));

  if (!window) {
    return {
      ok: false,
      reason: "Finder drag probe needs a visible Finder window at least 180x120."
    };
  }

  const { x, y, width, height } = window.bounds;
  const from = {
    x: Math.round(x + width * 0.25),
    y: Math.round(y + height * 0.5)
  };
  const to = {
    x: Math.round(x + width * 0.75),
    y: from.y
  };

  return {
    ok: true,
    action: {
      type: "drag",
      from,
      to,
      durationMs: FINDER_DRAG_PROBE_DURATION_MS
    }
  };
}

async function* performFinderItemDragDrop(
  rootPath: string,
  operations: FinderOrganizationOperation[],
  options: FinderTaskOptions,
  observation: FinderObservationOutcome | undefined
): AsyncGenerator<
  FinderTaskEvent,
  { ok: true; skippedMoveFrom: string; precreatedFolders: string[] } | { ok: false; precreatedFolders: string[] }
> {
  const move = findFinderItemDragDropMove(rootPath, operations);
  const precreatedFolders: string[] = [];

  if (!move) {
    yield {
      type: "verification_failed",
      stage: "file_operation",
      reason: "Finder item drag/drop requires a photo.png -> Images/photo.png fixture move."
    };
    return { ok: false, precreatedFolders };
  }

  await mkdir(move.targetFolderPath, { recursive: true });
  precreatedFolders.push(move.targetFolderPath);

  if (!options.desktopClient) {
    await cleanupEmptyPrecreatedFolders(precreatedFolders);
    yield {
      type: "verification_failed",
      stage: "drag",
      reason: "Finder item drag/drop requires a desktop client."
    };
    return { ok: false, precreatedFolders };
  }

  if (!observation?.ok || !observation.appState) {
    await cleanupEmptyPrecreatedFolders(precreatedFolders);
    yield {
      type: "verification_failed",
      stage: "drag",
      reason: "Finder item drag/drop needs a passed Finder observation."
    };
    return { ok: false, precreatedFolders };
  }

  if (!options.desktopClient.getFinderItemLayout) {
    await cleanupEmptyPrecreatedFolders(precreatedFolders);
    yield {
      type: "verification_failed",
      stage: "layout",
      reason: "Finder item drag/drop requires Finder item layout coordinates."
    };
    return { ok: false, precreatedFolders };
  }

  let layout: FinderItemLayoutResult;
  try {
    layout = await options.desktopClient.getFinderItemLayout(rootPath, [
      FINDER_ITEM_DRAG_DROP_SOURCE_ITEM,
      FINDER_ITEM_DRAG_DROP_TARGET_ITEM
    ]);
  } catch (error) {
    await cleanupEmptyPrecreatedFolders(precreatedFolders);
    yield {
      type: "verification_failed",
      stage: "layout",
      reason: readErrorMessage(error)
    };
    return { ok: false, precreatedFolders };
  }

  const layoutAction = createFinderItemDragDropAction(layout);
  if (!layoutAction.ok) {
    await cleanupEmptyPrecreatedFolders(precreatedFolders);
    yield {
      type: "verification_failed",
      stage: "layout",
      reason: layoutAction.reason
    };
    return { ok: false, precreatedFolders };
  }

  const dragResult = await executeFinderAction(options.desktopClient, layoutAction.action);
  if (!dragResult.ok) {
    await cleanupEmptyPrecreatedFolders(precreatedFolders);
    yield {
      type: "verification_failed",
      stage: "drag",
      reason: dragResult.reason
    };
    return { ok: false, precreatedFolders };
  }

  const moveVerified = await verifyFinderItemDragDropMove(move);
  if (!moveVerified.ok) {
    await cleanupEmptyPrecreatedFolders(precreatedFolders);
    yield {
      type: "verification_failed",
      stage: "file_operation",
      reason: moveVerified.reason
    };
    return { ok: false, precreatedFolders };
  }

  yield {
    type: "action_verified",
    actionType: "create_folder",
    status: "passed",
    message: `Created folder: ${move.targetFolderPath}`
  };

  yield {
    type: "action_verified",
    actionType: "item_drag_drop",
    status: "passed",
    message: `Dragged Finder item: ${move.from} -> ${move.to}`
  };

  return {
    ok: true,
    skippedMoveFrom: move.from,
    precreatedFolders
  };
}

async function cleanupEmptyPrecreatedFolders(folderPaths: readonly string[]): Promise<void> {
  for (const folderPath of [...folderPaths].reverse()) {
    try {
      await rmdir(folderPath);
    } catch {
      // If Finder or the user placed anything there, leave it intact.
    }
  }
}

export function findFinderItemDragDropMove(
  rootPath: string,
  operations: FinderOrganizationOperation[]
):
  | { from: string; to: string; targetFolderPath: string }
  | undefined {
  const expectedFrom = path.resolve(rootPath, FINDER_ITEM_DRAG_DROP_SOURCE_ITEM);
  const expectedTo = path.resolve(
    rootPath,
    FINDER_ITEM_DRAG_DROP_TARGET_ITEM,
    FINDER_ITEM_DRAG_DROP_SOURCE_ITEM
  );

  return operations
    .filter((operation): operation is Extract<FinderOrganizationOperation, { type: "move_file" }> => (
      operation.type === "move_file"
    ))
    .map((operation) => ({
      from: operation.from,
      to: operation.to,
      targetFolderPath: path.dirname(operation.to)
    }))
    .find((operation) => (
      path.resolve(operation.from) === expectedFrom
      && path.resolve(operation.to) === expectedTo
    ));
}

function createFinderItemDragDropAction(layout: FinderItemLayoutResult):
  | { ok: true; action: Extract<DesktopExecutableAction, { type: "drag" }> }
  | { ok: false; reason: string } {
  const source = layout.items.find((item) => (
    item.name === FINDER_ITEM_DRAG_DROP_SOURCE_ITEM
    && item.kind === "file"
  ));
  const target = layout.items.find((item) => (
    item.name === FINDER_ITEM_DRAG_DROP_TARGET_ITEM
    && item.kind === "directory"
  ));

  if (!source) {
    return {
      ok: false,
      reason: `Finder item layout did not include ${FINDER_ITEM_DRAG_DROP_SOURCE_ITEM}.`
    };
  }

  if (!target) {
    return {
      ok: false,
      reason: `Finder item layout did not include ${FINDER_ITEM_DRAG_DROP_TARGET_ITEM}.`
    };
  }

  return {
    ok: true,
    action: {
      type: "drag",
      from: source.center,
      to: target.center,
      durationMs: FINDER_ITEM_DRAG_DROP_DURATION_MS
    }
  };
}

async function verifyFinderItemDragDropMove(
  move: { from: string; to: string }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!await pathExists(move.to)) {
    return {
      ok: false,
      reason: `Finder item drag/drop did not create destination: ${move.to}`
    };
  }

  if (await pathExists(move.from)) {
    return {
      ok: false,
      reason: `Finder item drag/drop left source in place: ${move.from}`
    };
  }

  return { ok: true };
}

function formatFinderDragProbeMessage(
  action: Extract<DesktopExecutableAction, { type: "drag" }>
): string {
  return `Finder drag probe from ${action.from.x},${action.from.y} to ${action.to.x},${action.to.y} over ${action.durationMs ?? FINDER_DRAG_PROBE_DURATION_MS}ms.`;
}

async function* observeFinderSelection(
  desktopClient: FinderDesktopClient
): AsyncGenerator<FinderTaskEvent, FinderSelectionResult | undefined> {
  if (!desktopClient.getFinderSelection) {
    return undefined;
  }

  try {
    const context = await desktopClient.getFinderSelection();
    yield {
      type: "finder_selection_observed",
      context
    };
    return context;
  } catch (error) {
    yield {
      type: "verification_failed",
      stage: "selection",
      reason: readErrorMessage(error)
    };
    return undefined;
  }
}

async function executeFinderAction(
  desktopClient: FinderDesktopClient,
  action: DesktopExecutableAction
): Promise<
  | { ok: true; result: DesktopActionResult }
  | { ok: false; reason: string }
> {
  try {
    const result = await desktopClient.executeAction(action);

    if (isFailedActionResult(result)) {
      return {
        ok: false,
        reason: result.message ?? `Desktop helper could not ${action.type}.`
      };
    }

    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      reason: readErrorMessage(error)
    };
  }
}

function isFailedActionResult(result: DesktopActionResult): result is { ok: false; message?: string } {
  return "ok" in result && result.ok === false;
}

function isDesktopAppState(result: DesktopActionResult): result is DesktopAppState {
  return "bundleId" in result
    && "isRunning" in result
    && "isActive" in result
    && "screenshotPath" in result;
}

function defaultFinderScreenshotPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join("/tmp", "skfiy", `finder-before-${timestamp}.png`);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Finder desktop observation failed.";
}

export function parseFinderOrganizationIntent(input: string):
  | { ok: true; command: string; target: FinderOrganizationTarget }
  | { ok: false; reason: string } {
  const trimmed = input.trim();

  if (trimmed === FINDER_ORGANIZE_CURRENT_FOLDER) {
    return {
      ok: true,
      command: FINDER_CURRENT_FOLDER_COMMAND,
      target: { kind: "current_finder_folder" }
    };
  }

  if (trimmed === FINDER_ORGANIZE_SELECTED_FOLDER) {
    return {
      ok: true,
      command: FINDER_SELECTED_FOLDER_COMMAND,
      target: { kind: "selected_finder_folder" }
    };
  }

  if (trimmed === FINDER_ORGANIZE_SELECTED_ITEMS) {
    return {
      ok: true,
      command: FINDER_SELECTED_ITEMS_COMMAND,
      target: { kind: "selected_finder_items" }
    };
  }

  if (trimmed.startsWith(FINDER_RENAME_SELECTED_FILE_PREFIX)) {
    const newName = trimmed.slice(FINDER_RENAME_SELECTED_FILE_PREFIX.length).trim();
    if (!isSafeFinderEntryName(newName)) {
      return {
        ok: false,
        reason: "Finder selected-file rename requires one safe destination file name."
      };
    }
    return {
      ok: true,
      command: FINDER_RENAME_SELECTED_FILE_COMMAND,
      target: { kind: "rename_selected_finder_file", newName }
    };
  }

  if (trimmed.startsWith(FINDER_COPY_SELECTED_FILE_PREFIX)) {
    const newName = trimmed.slice(FINDER_COPY_SELECTED_FILE_PREFIX.length).trim();
    if (!isSafeFinderEntryName(newName)) {
      return {
        ok: false,
        reason: "Finder selected-file copy requires one safe destination file name."
      };
    }
    return {
      ok: true,
      command: FINDER_COPY_SELECTED_FILE_COMMAND,
      target: { kind: "copy_selected_finder_file", newName }
    };
  }

  if (trimmed.startsWith(FINDER_DRAG_PROBE_PREFIX)) {
    const rootPath = trimmed.slice(FINDER_DRAG_PROBE_PREFIX.length).trim();
    if (!path.isAbsolute(rootPath)) {
      return {
        ok: false,
        reason: "Finder drag probe requires an absolute folder path."
      };
    }

    return {
      ok: true,
      command: FINDER_DRAG_PROBE_COMMAND,
      target: {
        kind: "drag_probe",
        rootPath: path.resolve(rootPath)
      }
    };
  }

  if (trimmed.startsWith(FINDER_ITEM_DRAG_DROP_PREFIX)) {
    const rootPath = trimmed.slice(FINDER_ITEM_DRAG_DROP_PREFIX.length).trim();
    if (!path.isAbsolute(rootPath)) {
      return {
        ok: false,
        reason: "Finder item drag/drop requires an absolute folder path."
      };
    }

    return {
      ok: true,
      command: FINDER_ITEM_DRAG_DROP_COMMAND,
      target: {
        kind: "item_drag_drop",
        rootPath: path.resolve(rootPath)
      }
    };
  }

  if (!trimmed.startsWith(FINDER_ORGANIZE_PREFIX)) {
    return {
      ok: false,
      reason: "Finder organization requires a supported folder, selected-item, selected-file rename, or drag workflow."
    };
  }

  const rootPath = trimmed.slice(FINDER_ORGANIZE_PREFIX.length).trim();
  if (!path.isAbsolute(rootPath)) {
    return {
      ok: false,
      reason: "Finder organization requires an absolute folder path."
    };
  }

  return {
    ok: true,
    command: path.resolve(rootPath),
    target: {
      kind: "absolute_path",
      rootPath: path.resolve(rootPath)
    }
  };
}

export function resolveSemanticFinderFolder(
  kind: "current_finder_folder" | "selected_finder_folder",
  selection: FinderSelectionResult | undefined
):
  | { ok: true; rootPath: string }
  | { ok: false; reason: string } {
  if (kind === "current_finder_folder") {
    return resolveCurrentFinderFolder(selection);
  }

  return resolveSelectedFinderFolder(selection);
}

export function resolveSelectedFinderItems(
  selection: FinderSelectionResult | undefined
):
  | { ok: true; rootPath: string; entries: FinderEntry[] }
  | { ok: false; reason: string } {
  if (!selection?.targetPath || !path.isAbsolute(selection.targetPath)) {
    return {
      ok: false,
      reason: "Finder selected-item organization needs a current Finder folder."
    };
  }
  const rootPath = path.resolve(selection.targetPath);
  if (selection.selection.length === 0) {
    return {
      ok: false,
      reason: "Finder selected-item organization needs at least one selected file."
    };
  }
  const selectedPaths = new Set<string>();
  const entries: FinderEntry[] = [];
  for (const item of selection.selection) {
    if (item.kind !== "file" || !path.isAbsolute(item.path)) {
      return {
        ok: false,
        reason: "Finder selected-item organization accepts only direct files in the current Finder folder."
      };
    }
    const itemPath = path.resolve(item.path);
    if (
      path.dirname(itemPath) !== rootPath
      || path.basename(itemPath) !== item.name
      || selectedPaths.has(itemPath)
    ) {
      return {
        ok: false,
        reason: "Finder selected-item organization could not bind every selected file to the current Finder folder."
      };
    }
    selectedPaths.add(itemPath);
    entries.push({ name: item.name, kind: "file" });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return { ok: true, rootPath, entries };
}

export function resolveSelectedFinderFile(
  selection: FinderSelectionResult | undefined
):
  | { ok: true; rootPath: string; path: string; entry: FinderEntry }
  | { ok: false; reason: string } {
  const resolved = resolveSelectedFinderItems(selection);
  if (!resolved.ok) return resolved;
  if (resolved.entries.length !== 1 || !selection) {
    return {
      ok: false,
      reason: "Finder selected-file rename needs exactly one selected direct file."
    };
  }
  const [entry] = resolved.entries;
  return {
    ok: true,
    rootPath: resolved.rootPath,
    path: path.join(resolved.rootPath, entry.name),
    entry
  };
}

function resolveSelectedFinderFolder(selection: FinderSelectionResult | undefined):
  | { ok: true; rootPath: string }
  | { ok: false; reason: string } {
  const selectedFolders = selection?.selection
    .filter((item) => item.kind === "directory" && path.isAbsolute(item.path))
    ?? [];

  if (selectedFolders.length === 1) {
    return {
      ok: true,
      rootPath: path.resolve(selectedFolders[0].path)
    };
  }

  return {
    ok: false,
    reason: "Finder selected-folder organization needs exactly one selected folder."
  };
}

function resolveCurrentFinderFolder(selection: FinderSelectionResult | undefined):
  | { ok: true; rootPath: string }
  | { ok: false; reason: string } {
  if (selection?.targetPath && path.isAbsolute(selection.targetPath)) {
    return {
      ok: true,
      rootPath: path.resolve(selection.targetPath)
    };
  }

  const selectedFolder = resolveSelectedFinderFolder(selection);

  if (selectedFolder.ok) {
    return selectedFolder;
  }

  return {
    ok: false,
    reason: "Finder current-folder organization needs a Finder window target path or one selected folder."
  };
}

function blockedDecision(reason: string): RiskDecision {
  return {
    level: "blocked",
    reason,
    requiresApproval: true
  };
}

async function readDirectoryStatus(rootPath: string): Promise<
  | { ok: true }
  | { ok: false; reason: string }
> {
  try {
    const root = await stat(rootPath);
    return root.isDirectory()
      ? { ok: true }
      : { ok: false, reason: `Finder organization root is not a directory: ${rootPath}` };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error
        ? error.message
        : `Finder organization root is unavailable: ${rootPath}`
    };
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

type FinderFileOperation = Extract<FinderOrganizationOperation, { type: "move_file" | "copy_file" }>;

interface FinderFileOperationOutcome {
  ok: boolean;
  errorCode: FinderTaskErrorCode;
  reason: string;
}

async function executeFinderFileOperation(
  operation: FinderFileOperation,
  destinationPath: string,
  fileClient: FinderFileClient | undefined
): Promise<FinderFileOperationOutcome> {
  if (fileClient) {
    const identity = await readAtomicFileIdentity(operation.from);
    if (!identity.ok) {
      return identity.outcome;
    }

    try {
      if (operation.type === "copy_file") {
        const result = await fileClient.atomicCopyFileNoReplace({
          sourcePath: operation.from,
          destinationPath,
          expectedSourceIdentity: identity.identity
        });
        return readAtomicCopyOutcome(result.state);
      }

      const result = await fileClient.atomicMoveFileNoReplace({
        sourcePath: operation.from,
        destinationPath,
        expectedSourceIdentity: identity.identity
      });
      return readAtomicMoveOutcome(result.state);
    } catch (error) {
      return mapFinderFilesystemError(error);
    }
  }

  try {
    if (operation.type === "copy_file") {
      await copyFile(operation.from, destinationPath);
    } else {
      await rename(operation.from, destinationPath);
    }
    return { ok: true, errorCode: "filesystem-error", reason: "" };
  } catch (error) {
    return mapFinderFilesystemError(error);
  }
}

async function readAtomicFileIdentity(
  sourcePath: string
): Promise<
  | { ok: true; identity: AtomicFileIdentity }
  | { ok: false; outcome: FinderFileOperationOutcome }
> {
  try {
    const source = await stat(sourcePath);
    return {
      ok: true,
      identity: {
        device: source.dev,
        inode: source.ino,
        size: source.size,
        modifiedAtMs: source.mtimeMs,
        changedAtMs: source.ctimeMs
      }
    };
  } catch (error) {
    return { ok: false, outcome: mapFinderFilesystemError(error) };
  }
}

function readAtomicMoveOutcome(
  state: AtomicMoveFileNoReplaceResult["state"]
): FinderFileOperationOutcome {
  switch (state) {
    case "moved":
      return { ok: true, errorCode: "filesystem-error", reason: "" };
    case "destination-exists":
      return {
        ok: false,
        errorCode: "destination-exists",
        reason: "Destination already exists."
      };
    case "source-missing":
      return {
        ok: false,
        errorCode: "source-missing",
        reason: "Source file no longer exists."
      };
    case "source-changed":
      return {
        ok: false,
        errorCode: "source-changed",
        reason: "Source file changed between planning and execution."
      };
    case "cross-device":
      return {
        ok: false,
        errorCode: "cross-device",
        reason: "Source and destination are on different filesystems."
      };
    case "permission-denied":
      return {
        ok: false,
        errorCode: "permission-denied",
        reason: "Filesystem permission denied the move."
      };
    case "rollback-incomplete":
      return {
        ok: false,
        errorCode: "rollback-incomplete",
        reason: "Move failed and rollback could not restore the source."
      };
    case "filesystem-error":
      return {
        ok: false,
        errorCode: "filesystem-error",
        reason: "Filesystem error during atomic move."
      };
  }
}

function readAtomicCopyOutcome(
  state: AtomicCopyFileNoReplaceResult["state"]
): FinderFileOperationOutcome {
  switch (state) {
    case "copied":
      return { ok: true, errorCode: "filesystem-error", reason: "" };
    case "destination-exists":
      return {
        ok: false,
        errorCode: "destination-exists",
        reason: "Destination already exists."
      };
    case "source-missing":
      return {
        ok: false,
        errorCode: "source-missing",
        reason: "Source file no longer exists."
      };
    case "source-changed":
      return {
        ok: false,
        errorCode: "source-changed",
        reason: "Source file changed between planning and execution."
      };
    case "permission-denied":
      return {
        ok: false,
        errorCode: "permission-denied",
        reason: "Filesystem permission denied the copy."
      };
    case "cleanup-incomplete":
      return {
        ok: false,
        errorCode: "rollback-incomplete",
        reason: "Copy failed and cleanup could not remove the partial destination."
      };
    case "filesystem-error":
      return {
        ok: false,
        errorCode: "filesystem-error",
        reason: "Filesystem error during atomic copy."
      };
  }
}

function mapFinderFilesystemError(error: unknown): FinderFileOperationOutcome {
  const code = (error as NodeJS.ErrnoException).code;
  const reason = error instanceof Error
    ? error.message
    : "Finder file operation failed.";

  switch (code) {
    case "ENOENT":
      return { ok: false, errorCode: "source-missing", reason };
    case "EEXIST":
      return { ok: false, errorCode: "destination-exists", reason };
    case "EXDEV":
      return { ok: false, errorCode: "cross-device", reason };
    case "EACCES":
    case "EPERM":
      return { ok: false, errorCode: "permission-denied", reason };
    default:
      return { ok: false, errorCode: "filesystem-error", reason };
  }
}

async function createRenamedDestination(destinationPath: string): Promise<string> {
  const directory = path.dirname(destinationPath);
  const extension = path.extname(destinationPath);
  const baseName = path.basename(destinationPath, extension);
  let counter = 1;

  for (;;) {
    const candidate = path.join(directory, `${baseName} (${counter})${extension}`);
    if (!await pathExists(candidate)) {
      return candidate;
    }
    counter += 1;
  }
}
