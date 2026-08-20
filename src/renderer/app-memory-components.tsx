import { RefreshCw } from "lucide-react";
import type {
  PendingPersonalMemoryWrite,
  PersonalMemoryDashboardSnapshot,
  PersonalMemoryJournalEntry,
  PersonalMemorySettings
} from "./app-types";
import {
  describePersonalMemoryAction,
  formatMemoryUsage,
  formatPersonalMemoryTimestamp,
  readMemoryUsageTone,
  type PersonalMemoryFeedback
} from "./app-memory-state";

export interface MemoryControlCenterPanelProps {
  snapshot: PersonalMemoryDashboardSnapshot;
  feedback: PersonalMemoryFeedback | null;
  actionPending: boolean;
  onRefresh: () => void;
  onForget: (target: "user" | "agent", content: string) => void;
  onApprove: (pendingId: string) => void;
  onReject: (pendingId: string) => void;
  onUpdateSettings: (update: {
    postTurnLearningEnabled?: boolean;
    writeApprovalEnabled?: boolean;
  }) => void;
}

export function MemoryControlCenterPanel({
  snapshot,
  feedback,
  actionPending,
  onRefresh,
  onForget,
  onApprove,
  onReject,
  onUpdateSettings
}: MemoryControlCenterPanelProps) {
  return (
    <section className="memory-control-center" aria-label="记忆控制中心">
      <div className="memory-heading">
        <strong>记忆控制中心</strong>
        <button
          type="button"
          aria-label="刷新记忆状态"
          disabled={actionPending}
          onClick={onRefresh}
        >
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>
      <MemoryStatusChips snapshot={snapshot} />
      <MemorySettingsToggles
        settings={snapshot.settings}
        actionPending={actionPending}
        onUpdateSettings={onUpdateSettings}
      />
      <div className="memory-entry-grid">
        <MemoryEntryList
          title="用户偏好"
          entries={snapshot.userEntries}
          actionPending={actionPending}
          onForget={(content) => onForget("user", content)}
        />
        <MemoryEntryList
          title="Agent 操作备注"
          entries={snapshot.agentEntries}
          actionPending={actionPending}
          onForget={(content) => onForget("agent", content)}
        />
      </div>
      <PendingMemoryWriteList
        writes={snapshot.pendingWrites}
        actionPending={actionPending}
        onApprove={onApprove}
        onReject={onReject}
      />
      <MemoryJournalTrail entries={snapshot.journal} />
      <MemoryFeedbackLine feedback={feedback} />
    </section>
  );
}

function MemoryStatusChips({ snapshot }: { snapshot: PersonalMemoryDashboardSnapshot }) {
  return (
    <div className="memory-status-chips" aria-label="记忆状态">
      <span className="memory-chip" data-tone="neutral">
        用户偏好 {snapshot.userEntries.length}
      </span>
      <span className="memory-chip" data-tone="neutral">
        Agent 备注 {snapshot.agentEntries.length}
      </span>
      <span className="memory-chip" data-tone="neutral">
        会话 {snapshot.sessionCount}
      </span>
      <span
        className="memory-chip"
        data-tone={snapshot.pendingWrites.length > 0 ? "warning" : "neutral"}
      >
        待审批 {snapshot.pendingWrites.length}
      </span>
      <span
        className="memory-chip"
        data-tone={readMemoryUsageTone(snapshot.usage.user.percent)}
      >
        用户预算 {formatMemoryUsage(snapshot.usage.user)}
      </span>
      <span
        className="memory-chip"
        data-tone={readMemoryUsageTone(snapshot.usage.agent.percent)}
      >
        Agent 预算 {formatMemoryUsage(snapshot.usage.agent)}
      </span>
      <span className="memory-chip" data-tone="neutral">
        更新于 {formatPersonalMemoryTimestamp(snapshot.latestUpdatedAt)}
      </span>
    </div>
  );
}

