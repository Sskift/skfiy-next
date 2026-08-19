import { execFile } from "node:child_process";
import type {
  DesktopActionResult,
  DesktopAppInfo,
  DesktopAppState,
  DesktopSessionStatus,
  DesktopExecutableAction,
  FinderSelectionItem,
  FinderSelectionItemKind,
  FinderSelectionResult,
  DesktopHelperActionResult,
  DesktopHelperClientOptions,
  DesktopHelperProcessResult,
  DesktopPoint,
  DesktopWindowInfo,
  FinderItemLayoutItem,
  FinderItemLayoutResult,
  OpenGhosttySessionResult,
  OcrImageResult,
  OcrLabelObservation,
  PermissionSettingsTarget,
  PermissionState,
  PermissionSummary,
  ProcessRunner,
  ProcessRunnerOptions,
  ScreenshotResult
} from "./types.js";

const DEFAULT_HELPER_PATH = "dist/skfiy-helper";

interface ListAppsResponse {
  apps: DesktopAppInfo[];
}

export class DesktopHelperClient {
  private readonly helperPath: string;
  private readonly runner: ProcessRunner;

  constructor(options: DesktopHelperClientOptions = {}) {
    this.helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
    this.runner = options.runner ?? runProcess;
  }

  async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
    if (!isRecord(action)) {
      throw new Error("Desktop action must be a JSON object.");
    }

    if (typeof action.type !== "string" || action.type.length === 0) {
      throw new Error("Desktop action type must be a non-empty string.");
    }

