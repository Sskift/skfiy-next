import {
  Archive,
  ChevronDown,
  History,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X
} from "lucide-react";
import {
  useEffect,
  useState,
  type FormEvent
} from "react";

import type {
  ConversationHistorySnapshot,
  ConversationMessage,
  ConversationSession,
  ConversationTurn
} from "../shared/conversation-history";
import {
  formatConversationTimestamp,
  readConversationMessageRows,
  readConversationSessionGroups,
  type ConversationSessionState
} from "./app-conversation-state";

export type ConversationSessionAction =
  | "start"
  | "switch"
  | "rename"
  | "archive"
  | "delete"
  | "restore"
  | "retry";

export interface ConversationActionState {
  action: ConversationSessionAction;
  sessionId?: string;
  turnId?: string;
}

export function ConversationAssistantHeader({
  action,
  activeSession,
  historyAvailable,
  navigatorOpen,
  onStartSession,
  onToggleNavigator,
  providerLabel,
  providerReadiness,
  providerReadinessLabel
}: {
  action: ConversationActionState | null;
  activeSession: ConversationSession | undefined;
  historyAvailable: boolean;
  navigatorOpen: boolean;
  onStartSession: () => void;
  onToggleNavigator: () => void;
  providerLabel: string;
  providerReadiness: string;
  providerReadinessLabel: string;
}) {
  return (
    <div className="conversation-header" aria-label="skfiy agent status">
      <div className="conversation-session-toolbar">
        <button
          type="button"
          className="conversation-session-picker"
          aria-controls="skfiy-conversation-navigator"
          aria-expanded={navigatorOpen}
          aria-label="打开会话导航"
          disabled={!historyAvailable}
          onClick={onToggleNavigator}
          title={activeSession?.title ?? "新会话"}
        >
          <History size={13} aria-hidden="true" />
          <span>{activeSession?.title ?? "新会话"}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="conversation-new-session"
          aria-label="新建会话"
          disabled={!historyAvailable || action?.action === "start"}
          onClick={onStartSession}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>
      <div
        className="conversation-provider-status"
        aria-label="Background Agent 状态"
        data-readiness={providerReadiness}
        role="status"
      >
        <strong>agent</strong>
        <span>{providerLabel} · {providerReadinessLabel}</span>
      </div>
    </div>
  );
}