function MemorySettingsToggles({
  settings,
  actionPending,
  onUpdateSettings
}: {
  settings: PersonalMemorySettings;
  actionPending: boolean;
  onUpdateSettings: MemoryControlCenterPanelProps["onUpdateSettings"];
}) {
  return (
    <div className="memory-settings-toggles">
      <div className="memory-toggle-row">
        <span>回合后学习</span>
        <button
          type="button"
          className="memory-toggle"
          aria-label="回合后学习开关"
          aria-pressed={settings.postTurnLearningEnabled}
          disabled={actionPending}
          onClick={() => onUpdateSettings({
            postTurnLearningEnabled: !settings.postTurnLearningEnabled
          })}
        >
          {settings.postTurnLearningEnabled ? "开" : "关"}
        </button>
      </div>
      <div className="memory-toggle-row">
        <span>写入审批模式</span>
        <button
          type="button"
          className="memory-toggle"
          aria-label="写入审批模式开关"
          aria-pressed={settings.writeApprovalEnabled}
          disabled={actionPending}
          onClick={() => onUpdateSettings({
            writeApprovalEnabled: !settings.writeApprovalEnabled
          })}
        >
          {settings.writeApprovalEnabled ? "开" : "关"}
        </button>
      </div>
    </div>
  );
}

function MemoryEntryList({
  title,
  entries,
  actionPending,
  onForget
}: {
  title: string;
  entries: string[];
  actionPending: boolean;
  onForget: (content: string) => void;
}) {
  return (
    <div className="memory-entry-list" aria-label={title}>
      <h4>{title}</h4>
      {entries.length > 0 ? (
        <ul>
          {entries.map((entry) => (
            <li key={entry}>
              <span>{entry}</span>
              <button
                type="button"
                aria-label={`忘记：${entry}`}
                disabled={actionPending}
                onClick={() => onForget(entry)}
              >
                忘记
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="memory-empty">暂无记忆</p>
      )}
    </div>
  );
}

function PendingMemoryWriteList({
  writes,
  actionPending,
  onApprove,
  onReject
}: {
  writes: PendingPersonalMemoryWrite[];
  actionPending: boolean;
  onApprove: (pendingId: string) => void;
  onReject: (pendingId: string) => void;
}) {
  if (writes.length === 0) {
    return null;
  }

  return (
    <div className="memory-pending-list" aria-label="待审批记忆写入">
      <h4>待审批写入</h4>
      <ul>
        {writes.map((write) => (
          <li key={write.id}>
            <div className="memory-pending-content">
              <strong>{describePersonalMemoryAction(write.action, write.target)}</strong>
              <span>{write.content}</span>
              <small>
                {write.source} · {formatPersonalMemoryTimestamp(write.createdAt)}
              </small>
            </div>
            <div className="memory-pending-actions">
              <button
                type="button"
                aria-label={`批准：${write.content}`}
                disabled={actionPending}
                onClick={() => onApprove(write.id)}
              >
                批准
              </button>
              <button
                type="button"
                aria-label={`拒绝：${write.content}`}
                disabled={actionPending}
                onClick={() => onReject(write.id)}
              >
                拒绝
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MemoryJournalTrail({ entries }: { entries: PersonalMemoryJournalEntry[] }) {
  return (
    <div className="memory-journal-trail" aria-label="记忆变更记录">
      <h4>记忆变更记录</h4>
      {entries.length > 0 ? (
        <ol>
          {entries.map((entry) => (
            <li key={entry.id} data-stage={entry.stage}>
              <span>
                {describePersonalMemoryAction(entry.action, entry.target)}
                {" · "}
                {entry.providerLabel}
                {" · "}
                {entry.stage === "durable" ? "已写入" : "待审批"}
              </span>
              <strong>{entry.content}</strong>
              <small>
                回合 {entry.turnId} · {formatPersonalMemoryTimestamp(entry.createdAt)}
              </small>
            </li>
          ))}
        </ol>
      ) : (
        <p className="memory-empty">暂无记忆变更记录</p>
      )}
    </div>
  );
}

function MemoryFeedbackLine({ feedback }: { feedback: PersonalMemoryFeedback | null }) {
  return (
    <p
      aria-live="polite"
      className="memory-feedback-line"
      data-tone={feedback?.tone ?? "neutral"}
    >
      {feedback?.message ?? ""}
    </p>
  );
}
