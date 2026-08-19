import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createTmuxSupervisionReport,
  parseTmuxPaneList,
  parseTmuxWindowList
} from "./tmux-supervisor";

const WINDOW_LINES = [
  "@1\t0\tagent\t1\t2",
  "@2\t1\tlogs\t0\t1"
].join("\n");
const execFileAsync = promisify(execFile);

const PANE_LINES = [
  "money-run\t@1\t0\tagent\t%1\t0\t1\t0\tzsh\tmain",
  "money-run\t@1\t0\tagent\t%2\t1\t0\t0\tnode\tworker",
  "money-run\t@2\t1\tlogs\t%3\t0\t0\t0\ttail\tlogs"
].join("\n");

describe("parseTmuxWindowList", () => {
  it("parses tmux list-windows tab-separated output", () => {
    expect(parseTmuxWindowList(WINDOW_LINES)).toEqual([
      {
        id: "@1",
        index: 0,
        name: "agent",
        active: true,
        paneCount: 2
      },
      {
        id: "@2",
        index: 1,
        name: "logs",
        active: false,
        paneCount: 1
      }
    ]);
  });
});

describe("parseTmuxPaneList", () => {
  it("parses tmux list-panes tab-separated output", () => {
    expect(parseTmuxPaneList(PANE_LINES)).toEqual([
      {
        id: "%1",
        index: 0,
        active: true,
        dead: false,
        currentCommand: "zsh",
        title: "main",
        sessionName: "money-run",
        windowId: "@1",
        windowIndex: 0,
        windowName: "agent"
      },
      {
        id: "%2",
        index: 1,
        active: false,
        dead: false,
        currentCommand: "node",
        title: "worker",
        sessionName: "money-run",
        windowId: "@1",
        windowIndex: 0,
        windowName: "agent"
      },
      {
        id: "%3",
        index: 0,
        active: false,
        dead: false,
        currentCommand: "tail",
        title: "logs",
        sessionName: "money-run",
        windowId: "@2",
        windowIndex: 1,
        windowName: "logs"
      }
    ]);
  });
});