export function ConversationSessionNavigator({
  action,
  activeSessionId,
  onArchive,
  onDelete,
  onRename,
  onRestore,
  onSwitch,
  snapshot
}: {
  action: ConversationActionState | null;
  activeSessionId: string | undefined;
  onArchive: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onRestore: (sessionId: string) => void;
  onSwitch: (sessionId: string) => void;
  snapshot: ConversationHistorySnapshot;
}) {
  const [managedSessionId, setManagedSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const groups = readConversationSessionGroups(snapshot);

  useEffect(() => {
    setManagedSessionId(null);
    setRenamingSessionId(null);
  }, [snapshot]);

  function startRename(session: ConversationSession) {
    setManagedSessionId(session.id);
    setRenamingSessionId(session.id);
    setRenameTitle(session.title);
  }

  function submitRename(event: FormEvent<HTMLFormElement>, sessionId: string) {
    event.preventDefault();
    const title = renameTitle.trim();
    if (!title) {
      return;
    }

    onRename(sessionId, title);
    setRenamingSessionId(null);
    setManagedSessionId(null);
  }

  return (
    <section
      id="skfiy-conversation-navigator"
      className="conversation-navigator"
      aria-label="会话导航"
    >
      <ConversationSessionGroup
        action={action}
        activeSessionId={activeSessionId}
        label="进行中的会话"
        managedSessionId={managedSessionId}
        onArchive={onArchive}
        onDelete={onDelete}
        onManage={(sessionId) => {
          setManagedSessionId((current) => current === sessionId ? null : sessionId);
          setRenamingSessionId(null);
        }}
        onRename={startRename}
        onRestore={onRestore}
        onSwitch={onSwitch}
        renameTitle={renameTitle}
        renamingSessionId={renamingSessionId}
        sessions={groups.active}
        state="active"
        onCancelRename={() => setRenamingSessionId(null)}
        onChangeRenameTitle={setRenameTitle}
        onSubmitRename={submitRename}
      />
      <ConversationSessionGroup
        action={action}
        activeSessionId={activeSessionId}
        label="已归档会话"
        managedSessionId={managedSessionId}
        onArchive={onArchive}
        onDelete={onDelete}
        onManage={(sessionId) => {
          setManagedSessionId((current) => current === sessionId ? null : sessionId);
          setRenamingSessionId(null);
        }}
        onRename={startRename}
        onRestore={onRestore}
        onSwitch={onSwitch}
        renameTitle={renameTitle}
        renamingSessionId={renamingSessionId}
        sessions={groups.archived}
        state="archived"
        onCancelRename={() => setRenamingSessionId(null)}
        onChangeRenameTitle={setRenameTitle}
        onSubmitRename={submitRename}
      />
      <ConversationSessionGroup
        action={action}
        activeSessionId={activeSessionId}
        label="最近删除的会话"
        managedSessionId={managedSessionId}
        onArchive={onArchive}
        onDelete={onDelete}
        onManage={setManagedSessionId}
        onRename={startRename}
        onRestore={onRestore}
        onSwitch={onSwitch}
        renameTitle={renameTitle}
        renamingSessionId={renamingSessionId}
        sessions={groups.deleted}
        state="deleted"
        onCancelRename={() => setRenamingSessionId(null)}
        onChangeRenameTitle={setRenameTitle}
        onSubmitRename={submitRename}
      />
    </section>
  );
}

function ConversationSessionGroup({
  action,
  activeSessionId,
  label,
  managedSessionId,
  onArchive,
  onCancelRename,
  onChangeRenameTitle,
  onDelete,
  onManage,
  onRename,
  onRestore,
  onSubmitRename,
  onSwitch,
  renameTitle,
  renamingSessionId,
  sessions,
  state
}: {
  action: ConversationActionState | null;
  activeSessionId: string | undefined;
  label: string;
  managedSessionId: string | null;
  onArchive: (sessionId: string) => void;
  onCancelRename: () => void;
  onChangeRenameTitle: (title: string) => void;
  onDelete: (sessionId: string) => void;
  onManage: (sessionId: string) => void;
  onRename: (session: ConversationSession) => void;
  onRestore: (sessionId: string) => void;
  onSubmitRename: (event: FormEvent<HTMLFormElement>, sessionId: string) => void;
  onSwitch: (sessionId: string) => void;
  renameTitle: string;
  renamingSessionId: string | null;
  sessions: ConversationSession[];
  state: ConversationSessionState;
}) {
  if (sessions.length === 0) {
    return state === "active" ? (
      <div className="conversation-session-group" aria-label={label}>
        <strong>{label}</strong>
        <p>暂无会话</p>
      </div>
    ) : null;
  }

  return (
    <div className="conversation-session-group" aria-label={label}>
      <strong>{label}</strong>
      <ul>
        {sessions.map((session) => {
          const managed = managedSessionId === session.id;
          const busy = action?.sessionId === session.id;
          return (
            <li
              key={session.id}
              data-session-id={session.id}
              data-session-state={state}
            >
              <div className="conversation-session-row">
                <button
                  type="button"
                  className="conversation-session-switch"
                  data-conversation-focus="true"
                  aria-current={activeSessionId === session.id ? "true" : undefined}
                  aria-label={`切换会话 ${session.title}`}
                  disabled={state !== "active" || busy}
                  onClick={() => onSwitch(session.id)}
                >
                  <span>{session.title}</span>
                  <time dateTime={session.updatedAt}>
                    {formatConversationTimestamp(session.updatedAt)}
                  </time>
                </button>
                {state !== "deleted" ? (
                  <button
                    type="button"
                    className="conversation-session-manage"
                    aria-expanded={managed}
                    aria-label="管理会话"
                    disabled={busy}
                    onClick={() => onManage(session.id)}
                  >
                    <MoreHorizontal size={13} aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="conversation-session-manage"
                    aria-label="恢复会话"
                    disabled={busy}
                    onClick={() => onRestore(session.id)}
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
              {managed && state !== "deleted" ? (
                renamingSessionId === session.id ? (
                  <form
                    className="conversation-rename-form"
                    aria-label="重命名会话"
                    onSubmit={(event) => onSubmitRename(event, session.id)}
                  >
                    <input
                      aria-label="会话名称"
                      autoFocus
                      maxLength={120}
                      value={renameTitle}
                      onChange={(event) => onChangeRenameTitle(event.currentTarget.value)}
                    />
                    <button type="submit" aria-label="保存会话名称" disabled={!renameTitle.trim()}>
                      <Save size={12} aria-hidden="true" />
                    </button>
                    <button type="button" aria-label="取消重命名" onClick={onCancelRename}>
                      <X size={12} aria-hidden="true" />
                    </button>
                  </form>
                ) : (
                  <div className="conversation-session-actions" role="group" aria-label="会话操作">
                    <button type="button" aria-label="重命名会话" onClick={() => onRename(session)}>
                      <Pencil size={11} aria-hidden="true" />
                      <span>重命名</span>
                    </button>
                    {state === "active" ? (
                      <button type="button" aria-label="归档会话" onClick={() => onArchive(session.id)}>
                        <Archive size={11} aria-hidden="true" />
                        <span>归档</span>
                      </button>
                    ) : (
                      <button type="button" aria-label="恢复会话" onClick={() => onRestore(session.id)}>
                        <RotateCcw size={11} aria-hidden="true" />
                        <span>恢复</span>
                      </button>
                    )}
                    <button type="button" aria-label="删除会话" onClick={() => onDelete(session.id)}>
                      <Trash2 size={11} aria-hidden="true" />
                      <span>删除</span>
                    </button>
                  </div>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ConversationTranscript({
  activeSession,
  busyTurnId,
  onRetry
}: {
  activeSession: ConversationSession | undefined;
  busyTurnId: string | undefined;
  onRetry: (session: ConversationSession, turn: ConversationTurn) => void;
}) {
  const rows = readConversationMessageRows(activeSession);
  if (rows.length === 0) {
    return (
      <div className="conversation-empty" aria-label="会话消息">
        <strong>开始一段新对话</strong>
        <span>历史会保存在这台 Mac 上。</span>
      </div>
    );
  }

  return (
    <ol className="assistant-thread conversation-transcript" aria-label="会话消息">
      {rows.map(({ message, retryEligible, turn }) => (
        <li
          className="conversation-message-row"
          data-message-kind={message.kind}
          data-outcome={turn.status}
          data-turn-id={turn.id}
          key={message.id}
        >
          <article
            className="assistant-message conversation-message"
            data-role={readConversationMessageRole(message)}
            data-state={readConversationMessageState(message)}
            aria-label={readConversationMessageAriaLabel(message)}
          >
            <div className="conversation-message-meta">
              <strong>{readConversationMessageKindLabel(message)}</strong>
              <time dateTime={message.createdAt}>
                {formatConversationTimestamp(message.createdAt)}
              </time>
            </div>
            <p>{message.text}</p>
            {retryEligible && activeSession ? (
              <button
                type="button"
                aria-label="安全重试失败回复"
                data-retry-safety="safe"
                disabled={busyTurnId === turn.id}
                onClick={() => onRetry(activeSession, turn)}
              >
                {busyTurnId === turn.id ? "重试中" : "安全重试"}
              </button>
            ) : null}
            {turn.status === "provider-failed" && !retryEligible && message.kind === "agent-reply" ? (
              <small>此轮不能安全重试，避免重复 Computer Use。</small>
            ) : null}
          </article>
        </li>
      ))}
    </ol>
  );
}

function readConversationMessageRole(message: ConversationMessage): "user" | "assistant" | "event" {
  if (message.kind === "user-text") {
    return "user";
  }
  return message.kind === "agent-reply" ? "assistant" : "event";
}

function readConversationMessageAriaLabel(message: ConversationMessage): string {
  if (message.kind === "user-text") {
    return "你发送给 skfiy";
  }
  if (message.kind === "agent-reply") {
    return "skfiy 回复";
  }
  return readConversationMessageKindLabel(message);
}

function readConversationMessageKindLabel(message: ConversationMessage): string {
  switch (message.kind) {
    case "user-text":
      return "你";
    case "agent-reply":
      return "skfiy";
    case "computer-use-request":
      return "Computer Use 请求";
    case "approval":
      return "审批";
    case "result":
      return "结果";
    case "stopped":
      return "已停止";
  }
}

function readConversationMessageState(message: ConversationMessage): string {
  switch (message.kind) {
    case "agent-reply":
      return message.state;
    case "approval":
      return message.decision;
    case "result":
      return message.status;
    case "computer-use-request":
      return "requested";
    case "stopped":
      return "stopped";
    case "user-text":
      return "completed";
  }
}
