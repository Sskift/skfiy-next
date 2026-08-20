import {
  CirclePause,
  Copy,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2
} from "lucide-react";
import { useState, type FormEvent } from "react";
import type {
  AutomationMonitorDefinitionPreview,
  AutomationMonitorRuntime,
  AutomationMonitorSnapshot,
  AutomationMonitorTriggerMode
} from "./app-types";
import {
  describeAutomationMonitorOutcome,
  formatAutomationInterval,
  formatAutomationTimeout,
  formatAutomationTimestamp,
  readAutomationPreviewRows,
  readAutomationStatusLabel,
  readAutomationStatusTone,
  readAutomationTriggerModeLabel,
  type AutomationFeedback
} from "./app-automation-state";

export interface AutomationDefinitionDraft {
  monitorId?: string;
  label: string;
  sessionName: string;
  triggerMode: AutomationMonitorTriggerMode;
  intervalMs: number;
  timeoutMs: number;
}

export type AutomationEditorState =
  | { mode: "create" }
  | { mode: "edit"; monitor: AutomationMonitorRuntime };

export interface AutomationPreviewState {
  preview: AutomationMonitorDefinitionPreview;
  draft: AutomationDefinitionDraft;
}

export interface AutomationControlCenterPanelProps {
  snapshot: AutomationMonitorSnapshot;
  feedback: AutomationFeedback | null;
  actionPending: boolean;
  editor: AutomationEditorState | null;
  preview: AutomationPreviewState | null;
  onRefresh: () => void;
  onCreate: () => void;
  onRunNow: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onDuplicate: (id: string) => void;
  onEdit: (monitor: AutomationMonitorRuntime) => void;
  onDelete: (id: string) => void;
  onSubmitDefinition: (draft: AutomationDefinitionDraft) => void;
  onCancelEditor: () => void;
  onConfirmPreview: (enabled: boolean) => void;
  onCancelPreview: () => void;
}

