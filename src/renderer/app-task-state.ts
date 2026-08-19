import type {
  FinderPlanPreview,
  ObserveAppReplayRecord,
  RouteOutcome,
  TaskEvent,
  TaskEventStopTurnBehavior,
  TaskStatus
} from "./app-types";
import { STATUS_COPY, canStopTurn } from "./app-view-model";

export interface TaskView {
  status: TaskStatus;
  message: string;
  command?: string;
  route?: string;
  routeReason?: string;
  denialKind?: string;
  policyKind?: string;
  routeOutcome?: RouteOutcome;
  stopTurnBehavior?: TaskEventStopTurnBehavior;
  finderPlanPreview?: FinderPlanPreview;
}

export interface AssistantConversationMessage {
  role: "user" | "assistant";
  text: string;
  state?: "pending" | "error";
}

export function createInitialTaskView(): TaskView {
  return {
    status: "idle",
    message: STATUS_COPY.idle.message,
    finderPlanPreview: undefined
  };
}

export function createTaskStatusView(
  status: TaskStatus,
  message = STATUS_COPY[status].message
): TaskView {
  return {
    status,
    message,
    ...(status === "idle" ? { finderPlanPreview: undefined } : {})
  };
}

export type TaskActionFailure =
  | "approve-task"
  | "deny-task"
  | "open-permission-settings"
  | "set-app-policy"
  | "set-assistant-agent"
  | "set-planner-provider"
  | "stop-current-turn";

const TASK_ACTION_FAILURE_MESSAGES: Record<TaskActionFailure, string> = {
  "approve-task": "确认请求失败.",
  "deny-task": "拒绝请求失败.",
  "open-permission-settings": "打开系统设置失败.",
  "set-app-policy": "切换应用策略失败.",
  "set-assistant-agent": "切换 Background Agent 失败.",
  "set-planner-provider": "切换规划模式失败.",
  "stop-current-turn": "停止任务失败."
};

export function createTaskActionFailureView(action: TaskActionFailure): TaskView {
  return createTaskStatusView("failed", TASK_ACTION_FAILURE_MESSAGES[action]);
}

export function createTaskViewFromEvent(event: TaskEvent): TaskView {
  return {
    status: event.status,
    message: event.message ?? STATUS_COPY[event.status].message,
    ...(event.command ? { command: event.command } : {}),
    ...(event.route ? { route: event.route } : {}),
    ...(event.routeReason ? { routeReason: event.routeReason } : {}),
    ...(event.denialKind ? { denialKind: event.denialKind } : {}),
    ...(event.policyKind ? { policyKind: event.policyKind } : {}),
    ...(event.routeOutcome ? { routeOutcome: event.routeOutcome } : {}),
    ...(event.stopTurnBehavior ? { stopTurnBehavior: event.stopTurnBehavior } : {}),
    finderPlanPreview: event.finderPlanPreview
  };
}

export function mergeReplayRecord(
  records: ObserveAppReplayRecord[],
  nextRecord: ObserveAppReplayRecord
): ObserveAppReplayRecord[] {
  const byStage = new Map<ObserveAppReplayRecord["stage"], ObserveAppReplayRecord>();

  for (const record of records) {
    byStage.set(record.stage, record);
  }

  byStage.set(nextRecord.stage, nextRecord);
  return ["before", "after"].flatMap((stage) => {
    const record = byStage.get(stage as ObserveAppReplayRecord["stage"]);
    return record ? [record] : [];
  });
}

export function updateReplayRecordsForTaskEvent(
  records: ObserveAppReplayRecord[],
  event: TaskEvent
): ObserveAppReplayRecord[] {
  if (event.replayReset) {
    return event.replayRecord ? [event.replayRecord] : [];
  }

  if (event.replayRecord) {
    return mergeReplayRecord(records, event.replayRecord);
  }

  return event.status === "idle" ? [] : records;
}

export function isAssistantConversationReplyEvent(
  event: TaskEvent,
  pendingPrompt: string | null
): boolean {
  return Boolean(pendingPrompt)
    && !event.command
    && (event.status === "completed" || event.status === "failed");
}

export function readAssistantConversationReply(message: string | undefined, status: TaskStatus): string {
  const fallback = status === "failed" ? "Background Agent 暂时不可用." : STATUS_COPY.completed.message;
  const text = message?.trim() || fallback;
  return text.replace(/^(?:Codex|Claude Code|Hermes):\s*/u, "").trim() || fallback;
}