    switch (action.type) {
      case "activate_app":
        return this.activateApp(action.bundleId, action.pid);
      case "screenshot":
        return this.screenshot(action.outputPath);
      case "click":
        return this.click(action.x, action.y);
      case "drag":
        return this.drag(action.from, action.to, action.durationMs);
      case "scroll":
        return this.scroll(action.deltaX, action.deltaY);
      case "type_text":
        return this.typeText(action.text);
      case "press_key":
        return this.pressKey(action.key);
      case "hotkey":
        return this.pressShortcut(action.key, action.modifiers);
      case "open_ghostty_session":
        return this.openGhosttySession(action.title, action.workingDirectory);
      case "observe_app":
        return this.getAppState(action.bundleId, action.screenshotOutputPath, action.pid);
      default: {
        const unsupportedAction = action as { type: string };
        throw new Error(`Unsupported desktop action type: ${unsupportedAction.type}`);
      }
    }
  }

  async listApps(): Promise<DesktopAppInfo[]> {
    const response = await this.runJson("list-apps", ["list-apps"], readListAppsResponse);
    return response.apps;
  }

  async getDesktopSessionStatus(): Promise<DesktopSessionStatus> {
    return this.runJson(
      "desktop-session-status",
      ["desktop-session-status"],
      readDesktopSessionStatus
    );
  }

  async activateApp(bundleId: string, pid?: number): Promise<DesktopHelperActionResult> {
    const checkedBundleId = requireNonEmptyString(bundleId, "bundleId");
    const args = ["activate-app", "--bundle-id", checkedBundleId];
    appendOptionalPid(args, pid);

    return this.runJson(
      "activate-app",
      args,
      readActionResult
    );
  }

  async screenshot(outputPath: string): Promise<ScreenshotResult> {
    const checkedOutputPath = requireNonEmptyString(outputPath, "outputPath");
    return this.runJson(
      "screenshot",
      ["screenshot", "--output", checkedOutputPath],
      readScreenshotResult
    );
  }

  async ocrImage(inputPath: string): Promise<OcrImageResult> {
    const checkedInputPath = requireNonEmptyString(inputPath, "inputPath");
    return this.runJson(
      "ocr-image",
      ["ocr-image", "--input", checkedInputPath],
      readOcrImageResult
    );
  }

  async getFinderSelection(): Promise<FinderSelectionResult> {
    return this.runJson(
      "get-finder-selection",
      ["get-finder-selection"],
      readFinderSelectionResult
    );
  }

  async getFinderItemLayout(
    folderPath: string,
    itemNames: readonly string[]
  ): Promise<FinderItemLayoutResult> {
    const checkedFolderPath = requireNonEmptyString(folderPath, "folderPath");
    const checkedItemNames = requireFinderItemNames(itemNames);
    return this.runJson(
      "get-finder-item-layout",
      [
        "get-finder-item-layout",
        "--folder",
        checkedFolderPath,
        "--items",
        checkedItemNames.join(",")
      ],
      readFinderItemLayoutResult
    );
  }

  async click(x: number, y: number): Promise<DesktopHelperActionResult> {
    const checkedX = requireFiniteNumber(x, "x");
    const checkedY = requireFiniteNumber(y, "y");
    return this.runJson(
      "click",
      ["click", "--x", String(checkedX), "--y", String(checkedY)],
      readActionResult
    );
  }

  async drag(
    from: DesktopPoint,
    to: DesktopPoint,
    durationMs?: number
  ): Promise<DesktopHelperActionResult> {
    const checkedFrom = requirePoint(from, "from");
    const checkedTo = requirePoint(to, "to");
    const args = [
      "drag",
      "--from-x",
      String(checkedFrom.x),
      "--from-y",
      String(checkedFrom.y),
      "--to-x",
      String(checkedTo.x),
      "--to-y",
      String(checkedTo.y)
    ];

    if (durationMs !== undefined) {
      args.push("--duration-ms", String(requireFiniteNumber(durationMs, "durationMs")));
    }

    return this.runJson("drag", args, readActionResult);
  }

  async scroll(deltaX: number, deltaY: number): Promise<DesktopHelperActionResult> {
    const checkedDeltaX = requireFiniteNumber(deltaX, "deltaX");
    const checkedDeltaY = requireFiniteNumber(deltaY, "deltaY");
    return this.runJson(
      "scroll",
      ["scroll", "--delta-x", String(checkedDeltaX), "--delta-y", String(checkedDeltaY)],
      readActionResult
    );
  }

  async typeText(text: string): Promise<DesktopHelperActionResult> {
    const checkedText = requireNonEmptyString(text, "text");
    return this.runJson("type-text", ["type-text", "--text", checkedText], readActionResult);
  }

  async pressKey(key: string): Promise<DesktopHelperActionResult> {
    const checkedKey = requireNonEmptyString(key, "key");
    return this.runJson("press-key", ["press-key", "--key", checkedKey], readActionResult);
  }

  async pressShortcut(
    key: string,
    modifiers: readonly string[]
  ): Promise<DesktopHelperActionResult> {
    const checkedKey = requireNonEmptyString(key, "key");
    const checkedModifiers = requireNonEmptyStringArray(modifiers, "modifiers", "modifier");

    return this.runJson(
      "press-shortcut",
      ["press-shortcut", "--key", checkedKey, "--modifiers", checkedModifiers.join(",")],
      readActionResult
    );
  }

  async openGhosttySession(
    title: string,
    workingDirectory?: string
  ): Promise<OpenGhosttySessionResult> {
    const checkedTitle = requireNonEmptyString(title, "title");
    const args = ["open-ghostty-session", "--title", checkedTitle];

    if (workingDirectory !== undefined) {
      args.push("--working-directory", requireNonEmptyString(workingDirectory, "workingDirectory"));
    }

    return this.runJson("open-ghostty-session", args, readOpenGhosttySessionResult);
  }

  async selectInputSource(sourceId: string): Promise<DesktopHelperActionResult> {
    const checkedSourceId = requireNonEmptyString(sourceId, "sourceId");
    return this.runJson(
      "select-input-source",
      ["select-input-source", "--source-id", checkedSourceId],
      readActionResult
    );
  }

  async doubleTapFunctionKey(): Promise<DesktopHelperActionResult> {
    return this.runJson("double-tap-fn", ["double-tap-fn"], readActionResult);
  }

  async getAppState(
    bundleId: string,
    screenshotOutputPath: string,
    pid?: number
  ): Promise<DesktopAppState> {
    const checkedBundleId = requireNonEmptyString(bundleId, "bundleId");
    const checkedScreenshotOutputPath = requireNonEmptyString(
      screenshotOutputPath,
      "screenshotOutputPath"
    );
    const args = [
      "get-app-state",
      "--bundle-id",
      checkedBundleId
    ];
    appendOptionalPid(args, pid);
    args.push("--screenshot-output", checkedScreenshotOutputPath);

    return this.runJson(
      "get-app-state",
      args,
      readAppState
    );
  }

  async getPermissions(): Promise<PermissionSummary> {
    return this.runJson("permissions-status", ["permissions-status"], readPermissionSummary);
  }

  async openPermissionSettings(
    permission: PermissionSettingsTarget
  ): Promise<DesktopHelperActionResult> {
    const checkedPermission = requirePermissionSettingsTarget(permission);
    return this.runJson(
      "open-permission-settings",
      ["open-permission-settings", "--permission", checkedPermission],
      readActionResult
    );
  }

  private async runJson<T>(
    commandName: string,
    args: readonly string[],
    readResponse: (payload: unknown, commandName: string) => T,
    options?: ProcessRunnerOptions
  ): Promise<T> {
    const result = await this.runner(this.helperPath, args, options);

    if (result.exitCode !== 0) {
      const detail = readFailureDetail(commandName, result);
      throw new Error(
        `Desktop helper command failed (${commandName}) with exit code ${result.exitCode}: ${detail}`
      );
    }

    const payload = unwrapHelperPayload(parseJson(commandName, result.stdout), commandName);
    return readResponse(payload, commandName);
  }
}

