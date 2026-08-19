import { describe, expect, it } from "vitest";
import { runTmuxSupervisionTask, type TmuxSupervisionTaskClient } from "./tmux-supervision-task";

describe("runTmuxSupervisionTask", () => {
  it("requests approval before reading money-run pane output", async () => {
    const client: TmuxSupervisionTaskClient = {
      observeSession: async () => {
        throw new Error("should not read tmux before approval");
      }
    };

    await expect(collect(runTmuxSupervisionTask("money-run", client))).resolves.toEqual([
      {
        type: "started",
        sessionName: "money-run",
        risk: {
          level: "medium",
          reason: "tmux supervision reads recent pane output but does not mutate the session.",
          requiresApproval: true
        }
      },
      {
        type: "approval_required",
        sessionName: "money-run",
        risk: {
          level: "medium",
          reason: "tmux supervision reads recent pane output but does not mutate the session.",
          requiresApproval: true
        }
      }
    ]);
  });

  it("emits a non-mutating report after approval", async () => {
    const client: TmuxSupervisionTaskClient = {
      observeSession: async (sessionName) => ({
        sessionName,
        status: "observing",
        summary: {
          windowCount: 1,
          paneCount: 1,
          activePaneIds: ["%11"],
          deadPaneIds: []
        },
        windows: [
          {
            id: "@11",
            index: 1,
            name: "node",
            active: true,
            paneCount: 1
          }
        ],
        panes: [
          {
            id: "%11",
            index: 1,
            active: true,
            dead: false,
            currentCommand: "node",
            title: "money-run-d1246",
            sessionName,
            windowId: "@11",
            windowIndex: 1,
            windowName: "node",
            recentTail: "account equity +0.9%"
          }
        ],
        signals: [],
        recommendation: {
          action: "continue_observing",
          reason: "money-run has 1 window, 1 pane, and no obvious block markers.",
          mutatesSession: false
        }
      })
    };

    await expect(collect(runTmuxSupervisionTask("money-run", client, {
      approved: true
    }))).resolves.toEqual([
      {
        type: "started",
        sessionName: "money-run",
        risk: {
          level: "medium",
          reason: "tmux supervision reads recent pane output but does not mutate the session.",
          requiresApproval: true
        }
      },
      {
        type: "observing",
        sessionName: "money-run",
        message: "Reading tmux session money-run with read-only probes."
      },
      {
        type: "completed",
        sessionName: "money-run",
        report: expect.objectContaining({
          status: "observing",
          recommendation: {
            action: "continue_observing",
            reason: "money-run has 1 window, 1 pane, and no obvious block markers.",
            mutatesSession: false
          }
        }),
        summary: "money-run supervision: observing. money-run has 1 window, 1 pane, and no obvious block markers."
      }
    ]);
  });
});

async function collect<T>(events: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];

  for await (const event of events) {
    result.push(event);
  }

  return result;
}
