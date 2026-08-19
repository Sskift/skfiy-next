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
  getTaskReplayRows,
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
  TurnReplay
} from "./app-types";

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
      </div>
      <div className="finder-plan-moves">
        {previewViewModel.moveItems.map((move) => <em key={move.key}>{move.label}</em>)}
      </div>
    </div>
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
  onClick,
  onContextMenu,
  onPointerDown,
  onPointerMove,
  onPointerUp
}: {
  state: PetAtlasState;
  atlas: PetAtlas;
  onClick: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const animation = atlas.states[state];

  return (
    <div
      aria-label="skfiy Codex-style pet"
      className={`skfiy-pet pet-state-${state}`}
      data-pet-skin={atlas.slug}
      data-atlas-state={state}
      data-frame-count={animation.frames}
      data-drag-mode="manual"
      data-agent-entry="left-click"
      data-settings-entry="right-click"
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={getPetSpriteStyle(state, atlas)}
    >
      <span className="pet-sprite-frame" aria-hidden="true" />
    </div>
  );
}
