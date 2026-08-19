import type {
  DesktopActionResult,
  DesktopAppInfo,
  DesktopAppState,
  DesktopExecutableAction,
  DesktopSessionStatus,
  OcrImageResult,
  OcrLabelObservation
} from "./types.js";
export interface ComputerUseDesktopRoute {
  kind: "desktop";
  bundleId: string;
  appName: string;
  pid?: number;
}

export type ComputerUseDecisionRisk =
  | "read_only"
  | "local_mutation"
  | "external_side_effect"
  | "credential"
  | "destructive";

interface ComputerUsePlannerDecisionBase {
  risk: ComputerUseDecisionRisk;
  rationale: string;
}

export type ComputerUsePlannerDecision =
  | (ComputerUsePlannerDecisionBase & { kind: "click"; x: number; y: number })
  | (ComputerUsePlannerDecisionBase & { kind: "type_text"; text: string })
  | (ComputerUsePlannerDecisionBase & { kind: "press_key"; key: string })
  | (ComputerUsePlannerDecisionBase & {
      kind: "hotkey";
      key: string;
      modifiers: string[];
    })
  | (ComputerUsePlannerDecisionBase & {
      kind: "scroll";
      deltaX: number;
      deltaY: number;
    })
  | (ComputerUsePlannerDecisionBase & {
      kind: "drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs?: number;
    })
  | (ComputerUsePlannerDecisionBase & { kind: "wait"; waitMs: number })
  | (ComputerUsePlannerDecisionBase & { kind: "finish"; summary: string })
  | (ComputerUsePlannerDecisionBase & { kind: "ask"; summary: string })
  | (ComputerUsePlannerDecisionBase & { kind: "refuse"; summary: string });

export interface ComputerUseAgentHistoryEntry {
  action: Exclude<ComputerUsePlannerDecision["kind"], "finish" | "ask" | "refuse">;
  outcome: string;
}

export interface ComputerUseAgentPlannerInput {
  goal: string;
  route: ComputerUseDesktopRoute;
  observation: DesktopAppState & { ocrLabels: OcrLabelObservation[] };
  history: ComputerUseAgentHistoryEntry[];
  step: number;
  remainingSteps: number;
  signal?: AbortSignal;
}

export interface ComputerUseAgentPlanner {
  decide(input: ComputerUseAgentPlannerInput): Promise<ComputerUsePlannerDecision>;
}

export interface ComputerUseAgentLoopClient {
  listApps(): Promise<DesktopAppInfo[]>;
  getDesktopSessionStatus(): Promise<DesktopSessionStatus>;
  getAppState(bundleId: string, screenshotOutputPath: string, pid?: number): Promise<DesktopAppState>;
  ocrImage(inputPath: string): Promise<OcrImageResult>;
  executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult>;
}

export type ComputerUseDesktopTargetResolution =
  | { kind: "resolved"; route: ComputerUseDesktopRoute }
  | { kind: "blocked"; reason: string };

export interface ComputerUseAgentLoopProgress {
  status: "observing" | "executing" | "verifying";
  message: string;
  sideEffectState?: "possible" | "occurred";
}

export interface ComputerUseAgentLoopResult {
  status: "completed" | "blocked" | "failed" | "cancelled";
  summary: string;
  observationCount: number;
  actionCount: number;
  sideEffectState: "none" | "occurred";
}

export interface RunComputerUseAgentLoopInput {
  goal: string;
  route: ComputerUseDesktopRoute;
  client: ComputerUseAgentLoopClient;
  planner: ComputerUseAgentPlanner;
  createScreenshotPath(step: number): string;
  removeScreenshot?: (path: string) => Promise<void>;
  onProgress?: (progress: ComputerUseAgentLoopProgress) => void;
  signal?: AbortSignal;
  maxSteps?: number;
  timeoutMs?: number;
  now?: () => number;
}

