export interface DesktopHelperProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessRunnerOptions
) => Promise<DesktopHelperProcessResult>;

export interface ProcessRunnerOptions {
  signal?: AbortSignal;
}

export interface DesktopHelperClientOptions {
  helperPath?: string;
  runner?: ProcessRunner;
}

export interface DesktopAppInfo {
  bundleId: string;
  name: string;
  pid?: number;
}

export interface DesktopSessionStatus {
  frontmostBundleId?: string;
  frontmostLocalizedName?: string;
  frontmostProcessIdentifier?: number;
  mainDisplayAsleep?: boolean;
  controllable: boolean;
}

export type DesktopExecutableAction =
  | { type: "screenshot"; outputPath: string }
  | { type: "click"; x: number; y: number }
  | { type: "drag"; from: DesktopPoint; to: DesktopPoint; durationMs?: number }
  | { type: "scroll"; deltaX: number; deltaY: number }
  | { type: "type_text"; text: string }
  | { type: "press_key"; key: string }
  | { type: "hotkey"; key: string; modifiers: readonly string[] }
  | { type: "activate_app"; bundleId: string; pid?: number }
  | { type: "open_ghostty_session"; title: string; workingDirectory?: string }
  | { type: "observe_app"; bundleId: string; pid?: number; screenshotOutputPath: string };

export interface WaitAction {
  type: "wait";
  ms: number;
}

export type DesktopAction = DesktopExecutableAction | WaitAction;

export interface ScreenshotResult {
  outputPath: string;
}

export interface OcrLabelObservation {
  text: string;
  confidence: number;
  bounds: DesktopWindowBounds;
}

export interface OcrImageResult {
  labels: OcrLabelObservation[];
}

export type FinderSelectionSource = "finder-applescript";
export type FinderItemLayoutSource = "finder-applescript-layout";
export type FinderSelectionItemKind = "file" | "directory" | "other";

export interface FinderSelectionItem {
  path: string;
  name: string;
  kind: FinderSelectionItemKind;
}

export interface FinderSelectionResult {
  source: FinderSelectionSource;
  frontmostBundleId?: string;
  targetPath?: string;
  selection: FinderSelectionItem[];
}

export interface FinderItemLayoutItem {
  path: string;
  name: string;
  kind: FinderSelectionItemKind;
  center: DesktopPoint;
  bounds: DesktopWindowBounds;
}

export interface FinderItemLayoutResult {
  source: FinderItemLayoutSource;
  frontmostBundleId?: string;
  folderPath: string;
  items: FinderItemLayoutItem[];
}

export interface DesktopHelperActionResult {
  ok: boolean;
  message?: string;
}

export interface OpenGhosttySessionResult {
  bundleId: string;
  title: string;
  pid: number;
  opened: true;
  workingDirectory?: string;
  appURL?: string;
  arguments?: string[];
}

export type PermissionState = "granted" | "denied" | "not-determined" | "unknown";

export type PermissionSettingsTarget =
  | "screen-recording"
  | "accessibility";

export interface PermissionStatus {
  state: PermissionState;
}

export interface PermissionSummary {
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
}

export interface DesktopAppState {
  bundleId: string;
  pid?: number;
  isRunning: boolean;
  isActive: boolean;
  screenshotPath: string;
  frontmostBundleId?: string;
  accessibilityTrusted?: boolean;
  windows?: DesktopWindowInfo[];
  ocrLabels?: OcrLabelObservation[];
}

export interface DesktopWindowInfo {
  title?: string;
  layer: number;
  bounds: DesktopWindowBounds;
}

export interface DesktopWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopPoint {
  x: number;
  y: number;
}

export interface WaitResult {
  ok: true;
  waitedMs: number;
}

export type DesktopActionResult =
  | ScreenshotResult
  | OcrImageResult
  | DesktopSessionStatus
  | DesktopHelperActionResult
  | OpenGhosttySessionResult
  | DesktopAppState
  | WaitResult;