export function AutomationControlCenterPanel({
  snapshot,
  feedback,
  actionPending,
  editor,
  preview,
  onRefresh,
  onCreate,
  onRunNow,
  onToggleEnabled,
  onDuplicate,
  onEdit,
  onDelete,
  onSubmitDefinition,
  onCancelEditor,
  onConfirmPreview,
  onCancelPreview
}: AutomationControlCenterPanelProps) {
  return (
    <section className="automation-control-center" aria-label="自动化监控">
      <div className="automation-heading">
        <strong>自动化监控</strong>
        <span className="automation-heading-actions">
          <button
            type="button"
            aria-label="新建自动化监控"
            disabled={actionPending || editor !== null}
            onClick={onCreate}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="刷新自动化监控"
            disabled={actionPending}
            onClick={onRefresh}
          >
            <RefreshCw size={12} aria-hidden="true" />
          </button>
        </span>
      </div>
      {snapshot.monitors.length > 0 ? (
        <ul className="automation-monitor-list">
          {snapshot.monitors.map((monitor) => (
            <AutomationMonitorRow
              key={monitor.id}
              monitor={monitor}
              actionPending={actionPending}
              onRunNow={onRunNow}
              onToggleEnabled={onToggleEnabled}
              onDuplicate={onDuplicate}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      ) : (
        <p className="automation-empty">暂无自动化监控</p>
      )}
      {editor ? (
        <AutomationDefinitionForm
          editor={editor}
          actionPending={actionPending}
          onSubmit={onSubmitDefinition}
          onCancel={onCancelEditor}
        />
      ) : null}
      {preview ? (
        <AutomationPreviewCard
          preview={preview.preview}
          actionPending={actionPending}
          onConfirm={onConfirmPreview}
          onCancel={onCancelPreview}
        />
      ) : null}
      <AutomationFeedbackLine feedback={feedback} />
    </section>
  );
}

function AutomationMonitorRow({
  monitor,
  actionPending,
  onRunNow,
  onToggleEnabled,
  onDuplicate,
  onEdit,
  onDelete
}: {
  monitor: AutomationMonitorRuntime;
  actionPending: boolean;
  onRunNow: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onDuplicate: (id: string) => void;
  onEdit: (monitor: AutomationMonitorRuntime) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <li className="automation-monitor-row" data-status={monitor.status}>
      <div className="automation-monitor-summary">
        <strong>{monitor.label}</strong>
        <span className="automation-monitor-session">tmux: {monitor.sessionName}</span>
        <AutomationStatusChip status={monitor.status} />
        <span className="automation-trigger-mode">
          {readAutomationTriggerModeLabel(monitor.triggerMode)}
        </span>
        {monitor.enabled && monitor.triggerMode === "scheduled" ? (
          <span className="automation-next-check">
            下次检查 {formatAutomationTimestamp(monitor.nextCheckAt)}
          </span>
        ) : null}
        <span className="automation-monitor-interval">
          间隔 {formatAutomationInterval(monitor.intervalMs)} · 超时{" "}
          {formatAutomationTimeout(monitor.timeoutMs)}
        </span>
        <p className="automation-monitor-outcome">
          {describeAutomationMonitorOutcome(monitor)}
        </p>
      </div>
      <div className="automation-monitor-actions">
        <button
          type="button"
          aria-label={`立即运行：${monitor.label}`}
          disabled={actionPending || !monitor.enabled}
          onClick={() => onRunNow(monitor.id)}
        >
          <Play size={11} aria-hidden="true" />
          运行
        </button>
        <button
          type="button"
          aria-label={monitor.enabled ? `暂停：${monitor.label}` : `恢复：${monitor.label}`}
          disabled={actionPending}
          onClick={() => onToggleEnabled(monitor.id, !monitor.enabled)}
        >
          <CirclePause size={11} aria-hidden="true" />
          {monitor.enabled ? "暂停" : "恢复"}
        </button>
        <button
          type="button"
          aria-label={`复制：${monitor.label}`}
          disabled={actionPending}
          onClick={() => onDuplicate(monitor.id)}
        >
          <Copy size={11} aria-hidden="true" />
          复制
        </button>
        <button
          type="button"
          aria-label={`编辑：${monitor.label}`}
          disabled={actionPending}
          onClick={() => onEdit(monitor)}
        >
          <Pencil size={11} aria-hidden="true" />
          编辑
        </button>
        <button
          type="button"
          aria-label={`删除：${monitor.label}`}
          disabled={actionPending}
          onClick={() => onDelete(monitor.id)}
        >
          <Trash2 size={11} aria-hidden="true" />
          删除
        </button>
      </div>
    </li>
  );
}

function AutomationDefinitionForm({
  editor,
  actionPending,
  onSubmit,
  onCancel
}: {
  editor: AutomationEditorState;
  actionPending: boolean;
  onSubmit: (draft: AutomationDefinitionDraft) => void;
  onCancel: () => void;
}) {
  const editing = editor.mode === "edit" ? editor.monitor : null;
  const [label, setLabel] = useState(editing?.label ?? "");
  const [sessionName, setSessionName] = useState(editing?.sessionName ?? "");
  const [triggerMode, setTriggerMode] = useState<AutomationMonitorTriggerMode>(
    editing?.triggerMode ?? "scheduled"
  );
  const [intervalSeconds, setIntervalSeconds] = useState(
    String(Math.round((editing?.intervalMs ?? 300_000) / 1_000))
  );
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    String(Math.round((editing?.timeoutMs ?? 30_000) / 1_000))
  );
  const trimmedSession = sessionName.trim();
  const sessionInvalid = trimmedSession.length === 0
    || !/^[A-Za-z0-9_.:-]+$/u.test(trimmedSession);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sessionInvalid) {
      return;
    }

    const parsedInterval = Number.parseInt(intervalSeconds, 10);
    const parsedTimeout = Number.parseInt(timeoutSeconds, 10);
    onSubmit({
      ...(editing ? { monitorId: editing.id } : {}),
      label: label.trim(),
      sessionName: trimmedSession,
      triggerMode,
      intervalMs: Number.isFinite(parsedInterval) && parsedInterval > 0
        ? parsedInterval * 1_000
        : 300_000,
      timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout * 1_000
        : 30_000
    });
  }

  return (
    <form className="automation-definition-form" aria-label="自动化监控定义" onSubmit={submit}>
      <label>
        名称
        <input
          type="text"
          value={label}
          placeholder="可选，默认为 tmux 会话名"
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label>
        tmux 会话
        <input
          type="text"
          value={sessionName}
          readOnly={editing !== null}
          aria-label="tmux 会话名"
          onChange={(event) => setSessionName(event.target.value)}
        />
      </label>
      <label>
        触发方式
        <select
          value={triggerMode}
          aria-label="触发方式"
          onChange={(event) => setTriggerMode(event.target.value as AutomationMonitorTriggerMode)}
        >
          <option value="manual">手动</option>
          <option value="scheduled">定时</option>
          <option value="local-state">本地状态</option>
        </select>
      </label>
      {triggerMode === "scheduled" ? (
        <label>
          检查间隔（秒）
          <input
            type="number"
            min={30}
            value={intervalSeconds}
            aria-label="检查间隔（秒）"
            onChange={(event) => setIntervalSeconds(event.target.value)}
          />
        </label>
      ) : null}
      <label>
        超时（秒）
        <input
          type="number"
          min={1}
          max={300}
          value={timeoutSeconds}
          aria-label="超时（秒）"
          onChange={(event) => setTimeoutSeconds(event.target.value)}
        />
      </label>
      <div className="automation-form-actions">
        <button type="submit" disabled={actionPending || sessionInvalid}>
          预览安全边界
        </button>
        <button type="button" disabled={actionPending} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function AutomationPreviewCard({
  preview,
  actionPending,
  onConfirm,
  onCancel
}: {
  preview: AutomationMonitorDefinitionPreview;
  actionPending: boolean;
  onConfirm: (enabled: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <div className="automation-preview-card" aria-label="自动化安全边界预览">
      <div className="automation-preview-heading">
        <ShieldCheck size={12} aria-hidden="true" />
        <strong>安全边界预览</strong>
      </div>
      <dl className="automation-preview-rows">
        {readAutomationPreviewRows(preview).map((row) => (
          <div key={row.label} className="automation-preview-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="automation-preview-policy-note">
        启用监控不会扩大 macOS、Chrome、应用或主机策略权限。
      </p>
      <div className="automation-preview-actions">
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onConfirm(true)}
        >
          保存并启用
        </button>
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onConfirm(false)}
        >
          仅保存（停用）
        </button>
        <button type="button" disabled={actionPending} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export function AutomationStatusChip({ status }: { status: AutomationMonitorRuntime["status"] }) {
  return (
    <span className="automation-status-chip" data-tone={readAutomationStatusTone(status)}>
      {readAutomationStatusLabel(status)}
    </span>
  );
}

export function AutomationFeedbackLine({ feedback }: { feedback: AutomationFeedback | null }) {
  return (
    <p
      aria-live="polite"
      className="automation-feedback-line"
      data-tone={feedback?.tone ?? "neutral"}
    >
      {feedback?.message ?? ""}
    </p>
  );
}
