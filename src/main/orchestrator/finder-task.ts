import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  createFinderOrganizationPlan,
  type FinderOrganizationOperation
} from "../computer-use/finder-organizer.js";
import { createDesktopSessionDiagnostics } from "../desktop-session-diagnostics.js";
import type {
  DesktopActionResult,
  DesktopExecutableAction,
  DesktopAppState,
  DesktopSessionStatus,
  FinderItemLayoutResult,
  FinderSelectionResult
} from "../computer-use/types.js";
import type { RiskDecision } from "../../shared/types.js";

const FINDER_APP_NAME = "Finder";
const FINDER_BUNDLE_ID = "com.apple.finder";
const FINDER_ORGANIZE_PREFIX = "整理 Finder 测试文件夹 ";
const FINDER_ORGANIZE_CURRENT_FOLDER = "整理 Finder 当前文件夹";
const FINDER_ORGANIZE_SELECTED_FOLDER = "整理 Finder 选中文件夹";
const FINDER_DRAG_PROBE_PREFIX = "探测 Finder 拖拽测试文件夹 ";
const FINDER_ITEM_DRAG_DROP_PREFIX = "拖放 Finder 测试文件夹 ";
const FINDER_CURRENT_FOLDER_COMMAND = "Finder current folder";
const FINDER_SELECTED_FOLDER_COMMAND = "Finder selected folder";
const FINDER_DRAG_PROBE_COMMAND = "Finder drag probe";
const FINDER_ITEM_DRAG_DROP_COMMAND = "Finder item drag/drop";
const FINDER_DRAG_PROBE_DURATION_MS = 300;
const FINDER_ITEM_DRAG_DROP_DURATION_MS = 300;
const FINDER_ITEM_DRAG_DROP_SOURCE_ITEM = "photo.png";
const FINDER_ITEM_DRAG_DROP_TARGET_ITEM = "Images";

const FINDER_ORGANIZATION_RISK: RiskDecision = {
  level: "medium",
  reason: "Finder organization moves files inside a user-approved folder.",
  requiresApproval: true
};

type FinderOrganizationTarget =
  | { kind: "absolute_path"; rootPath: string }
  | { kind: "current_finder_folder" }
  | { kind: "selected_finder_folder" }
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
      actionType: "create_folder" | "move_file" | "drag" | "item_drag_drop";
      status: "passed";
      message: string;
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
    };

export interface FinderTaskOptions {
  approved?: boolean;
  planApproved?: boolean;
  approvedPlanPreview?: FinderPlanPreview;
  desktopClient?: FinderDesktopClient;
  createScreenshotPath?: (stage: "before") => string;
}

export interface FinderPlanPreview {
  rootPath: string;
  operationCount: number;
  destructiveOperationCount: number;
  createFolders: string[];
  moveFiles: Array<{ from: string; to: string }>;
}

export interface FinderDesktopClient {
  executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult>;
  getDesktopSessionStatus?(): Promise<DesktopSessionStatus>;
  getFinderSelection?(): Promise<FinderSelectionResult>;
  getFinderItemLayout?(folderPath: string, itemNames: readonly string[]): Promise<FinderItemLayoutResult>;
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
    risk: parsed.ok ? FINDER_ORGANIZATION_RISK : blockedDecision(parsed.reason)
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

  let observation: FinderObservationOutcome | undefined;

  if (parsed.target.kind === "current_finder_folder" || parsed.target.kind === "selected_finder_folder") {
    yield {
      type: "locating_app",
      appName: FINDER_APP_NAME
    };

    const finderObservation = yield* observeFinder(options);
    if (!finderObservation.ok) {
      return;
    }
    observation = finderObservation;

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

  const entries = (await readdir(rootPath, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const plan = createFinderOrganizationPlan({
    rootPath,
    entries: entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : "file"
    }))
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

  for (const operation of plan.operations) {
    if (operation.type === "create_folder") {
      if (precreatedFolders.has(path.resolve(operation.path))) {
        continue;
      }

      await mkdir(operation.path, { recursive: true });
      yield {
        type: "action_verified",
        actionType: "create_folder",
        status: "passed",
        message: `Created folder: ${operation.path}`
      };
      continue;
    }

    if (draggedMoveSources.has(path.resolve(operation.from))) {
      continue;
    }

    if (await pathExists(operation.to)) {
      yield {
        type: "verification_failed",
        stage: "file_operation",
        reason: `Destination already exists: ${operation.to}`
      };
      return;
    }

    await rename(operation.from, operation.to);
    yield {
      type: "action_verified",
      actionType: "move_file",
      status: "passed",
      message: `Moved file: ${operation.from} -> ${operation.to}`
    };
  }

  yield {
    type: "completed",
    command: rootPath,
    summary: "Finder test folder organized."
  };
}

function needsFinderPlanConfirmation(target: FinderOrganizationTarget): boolean {
  return target.kind === "current_finder_folder" || target.kind === "selected_finder_folder";
}

function readFinderPlanConfirmationReason(target: FinderOrganizationTarget): string {
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
      }))
  };
}

function areFinderPlanPreviewsEquivalent(left: FinderPlanPreview, right: FinderPlanPreview): boolean {
  return path.resolve(left.rootPath) === path.resolve(right.rootPath)
    && left.operationCount === right.operationCount
    && left.destructiveOperationCount === right.destructiveOperationCount
    && haveSamePathSet(left.createFolders, right.createFolders)
    && haveSameMoveSet(left.moveFiles, right.moveFiles);
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

function findFinderItemDragDropMove(
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
      reason: "Finder organization requires: 整理 Finder 测试文件夹 <absolute-path>, 整理 Finder 当前文件夹, 整理 Finder 选中文件夹, 探测 Finder 拖拽测试文件夹 <absolute-path>, or 拖放 Finder 测试文件夹 <absolute-path>"
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

function resolveSemanticFinderFolder(
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