export function appendAssistantConversationReply(
  messages: AssistantConversationMessage[],
  event: TaskEvent
): AssistantConversationMessage[] {
  return [
    ...messages.filter((message) => message.state !== "pending"),
    {
      role: "assistant",
      text: readAssistantConversationReply(event.message, event.status),
      ...(event.status === "failed" ? { state: "error" as const } : {})
    }
  ];
}

export function removePendingAssistantConversationMessages(
  messages: AssistantConversationMessage[]
): AssistantConversationMessage[] {
  return messages.filter((message) => message.state !== "pending");
}

export type TaskEventConversationAction =
  | "append-assistant-reply"
  | "remove-pending"
  | "none";

export type TaskEventPanelAction = "assistant-reply" | "non-idle-task-event";

export interface TaskEventUiTransition {
  task: TaskView;
  conversationAction: TaskEventConversationAction;
  clearPendingAssistantPrompt: boolean;
  finishAssistantInputSubmitting: boolean;
  panelAction?: TaskEventPanelAction;
}

export function createTaskEventUiTransition(
  event: TaskEvent,
  pendingPrompt: string | null
): TaskEventUiTransition {
  const task = createTaskViewFromEvent(event);

  if (isAssistantConversationReplyEvent(event, pendingPrompt)) {
    return {
      task,
      conversationAction: "append-assistant-reply",
      clearPendingAssistantPrompt: true,
      finishAssistantInputSubmitting: true,
      panelAction: "assistant-reply"
    };
  }

  if (event.status !== "idle") {
    return {
      task,
      conversationAction: event.command ? "remove-pending" : "none",
      clearPendingAssistantPrompt: Boolean(event.command),
      finishAssistantInputSubmitting: false,
      panelAction: "non-idle-task-event"
    };
  }

  return {
    task,
    conversationAction: "none",
    clearPendingAssistantPrompt: false,
    finishAssistantInputSubmitting: false
  };
}

export function updateAssistantConversationForTaskEvent(
  messages: AssistantConversationMessage[],
  event: TaskEvent,
  action: TaskEventConversationAction
): AssistantConversationMessage[] {
  if (action === "append-assistant-reply") {
    return appendAssistantConversationReply(messages, event);
  }

  if (action === "remove-pending") {
    return removePendingAssistantConversationMessages(messages);
  }

  return messages;
}

export function createAssistantSubmissionTaskView(): TaskView {
  return {
    status: "planned",
    message: "已交给 Background Agent."
  };
}

export function createAssistantSubmissionFailureTaskView(): TaskView {
  return {
    status: "failed",
    message: "发送给 Background Agent 失败."
  };
}

export function appendAssistantConversationSubmission(
  messages: AssistantConversationMessage[],
  command: string
): AssistantConversationMessage[] {
  return [
    ...messages.filter((message) => message.state !== "pending"),
    {
      role: "user",
      text: command
    },
    {
      role: "assistant",
      text: "Background Agent 正在回复...",
      state: "pending"
    }
  ];
}

export function appendAssistantConversationSubmissionFailure(
  messages: AssistantConversationMessage[]
): AssistantConversationMessage[] {
  return [
    ...messages.filter((message) => message.state !== "pending"),
    {
      role: "assistant",
      text: "发送给 Background Agent 失败.",
      state: "error"
    }
  ];
}

export interface StopTurnUiTransition {
  task: TaskView;
  panelAction: "non-idle-task-event";
}

export function createStopTurnUiTransition(status: TaskStatus): StopTurnUiTransition | null {
  if (!canStopTurn(status)) {
    return null;
  }

  return {
    task: createTaskStatusView("cancelled"),
    panelAction: "non-idle-task-event"
  };
}

export function shouldStopCurrentTurnFromKeyboard({
  key
}: {
  key: string;
}): boolean {
  return key === "Escape";
}

export type AssistantInputSubmissionTransition =
  | {
    type: "blocked";
    focusInput: true;
  }
  | {
    type: "submit";
    command: string;
    task: TaskView;
    panelAction: "open-assistant";
  };

export function shouldSubmitAssistantInputFromKeyboard({
  key,
  shiftKey
}: {
  key: string;
  shiftKey: boolean;
}): boolean {
  return key === "Enter" && !shiftKey;
}

export function createAssistantInputSubmissionTransition(
  input: string,
  submitting: boolean
): AssistantInputSubmissionTransition {
  const command = input.trim();

  if (!command || submitting) {
    return {
      type: "blocked",
      focusInput: true
    };
  }

  return {
    type: "submit",
    command,
    task: createAssistantSubmissionTaskView(),
    panelAction: "open-assistant"
  };
}