const SKFIY_BUNDLE_IDS = new Set(["com.sskift.skfiy", "com.sskift.skfiy.helper"]);
const UNSAFE_DECISION_RISKS = new Set<ComputerUseDecisionRisk>([
  "external_side_effect",
  "credential",
  "destructive"
]);
const PRESS_KEYS = new Set([
  "enter",
  "escape",
  "space",
  "tab",
  "backspace",
  "delete",
  "arrow_up",
  "arrow_down",
  "arrow_left",
  "arrow_right"
]);
const HOTKEYS = new Set([
  "command+a",
  "command+c",
  "command+f",
  "command+s",
  "command+x",
  "command+z",
  "command+shift+z",
  "control+a",
  "control+e"
]);
const MAX_OCR_LABELS = 80;
const MAX_OCR_TEXT_LENGTH = 160;
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_TIMEOUT_MS = 120_000;

export async function resolveComputerUseDesktopTarget(
  goal: string,
  client: Pick<ComputerUseAgentLoopClient, "listApps" | "getDesktopSessionStatus">,
  options: { excludedProcessIds?: readonly number[] } = {}
): Promise<ComputerUseDesktopTargetResolution> {
  const excludedProcessIds = new Set(options.excludedProcessIds ?? []);
  let apps: DesktopAppInfo[];
  try {
    apps = (await client.listApps()).filter((candidate) => (
      isControllableTargetCandidate(candidate)
      && (candidate.pid === undefined || !excludedProcessIds.has(candidate.pid))
    ));
  } catch {
    return {
      kind: "blocked",
      reason: "Running applications could not be inspected. Check packaged helper readiness, then retry."
    };
  }
  const normalizedGoal = normalizeMatchText(goal);
  const namedMatch = apps
    .filter((candidate) => {
      const name = normalizeMatchText(candidate.name);
      const bundleId = normalizeMatchText(candidate.bundleId);
      const bundleName = normalizeMatchText(candidate.bundleId.split(".").at(-1) ?? "");
      return (name.length >= 3 && normalizedGoal.includes(name))
        || (bundleName.length >= 3 && normalizedGoal.includes(bundleName))
        || (bundleId.length > 0 && normalizedGoal.includes(bundleId));
    })
    .sort((left, right) => right.name.length - left.name.length)[0];

  if (namedMatch) {
    return { kind: "resolved", route: createDesktopRoute(namedMatch) };
  }

  const requestedAppName = readRequestedAppName(goal);
  if (requestedAppName) {
    return {
      kind: "blocked",
      reason: `The requested app ${boundedPublicText(requestedAppName, "target")} is not running. Open it, then retry.`
    };
  }

  let session: DesktopSessionStatus;
  try {
    session = await client.getDesktopSessionStatus();
  } catch {
    return {
      kind: "blocked",
      reason: "The frontmost application could not be inspected. Check desktop readiness, then retry."
    };
  }
  if (!session.controllable) {
    return {
      kind: "blocked",
      reason: "The desktop session is not controllable. Wake and unlock the Mac, then retry."
    };
  }
  const frontmostBundleId = session.frontmostBundleId?.trim();
  if (
    !frontmostBundleId
    || isExcludedTargetBundle(frontmostBundleId)
    || (session.frontmostProcessIdentifier !== undefined
      && excludedProcessIds.has(session.frontmostProcessIdentifier))
  ) {
    return {
      kind: "blocked",
      reason: "No non-skfiy frontmost application could be bound. Focus the target app or name a running app, then retry."
    };
  }
  const frontmostApp = apps.find((candidate) => (
    candidate.bundleId === frontmostBundleId
    && (session.frontmostProcessIdentifier === undefined
      || candidate.pid === undefined
      || candidate.pid === session.frontmostProcessIdentifier)
  ));

  return {
    kind: "resolved",
    route: createDesktopRoute(frontmostApp ?? {
      bundleId: frontmostBundleId,
      name: session.frontmostLocalizedName ?? frontmostBundleId,
      ...(session.frontmostProcessIdentifier !== undefined
        ? { pid: session.frontmostProcessIdentifier }
        : {})
    })
  };
}

