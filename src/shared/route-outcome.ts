export type RouteOutcomeTone = "success" | "warning" | "danger" | "neutral";

export type RouteOutcomeKind =
  | "idle"
  | "running"
  | "approval_required"
  | "needs_confirmation"
  | "needs_clarification"
  | "app_policy_denied"
  | "chrome_host_policy_denied"
  | "user_denied"
  | "blocked"
  | "cancelled"
  | "stopped"
  | "failed"
  | "completed"
  | "unknown";

export const ROUTE_OUTCOME_KINDS: readonly RouteOutcomeKind[] = [
  "idle",
  "running",
  "approval_required",
  "needs_confirmation",
  "needs_clarification",
  "app_policy_denied",
  "chrome_host_policy_denied",
  "user_denied",
  "blocked",
  "cancelled",
  "stopped",
  "failed",
  "completed",
  "unknown"
];

export const ROUTE_OUTCOME_TONES: readonly RouteOutcomeTone[] = [
  "success",
  "warning",
  "danger",
  "neutral"
];

export interface RouteOutcome {
  kind: RouteOutcomeKind;
  title: string;
  value: string;
  detail: string;
  tone: RouteOutcomeTone;
  source: string;
  routeLabel: string;
  state: string;
  denialKind?: string;
  policyKind?: string;
}

export interface RouteOutcomeInput {
  currentTurn?: Record<string, unknown>;
  replay?: Record<string, unknown>;
  defaultSource?: string;
  includeCommandDetail?: boolean;
  sanitizeString?: (value: string) => string | undefined;
}

export interface ExplicitRouteOutcomeInput {
  sanitizeString?: (value: string) => string | undefined;
  requireKind?: boolean;
}

export function isRouteOutcomeKind(value: unknown): value is RouteOutcomeKind {
  return typeof value === "string" && ROUTE_OUTCOME_KINDS.includes(value as RouteOutcomeKind);
}

export function isRouteOutcomeTone(value: unknown): value is RouteOutcomeTone {
  return typeof value === "string" && ROUTE_OUTCOME_TONES.includes(value as RouteOutcomeTone);
}

