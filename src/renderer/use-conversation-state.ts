import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from "react";
import {
  type ConversationActionState
} from "./app-conversation-components";
import {
  createConversationRetryRequest,
  createEmptyConversationHistorySnapshot,
  readActiveConversationSession
} from "./app-conversation-state";
import {
  appendAssistantConversationSubmission,
  appendAssistantConversationSubmissionFailure,
  createAssistantInputSubmissionTransition,
  createAssistantSubmissionFailureTaskView,
  createTaskStatusView,
  shouldSubmitAssistantInputFromKeyboard,
  type AssistantConversationMessage,
  type TaskView
} from "./app-task-state";
import type { PanelStateAction } from "./app-panel-state";
import type {
  ConversationHistorySnapshot,
  ConversationRetryResult,
  DesktopApi,
  ManualMode,
  TaskApprovalDecisionInput
} from "./app-types";
import type { TaskControlSnapshot } from "../shared/task-control";

function createConversationRetryTaskView(
  result: Pick<ConversationRetryResult, "status" | "message">
): TaskView {
  switch (result.status) {
    case "completed":
      return createTaskStatusView("completed", result.message);
    case "cancelled":
      return createTaskStatusView("cancelled", result.message);
    case "computer-use-blocked":
    case "unsafe-retry-blocked":
    case "not-found":
    case "retry-in-progress":
      return createTaskStatusView("blocked", result.message);
    case "provider-failed":
    case "storage-error":
      return createTaskStatusView("failed", result.message);
  }
}

function createConversationRetryRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `conversation-retry-${globalThis.crypto.randomUUID()}`;
  }

  return `conversation-retry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ConversationStateDeps {
  assistantInputRef: RefObject<HTMLTextAreaElement | null>;
  assistantPanelOpen: boolean;
  transitionPanelState: (action: PanelStateAction) => void;
  preserveActiveTaskView: (current: TaskView, next: TaskView) => TaskView;
  taskControl: TaskControlSnapshot | null;
  taskControlRef: MutableRefObject<TaskControlSnapshot | null>;
  setTaskControl: Dispatch<SetStateAction<TaskControlSnapshot | null>>;
  setTaskControlDecisionPending: Dispatch<SetStateAction<boolean>>;
  pendingTaskControlDecisionRef: MutableRefObject<TaskApprovalDecisionInput | null>;
  setTask: Dispatch<SetStateAction<TaskView>>;
  setTaskStopPending: Dispatch<SetStateAction<boolean>>;
  taskStopPendingRef: MutableRefObject<boolean>;
  defaultManualMode: ManualMode;
}

export function useConversationState(api: DesktopApi, deps: ConversationStateDeps) {
  const {
    assistantInputRef,
    assistantPanelOpen,
    transitionPanelState,
    preserveActiveTaskView,
    taskControl,
    taskControlRef,
    setTaskControl,
    setTaskControlDecisionPending,
    pendingTaskControlDecisionRef,
    setTask,
    setTaskStopPending,
    taskStopPendingRef,
    defaultManualMode
  } = deps;

  const [assistantInput, setAssistantInput] = useState("");
  const [assistantInputSubmitting, setAssistantInputSubmitting] = useState(false);
  const [assistantConversation, setAssistantConversation] = useState<AssistantConversationMessage[]>([]);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistorySnapshot>(
    createEmptyConversationHistorySnapshot
  );
  const [conversationHistoryAvailable, setConversationHistoryAvailable] = useState(false);
  const [conversationHistoryLoading, setConversationHistoryLoading] = useState(true);
  const [conversationNavigatorOpen, setConversationNavigatorOpen] = useState(false);
  const [conversationAction, setConversationAction] = useState<ConversationActionState | null>(null);
  const [conversationFeedback, setConversationFeedback] = useState("");
  const pendingAssistantPromptRef = useRef<string | null>(null);
  const conversationHistoryAvailableRef = useRef(false);
  const conversationHistoryEventReceivedRef = useRef(false);
  const assistantInputValueRef = useRef(assistantInput);

  const activeConversationSession = useMemo(
    () => readActiveConversationSession(conversationHistory),
    [conversationHistory]
  );
  const conversationRetrying = conversationAction?.action === "retry";

  const applyConversationHistorySnapshot = useCallback((snapshot: ConversationHistorySnapshot) => {
    setConversationHistory(snapshot);
    setConversationHistoryAvailable(true);
    setConversationHistoryLoading(false);
    setAssistantConversation([]);
  }, []);

  const refreshConversationHistory = useCallback(async () => {
    try {
      const snapshot = await api.getConversationHistory();
      applyConversationHistorySnapshot(snapshot);
      return snapshot;
    } catch {
      setConversationHistoryLoading(false);
      setConversationFeedback("本地会话历史不可用，已有历史不会被空数据覆盖。");
      return null;
    }
  }, [api, applyConversationHistorySnapshot]);

  useEffect(() => {
    conversationHistoryAvailableRef.current = conversationHistoryAvailable;
  }, [conversationHistoryAvailable]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.onConversationHistoryChanged((snapshot) => {
      if (!cancelled) {
        conversationHistoryEventReceivedRef.current = true;
        applyConversationHistorySnapshot(snapshot);
      }
    });

    void api.getConversationHistory().then((snapshot) => {
      if (!cancelled && !conversationHistoryEventReceivedRef.current) {
        applyConversationHistorySnapshot(snapshot);
      }
    }).catch(() => {
      if (!cancelled) {
        setConversationHistoryLoading(false);
        setConversationFeedback("本地会话历史不可用，已有历史不会被空数据覆盖。");
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, applyConversationHistorySnapshot]);

  useEffect(() => {
    if (assistantPanelOpen && !conversationNavigatorOpen) {
      assistantInputRef.current?.focus();
    } else if (!assistantPanelOpen) {
      setConversationNavigatorOpen(false);
    }
  }, [assistantPanelOpen, conversationNavigatorOpen, assistantInputRef]);

  useEffect(() => {
    if (conversationNavigatorOpen) {
      document.querySelector<HTMLElement>(
        '#skfiy-conversation-navigator [data-conversation-focus="true"]:not(:disabled)'
      )?.focus();
    }
  }, [conversationNavigatorOpen]);

  useEffect(() => {
    assistantInputValueRef.current = assistantInput;
  }, [assistantInput]);

  async function runConversationSnapshotAction(
    action: ConversationActionState,
    operation: () => Promise<ConversationHistorySnapshot>,
    options: { closeNavigator?: boolean } = {}
  ) {
    setConversationAction(action);
    setConversationFeedback("");
    try {
      applyConversationHistorySnapshot(await operation());
      if (options.closeNavigator) {
        setConversationNavigatorOpen(false);
      }
    } catch {
      setConversationFeedback("会话操作失败，请重试。");
    } finally {
      setConversationAction(null);
    }
  }

  async function startConversationSession() {
    await runConversationSnapshotAction(
      { action: "start" },
      () => api.startConversationSession(),
      { closeNavigator: true }
    );
  }

  async function switchConversationSession(sessionId: string) {
    await runConversationSnapshotAction(
      { action: "switch", sessionId },
      () => api.switchConversationSession(sessionId),
      { closeNavigator: true }
    );
  }

  async function renameConversationSession(sessionId: string, title: string) {
    await runConversationSnapshotAction(
      { action: "rename", sessionId },
      () => api.renameConversationSession({ sessionId, title })
    );
  }

  async function archiveConversationSession(sessionId: string) {
    await runConversationSnapshotAction(
      { action: "archive", sessionId },
      () => api.archiveConversationSession(sessionId)
    );
  }

  async function deleteConversationSession(sessionId: string) {
    await runConversationSnapshotAction(
      { action: "delete", sessionId },
      () => api.deleteConversationSession(sessionId)
    );
  }

  async function restoreConversationSession(sessionId: string) {
    await runConversationSnapshotAction(
      { action: "restore", sessionId },
      () => api.restoreConversationSession(sessionId)
    );
  }

  async function retryConversationTurn(
    session: Parameters<typeof createConversationRetryRequest>[0],
    turn: Parameters<typeof createConversationRetryRequest>[1]
  ) {
    const request = createConversationRetryRequest(
      session,
      turn,
      createConversationRetryRequestId
    );
    if (!request) {
      setConversationFeedback("此轮不能安全重试，避免重复 Computer Use。");
      return;
    }
    if (taskControlRef.current && taskControlRef.current.phase !== "terminal") {
      setConversationFeedback("先完成或停止当前 Computer Use，再安全重试 Background Agent。");
      return;
    }

    setConversationAction({ action: "retry", sessionId: session.id, turnId: turn.id });
    setConversationFeedback("");
    taskControlRef.current = null;
    setTaskControl(null);
    pendingTaskControlDecisionRef.current = null;
    setTaskControlDecisionPending(false);
    setTask(createTaskStatusView(
      "planned",
      "Retrying the Background Agent only. Computer Use remains disabled."
    ));

    try {
      const result = await api.retryConversationTurn(request);
      applyConversationHistorySnapshot(result.snapshot);
      setConversationFeedback(result.message);
      setTask(createConversationRetryTaskView(result));
    } catch {
      setConversationFeedback("安全重试失败，请稍后再试。");
      setTask(createTaskStatusView("failed", "Background Agent 安全重试失败。"));
    } finally {
      setConversationAction(null);
    }
  }

  async function submitAssistantInput(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const transition = createAssistantInputSubmissionTransition(
      assistantInput,
      assistantInputSubmitting
        || conversationAction?.action === "retry"
        || Boolean(taskControl && taskControl.phase !== "terminal")
    );

    if (transition.type === "blocked") {
      assistantInputRef.current?.focus();
      return;
    }

    pendingAssistantPromptRef.current = transition.command;
    if (!conversationHistoryAvailable) {
      setAssistantConversation((messages) => appendAssistantConversationSubmission(messages, transition.command));
    }
    setAssistantInputSubmitting(true);
    taskStopPendingRef.current = false;
    setTaskStopPending(false);
    transitionPanelState({ type: transition.panelAction });
    setTask((current) => preserveActiveTaskView(current, transition.task));
    setAssistantInput("");

    try {
      await api.runCommand(transition.command, {
        mode: defaultManualMode
      });
      if (conversationHistoryAvailable) {
        await refreshConversationHistory();
      }
    } catch {
      pendingAssistantPromptRef.current = null;
      if (!conversationHistoryAvailable) {
        setAssistantConversation(appendAssistantConversationSubmissionFailure);
      } else {
        await refreshConversationHistory();
      }
      setTask((current) => preserveActiveTaskView(
        current,
        createAssistantSubmissionFailureTaskView()
      ));
    } finally {
      setAssistantInputSubmitting(false);
    }
  }

  function submitAssistantInputFromKeyboard(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSubmitAssistantInputFromKeyboard({
      key: event.key,
      shiftKey: event.shiftKey
    })) {
      event.preventDefault();
      void submitAssistantInput();
    }
  }

  return {
    assistantInput,
    setAssistantInput,
    assistantInputSubmitting,
    setAssistantInputSubmitting,
    assistantConversation,
    setAssistantConversation,
    conversationHistory,
    conversationHistoryAvailable,
    conversationHistoryLoading,
    conversationNavigatorOpen,
    setConversationNavigatorOpen,
    conversationAction,
    conversationFeedback,
    setConversationFeedback,
    activeConversationSession,
    conversationRetrying,
    pendingAssistantPromptRef,
    conversationHistoryAvailableRef,
    assistantInputValueRef,
    refreshConversationHistory,
    startConversationSession,
    switchConversationSession,
    renameConversationSession,
    archiveConversationSession,
    deleteConversationSession,
    restoreConversationSession,
    retryConversationTurn,
    submitAssistantInput,
    submitAssistantInputFromKeyboard
  };
}