export async function runComputerUseAgentLoop({
  goal,
  route,
  client,
  planner,
  createScreenshotPath,
  removeScreenshot,
  onProgress,
  signal,
  maxSteps = DEFAULT_MAX_STEPS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now
}: RunComputerUseAgentLoopInput): Promise<ComputerUseAgentLoopResult> {
  const startedAt = now();
  const history: ComputerUseAgentHistoryEntry[] = [];
  let observationCount = 0;
  let actionCount = 0;
  let latestWindows: DesktopAppState["windows"] = [];
  let latestAccessibilityTrusted: boolean | undefined;
  let sideEffectState: ComputerUseAgentLoopResult["sideEffectState"] = "none";

  const finish = (
    status: ComputerUseAgentLoopResult["status"],
    summary: string
  ): ComputerUseAgentLoopResult => ({
    status,
    summary: boundedPublicText(summary, "Computer Use stopped without a result."),
    observationCount,
    actionCount,
    sideEffectState
  });

  try {
    const goalPolicyBlock = readGenericGoalPolicyBlock(goal);
    if (goalPolicyBlock) {
      return finish("blocked", goalPolicyBlock);
    }
    assertLoopActive(signal, startedAt, timeoutMs, now);
    const initialSession = await client.getDesktopSessionStatus();
    if (!initialSession.controllable) {
      return finish("blocked", "The desktop session is not controllable. Wake and unlock the Mac, then retry.");
    }
    if (!isBoundTargetFrontmost(initialSession, route)) {
      onProgress?.({
        status: "executing",
        message: `Activating the approved target app ${route.appName}.`
      });
      const activation = await client.executeAction({
        type: "activate_app",
        bundleId: route.bundleId,
        ...(route.pid !== undefined ? { pid: route.pid } : {})
      });
      if (!isSuccessfulActionResult(activation)) {
        return finish("failed", `Could not activate the approved target app ${route.appName}.`);
      }
      const activatedSession = await client.getDesktopSessionStatus();
      if (!isBoundTargetFrontmost(activatedSession, route)) {
        return finish("blocked", "The approved target app could not be made frontmost.");
      }
    }

    for (let step = 1; step <= maxSteps; step += 1) {
      assertLoopActive(signal, startedAt, timeoutMs, now);
      const screenshotRequestPath = createScreenshotPath(step);
      let screenshotPath = screenshotRequestPath;
      let decision: ComputerUsePlannerDecision;
      try {
        onProgress?.({
          status: actionCount === 0 ? "observing" : "verifying",
          message: actionCount === 0
            ? `Observing ${route.appName}.`
            : `Observing ${route.appName} again to verify the last action.`
        });
        const rawObservation = await client.getAppState(
          route.bundleId,
          screenshotRequestPath,
          route.pid
        );
        screenshotPath = rawObservation.screenshotPath || screenshotRequestPath;
        observationCount += 1;
        const targetProblem = readObservationTargetProblem(rawObservation, route);
        if (targetProblem) {
          return finish("blocked", targetProblem);
        }
        const ocr = await client.ocrImage(screenshotPath);
        const observation = {
          ...rawObservation,
          ocrLabels: boundOcrLabels(ocr.labels)
        };
        latestWindows = observation.windows?.map((window) => ({
          ...window,
          bounds: { ...window.bounds }
        })) ?? [];
        latestAccessibilityTrusted = observation.accessibilityTrusted;
        assertLoopActive(signal, startedAt, timeoutMs, now);
        onProgress?.({
          status: "observing",
          message: `Planning the next bounded action from observation ${observationCount}.`
        });
        decision = await planner.decide({
          goal: boundedGoal(goal),
          route,
          observation,
          history: history.map((entry) => ({ ...entry })),
          step,
          remainingSteps: maxSteps - step,
          ...(signal ? { signal } : {})
        });
      } finally {
        if (removeScreenshot) {
          await removeScreenshot(screenshotPath).catch(() => undefined);
        }
      }

      assertLoopActive(signal, startedAt, timeoutMs, now);
      const checkedDecision = readCheckedPlannerDecision(decision);
      if (checkedDecision.kind === "invalid") {
        return finish("blocked", checkedDecision.reason);
      }
      if (UNSAFE_DECISION_RISKS.has(checkedDecision.decision.risk)) {
        return finish(
          "blocked",
          `The planner classified the next step as ${checkedDecision.decision.risk}; generic Computer Use refuses that side effect.`
        );
      }
      if (checkedDecision.decision.kind === "finish") {
        return finish("completed", checkedDecision.decision.summary);
      }
      if (checkedDecision.decision.kind === "ask") {
        return finish("blocked", `The planner needs user input: ${checkedDecision.decision.summary}`);
      }
      if (checkedDecision.decision.kind === "refuse") {
        return finish("blocked", checkedDecision.decision.summary);
      }

      const actionDecision = checkedDecision.decision;
      const action = createValidatedDesktopAction(actionDecision, latestWindows);
      if (action.kind === "invalid") {
        return finish("blocked", action.reason);
      }
      if (action.action.type !== "wait" && latestAccessibilityTrusted === false) {
        return finish(
          "blocked",
          "Accessibility permission is no longer available; no further Computer Use action was executed."
        );
      }
      const currentSession = await client.getDesktopSessionStatus();
      if (!isBoundTargetFrontmost(currentSession, route)) {
        return finish(
          "blocked",
          "The target app changed after observation; no further Computer Use action was executed."
        );
      }
      assertLoopActive(signal, startedAt, timeoutMs, now);
      onProgress?.({
        status: "executing",
        message: `Executing approved ${formatDecisionKind(actionDecision.kind)} action ${actionCount + 1}.`,
        ...(action.action.type === "wait" ? {} : { sideEffectState: "possible" as const })
      });

      if (action.action.type === "wait") {
        await waitFor(action.action.ms, signal);
      } else {
        const result = await client.executeAction(action.action);
        if (!isSuccessfulActionResult(result)) {
          return finish("failed", `The ${formatDecisionKind(actionDecision.kind)} action failed.`);
        }
        sideEffectState = "occurred";
        onProgress?.({
          status: "verifying",
          message: `Action ${actionCount + 1} finished; capturing a fresh observation before continuing.`,
          sideEffectState: "occurred"
        });
      }
      actionCount += 1;
      history.push({
        action: actionDecision.kind,
        outcome: createHistoryOutcome(actionDecision)
      });
    }

    return finish(
      "blocked",
      `Computer Use reached its ${maxSteps}-step budget without verified completion.`
    );
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      return finish("cancelled", "Computer Use stopped before another action.");
    }
    const message = error instanceof Error ? error.message : "Computer Use failed unexpectedly.";
    return finish("failed", message);
  }
}