export function readRouteOutcome({
  currentTurn,
  replay,
  defaultSource = "Current turn",
  includeCommandDetail = true,
  sanitizeString = sanitizeRouteOutcomeString
}: RouteOutcomeInput): RouteOutcome {
  const latestReplayEvent = readLatestReplayEvent(replay);
  const latestToolCall = readRecord(replay?.latestToolCall);
  const state = readRouteStateString(currentTurn?.state, sanitizeString)
    ?? readReplayRouteState(replay, latestReplayEvent, latestToolCall, sanitizeString)
    ?? "idle";
  const approvalState = readString(currentTurn?.approvalState, sanitizeString);
  const approvalPending = isApprovalPending(currentTurn, approvalState);
  const routeSignal = readRouteLabel(currentTurn, replay, latestReplayEvent, sanitizeString);
  const routeLabel = routeSignal ?? "unknown";
  const source = readString(currentTurn?.source, sanitizeString)
    ?? readString(replay?.source, sanitizeString)
    ?? defaultSource;
  const detail = readRouteDetail({ currentTurn, replay, latestReplayEvent, includeCommandDetail, sanitizeString });
  const denialKind = readString(currentTurn?.denialKind, sanitizeString)
    ?? readString(latestReplayEvent?.denialKind, sanitizeString)
    ?? readString(latestToolCall?.denialKind, sanitizeString);
  const policyKind = readString(currentTurn?.policyKind, sanitizeString)
    ?? readString(latestReplayEvent?.policyKind, sanitizeString)
    ?? readString(latestToolCall?.policyKind, sanitizeString);
  const createOutcome = (outcome: RouteOutcome): RouteOutcome => createRouteOutcome({
    ...outcome,
    ...(denialKind ? { denialKind } : {}),
    ...(policyKind ? { policyKind } : {})
  });
  const classifierText = [
    denialKind,
    policyKind,
    readString(currentTurn?.routeReason, sanitizeString),
    readString(currentTurn?.reason, sanitizeString),
    readString(currentTurn?.latestMessage, sanitizeString),
    readString(currentTurn?.message, sanitizeString),
    detail,
    readString(currentTurn?.updateSource, sanitizeString)
  ].filter(Boolean).join(" ").toLowerCase();

  if (state === "idle" && !routeSignal && !readString(currentTurn?.command, sanitizeString) && !approvalPending) {
    return createOutcome({
      kind: "idle",
      title: "No active route",
      state,
      value: "idle",
      detail,
      tone: "neutral",
      source,
      routeLabel
    });
  }

  if (state === "approval_required" || (approvalPending && canApprovalOverrideState(state))) {
    return createOutcome({
      kind: "approval_required",
      title: "Route approval required",
      state,
      value: "approval_required",
      detail,
      tone: "warning",
      source,
      routeLabel
    });
  }

  if (state === "needs_confirmation") {
    return createOutcome({
      kind: "needs_confirmation",
      title: "Route needs confirmation",
      state,
      value: "needs_confirmation",
      detail,
      tone: "warning",
      source,
      routeLabel
    });
  }

  if (state === "needs_clarification") {
    return createOutcome({
      kind: "needs_clarification",
      title: "Route needs clarification",
      state,
      value: "needs_clarification",
      detail,
      tone: "warning",
      source,
      routeLabel
    });
  }

  const appPolicyDenied = isAppPolicyDenialState(state)
    || (isDeniedOrBlockedState(state) && isAppPolicyDenial(classifierText, denialKind, policyKind));
  if (appPolicyDenied) {
    return createOutcome({
      kind: "app_policy_denied",
      title: "App policy denied route",
      state,
      value: "app_policy_denied",
      detail,
      tone: "danger",
      source,
      routeLabel
    });
  }

  const chromeHostPolicyDenied = isChromeHostPolicyDenialState(state)
    || (isDeniedOrBlockedState(state) && isChromeHostPolicyDenial(classifierText, policyKind));
  if (chromeHostPolicyDenied) {
    return createOutcome({
      kind: "chrome_host_policy_denied",
      title: "Chrome host policy denied route",
      state,
      value: "chrome_host_policy_denied",
      detail,
      tone: "danger",
      source,
      routeLabel
    });
  }

  if (state === "user_denied" || state === "denied" || (state === "blocked" && isUserDenial(denialKind))) {
    return createOutcome({
      kind: "user_denied",
      title: "User denied route",
      state,
      value: "user_denied",
      detail,
      tone: "neutral",
      source,
      routeLabel
    });
  }

  if (state === "blocked") {
    return createOutcome({
      kind: "blocked",
      title: classifierText.includes("route policy") ? "Route policy blocked" : "Route blocked",
      state,
      value: "blocked",
      detail,
      tone: "danger",
      source,
      routeLabel
    });
  }

  if (state === "cancelled" && isStopTurnOutcome(classifierText, currentTurn, replay, sanitizeString)) {
    return createOutcome({
      kind: "stopped",
      title: "Route stopped",
      state,
      value: "stopped",
      detail,
      tone: "neutral",
      source,
      routeLabel
    });
  }

  if (state === "cancelled") {
    return createOutcome({
      kind: "cancelled",
      title: "Route cancelled",
      state,
      value: "cancelled",
      detail,
      tone: "neutral",
      source,
      routeLabel
    });
  }

  if (state === "failed") {
    return createOutcome({
      kind: "failed",
      title: "Route failed",
      state,
      value: "failed",
      detail,
      tone: "danger",
      source,
      routeLabel
    });
  }

  if (state === "completed") {
    return createOutcome({
      kind: "completed",
      title: "Route completed",
      state,
      value: "completed",
      detail,
      tone: "success",
      source,
      routeLabel
    });
  }

  if (["planned", "observing", "executing", "running"].includes(state)) {
    return createOutcome({
      kind: "running",
      title: "Route running",
      state,
      value: state,
      detail,
      tone: "warning",
      source,
      routeLabel
    });
  }

  return createOutcome({
    kind: "unknown",
    title: "Route state unknown",
    state,
    value: state,
    detail,
    tone: "neutral",
    source,
    routeLabel
  });
}

