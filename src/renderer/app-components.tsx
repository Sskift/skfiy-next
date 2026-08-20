import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  ClipboardList,
  History,
  Play,
  RefreshCw,
  Route as RouteIcon,
  ShieldCheck,
  ShieldQuestion
} from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode
} from "react";
import {
  getPetSpriteStyle,
  type PetAtlas,
  type PetAtlasState
} from "./pet-atlas";
import {
  getFinderPlanPreviewSummaryViewModel,
  getLocalReplayViewModel,
  getPlannerProviderDisplayViewModel,
  getPolicySummary,
  getTaskControlCardViewModel,
  getTaskReplayRows,
  TASK_CONTROL_RECOVERY_LABELS,
  getUserDashboardPanelViewModel
} from "./app-view-model";
import type { TaskView } from "./app-task-state";
import type {
  AppPolicySettings,
  DesktopSessionDiagnostics,
  FinderPlanPreview,
  ObserveAppReplayRecord,
  PermissionSummary,
  PlannerProviderSettings,
  TaskApprovalDecisionInput,
  TurnReplay
} from "./app-types";
import type {
  TaskControlRecoveryAction,
  TaskControlRecoveryDescriptor,
  TaskControlSnapshot
} from "../shared/task-control";
import {
  areTaskControlRecoveryDescriptorsEqual,
  readAuthoritativeTaskControlRecoveryDescriptors
} from "./app-task-control-recovery";

const TASK_CONTROL_PREPARED_RECOVERY_LABELS = {
  retry_observation: "Run prepared observation retry",
  retry_verification: "Run prepared verification retry"
} as const;

export function TaskReplay({ records }: { records: ObserveAppReplayRecord[] }) {
  const rows = getTaskReplayRows(records);

  if (rows.length === 0) return null;

  return (
    <div className="task-replay" aria-label="Computer Use replay">
      {rows.map((row) => (
        <div className="task-replay-row" key={row.key}>
          <strong>{row.stage}</strong>
          <span title={row.screenshotPath}>{row.screenshotPath}</span>
          <em data-state={row.accessibilityState}>
            {row.accessibilityLabel}
          </em>
          {row.ocrLabel ? <em data-state="ok">{row.ocrLabel}</em> : null}
        </div>
      ))}
    </div>
  );
}

export function FinderPlanPreviewSummary({ preview }: { preview: FinderPlanPreview }) {
  const previewViewModel = getFinderPlanPreviewSummaryViewModel(preview);

  return (
    <div className="finder-plan-preview" aria-label="Finder plan preview">
      <strong>Finder plan preview</strong>
      <div className="finder-plan-stats">
        <span>{previewViewModel.operationCount} operations</span>
        <span>{previewViewModel.destructiveOperationCount} destructive</span>
        <span>{previewViewModel.moveCount} moves</span>
        <span>{previewViewModel.copyCount} copies</span>
      </div>
      <div className="finder-plan-moves">
        {previewViewModel.moveItems.map((move) => <em key={move.key}>{move.label}</em>)}
        {previewViewModel.copyItems.map((copy) => <em key={copy.key}>Copy: {copy.label}</em>)}
      </div>
    </div>
  );
}