export const runProcess: ProcessRunner = (
  command,
  args,
  options
): Promise<DesktopHelperProcessResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", signal: options?.signal },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode: readExitCode(error)
        });
      }
    );
  });

function readExitCode(error: unknown): number {
  if (!error) {
    return 0;
  }

  if (isRecord(error) && typeof error.code === "number") {
    return error.code;
  }

  return 1;
}

function parseJson(commandName: string, stdout: string): unknown {
  const text = stdout.trim();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Desktop helper returned invalid JSON for ${commandName}: ${text || "(empty stdout)"}`);
  }
}

function readFailureDetail(commandName: string, result: DesktopHelperProcessResult): string {
  const stderr = result.stderr.trim();
  if (stderr) {
    return stderr;
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    if (commandName === "screenshot" || commandName === "get-app-state") {
      return "Screen Recording permission is required for skfiy. Grant it in System Settings > Privacy & Security > Screen Recording, then try again.";
    }

    return "No error output.";
  }

  const payload = tryParseJson(stdout);
  const helperMessage = payload === undefined ? undefined : readHelperErrorMessage(payload, commandName);
  return helperMessage ?? stdout;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function unwrapHelperPayload(payload: unknown, commandName: string): unknown {
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    return payload;
  }

  const isEnvelope =
    "data" in payload || "error" in payload || typeof payload.command === "string";
  if (!isEnvelope) {
    return payload;
  }

  if (!payload.ok) {
    throw new Error(readHelperErrorMessage(payload, commandName) ?? `Helper reported ${commandName} failed.`);
  }

  if (!("data" in payload)) {
    throw invalidShape(commandName, "expected data in a successful helper envelope");
  }

  return payload.data;
}

function readHelperErrorMessage(payload: unknown, commandName: string): string | undefined {
  const record = readRecord(payload, commandName);
  const error = record.error;

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  if (typeof record.message === "string") {
    return record.message;
  }

  return undefined;
}

function readListAppsResponse(payload: unknown, commandName: string): ListAppsResponse {
  const record = readRecord(payload, commandName);
  const apps = record.apps;

  if (!Array.isArray(apps)) {
    throw invalidShape(commandName, "expected an apps array");
  }

  return { apps: apps.map((app) => readAppInfo(app, commandName)) };
}

function readDesktopSessionStatus(
  payload: unknown,
  commandName: string
): DesktopSessionStatus {
  const record = readRecord(payload, commandName);
  const status: DesktopSessionStatus = {
    controllable: readBoolean(record, "controllable", commandName)
  };
  const frontmostBundleId = readOptionalString(record, "frontmostBundleId", commandName);
  const frontmostLocalizedName = readOptionalString(record, "frontmostLocalizedName", commandName);
  const frontmostProcessIdentifier = readOptionalNumber(
    record,
    "frontmostProcessIdentifier",
    commandName
  );
  const mainDisplayAsleep = readOptionalBoolean(record, "mainDisplayAsleep", commandName);

  if (frontmostBundleId !== undefined) {
    status.frontmostBundleId = frontmostBundleId;
  }

  if (frontmostLocalizedName !== undefined) {
    status.frontmostLocalizedName = frontmostLocalizedName;
  }

  if (frontmostProcessIdentifier !== undefined) {
    status.frontmostProcessIdentifier = frontmostProcessIdentifier;
  }

  if (mainDisplayAsleep !== undefined) {
    status.mainDisplayAsleep = mainDisplayAsleep;
  }

  return status;
}

function readAppInfo(payload: unknown, commandName: string): DesktopAppInfo {
  const record = readRecord(payload, commandName);
  const bundleId = readString(record, "bundleId", commandName);
  const name = readOptionalString(record, "name", commandName)
    ?? readOptionalString(record, "localizedName", commandName)
    ?? bundleId;
  const pid = record.pid ?? record.processIdentifier;

  if (pid !== undefined && typeof pid !== "number") {
    throw invalidShape(commandName, "expected pid/processIdentifier to be a number when provided");
  }

  return pid === undefined ? { bundleId, name } : { bundleId, name, pid };
}

function readScreenshotResult(payload: unknown, commandName: string): ScreenshotResult {
  const record = readRecord(payload, commandName);
  return {
    outputPath:
      readOptionalString(record, "outputPath", commandName)
      ?? readString(record, "output", commandName)
  };
}

function readOcrImageResult(payload: unknown, commandName: string): OcrImageResult {
  const record = readRecord(payload, commandName);
  const labels = record.labels;

  if (!Array.isArray(labels)) {
    throw invalidShape(commandName, "expected labels to be an array");
  }

  return {
    labels: labels.map((label) => readOcrLabelObservation(label, commandName))
  };
}

function readOcrLabelObservation(payload: unknown, commandName: string): OcrLabelObservation {
  const record = readRecord(payload, commandName);
  const bounds = readRecord(record.bounds, commandName);

  return {
    text: readString(record, "text", commandName),
    confidence: readNumber(record, "confidence", commandName),
    bounds: {
      x: readNumber(bounds, "x", commandName),
      y: readNumber(bounds, "y", commandName),
      width: readNumber(bounds, "width", commandName),
      height: readNumber(bounds, "height", commandName)
    }
  };
}

function readActionResult(payload: unknown, commandName: string): DesktopHelperActionResult {
  const record = readRecord(payload, commandName);
  const message = readOptionalString(record, "message", commandName);

  if (typeof record.ok === "boolean") {
    return message === undefined ? { ok: record.ok } : { ok: record.ok, message };
  }

  if (typeof record.activated === "boolean") {
    const activationMessage = message ?? readActivationMessage(record);
    return activationMessage === undefined
      ? { ok: record.activated }
      : { ok: record.activated, message: activationMessage };
  }

  if (typeof record.opened === "boolean") {
    return message === undefined ? { ok: record.opened } : { ok: record.opened, message };
  }

  return message === undefined ? { ok: true } : { ok: true, message };
}

function readActivationMessage(record: Record<string, unknown>): string | undefined {
  if (record.activated !== false) {
    return undefined;
  }

  const frontmostBundleId = typeof record.frontmostBundleId === "string"
    ? record.frontmostBundleId
    : undefined;
  const requestedActivation = typeof record.requestedActivation === "boolean"
    ? record.requestedActivation
    : undefined;

  if (frontmostBundleId === "com.apple.loginwindow") {
    return "Desktop session is not controllable because loginwindow is frontmost. Unlock the Mac and keep the display awake, then try again.";
  }

  if (frontmostBundleId && frontmostBundleId.length > 0) {
    const frontmostProcessIdentifier = typeof record.frontmostProcessIdentifier === "number"
      ? record.frontmostProcessIdentifier
      : undefined;
    const processLabel = frontmostProcessIdentifier === undefined
      ? ""
      : ` (pid ${frontmostProcessIdentifier})`;
    return `Target app did not become frontmost; current frontmost app is ${frontmostBundleId}${processLabel}.`;
  }

  if (requestedActivation === false) {
    return "Target app activation request was rejected by macOS.";
  }

  return "Target app did not become frontmost.";
}

function readOpenGhosttySessionResult(
  payload: unknown,
  commandName: string
): OpenGhosttySessionResult {
  const record = readRecord(payload, commandName);
  const opened = readBoolean(record, "opened", commandName);

  if (!opened) {
    throw invalidShape(commandName, "expected opened to be true");
  }

  const result: OpenGhosttySessionResult = {
    bundleId: readString(record, "bundleId", commandName),
    title: readString(record, "title", commandName),
    pid: readProcessIdentifier(record, commandName),
    opened: true
  };
  const workingDirectory = readOptionalString(record, "workingDirectory", commandName);
  const appURL = readOptionalString(record, "appURL", commandName);
  const args = readOptionalStringArray(record, "arguments", commandName);

  if (workingDirectory !== undefined) {
    result.workingDirectory = workingDirectory;
  }

  if (appURL !== undefined) {
    result.appURL = appURL;
  }

  if (args !== undefined) {
    result.arguments = args;
  }

  return result;
}

function readAppState(payload: unknown, commandName: string): DesktopAppState {
  const record = readRecord(payload, commandName);

  if (isRecord(record.app)) {
    const screenshot = readRecord(record.screenshot, commandName);

    return {
      bundleId: readString(record.app, "bundleId", commandName),
      pid: readProcessIdentifier(record.app, commandName),
      isRunning: true,
      isActive: readBoolean(record.app, "isActive", commandName),
      screenshotPath:
        readOptionalString(screenshot, "screenshotPath", commandName)
        ?? readString(screenshot, "output", commandName),
      frontmostBundleId: readOptionalString(record, "frontmostBundleId", commandName),
      accessibilityTrusted: readOptionalBoolean(record, "accessibilityTrusted", commandName),
      windows: readOptionalWindows(record, commandName)
    };
  }

  return {
    bundleId: readString(record, "bundleId", commandName),
    pid: readOptionalProcessIdentifier(record, commandName),
    isRunning: readBoolean(record, "isRunning", commandName),
    isActive: readBoolean(record, "isActive", commandName),
    screenshotPath: readString(record, "screenshotPath", commandName),
    frontmostBundleId: readOptionalString(record, "frontmostBundleId", commandName),
    accessibilityTrusted: readOptionalBoolean(record, "accessibilityTrusted", commandName),
    windows: readOptionalWindows(record, commandName)
  };
}

function readOptionalWindows(
  record: Record<string, unknown>,
  commandName: string
): DesktopWindowInfo[] | undefined {
  const windows = record.windows;

  if (windows === undefined || windows === null) {
    return undefined;
  }

  if (!Array.isArray(windows)) {
    throw invalidShape(commandName, "expected windows to be an array when provided");
  }

  return windows.map((window) => readWindowInfo(window, commandName));
}

function readWindowInfo(payload: unknown, commandName: string): DesktopWindowInfo {
  const record = readRecord(payload, commandName);
  const bounds = readRecord(record.bounds, commandName);

  return {
    title: readOptionalString(record, "title", commandName),
    layer: readNumber(record, "layer", commandName),
    bounds: {
      x: readNumber(bounds, "x", commandName),
      y: readNumber(bounds, "y", commandName),
      width: readNumber(bounds, "width", commandName),
      height: readNumber(bounds, "height", commandName)
    }
  };
}

function readPermissionSummary(payload: unknown, commandName: string): PermissionSummary {
  const record = readRecord(payload, commandName);

  return {
    screenRecording: readPermissionStatus(record.screenRecording, commandName),
    accessibility: readPermissionStatus(record.accessibility, commandName)
  };
}

function readFinderSelectionResult(
  payload: unknown,
  commandName: string
): FinderSelectionResult {
  const record = readRecord(payload, commandName);
  const source = readString(record, "source", commandName);

  if (source !== "finder-applescript") {
    throw invalidShape(commandName, `expected known Finder selection source, got ${source}`);
  }

  const selection = record.selection;
  if (!Array.isArray(selection)) {
    throw invalidShape(commandName, "expected selection to be an array");
  }

  const result: FinderSelectionResult = {
    source,
    selection: selection.map((item) => readFinderSelectionItem(item, commandName))
  };
  const frontmostBundleId = readOptionalString(record, "frontmostBundleId", commandName);
  const targetPath = readOptionalString(record, "targetPath", commandName);

  if (frontmostBundleId !== undefined) {
    result.frontmostBundleId = frontmostBundleId;
  }

  if (targetPath !== undefined) {
    result.targetPath = targetPath;
  }

  return result;
}

function readFinderSelectionItem(
  payload: unknown,
  commandName: string
): FinderSelectionItem {
  const record = readRecord(payload, commandName);
  const kind = readString(record, "kind", commandName);

  if (!isFinderSelectionItemKind(kind)) {
    throw invalidShape(commandName, `expected known Finder selection item kind, got ${kind}`);
  }

  return {
    path: readString(record, "path", commandName),
    name: readString(record, "name", commandName),
    kind
  };
}

function readFinderItemLayoutResult(
  payload: unknown,
  commandName: string
): FinderItemLayoutResult {
  const record = readRecord(payload, commandName);
  const source = readString(record, "source", commandName);

  if (source !== "finder-applescript-layout") {
    throw invalidShape(commandName, `expected known Finder item layout source, got ${source}`);
  }

  const items = record.items;
  if (!Array.isArray(items)) {
    throw invalidShape(commandName, "expected items to be an array");
  }

  const result: FinderItemLayoutResult = {
    source,
    folderPath: readString(record, "folderPath", commandName),
    items: items.map((item) => readFinderItemLayoutItem(item, commandName))
  };
  const frontmostBundleId = readOptionalString(record, "frontmostBundleId", commandName);

  if (frontmostBundleId !== undefined) {
    result.frontmostBundleId = frontmostBundleId;
  }

  return result;
}

function readFinderItemLayoutItem(
  payload: unknown,
  commandName: string
): FinderItemLayoutItem {
  const record = readRecord(payload, commandName);
  const kind = readString(record, "kind", commandName);
  const center = readRecord(record.center, commandName);
  const bounds = readRecord(record.bounds, commandName);

  if (!isFinderSelectionItemKind(kind)) {
    throw invalidShape(commandName, `expected known Finder item kind, got ${kind}`);
  }

  return {
    path: readString(record, "path", commandName),
    name: readString(record, "name", commandName),
    kind,
    center: {
      x: readNumber(center, "x", commandName),
      y: readNumber(center, "y", commandName)
    },
    bounds: {
      x: readNumber(bounds, "x", commandName),
      y: readNumber(bounds, "y", commandName),
      width: readNumber(bounds, "width", commandName),
      height: readNumber(bounds, "height", commandName)
    }
  };
}

function isFinderSelectionItemKind(value: string): value is FinderSelectionItemKind {
  return value === "file" || value === "directory" || value === "other";
}

function readPermissionStatus(payload: unknown, commandName: string) {
  const record = readRecord(payload, commandName);
  const state = readOptionalString(record, "state", commandName)
    ?? normalizeNativePermissionStatus(record, commandName);

  if (!isPermissionState(state)) {
    throw invalidShape(commandName, `expected permission state to be known, got ${state}`);
  }

  return { state };
}

function normalizeNativePermissionStatus(
  record: Record<string, unknown>,
  commandName: string
): PermissionState {
  const status = readOptionalString(record, "status", commandName);

  if (!status) {
    throw invalidShape(commandName, "expected state or status to be a string");
  }

  switch (status) {
    case "authorized":
      return "granted";
    case "notDetermined":
      return "not-determined";
    case "denied":
    case "restricted":
    case "notAuthorized":
      return "denied";
    case "unknown":
      return "unknown";
    default:
      throw invalidShape(commandName, `expected known native permission status, got ${status}`);
  }
}

function readRecord(payload: unknown, commandName: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw invalidShape(commandName, "expected a JSON object");
  }

  return payload;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function requireNonEmptyStringArray(
  value: unknown,
  label: string,
  itemLabel: string
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must include at least one ${itemLabel}.`);
  }

  return value.map((item) => requireNonEmptyString(item, itemLabel));
}

