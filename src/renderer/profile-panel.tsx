import {
  Download,
  FolderLock,
  Pencil,
  Plus,
  Share2,
  ShieldAlert,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

import type {
  PolicyBroadening,
  ProfileExportBundle,
  ProfileSummary
} from "./app-types";
import type { ProfileState, ProfileSwitchRequest } from "./app-profile-state";

const PROFILE_POLICY_LABELS: Record<string, string> = {
  allow: "允许",
  ask: "询问",
  deny: "拒绝"
};

export function ProfilePanel({
  state,
  onSwitch
}: {
  state: ProfileState;
  onSwitch: (profileId: string) => void;
}) {
  const [name, setName] = useState("");
  const [memoryScope, setMemoryScope] = useState<"isolated" | "shared">("isolated");
  const [cloneFromActive, setCloneFromActive] = useState(true);
  const [defaultManualMode, setDefaultManualMode] = useState<"active" | "quiet">("active");
  const [renameTarget, setRenameTarget] = useState<ProfileSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [exportWithMemory, setExportWithMemory] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await state.createProfile({
      name,
      memoryScope,
      cloneFromActive,
      defaultManualMode
    });
    if (created) {
      setName("");
    }
  }

  async function handleRenameSubmit(profile: ProfileSummary) {
    const nextName = renameValue.trim();
    if (nextName.length === 0 || nextName === profile.name) {
      setRenameTarget(null);
      return;
    }
    const renamed = await state.renameProfile(profile.id, nextName);
    if (renamed) {
      setRenameTarget(null);
    }
  }

  async function handleExport(profile: ProfileSummary) {
    const bundle = await state.exportProfile(profile.id, exportWithMemory);
    if (!bundle) {
      return;
    }
    downloadProfileBundle(bundle);
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as ProfileExportBundle;
      await state.importProfile(parsed);
    } catch {
      // The hook surfaces import errors through state.error; malformed JSON
      // is reported the same way.
    }
  }

  return (
    <div className="app-policy-panel profile-panel" aria-label="工作与偏好配置">
      <div className="app-policy-heading">
        <strong>工作与偏好配置</strong>
        <span>按工作目录或上下文切换 Agent、Planner、记忆与策略</span>
      </div>

      {state.error ? (
        <div className="profile-panel-error" role="alert">
          {state.error}
        </div>
      ) : null}

      <ul className="profile-list" aria-label="配置列表">
        {state.snapshot.profiles.map((profile) => (
          <li
            key={profile.id}
            className={`profile-row${profile.isActive ? " profile-row-active" : ""}`}
          >
            <div className="profile-row-identity">
              {renameTarget?.id === profile.id ? (
                <input
                  className="profile-rename-input"
                  aria-label="重命名配置"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                    if (event.key === "Enter") {
                      void handleRenameSubmit(profile);
                    } else if (event.key === "Escape") {
                      setRenameTarget(null);
                    }
                  }}
                  autoFocus
                />
              ) : (
                <span className="profile-row-name">{profile.name}</span>
              )}
              <span className="profile-row-meta">
                {profile.memoryScope === "isolated" ? (
                  <>
                    <FolderLock size={12} aria-hidden="true" /> 隔离记忆
                  </>
                ) : (
                  <>
                    <Share2 size={12} aria-hidden="true" /> 共享记忆
                  </>
                )}
                {profile.isDefault ? <em>默认</em> : null}
                {profile.isActive ? <em>当前</em> : null}
              </span>
            </div>
            <div className="profile-row-actions">
              {!profile.isActive ? (
                <button
                  type="button"
                  aria-label={`切换到 ${profile.name}`}
                  disabled={state.actionPending}
                  onClick={() => onSwitch(profile.id)}
                >
                  切换
                </button>
              ) : null}
              {renameTarget?.id === profile.id ? (
                <>
                  <button
                    type="button"
                    aria-label={`确认重命名 ${profile.name}`}
                    disabled={state.actionPending}
                    onClick={() => void handleRenameSubmit(profile)}
                  >
                    确认
                  </button>
                  <button
                    type="button"
                    aria-label="取消重命名"
                    onClick={() => setRenameTarget(null)}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  aria-label={`重命名 ${profile.name}`}
                  disabled={state.actionPending}
                  onClick={() => {
                    setRenameTarget(profile);
                    setRenameValue(profile.name);
                  }}
                >
                  <Pencil size={12} aria-hidden="true" /> 重命名
                </button>
              )}
              <button
                type="button"
                aria-label={`导出 ${profile.name}`}
                disabled={state.actionPending}
                onClick={() => void handleExport(profile)}
              >
                <Download size={12} aria-hidden="true" /> 导出
              </button>
              {!profile.isDefault && !profile.isActive ? (
                <button
                  type="button"
                  aria-label={`删除 ${profile.name}`}
                  disabled={state.actionPending}
                  onClick={() => void state.deleteProfile(profile.id)}
                >
                  <Trash2 size={12} aria-hidden="true" /> 删除
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <form className="profile-create-form" onSubmit={(event) => void handleCreate(event)}>
        <label>
          <span>新配置名称</span>
          <input
            aria-label="新配置名称"
            value={name}
            maxLength={60}
            placeholder="例如：obsidian 写作"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>记忆范围</span>
          <select
            aria-label="记忆范围"
            value={memoryScope}
            onChange={(event) =>
              setMemoryScope(event.target.value === "shared" ? "shared" : "isolated")
            }
          >
            <option value="isolated">隔离记忆</option>
            <option value="shared">共享记忆</option>
          </select>
        </label>
        <label>
          <span>默认手动模式</span>
          <select
            aria-label="默认手动模式"
            value={defaultManualMode}
            onChange={(event) =>
              setDefaultManualMode(event.target.value === "quiet" ? "quiet" : "active")
            }
          >
            <option value="active">active</option>
            <option value="quiet">quiet</option>
          </select>
        </label>
        <label className="profile-create-clone">
          <input
            type="checkbox"
            checked={cloneFromActive}
            onChange={(event) => setCloneFromActive(event.target.checked)}
          />
          <span>克隆当前设置</span>
        </label>
        <button type="submit" disabled={state.actionPending || name.trim().length === 0}>
          <Plus size={12} aria-hidden="true" /> 创建配置
        </button>
      </form>

      <div className="profile-import-row">
        <label className="profile-export-memory">
          <input
            type="checkbox"
            checked={exportWithMemory}
            onChange={(event) => setExportWithMemory(event.target.checked)}
          />
          <span>导出时包含记忆</span>
        </label>
        <button
          type="button"
          disabled={state.actionPending}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={12} aria-hidden="true" /> 导入配置
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => void handleImportFile(event)}
        />
      </div>
    </div>
  );
}

export function ProfileSwitchConfirmationDialog({
  request,
  pending,
  onConfirm,
  onCancel
}: {
  request: ProfileSwitchRequest;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="profile-confirmation-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        className="profile-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="确认切换配置"
      >
        <div className="profile-confirmation-heading">
          <ShieldAlert size={16} aria-hidden="true" />
          <strong>切换到 {request.profileName} 需要确认</strong>
        </div>
        <p>该配置会放宽以下应用策略。只有明确确认后才会切换：</p>
        <ul className="profile-confirmation-list">
          {request.broadenings.map((broadening) => (
            <li key={`${broadening.kind}:${broadening.target}`}>
              <span>{readBroadeningLabel(broadening)}</span>
              <strong>
                {readPolicyLabel(broadening.from)} → {readPolicyLabel(broadening.to)}
              </strong>
            </li>
          ))}
        </ul>
        <div className="profile-confirmation-actions">
          <button type="button" onClick={onCancel} disabled={pending}>
            <X size={12} aria-hidden="true" /> 取消
          </button>
          <button type="button" className="danger" onClick={onConfirm} disabled={pending}>
            确认切换
          </button>
        </div>
      </div>
    </div>
  );
}

function readBroadeningLabel(broadening: PolicyBroadening): string {
  return broadening.targetName ?? broadening.target;
}

function readPolicyLabel(policy: string): string {
  return PROFILE_POLICY_LABELS[policy] ?? policy;
}

function downloadProfileBundle(bundle: ProfileExportBundle): void {
  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `skfiy-profile-${bundle.profile.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