function createDesktopRoute(app: DesktopAppInfo): ComputerUseDesktopRoute {
  return {
    kind: "desktop",
    bundleId: app.bundleId,
    appName: boundedPublicText(app.name, app.bundleId),
    ...(app.pid !== undefined ? { pid: app.pid } : {})
  };
}

function isControllableTargetCandidate(app: DesktopAppInfo): boolean {
  return app.bundleId.trim().length > 0
    && app.name.trim().length > 0
    && !isExcludedTargetBundle(app.bundleId);
}

function isExcludedTargetBundle(bundleId: string): boolean {
  return SKFIY_BUNDLE_IDS.has(bundleId)
    || bundleId === "com.apple.loginwindow"
    || bundleId.startsWith("com.apple.SecurityAgent");
}

function normalizeMatchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function readRequestedAppName(goal: string): string | undefined {
  const patterns = [
    /(?:用|在)\s*([\p{L}\p{N}][\p{L}\p{N} ._-]{0,40}?)\s*(?:里|中|上|应用|app)?\s*(?=输入|写入|写下|填写|编辑|保存|选择|点击|点|观察|查看|读取|截图|按|拖|滚动)/iu,
    /\b(?:in|using|use)\s+([a-z][a-z0-9 ._-]{0,40}?)\s+(?=type|write|fill|edit|save|select|click|observe|watch|read|inspect|capture|press|drag|scroll|navigate)\b/iu
  ];
  const match = patterns.map((pattern) => pattern.exec(goal)).find(Boolean);
  const candidate = match?.[1]?.trim();
  if (!candidate) {
    return undefined;
  }
  const genericTargets = new Set([
    "当前", "当前应用", "当前程序", "当前窗口", "前台应用", "前台程序", "前台窗口",
    "可见应用", "可见程序", "可见窗口", "currentapp", "currentapplication", "currentwindow",
    "frontmostapp", "frontmostapplication", "frontmostwindow", "visibleapp", "visibleapplication",
    "anyapp", "anyapplication"
  ]);
  return genericTargets.has(normalizeMatchText(candidate)) ? undefined : candidate;
}