function requireFinderItemNames(value: readonly string[]): string[] {
  const names = requireNonEmptyStringArray(value, "itemNames", "item name");
  const invalidName = names.find((name) => name.includes(","));

  if (invalidName !== undefined) {
    throw new Error(`Finder item names cannot include commas: ${invalidName}`);
  }

  return names;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }

  return value;
}

function requirePoint(value: unknown, label: string): DesktopPoint {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a point object.`);
  }

  return {
    x: requireFiniteNumber(value.x, `${label}.x`),
    y: requireFiniteNumber(value.y, `${label}.y`)
  };
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return number;
}

function appendOptionalPid(args: string[], pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }

  args.push("--pid", String(requirePositiveInteger(pid, "pid")));
}

function requirePermissionSettingsTarget(value: unknown): PermissionSettingsTarget {
  if (
    value === "screen-recording"
    || value === "accessibility"
  ) {
    return value;
  }

  throw new Error(
    "permission must be screen-recording or accessibility."
  );
}

function isPermissionState(value: string): value is PermissionState {
  return (
    value === "granted"
    || value === "denied"
    || value === "not-determined"
    || value === "unknown"
  );
}

function readString(
  record: Record<string, unknown>,
  key: string,
  commandName: string
): string {
  const value = record[key];

  if (typeof value !== "string") {
    throw invalidShape(commandName, `expected ${key} to be a string`);
  }

  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  commandName: string
): string | undefined {
  const value = record[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw invalidShape(commandName, `expected ${key} to be a string when provided`);
  }

  return value;
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  commandName: string
): string[] | undefined {
  const value = record[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalidShape(commandName, `expected ${key} to be an array of strings when provided`);
  }

  return value;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  commandName: string
): boolean {
  const value = record[key];

  if (typeof value !== "boolean") {
    throw invalidShape(commandName, `expected ${key} to be a boolean`);
  }

  return value;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  commandName: string
): boolean | undefined {
  const value = record[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw invalidShape(commandName, `expected ${key} to be a boolean when provided`);
  }

  return value;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  commandName: string
): number {
  const value = record[key];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidShape(commandName, `expected ${key} to be a finite number`);
  }

  return value;
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  commandName: string
): number | undefined {
  const value = record[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidShape(commandName, `expected ${key} to be a finite number when provided`);
  }

  return value;
}

function readProcessIdentifier(
  record: Record<string, unknown>,
  commandName: string
): number {
  const value = record.pid ?? record.processIdentifier;

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidShape(commandName, "expected pid/processIdentifier to be a positive integer");
  }

  return value;
}

function readOptionalProcessIdentifier(
  record: Record<string, unknown>,
  commandName: string
): number | undefined {
  const value = record.pid ?? record.processIdentifier;

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidShape(commandName, "expected pid/processIdentifier to be a positive integer when provided");
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidShape(commandName: string, reason: string): Error {
  return new Error(`Desktop helper returned invalid JSON shape for ${commandName}: ${reason}.`);
}