describe("createTmuxSupervisionReport", () => {
  it("summarizes a live money-run session without mutating it", () => {
    expect(createTmuxSupervisionReport({
      sessionName: "money-run",
      hasSession: true,
      windowsOutput: WINDOW_LINES,
      panesOutput: PANE_LINES,
      paneTails: {
        "%1": "building...\nwaiting for next event",
        "%2": "worker ready",
        "%3": "logs streaming"
      }
    })).toEqual({
      sessionName: "money-run",
      status: "observing",
      summary: {
        windowCount: 2,
        paneCount: 3,
        activePaneIds: ["%1"],
        deadPaneIds: []
      },
      windows: [
        {
          id: "@1",
          index: 0,
          name: "agent",
          active: true,
          paneCount: 2
        },
        {
          id: "@2",
          index: 1,
          name: "logs",
          active: false,
          paneCount: 1
        }
      ],
      panes: [
        expect.objectContaining({
          id: "%1",
          active: true,
          dead: false,
          recentTail: "building...\nwaiting for next event"
        }),
        expect.objectContaining({
          id: "%2",
          active: false,
          dead: false,
          recentTail: "worker ready"
        }),
        expect.objectContaining({
          id: "%3",
          active: false,
          dead: false,
          recentTail: "logs streaming"
        })
      ],
      signals: [],
      recommendation: {
        action: "continue_observing",
        reason: "money-run has 2 windows, 3 panes, and no obvious block markers.",
        mutatesSession: false
      }
    });
  });

  it("blocks when the money-run session does not exist", () => {
    expect(createTmuxSupervisionReport({
      sessionName: "money-run",
      hasSession: false,
      commandError: "can't find session: money-run"
    })).toMatchObject({
      status: "blocked",
      summary: {
        windowCount: 0,
        paneCount: 0,
        activePaneIds: [],
        deadPaneIds: []
      },
      signals: [
        {
          type: "no-session",
          severity: "blocked",
          message: "tmux session money-run was not found."
        }
      ],
      recommendation: {
        action: "manual_recovery",
        reason: "Start or attach the money-run tmux session before supervision can continue.",
        mutatesSession: false
      }
    });
  });

  it("blocks when the session has no panes to supervise", () => {
    expect(createTmuxSupervisionReport({
      sessionName: "money-run",
      hasSession: true,
      windowsOutput: "@1\t0\tagent\t1\t0",
      panesOutput: ""
    })).toMatchObject({
      status: "blocked",
      signals: [
        {
          type: "no-panes",
          severity: "blocked",
          message: "tmux session money-run has no panes."
        }
      ],
      recommendation: {
        action: "manual_recovery",
        reason: "Create or restore a pane in money-run before supervision can continue.",
        mutatesSession: false
      }
    });
  });

  it("blocks when no pane is active", () => {
    expect(createTmuxSupervisionReport({
      sessionName: "money-run",
      hasSession: true,
      windowsOutput: "@1\t0\tagent\t1\t1",
      panesOutput: "money-run\t@1\t0\tagent\t%1\t0\t0\t0\tzsh\tmain"
    })).toMatchObject({
      status: "blocked",
      signals: [
        {
          type: "no-active-pane",
          severity: "blocked",
          message: "tmux session money-run has no active panes."
        }
      ],
      recommendation: {
        action: "inspect_state",
        reason: "Inspect money-run pane focus/state before deciding whether to recover it.",
        mutatesSession: false
      }
    });
  });

  it("blocks when the active pane is dead", () => {
    expect(createTmuxSupervisionReport({
      sessionName: "money-run",
      hasSession: true,
      windowsOutput: "@1\t0\tagent\t1\t1",
      panesOutput: "money-run\t@1\t0\tagent\t%1\t0\t1\t1\tzsh\tmain"
    })).toMatchObject({
      status: "blocked",
      summary: {
        activePaneIds: ["%1"],
        deadPaneIds: ["%1"]
      },
      signals: [
        {
          type: "dead-pane",
          severity: "blocked",
          paneId: "%1",
          message: "tmux pane %1 is dead."
        },
        {
          type: "active-pane-dead",
          severity: "blocked",
          paneId: "%1",
          message: "tmux active pane %1 is dead."
        }
      ],
      recommendation: {
        action: "manual_recovery",
        reason: "Recover the dead money-run pane before supervision can continue.",
        mutatesSession: false
      }
    });
  });

  it("asks for user input when recent output looks like an approval prompt", () => {
    expect(createTmuxSupervisionReport({
      sessionName: "money-run",
      hasSession: true,
      windowsOutput: "@1\t0\tagent\t1\t1",
      panesOutput: "money-run\t@1\t0\tagent\t%1\t0\t1\t0\tcodex\tmain",
      paneTails: {
        "%1": "Do you want to allow this command?\nApprove or deny"
      }
    })).toMatchObject({
      status: "needs_attention",
      signals: [
        {
          type: "approval-needed",
          severity: "attention",
          paneId: "%1",
          matchedText: "allow this command"
        }
      ],
      recommendation: {
        action: "ask_user",
        reason: "money-run appears to be waiting for approval in pane %1.",
        mutatesSession: false
      }
    });
  });

  it("does not treat research text mentioning confirmation grids as approval prompts", () => {
    expect(createTmuxSupervisionReport({
      sessionName: "money-run-goal",
      hasSession: true,
      windowsOutput: "@4\t1\tnode\t1\t1",
      panesOutput: "money-run-goal\t@4\t1\tnode\t%4\t0\t1\t0\tnode\tmoney-run-goal-e8654",
      paneTails: {
        "%4": [
          "下一轮趋势预判优先级：premium_mom24 的单变量 threshold / hold grid、简单 confirmation grid。",
          "Working (25m 12s) · 1 background terminal running"
        ].join("\n")
      }
    })).toMatchObject({
      sessionName: "money-run-goal",
      status: "observing",
      signals: [],
      recommendation: {
        action: "continue_observing",
        reason: "money-run-goal has 1 window, 1 pane, and no obvious block markers.",
        mutatesSession: false
      }
    });
  });

  it("accepts tmux panes with an empty title field", () => {
    expect(createTmuxSupervisionReport({
      sessionName: "money-run-goal",
      hasSession: true,
      windowsOutput: "@4\t1\tzsh\t1\t1",
      panesOutput: "money-run-goal\t@4\t1\tzsh\t%4\t1\t1\t0\tzsh\t",
      paneTails: {
        "%4": "Working (2m) · 1 background terminal running"
      }
    })).toMatchObject({
      sessionName: "money-run-goal",
      status: "observing",
      panes: [
        {
          id: "%4",
          title: ""
        }
      ]
    });
  });

  it("recommends inspection when recent output has obvious error markers", () => {
    expect(createTmuxSupervisionReport({
      sessionName: "money-run",
      hasSession: true,
      windowsOutput: "@1\t0\tagent\t1\t1",
      panesOutput: "money-run\t@1\t0\tagent\t%1\t0\t1\t0\tnode\tmain",
      paneTails: {
        "%1": "Traceback (most recent call last):\nError: permission denied"
      }
    })).toMatchObject({
      status: "needs_attention",
      signals: [
        {
          type: "error-marker",
          severity: "attention",
          paneId: "%1",
          matchedText: "Traceback"
        }
      ],
      recommendation: {
        action: "inspect_output",
        reason: "money-run recent output contains an obvious error marker in pane %1.",
        mutatesSession: false
      }
    });
  });
});