function boundedGoal(goal: string): string {
  return goal
    .replace(/[\u0000\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 4_000);
}

function boundOcrLabels(labels: OcrLabelObservation[]): OcrLabelObservation[] {
  return labels.slice(0, MAX_OCR_LABELS).map((label) => ({
    text: label.text
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, MAX_OCR_TEXT_LENGTH),
    confidence: Number.isFinite(label.confidence) ? label.confidence : 0,
    bounds: { ...label.bounds }
  })).filter((label) => label.text.length > 0);
}

function readObservationTargetProblem(
  observation: DesktopAppState,
  route: ComputerUseDesktopRoute
): string | undefined {
  if (!observation.isRunning || observation.bundleId !== route.bundleId) {
    return "The approved target app is no longer running.";
  }
  if (!observation.isActive || observation.frontmostBundleId !== route.bundleId) {
    return "The approved target app is no longer frontmost.";
  }
  if (route.pid !== undefined && observation.pid !== undefined && observation.pid !== route.pid) {
    return "The approved target app process changed after approval.";
  }
  return undefined;
}

function isBoundTargetFrontmost(
  session: DesktopSessionStatus,
  route: ComputerUseDesktopRoute
): boolean {
  return session.controllable
    && session.frontmostBundleId === route.bundleId
    && (route.pid === undefined
      || session.frontmostProcessIdentifier === undefined
      || session.frontmostProcessIdentifier === route.pid);
}

type CheckedPlannerDecision =
  | { kind: "valid"; decision: ComputerUsePlannerDecision }
  | { kind: "invalid"; reason: string };

function readCheckedPlannerDecision(value: unknown): CheckedPlannerDecision {
  if (!isRecord(value)) {
    return invalidDecision("The Computer Use planner returned a non-object decision.");
  }
  const kind = readString(value.kind);
  const risk = readString(value.risk);
  const rationale = readString(value.rationale);
  if (!isDecisionRisk(risk) || !rationale) {
    return invalidDecision("The Computer Use planner decision omitted a valid risk or rationale.");
  }
  const base = { risk, rationale: boundedPublicText(rationale, "No rationale supplied.") };

  switch (kind) {
    case "click": {
      const x = readFiniteNumber(value.x);
      const y = readFiniteNumber(value.y);
      return x === undefined || y === undefined
        ? invalidDecision("The planner returned invalid click coordinates.")
        : { kind: "valid", decision: { kind, ...base, x, y } };
    }
    case "type_text": {
      const text = readString(value.text);
      return text === undefined
        ? invalidDecision("The planner returned invalid text input.")
        : { kind: "valid", decision: { kind, ...base, text } };
    }
    case "press_key": {
      const key = readString(value.key);
      return !key
        ? invalidDecision("The planner returned an invalid key.")
        : { kind: "valid", decision: { kind, ...base, key } };
    }
    case "hotkey": {
      const key = readString(value.key);
      const modifiers = Array.isArray(value.modifiers)
        && value.modifiers.every((modifier) => typeof modifier === "string")
        ? value.modifiers as string[]
        : undefined;
      return !key || !modifiers
        ? invalidDecision("The planner returned an invalid keyboard shortcut.")
        : { kind: "valid", decision: { kind, ...base, key, modifiers } };
    }
    case "scroll": {
      const deltaX = readFiniteNumber(value.deltaX);
      const deltaY = readFiniteNumber(value.deltaY);
      return deltaX === undefined || deltaY === undefined
        ? invalidDecision("The planner returned invalid scroll deltas.")
        : { kind: "valid", decision: { kind, ...base, deltaX, deltaY } };
    }
    case "drag": {
      const fromX = readFiniteNumber(value.fromX);
      const fromY = readFiniteNumber(value.fromY);
      const toX = readFiniteNumber(value.toX);
      const toY = readFiniteNumber(value.toY);
      const durationMs = readFiniteNumber(value.durationMs);
      return fromX === undefined || fromY === undefined || toX === undefined || toY === undefined
        ? invalidDecision("The planner returned invalid drag coordinates.")
        : {
          kind: "valid",
          decision: {
            kind,
            ...base,
            fromX,
            fromY,
            toX,
            toY,
            ...(durationMs !== undefined ? { durationMs } : {})
          }
        };
    }
    case "wait": {
      const waitMs = readFiniteNumber(value.waitMs);
      return waitMs === undefined
        ? invalidDecision("The planner returned an invalid wait duration.")
        : { kind: "valid", decision: { kind, ...base, waitMs } };
    }
    case "finish":
    case "ask":
    case "refuse": {
      const summary = readString(value.summary);
      return !summary
        ? invalidDecision(`The planner returned ${kind} without a summary.`)
        : {
          kind: "valid",
          decision: { kind, ...base, summary: boundedPublicText(summary, "Computer Use stopped.") }
        };
    }
    default:
      return invalidDecision("The Computer Use planner returned an unsupported decision kind.");
  }
}

