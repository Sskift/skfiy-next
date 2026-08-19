export interface TmuxWindowState {
  id: string;
  index: number;
  name: string;
  active: boolean;
  paneCount: number;
}

export interface TmuxPaneState {
  id: string;
  index: number;
  active: boolean;
  dead: boolean;
  currentCommand: string;
  title: string;
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
}

export interface TmuxPaneSummary extends TmuxPaneState {
  recentTail: string;
}

export type TmuxSupervisionStatus = "observing" | "needs_attention" | "blocked";

export type TmuxSignal =
  | {
      type: "no-session";
      severity: "blocked";
      message: string;
    }
  | {
      type: "no-panes";
      severity: "blocked";
      message: string;
    }
  | {
      type: "no-active-pane";
      severity: "blocked";
      message: string;
    }
  | {
      type: "dead-pane" | "active-pane-dead";
      severity: "blocked";
      paneId: string;
      message: string;
    }
  | {
      type: "approval-needed" | "error-marker";
      severity: "attention";
      paneId: string;
      matchedText: string;
      message: string;
    };

export type TmuxRecommendationAction =
  | "continue_observing"
  | "manual_recovery"
  | "inspect_state"
  | "ask_user"
  | "inspect_output";

export interface TmuxRecommendation {
  action: TmuxRecommendationAction;
  reason: string;
  mutatesSession: false;
}

export interface TmuxSupervisionSummary {
  windowCount: number;
  paneCount: number;
  activePaneIds: string[];
  deadPaneIds: string[];
}

export interface TmuxSupervisionReport {
  sessionName: string;
  status: TmuxSupervisionStatus;
  summary: TmuxSupervisionSummary;
  windows: TmuxWindowState[];
  panes: TmuxPaneSummary[];
  signals: TmuxSignal[];
  recommendation: TmuxRecommendation;
}

export interface CreateTmuxSupervisionReportInput {
  sessionName?: string;
  hasSession: boolean;
  windowsOutput?: string;
  panesOutput?: string;
  paneTails?: Record<string, string | undefined>;
  commandError?: string;
  maxTailCharacters?: number;
}

const DEFAULT_SESSION_NAME = "money-run";
const DEFAULT_MAX_TAIL_CHARACTERS = 4_000;

const APPROVAL_MARKERS: RegExp[] = [
  /approval required/i,
  /requires approval/i,
  /permission required/i,
  /allow this command/i,
  /approve or deny/i,
  /are you sure/i,
  /proceed\?/i,
  /\bconfirm(?:\s+(?:this|command|action|operation|request)|\?)\b/i
];

const ERROR_MARKERS: RegExp[] = [
  /Traceback/i,
  /Error:/i,
  /permission denied/i,
  /command not found/i,
  /fatal:/i,
  /npm ERR!/i,
  /failed/i,
  /exception/i
];

export function parseTmuxWindowList(output: string | undefined): TmuxWindowState[] {
  return splitNonEmptyLines(output).map((line) => {
    const fields = line.split("\t");

    if (fields.length < 5) {
      throw new Error(`Invalid tmux window line: ${line}`);
    }

    const [id, index, name, active, paneCount] = fields;

    return {
      id,
      index: parseInteger(index, "window_index", line),
      name,
      active: parseTmuxBoolean(active, "window_active", line),
      paneCount: parseInteger(paneCount, "window_panes", line)
    };
  });
}

export function parseTmuxPaneList(output: string | undefined): TmuxPaneState[] {
  return splitNonEmptyLines(output).map((line) => {
    const fields = line.split("\t");

    if (fields.length < 10) {
      throw new Error(`Invalid tmux pane line: ${line}`);
    }

    const [
      sessionName,
      windowId,
      windowIndex,
      windowName,
      id,
      index,
      active,
      dead,
      currentCommand,
      title
    ] = fields;

    return {
      id,
      index: parseInteger(index, "pane_index", line),
      active: parseTmuxBoolean(active, "pane_active", line),
      dead: parseTmuxBoolean(dead, "pane_dead", line),
      currentCommand,
      title,
      sessionName,
      windowId,
      windowIndex: parseInteger(windowIndex, "window_index", line),
      windowName
    };
  });
}

export function createTmuxSupervisionReport(
  input: CreateTmuxSupervisionReportInput
): TmuxSupervisionReport {
  const sessionName = input.sessionName ?? DEFAULT_SESSION_NAME;

  if (!input.hasSession) {
    return createNoSessionReport(sessionName);
  }

  const windows = parseTmuxWindowList(input.windowsOutput);
  const panes = parseTmuxPaneList(input.panesOutput).map((pane) => ({
    ...pane,
    recentTail: truncateTail(input.paneTails?.[pane.id] ?? "", input.maxTailCharacters)
  }));
  const summary = createSummary(windows, panes);
  const signals = detectSignals(sessionName, panes);
  const status = readStatus(signals);
  const recommendation = createRecommendation({
    sessionName,
    summary,
    signals
  });

  return {
    sessionName,
    status,
    summary,
    windows,
    panes,
    signals,
    recommendation
  };
}

function createNoSessionReport(sessionName: string): TmuxSupervisionReport {
  const signal: TmuxSignal = {
    type: "no-session",
    severity: "blocked",
    message: `tmux session ${sessionName} was not found.`
  };

  return {
    sessionName,
    status: "blocked",
    summary: {
      windowCount: 0,
      paneCount: 0,
      activePaneIds: [],
      deadPaneIds: []
    },
    windows: [],
    panes: [],
    signals: [signal],
    recommendation: createRecommendation({
      sessionName,
      summary: {
        windowCount: 0,
        paneCount: 0,
        activePaneIds: [],
        deadPaneIds: []
      },
      signals: [signal]
    })
  };
}

