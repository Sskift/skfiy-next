import { CircleStop, History } from "lucide-react";
import { useState } from "react";
import type { AutomationRunRecord, AutomationRunSnapshot } from "./app-types";
import {
  describeAutomationRunOutcome,
  formatAutomationRunTimestamp,
  formatAutomationRunTimelineEntry,
  isAutomationRunTerminal,
  readAutomationRunStateLabel,
  readAutomationRunStateTone,
  readAutomationRunStepLabel,
  readAutomationRunTriggerLabel,
  type AutomationRunStatusTone
} from "./app-automation-run-state";

export interface AutomationRunPanelProps {
  snapshot: AutomationRunSnapshot;
  actionPending: boolean;
  onStopRun: (runId: string) => void;
}

export function AutomationRunPanel({
  snapshot,
  actionPending,
  onStopRun
}: AutomationRunPanelProps) {
  if (snapshot.runs.length === 0) {
    return null;
  }

  return (
    <section className="automation-run-panel" aria-label="自动化运行记录">
      <div className="automation-run-heading">
        <History size={12} aria-hidden="true" />
        <strong>运行记录</strong>
      </div>
      <ul className="automation-run-list">
        {snapshot.runs.map((run) => (
          <AutomationRunRow
            key={run.runId}
            run={run}
            actionPending={actionPending}
            onStopRun={onStopRun}
          />
        ))}
      </ul>
    </section>
  );
}

function AutomationRunRow({
  run,
  actionPending,
  onStopRun
}: {
  run: AutomationRunRecord;
  actionPending: boolean;
  onStopRun: (runId: string) => void;
}) {
  const [timelineOpen, setTimelineOpen] = useState(false);
  const terminal = isAutomationRunTerminal(run.state);

  return (
    <li className="automation-run-row" data-state={run.state}>
      <div className="automation-run-summary">
        <AutomationRunChip state={run.state} />
        <span className="automation-run-trigger">
          {readAutomationRunTriggerLabel(run.trigger)}
        </span>
        <span className="automation-run-attempt">
          第 {run.attempt}/{run.maxAttempts} 次
        </span>
        <span className="automation-run-step">
          {readAutomationRunStepLabel(run.currentStep)}
        </span>
        <span className="automation-run-updated">
          {formatAutomationRunTimestamp(run.updatedAt)}
        </span>
        <p className="automation-run-outcome">{describeAutomationRunOutcome(run)}</p>
      </div>
      <div className="automation-run-actions">
        <button
          type="button"
          aria-label={`查看时间线：${run.runId}`}
          disabled={actionPending || run.timeline.length === 0}
          onClick={() => setTimelineOpen((open) => !open)}
        >
          <History size={11} aria-hidden="true" />
          时间线
        </button>
        <button
          type="button"
          aria-label={`停止运行：${run.runId}`}
          disabled={actionPending || terminal}
          onClick={() => onStopRun(run.runId)}
        >
          <CircleStop size={11} aria-hidden="true" />
          停止
        </button>
      </div>
      {timelineOpen ? (
        <AutomationRunTimelineDrawer run={run} />
      ) : null}
    </li>
  );
}

export function AutomationRunChip({ state }: { state: AutomationRunRecord["state"] }) {
  const tone: AutomationRunStatusTone = readAutomationRunStateTone(state);
  return (
    <span className="automation-run-chip" data-tone={tone}>
      {readAutomationRunStateLabel(state)}
    </span>
  );
}

function AutomationRunTimelineDrawer({ run }: { run: AutomationRunRecord }) {
  const entries = [...run.timeline].reverse();
  return (
    <dl className="automation-run-timeline" aria-label={`${run.runId} 时间线`}>
      {entries.map((entry, index) => (
        <div className="automation-run-timeline-entry" key={`${entry.at}-${index}`}>
          <dt>{formatAutomationRunTimestamp(entry.at)}</dt>
          <dd>{formatAutomationRunTimelineEntry(entry)}</dd>
        </div>
      ))}
    </dl>
  );
}