function invalidDecision(reason: string): CheckedPlannerDecision {
  return { kind: "invalid", reason };
}

type ValidatedDesktopAction =
  | { kind: "valid"; action: DesktopExecutableAction | { type: "wait"; ms: number } }
  | { kind: "invalid"; reason: string };

function createValidatedDesktopAction(
  decision: Exclude<ComputerUsePlannerDecision, { kind: "finish" | "ask" | "refuse" }>,
  windows: DesktopAppState["windows"]
): ValidatedDesktopAction {
  switch (decision.kind) {
    case "click":
      return validatePointAction(decision.x, decision.y, windows, {
        type: "click",
        x: Math.round(decision.x),
        y: Math.round(decision.y)
      });
    case "drag": {
      if (!isCoordinateInApprovedWindow(decision.fromX, decision.fromY, windows)
        || !isCoordinateInApprovedWindow(decision.toX, decision.toY, windows)) {
        return { kind: "invalid", reason: "The planner drag leaves the approved app window bounds." };
      }
      const durationMs = decision.durationMs === undefined
        ? undefined
        : Math.round(decision.durationMs);
      if (durationMs !== undefined && (durationMs < 100 || durationMs > 2_000)) {
        return { kind: "invalid", reason: "The planner drag duration is outside the bounded range." };
      }
      return {
        kind: "valid",
        action: {
          type: "drag",
          from: { x: Math.round(decision.fromX), y: Math.round(decision.fromY) },
          to: { x: Math.round(decision.toX), y: Math.round(decision.toY) },
          ...(durationMs !== undefined ? { durationMs } : {})
        }
      };
    }
    case "type_text":
      if (
        decision.text.length === 0
        || decision.text.length > 2_000
        || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(decision.text)
      ) {
        return { kind: "invalid", reason: "The planner text input is empty, too long, or contains control characters." };
      }
      if (containsLikelyCredential(decision.text)) {
        return { kind: "invalid", reason: "Generic Computer Use refuses likely credential text." };
      }
      return { kind: "valid", action: { type: "type_text", text: decision.text } };
    case "press_key": {
      const key = normalizeKey(decision.key);
      return PRESS_KEYS.has(key)
        ? { kind: "valid", action: { type: "press_key", key } }
        : { kind: "invalid", reason: `The planner key ${boundedPublicText(key, "unknown")} is not allowed.` };
    }
    case "hotkey": {
      const key = normalizeKey(decision.key);
      const modifiers = [...new Set(decision.modifiers.map(normalizeKey))].sort();
      const signature = [...modifiers, key].join("+");
      return HOTKEYS.has(signature)
        ? { kind: "valid", action: { type: "hotkey", key, modifiers } }
        : { kind: "invalid", reason: "The planner keyboard shortcut is outside the approved shortcut set." };
    }
    case "scroll": {
      const deltaX = Math.round(decision.deltaX);
      const deltaY = Math.round(decision.deltaY);
      if (
        Math.abs(deltaX) > 1_200
        || Math.abs(deltaY) > 1_200
        || (deltaX === 0 && deltaY === 0)
      ) {
        return { kind: "invalid", reason: "The planner scroll is outside the bounded range." };
      }
      return { kind: "valid", action: { type: "scroll", deltaX, deltaY } };
    }
    case "wait": {
      const ms = Math.round(decision.waitMs);
      return ms >= 100 && ms <= 3_000
        ? { kind: "valid", action: { type: "wait", ms } }
        : { kind: "invalid", reason: "The planner wait is outside the 100–3000 ms range." };
    }
  }
}