function createSummary(
  windows: readonly TmuxWindowState[],
  panes: readonly TmuxPaneSummary[]
): TmuxSupervisionSummary {
  return {
    windowCount: windows.length,
    paneCount: panes.length,
    activePaneIds: panes.filter((pane) => pane.active).map((pane) => pane.id),
    deadPaneIds: panes.filter((pane) => pane.dead).map((pane) => pane.id)
  };
}

function detectSignals(
  sessionName: string,
  panes: readonly TmuxPaneSummary[]
): TmuxSignal[] {
  if (panes.length === 0) {
    return [
      {
        type: "no-panes",
        severity: "blocked",
        message: `tmux session ${sessionName} has no panes.`
      }
    ];
  }

  const signals: TmuxSignal[] = [];
  const activePanes = panes.filter((pane) => pane.active);

  for (const pane of panes) {
    if (pane.dead) {
      signals.push({
        type: "dead-pane",
        severity: "blocked",
        paneId: pane.id,
        message: `tmux pane ${pane.id} is dead.`
      });
    }
  }

  if (activePanes.length === 0) {
    signals.push({
      type: "no-active-pane",
      severity: "blocked",
      message: `tmux session ${sessionName} has no active panes.`
    });
  }

  for (const pane of activePanes) {
    if (pane.dead) {
      signals.push({
        type: "active-pane-dead",
        severity: "blocked",
        paneId: pane.id,
        message: `tmux active pane ${pane.id} is dead.`
      });
    }
  }

  if (signals.some((signal) => signal.severity === "blocked")) {
    return signals;
  }

  for (const pane of panes) {
    const approvalMatch = findMarker(pane.recentTail, APPROVAL_MARKERS);

    if (approvalMatch) {
      signals.push({
        type: "approval-needed",
        severity: "attention",
        paneId: pane.id,
        matchedText: approvalMatch,
        message: `tmux pane ${pane.id} appears to be waiting for approval.`
      });
      continue;
    }

    const errorMatch = findMarker(pane.recentTail, ERROR_MARKERS);

    if (errorMatch) {
      signals.push({
        type: "error-marker",
        severity: "attention",
        paneId: pane.id,
        matchedText: errorMatch,
        message: `tmux pane ${pane.id} recent output contains an obvious error marker.`
      });
    }
  }

  return signals;
}

function readStatus(signals: readonly TmuxSignal[]): TmuxSupervisionStatus {
  if (signals.some((signal) => signal.severity === "blocked")) {
    return "blocked";
  }

  if (signals.some((signal) => signal.severity === "attention")) {
    return "needs_attention";
  }

  return "observing";
}

function createRecommendation(input: {
  sessionName: string;
  summary: TmuxSupervisionSummary;
  signals: readonly TmuxSignal[];
}): TmuxRecommendation {
  const noSession = input.signals.find((signal) => signal.type === "no-session");

  if (noSession) {
    return {
      action: "manual_recovery",
      reason: `Start or attach the ${input.sessionName} tmux session before supervision can continue.`,
      mutatesSession: false
    };
  }

  const noPanes = input.signals.find((signal) => signal.type === "no-panes");

  if (noPanes) {
    return {
      action: "manual_recovery",
      reason: `Create or restore a pane in ${input.sessionName} before supervision can continue.`,
      mutatesSession: false
    };
  }

  const activePaneDead = input.signals.find((signal) => signal.type === "active-pane-dead");
  const deadPane = input.signals.find((signal) => signal.type === "dead-pane");

  if (activePaneDead || deadPane) {
    return {
      action: "manual_recovery",
      reason: `Recover the dead ${input.sessionName} pane before supervision can continue.`,
      mutatesSession: false
    };
  }

  const noActivePane = input.signals.find((signal) => signal.type === "no-active-pane");

  if (noActivePane) {
    return {
      action: "inspect_state",
      reason: `Inspect ${input.sessionName} pane focus/state before deciding whether to recover it.`,
      mutatesSession: false
    };
  }

  const approval = input.signals.find((signal) => signal.type === "approval-needed");

  if (approval && "paneId" in approval) {
    return {
      action: "ask_user",
      reason: `${input.sessionName} appears to be waiting for approval in pane ${approval.paneId}.`,
      mutatesSession: false
    };
  }

  const error = input.signals.find((signal) => signal.type === "error-marker");

  if (error && "paneId" in error) {
    return {
      action: "inspect_output",
      reason: `${input.sessionName} recent output contains an obvious error marker in pane ${error.paneId}.`,
      mutatesSession: false
    };
  }

  return {
    action: "continue_observing",
    reason: `${input.sessionName} has ${input.summary.windowCount} ${pluralize("window", input.summary.windowCount)}, ${input.summary.paneCount} ${pluralize("pane", input.summary.paneCount)}, and no obvious block markers.`,
    mutatesSession: false
  };
}

function splitNonEmptyLines(output: string | undefined): string[] {
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
}

function parseInteger(value: string, field: string, line: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${field} in tmux line: ${line}`);
  }

  return parsed;
}

function parseTmuxBoolean(value: string, field: string, line: string): boolean {
  if (value === "1") {
    return true;
  }

  if (value === "0") {
    return false;
  }

  throw new Error(`Invalid ${field} in tmux line: ${line}`);
}

function findMarker(text: string, markers: readonly RegExp[]): string | undefined {
  for (const marker of markers) {
    const match = marker.exec(text);

    if (match?.[0]) {
      return match[0];
    }
  }

  return undefined;
}

function truncateTail(text: string, maxCharacters = DEFAULT_MAX_TAIL_CHARACTERS): string {
  if (text.length <= maxCharacters) {
    return text;
  }

  return text.slice(text.length - maxCharacters);
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