export function sanitizeRouteOutcomeString(value: string): string | undefined {
  const sanitized = value
    .replace(/\b(token|password|secret|api[_-]?key)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/(?:file:\/\/)?(?:\/Users\/|\/tmp\/|\/private\/tmp\/|\/var\/|\/repo\/)[^\s"')]+/g, "[path]")
    .trim();

  return sanitized.length > 0 ? sanitized : undefined;
}

export function readExplicitRouteOutcome(
  value: unknown,
  fallback: RouteOutcome,
  {
    sanitizeString = sanitizeRouteOutcomeString,
    requireKind = false
  }: ExplicitRouteOutcomeInput = {}
): RouteOutcome | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  const kind = readExplicitRouteOutcomeKind(record.kind, sanitizeString)
    ?? (requireKind ? undefined : fallback.kind);
  if (!kind) {
    return undefined;
  }

  const defaults = createRouteOutcomeDefaults(kind, fallback);
  const denialKind = readString(record.denialKind, sanitizeString) ?? defaults.denialKind;
  const policyKind = readString(record.policyKind, sanitizeString) ?? defaults.policyKind;

  return {
    kind,
    title: readString(record.title, sanitizeString) ?? defaults.title,
    value: readExplicitRouteOutcomeValue(kind, record.value, defaults.value, sanitizeString),
    detail: readString(record.detail, sanitizeString) ?? defaults.detail,
    tone: isRouteOutcomeTone(record.tone) ? record.tone : defaults.tone,
    source: readString(record.source, sanitizeString) ?? defaults.source,
    routeLabel: readString(record.routeLabel, sanitizeString) ?? defaults.routeLabel,
    state: readRouteStateString(record.state, sanitizeString) ?? defaults.state,
    ...(denialKind ? { denialKind } : {}),
    ...(policyKind ? { policyKind } : {})
  };
}

function createRouteOutcome(outcome: RouteOutcome): RouteOutcome {
  return outcome;
}

function createRouteOutcomeDefaults(kind: RouteOutcomeKind, fallback: RouteOutcome): RouteOutcome {
  const state = readRouteOutcomeDefaultState(kind, fallback.state);

  return {
    ...fallback,
    kind,
    state,
    value: readRouteOutcomeDefaultValue(kind, state),
    title: readRouteOutcomeDefaultTitle(kind),
    tone: readRouteOutcomeDefaultTone(kind)
  };
}

function readRouteOutcomeDefaultValue(kind: RouteOutcomeKind, state: string): string {
  return kind === "running" && state !== "running" ? state : kind;
}

function readExplicitRouteOutcomeKind(
  value: unknown,
  sanitizeString?: (value: string) => string | undefined
): RouteOutcomeKind | undefined {
  const sanitized = readString(value, sanitizeString);
  if (isRouteOutcomeKind(sanitized)) {
    return sanitized;
  }

  const normalized = readRouteStateValue(sanitized);
  return isRouteOutcomeKind(normalized) ? normalized : undefined;
}

function readRouteOutcomeDefaultTitle(kind: RouteOutcomeKind): string {
  switch (kind) {
    case "idle":
      return "No active route";
    case "running":
      return "Route running";
    case "approval_required":
      return "Route approval required";
    case "needs_confirmation":
      return "Route needs confirmation";
    case "needs_clarification":
      return "Route needs clarification";
    case "app_policy_denied":
      return "App policy denied route";
    case "chrome_host_policy_denied":
      return "Chrome host policy denied route";
    case "user_denied":
      return "User denied route";
    case "blocked":
      return "Route blocked";
    case "cancelled":
      return "Route cancelled";
    case "stopped":
      return "Route stopped";
    case "failed":
      return "Route failed";
    case "completed":
      return "Route completed";
    default:
      return "Route state unknown";
  }
}

function readRouteOutcomeDefaultTone(kind: RouteOutcomeKind): RouteOutcomeTone {
  switch (kind) {
    case "completed":
      return "success";
    case "approval_required":
    case "needs_confirmation":
    case "needs_clarification":
    case "running":
      return "warning";
    case "app_policy_denied":
    case "chrome_host_policy_denied":
    case "blocked":
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function readRouteOutcomeDefaultState(kind: RouteOutcomeKind, fallbackState: string): string {
  if (isRouteOutcomeStateCompatible(kind, fallbackState)) {
    return fallbackState;
  }

  if (kind === "stopped") {
    return "cancelled";
  }

  return kind;
}

function isRouteOutcomeStateCompatible(kind: RouteOutcomeKind, state: string): boolean {
  switch (kind) {
    case "app_policy_denied":
      return state === "app_policy_denied" || state === "denied" || state === "blocked";
    case "chrome_host_policy_denied":
      return state === "chrome_host_policy_denied" || state === "denied" || state === "blocked";
    case "user_denied":
      return state === "user_denied" || state === "denied" || state === "blocked";
    case "stopped":
      return state === "cancelled";
    case "running":
      return ["planned", "observing", "executing", "running"].includes(state);
    case "approval_required":
      return state === "approval_required" || state === "running" || state === "observing";
    default:
      return state === kind;
  }
}

function isApprovalPending(
  currentTurn: Record<string, unknown> | undefined,
  approvalState: string | undefined
): boolean {
  return approvalState === "required"
    || approvalState === "pending"
    || currentTurn?.approvalRequired === true;
}

function canApprovalOverrideState(state: string): boolean {
  return ![
    "needs_confirmation",
    "needs_clarification",
    "blocked",
    "denied",
    "app_policy_denied",
    "chrome_host_policy_denied",
    "user_denied",
    "cancelled",
    "failed",
    "completed"
  ].includes(state);
}

function isDeniedOrBlockedState(state: string): boolean {
  return state === "denied" || state === "blocked";
}

function isAppPolicyDenialState(state: string): boolean {
  return state === "app_policy_denied";
}

function isChromeHostPolicyDenialState(state: string): boolean {
  return state === "chrome_host_policy_denied";
}

function isAppPolicyDenial(
  classifierText: string,
  denialKind: string | undefined,
  policyKind: string | undefined
): boolean {
  return classifierText.includes("denied by app policy")
    || denialKind === "app_policy"
    || policyKind === "app-policy";
}

function isChromeHostPolicyDenial(
  classifierText: string,
  policyKind: string | undefined
): boolean {
  return classifierText.includes("chrome host policy blocked")
    || classifierText.includes("chrome-host-policy")
    || policyKind === "chrome-host-policy";
}

function isUserDenial(denialKind: string | undefined): boolean {
  return denialKind === "user" || denialKind === "user_denied";
}

function isStopTurnOutcome(
  classifierText: string,
  currentTurn: Record<string, unknown> | undefined,
  replay: Record<string, unknown> | undefined,
  sanitizeString?: (value: string) => string | undefined
): boolean {
  if (classifierText.includes("task stopped") || classifierText.includes("stop turn")) {
    return true;
  }

  const stopTurnBehavior = readStopTurnBehavior(currentTurn, replay);
  if (!stopTurnBehavior) {
    return false;
  }

  const afterStatus = readRouteStateString(stopTurnBehavior.afterStatus, sanitizeString)
    ?? readRouteStateString(stopTurnBehavior.status, sanitizeString);
  const afterMessage = readString(stopTurnBehavior.afterMessage, sanitizeString)
    ?? readString(stopTurnBehavior.message, sanitizeString);

  return afterStatus === "cancelled"
    || afterMessage?.toLowerCase().includes("task stopped") === true;
}

function readRouteDetail({
  currentTurn,
  replay,
  latestReplayEvent,
  includeCommandDetail,
  sanitizeString
}: {
  currentTurn: Record<string, unknown> | undefined;
  replay: Record<string, unknown> | undefined;
  latestReplayEvent: Record<string, unknown> | undefined;
  includeCommandDetail: boolean;
  sanitizeString?: (value: string) => string | undefined;
}): string {
  const error = readRecord(currentTurn?.error);
  const latestToolCall = readRecord(replay?.latestToolCall);
  const stopTurnBehavior = readStopTurnBehavior(currentTurn, replay, latestReplayEvent);
  return readString(error?.message, sanitizeString)
    ?? readString(currentTurn?.error, sanitizeString)
    ?? readString(currentTurn?.routeReason, sanitizeString)
    ?? readString(currentTurn?.reason, sanitizeString)
    ?? readString(currentTurn?.latestMessage, sanitizeString)
    ?? readString(currentTurn?.message, sanitizeString)
    ?? readString(latestReplayEvent?.routeReason, sanitizeString)
    ?? readString(latestReplayEvent?.reason, sanitizeString)
    ?? readString(latestReplayEvent?.latestMessage, sanitizeString)
    ?? readString(latestReplayEvent?.message, sanitizeString)
    ?? readString(stopTurnBehavior?.afterMessage, sanitizeString)
    ?? readString(stopTurnBehavior?.message, sanitizeString)
    ?? readString(latestToolCall?.summary, sanitizeString)
    ?? readString(latestToolCall?.evidenceSummary, sanitizeString)
    ?? (includeCommandDetail ? readString(currentTurn?.command, sanitizeString) : undefined)
    ?? readString(currentTurn?.targetApp, sanitizeString)
    ?? readString(replay?.latestMessage, sanitizeString)
    ?? "No route activity has been recorded yet.";
}

function readRouteLabel(
  currentTurn: Record<string, unknown> | undefined,
  replay: Record<string, unknown> | undefined,
  latestReplayEvent: Record<string, unknown> | undefined,
  sanitizeString?: (value: string) => string | undefined
): string | undefined {
  const latestAction = readRecord(currentTurn?.latestAction);
  const latestToolCall = readRecord(replay?.latestToolCall);

  return readRouteValue(currentTurn?.route, sanitizeString)
    ?? readRouteValue(currentTurn?.targetRoute, sanitizeString)
    ?? readRouteValue(latestAction?.route, sanitizeString)
    ?? readRouteValue(latestReplayEvent?.route, sanitizeString)
    ?? readRouteValue(latestReplayEvent?.targetRoute, sanitizeString)
    ?? readRouteValue(latestToolCall?.route, sanitizeString)
    ?? readString(currentTurn?.targetApp, sanitizeString)
    ?? readString(currentTurn?.targetBundleId, sanitizeString);
}

function readReplayRouteState(
  replay: Record<string, unknown> | undefined,
  latestReplayEvent: Record<string, unknown> | undefined,
  latestToolCall: Record<string, unknown> | undefined,
  sanitizeString?: (value: string) => string | undefined
): string | undefined {
  return readRouteStateString(latestReplayEvent?.status, sanitizeString)
    ?? readRouteStateFromReplayOutcome(readString(replay?.outcome, sanitizeString))
    ?? readRouteStateFromReplayOutcome(readString(readRecord(replay?.transcript)?.outcome, sanitizeString))
    ?? readRouteStateString(latestToolCall?.status, sanitizeString)
    ?? readRouteStateString(replay?.state, sanitizeString);
}

function readRouteStateFromReplayOutcome(outcome: string | undefined): string | undefined {
  if (!outcome) {
    return undefined;
  }

  return readRouteStateValue(outcome);
}

function readRouteStateValue(value: string | undefined): string | undefined {
  if (!value || value === "available" || value === "empty" || value === "missing") {
    return undefined;
  }

  if (
    value === "approval-required"
    || value === "requires_approval"
    || value === "requires-approval"
    || value === "needs_approval"
    || value === "needs-approval"
  ) {
    return "approval_required";
  }

  if (value === "needs_user_confirmation" || value === "needs-user-confirmation" || value === "needs-confirmation") {
    return "needs_confirmation";
  }

  if (value === "needs_user_clarification" || value === "needs-user-clarification" || value === "needs-clarification") {
    return "needs_clarification";
  }

  if (value === "verification_failed") {
    return "needs_confirmation";
  }

  if (value === "passed" || value === "verified" || value === "ok" || value === "success" || value === "succeeded") {
    return "completed";
  }

  if (value === "error" || value === "errored" || value === "timed_out" || value === "timed-out" || value === "timeout") {
    return "failed";
  }

  if (
    value === "app-policy-denied"
    || value === "app_policy_blocked"
    || value === "app-policy-blocked"
    || value === "blocked_by_app_policy"
    || value === "blocked-by-app-policy"
    || value === "denied_by_app_policy"
    || value === "denied-by-app-policy"
  ) {
    return "app_policy_denied";
  }

  if (
    value === "chrome-host-policy-denied"
    || value === "chrome_host_policy_blocked"
    || value === "chrome-host-policy-blocked"
    || value === "host_policy_blocked"
    || value === "host-policy-blocked"
    || value === "blocked_by_host_policy"
    || value === "blocked-by-host-policy"
    || value === "blocked_by_chrome_host_policy"
    || value === "blocked-by-chrome-host-policy"
    || value === "denied_by_host_policy"
    || value === "denied-by-host-policy"
    || value === "denied_by_chrome_host_policy"
    || value === "denied-by-chrome-host-policy"
  ) {
    return "chrome_host_policy_denied";
  }

  if (value === "user-denied" || value === "denied_by_user" || value === "denied-by-user") {
    return "user_denied";
  }

  if (value === "canceled") {
    return "cancelled";
  }

  return value;
}

function readRouteStateString(
  value: unknown,
  sanitizeString?: (value: string) => string | undefined
): string | undefined {
  return readRouteStateValue(readString(value, sanitizeString));
}

function readExplicitRouteOutcomeValue(
  kind: RouteOutcomeKind,
  value: unknown,
  fallbackValue: string,
  sanitizeString?: (value: string) => string | undefined
): string {
  const sanitized = readString(value, sanitizeString);
  const stateValue = readRouteStateValue(sanitized);
  return kind === stateValue
    ? stateValue
    : sanitized ?? fallbackValue;
}

function readLatestReplayEvent(
  replay: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const timelineTail = readRecordArray(replay?.timelineTail);
  const timeline = readRecordArray(replay?.timeline);
  return timelineTail.at(-1) ?? timeline.at(-1);
}

function readStopTurnBehavior(
  currentTurn: Record<string, unknown> | undefined,
  replay: Record<string, unknown> | undefined,
  latestReplayEvent: Record<string, unknown> | undefined = readLatestReplayEvent(replay)
): Record<string, unknown> | undefined {
  return readRecord(currentTurn?.stopTurnBehavior)
    ?? readRecord(latestReplayEvent?.stopTurnBehavior)
    ?? readRecord(replay?.stopTurnBehavior);
}

function readRouteValue(
  value: unknown,
  sanitizeString?: (value: string) => string | undefined
): string | undefined {
  const text = readString(value, sanitizeString);
  if (text) {
    return text;
  }

  const record = readRecord(value);
  return readString(record?.kind, sanitizeString)
    ?? readString(record?.route, sanitizeString)
    ?? readString(record?.bundleId, sanitizeString)
    ?? readString(record?.sessionName, sanitizeString);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const record = readRecord(item);
    return record ? [record] : [];
  }) : [];
}

function readString(
  value: unknown,
  sanitizeString?: (value: string) => string | undefined
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return sanitizeString ? sanitizeString(value) : value;
}