export function TaskControlCard({
  actionError,
  approvalDecisionPending,
  onApprove,
  onDeny,
  onOpenReplay,
  onDispatchRecovery = () => undefined,
  onRecover,
  onStop,
  recoveryFeedback,
  preparedRecoveryDescriptor,
  recoveryDispatchPending = false,
  recoveryPreparationPending = false,
  snapshot,
  stopPending
}: {
  actionError?: string;
  approvalDecisionPending: boolean;
  onApprove: (input: TaskApprovalDecisionInput) => void;
  onDeny: (input: TaskApprovalDecisionInput) => void;
  onOpenReplay: () => void;
  onDispatchRecovery?: (descriptor: TaskControlRecoveryDescriptor) => void;
  onRecover: (descriptor: TaskControlRecoveryDescriptor) => void;
  onStop: () => void;
  recoveryFeedback?: string;
  preparedRecoveryDescriptor?: TaskControlRecoveryDescriptor;
  recoveryDispatchPending?: boolean;
  recoveryPreparationPending?: boolean;
  snapshot: TaskControlSnapshot;
  stopPending: boolean;
}) {
  const view = getTaskControlCardViewModel(snapshot);
  const approvalInput = snapshot.approval ? {
    executionId: snapshot.executionId,
    planId: snapshot.approval.planId
  } : null;
  const recoveryDescriptors = readAuthoritativeTaskControlRecoveryDescriptors(snapshot);

  return (
    <section
      className="task-control-card"
      aria-label="Computer Use task control"
      data-phase={snapshot.phase}
      data-status={snapshot.status}
      tabIndex={-1}
    >
      <div className="task-control-heading">
        <div>
          <strong>Task Control</strong>
          <span>{view.statusLabel}</span>
        </div>
        <code>{snapshot.status}</code>
      </div>

      <p className="task-control-message">{view.message}</p>

      <dl className="task-control-plan" aria-label="Computer Use plan preview">
        <div>
          <dt>App</dt>
          <dd>{snapshot.plan.appName}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{view.target}</dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd><strong>{view.riskLabel}</strong><span>{view.riskDetail}</span></dd>
        </div>
        <div>
          <dt>Approval</dt>
          <dd>{view.approvalLabel}</dd>
        </div>
        <div>
          <dt>Expected verification</dt>
          <dd>{view.verification}</dd>
        </div>
      </dl>

      {view.canApprove && snapshot.approval?.finderPlanPreview ? (
        <FinderPlanPreviewSummary preview={snapshot.approval.finderPlanPreview} />
      ) : null}

      {snapshot.phase === "terminal" ? (
        <div className="task-control-result" aria-label="Task Control completion summary">
          <strong>{view.statusLabel}</strong>
          <span>{view.sideEffectMessage}</span>
        </div>
      ) : null}

      {actionError ? <p className="task-control-error" role="alert">{actionError}</p> : null}
      {recoveryFeedback ? (
        <p className="task-control-recovery-feedback" role="status" aria-live="polite">
          {recoveryFeedback}
        </p>
      ) : null}

      <div
        className="task-control-actions"
        aria-busy={approvalDecisionPending ? "true" : undefined}
        aria-label="Task Control actions"
      >
        {view.active ? (
          <button
            type="button"
            aria-label={stopPending ? "Stopping task" : "Stop task"}
            disabled={stopPending}
            onClick={onStop}
          >
            <CirclePause size={13} aria-hidden="true" />
            <span>{stopPending ? "Stopping…" : "Stop"}</span>
          </button>
        ) : null}
        {view.canApprove && approvalInput ? (
          <>
            <button
              type="button"
              aria-label="Approve task plan"
              disabled={approvalDecisionPending}
              onClick={() => onApprove(approvalInput)}
            >
              <Play size={13} aria-hidden="true" />
              <span>Approve</span>
            </button>
            <button
              type="button"
              aria-label="Deny task plan"
              disabled={approvalDecisionPending}
              onClick={() => onDeny(approvalInput)}
            >
              <CirclePause size={13} aria-hidden="true" />
              <span>Deny</span>
            </button>
          </>
        ) : null}
        {snapshot.replayAvailable ? (
          <button type="button" aria-label="Open task replay" onClick={onOpenReplay}>
            <History size={13} aria-hidden="true" />
            <span>Open replay</span>
          </button>
        ) : null}
      </div>

      {recoveryDescriptors.length > 0 ? (
        <div
          className="task-control-recovery"
          aria-busy={recoveryPreparationPending || recoveryDispatchPending ? "true" : undefined}
          aria-label="Task recovery actions"
          role="group"
        >
          <strong>Recovery</strong>
          <div>
            {recoveryDescriptors.map((descriptor, index) => {
              const prepared = preparedRecoveryDescriptor
                && areTaskControlRecoveryDescriptorsEqual(
                  descriptor,
                  preparedRecoveryDescriptor
                )
                ? preparedRecoveryDescriptor
                : null;
              const preparationDisabled = recoveryPreparationPending || Boolean(prepared);
              return (
                <span key={descriptor.recoveryId}>
                  <button
                    type="button"
                    aria-disabled={preparationDisabled ? "true" : undefined}
                    aria-label={TASK_CONTROL_RECOVERY_LABELS[descriptor.action]}
                    data-task-control-primary-recovery={index === 0 ? "true" : undefined}
                    onClick={() => {
                      if (!preparationDisabled) onRecover(descriptor);
                    }}
                    onKeyDown={(event) => {
                      if (
                        preparationDisabled
                        && (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                  >
                    {TASK_CONTROL_RECOVERY_LABELS[descriptor.action]}
                  </button>
                  {prepared && prepared.action in TASK_CONTROL_PREPARED_RECOVERY_LABELS ? (
                    <button
                      type="button"
                      aria-disabled={recoveryDispatchPending ? "true" : undefined}
                      aria-label={TASK_CONTROL_PREPARED_RECOVERY_LABELS[
                        prepared.action as keyof typeof TASK_CONTROL_PREPARED_RECOVERY_LABELS
                      ]}
                      data-task-control-action="dispatch-recovery"
                      onClick={() => {
                        if (!recoveryDispatchPending) onDispatchRecovery(prepared);
                      }}
                      onKeyDown={(event) => {
                        if (
                          recoveryDispatchPending
                          && (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                        }
                      }}
                    >
                      {TASK_CONTROL_PREPARED_RECOVERY_LABELS[
                        prepared.action as keyof typeof TASK_CONTROL_PREPARED_RECOVERY_LABELS
                      ]}
                    </button>
                  ) : null}
                </span>
              );
            })}
          </div>
        </div>
      ) : snapshot.recoveryActions.length > 0 ? (
        <p
          className="task-control-recovery-unavailable"
          aria-label="Task recovery unavailable"
          role="note"
        >
          Task recovery is unavailable because authoritative recovery details are missing.
        </p>
      ) : null}
    </section>
  );
}

export function LocalReplayViewer({ replay }: { replay: TurnReplay | null }) {
  const replayViewModel = getLocalReplayViewModel(replay);

  return (
    <div className="turn-replay-panel" aria-label="本地回放">
      <div className="turn-replay-heading">
        <strong>本地回放</strong>
        <span>{replayViewModel.headingOutcome}</span>
      </div>
      {replayViewModel.hasTranscript ? (
        <>
          <div className="turn-replay-summary">
            <span>命令</span>
            <strong>{replayViewModel.command}</strong>
            <span>风险</span>
            <strong>{replayViewModel.riskLevel}</strong>
          </div>
          <ReplayList title="规划" items={replayViewModel.plannerItems} />
          <ReplayList title="动作" items={replayViewModel.actionItems} />
          <ReplayList title="截图" items={replayViewModel.screenshotItems} />
          <ReplayList title="时间线" items={replayViewModel.timelineItems} />
        </>
      ) : (
        <p>暂无回放</p>
      )}
    </div>
  );
}

function ReplayList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="turn-replay-list">
      <span>{title}</span>
      {items.map((item, index) => (
        <em key={`${title}-${index}`}>{item}</em>
      ))}
    </div>
  );
}

function DashboardSignal({
  detail,
  icon,
  label,
  tone
}: {
  detail: string;
  icon: ReactNode;
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
}) {
  return (
    <div className="dashboard-signal" data-tone={tone}>
      <span aria-hidden="true">{icon}</span>
      <div>
        <strong>{label}</strong>
        <em>{detail}</em>
      </div>
    </div>
  );
}

export function UserDashboardPanel({
  appPolicySettings,
  desktopSessionDiagnostics,
  onApprove,
  onDeny,
  onRefresh,
  onStop,
  permissions,
  permissionsLoading,
  plannerProviderSettings,
  task,
  turnReplay
}: {
  appPolicySettings: AppPolicySettings;
  desktopSessionDiagnostics: DesktopSessionDiagnostics;
  onApprove: () => void;
  onDeny: () => void;
  onRefresh: () => void;
  onStop: () => void;
  permissions: PermissionSummary;
  permissionsLoading: boolean;
  plannerProviderSettings: PlannerProviderSettings;
  task: TaskView;
  turnReplay: TurnReplay | null;
}) {
  const plannerProviderDisplay = getPlannerProviderDisplayViewModel(plannerProviderSettings);
  const { canApprove, canStop, permissionHealth, recent, risk, routeOutcomeSignal, status } =
    getUserDashboardPanelViewModel({ desktopSessionDiagnostics, permissions, task, turnReplay });

  return (
    <section className="dashboard-panel" aria-label="用户态 dashboard">
      <div className="dashboard-heading">
        <div>
          <strong>助手状态</strong>
          <span>{status.detail}</span>
        </div>
        <em data-tone={status.tone}>{status.label}</em>
      </div>

      <div className="dashboard-signals">
        <DashboardSignal
          icon={<ClipboardList size={14} />}
          label="当前任务"
          detail={status.label}
          tone={status.tone}
        />
        <DashboardSignal
          icon={permissionHealth.tone === "success" ? <ShieldCheck size={14} /> : <ShieldQuestion size={14} />}
          label={permissionsLoading ? "正在检查授权" : permissionHealth.label}
          detail={`${permissionHealth.detail} · ${getPolicySummary(appPolicySettings)}`}
          tone={permissionHealth.tone}
        />
        <DashboardSignal
          icon={risk.tone === "success" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          label={risk.label}
          detail={risk.detail}
          tone={risk.tone}
        />
        <DashboardSignal
          icon={<RouteIcon size={14} />}
          label={routeOutcomeSignal.label}
          detail={routeOutcomeSignal.detail}
          tone={routeOutcomeSignal.tone}
        />
        <DashboardSignal
          icon={<History size={14} />}
          label={recent.label}
          detail={recent.detail}
          tone={recent.tone}
        />
      </div>

      <div className="dashboard-actions" aria-label="任务操作">
        <button
          type="button"
          className="dashboard-icon-action"
          aria-label="刷新 dashboard 状态"
          onClick={onRefresh}
        >
          <RefreshCw size={13} aria-hidden="true" />
        </button>
        {canStop ? (
          <button type="button" aria-label="停止任务" onClick={onStop}>
            <CirclePause size={13} aria-hidden="true" />
            <span>停止</span>
          </button>
        ) : null}
        {canApprove ? (
          <>
            <button type="button" aria-label="确认" onClick={onApprove}>
              <Play size={13} aria-hidden="true" />
              <span>确认</span>
            </button>
            <button type="button" aria-label="拒绝" onClick={onDeny}>
              <CirclePause size={13} aria-hidden="true" />
              <span>拒绝</span>
            </button>
          </>
        ) : null}
      </div>

      <div className="dashboard-runtime-strip" aria-label="运行偏好">
        <span>agent</span>
        <span>{plannerProviderDisplay.runtimeLabel}</span>
      </div>
    </section>
  );
}

export function DesktopPet({
  state,
  atlas,
  accessibilityLabel,
  onClick,
  onContextMenu,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  panelOpen
}: {
  state: PetAtlasState;
  atlas: PetAtlas;
  accessibilityLabel: string;
  onClick: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  panelOpen: boolean;
}) {
  const animation = atlas.states[state];

  return (
    <div
      aria-expanded={panelOpen}
      aria-label={accessibilityLabel}
      className={`skfiy-pet pet-state-${state}`}
      data-pet-skin={atlas.slug}
      data-atlas-state={state}
      data-frame-count={animation.frames}
      data-drag-mode="manual"
      data-agent-entry="left-click"
      data-pet-entry="true"
      data-settings-entry="right-click"
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="button"
      tabIndex={0}
      style={getPetSpriteStyle(state, atlas)}
    >
      <span className="pet-sprite-frame" aria-hidden="true" />
    </div>
  );
}
