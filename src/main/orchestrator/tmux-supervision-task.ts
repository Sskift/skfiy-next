import type { RiskDecision } from "../../shared/types.js";
import type { TmuxSupervisionReport } from "../computer-use/tmux-supervisor.js";

const TMUX_SUPERVISION_RISK: RiskDecision = {
  level: "medium",
  reason: "tmux supervision reads recent pane output but does not mutate the session.",
  requiresApproval: true
};

export interface TmuxSupervisionTaskClient {
  observeSession(sessionName: string): Promise<TmuxSupervisionReport>;
}

export type TmuxSupervisionTaskEvent =
  | {
      type: "started";
      sessionName: string;
      risk: RiskDecision;
    }
  | {
      type: "approval_required";
      sessionName: string;
      risk: RiskDecision;
    }
  | {
      type: "observing";
      sessionName: string;
      message: string;
    }
  | {
      type: "completed";
      sessionName: string;
      report: TmuxSupervisionReport;
      summary: string;
    }
  | {
      type: "verification_failed";
      stage: "tmux";
      reason: string;
    };

export interface TmuxSupervisionTaskOptions {
  approved?: boolean;
}

export async function* runTmuxSupervisionTask(
  sessionName: string,
  client: TmuxSupervisionTaskClient,
  options: TmuxSupervisionTaskOptions = {}
): AsyncGenerator<TmuxSupervisionTaskEvent> {
  yield {
    type: "started",
    sessionName,
    risk: TMUX_SUPERVISION_RISK
  };

  if (!options.approved) {
    yield {
      type: "approval_required",
      sessionName,
      risk: TMUX_SUPERVISION_RISK
    };
    return;
  }

  yield {
    type: "observing",
    sessionName,
    message: `Reading tmux session ${sessionName} with read-only probes.`
  };

  try {
    const report = await client.observeSession(sessionName);

    yield {
      type: "completed",
      sessionName,
      report,
      summary: `${sessionName} supervision: ${report.status}. ${report.recommendation.reason}`
    };
  } catch (error) {
    yield {
      type: "verification_failed",
      stage: "tmux",
      reason: error instanceof Error ? error.message : "tmux supervision failed."
    };
  }
}