function validatePointAction(
  x: number,
  y: number,
  windows: DesktopAppState["windows"],
  action: DesktopExecutableAction
): ValidatedDesktopAction {
  return isCoordinateInApprovedWindow(x, y, windows)
    ? { kind: "valid", action }
    : { kind: "invalid", reason: "The planner click is outside the approved app window bounds." };
}

function isCoordinateInApprovedWindow(
  x: number,
  y: number,
  windows: DesktopAppState["windows"]
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  return (windows ?? []).some(({ bounds }) => (
    bounds.width > 0
    && bounds.height > 0
    && x >= bounds.x
    && y >= bounds.y
    && x <= bounds.x + bounds.width
    && y <= bounds.y + bounds.height
  ));
}

function createHistoryOutcome(
  decision: Exclude<ComputerUsePlannerDecision, { kind: "finish" | "ask" | "refuse" }>
): string {
  switch (decision.kind) {
    case "type_text":
      return `Typed ${decision.text.length} characters; content omitted.`;
    case "wait":
      return `Waited ${Math.round(decision.waitMs)} ms.`;
    default:
      return `${formatDecisionKind(decision.kind)} dispatched; awaiting fresh verification.`;
  }
}

function formatDecisionKind(kind: ComputerUsePlannerDecision["kind"]): string {
  return kind.replace(/_/gu, " ");
}

function containsLikelyCredential(value: string): boolean {
  return /\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/iu.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/u.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)
    || /\bsk-[A-Za-z0-9_-]{16,}/u.test(value);
}

function readGenericGoalPolicyBlock(goal: string): string | undefined {
  const normalized = goal.normalize("NFKC").toLocaleLowerCase();
  const policies: Array<[RegExp, string]> = [
    [/密码|口令|验证码|登录|凭据|密钥|\b(?:password|passcode|otp|credential|login|sign[ -]?in|api[ -]?key|secret|token)\b/u,
      "Generic Computer Use does not handle credentials or sign-in workflows."],
    [/付款|支付|转账|购买|下单|结账|\b(?:pay|payment|transfer|purchase|buy|checkout)\b/u,
      "Generic Computer Use does not handle payments, purchases, or transfers."],
    [/发送.{0,12}(?:消息|邮件|帖子)|回复.{0,12}(?:消息|邮件)|\b(?:send|post|publish|reply)\b.{0,24}\b(?:message|email|mail|comment)\b/u,
      "Generic Computer Use does not send or publish external communications."],
    [/安装|卸载|\b(?:install|uninstall)\b/u,
      "Generic Computer Use does not run installers or uninstallers."],
    [/删除|清空|抹掉|永久移除|\b(?:delete|erase|empty trash|permanently remove)\b/u,
      "Generic Computer Use does not perform destructive actions."]
  ];
  return policies.find(([pattern]) => pattern.test(normalized))?.[1];
}

function isSuccessfulActionResult(result: DesktopActionResult): boolean {
  return !isRecord(result) || !("ok" in result) || result.ok === true;
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[ -]+/gu, "_");
}

function isDecisionRisk(value: unknown): value is ComputerUseDecisionRisk {
  return value === "read_only"
    || value === "local_mutation"
    || value === "external_side_effect"
    || value === "credential"
    || value === "destructive";
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedPublicText(value: string, fallback: string): string {
  const bounded = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500)
    .replace(/(?:file:\/\/)?\/(?:Users|tmp|private\/tmp|var)(?:\/[^\s"'`<>)]*)?/gu, "[path]")
    .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*([^\s&]+)/giu, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]");
  return bounded || fallback;
}

function assertLoopActive(
  signal: AbortSignal | undefined,
  startedAt: number,
  timeoutMs: number,
  now: () => number
): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
  }
  if (now() - startedAt >= timeoutMs) {
    throw new Error(`Computer Use exceeded its ${timeoutMs} ms timeout.`);
  }
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
      return;
    }
    const handleAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
