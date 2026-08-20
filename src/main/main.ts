import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Notification as ElectronNotification,
  screen,
  systemPreferences
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopHelperClient } from "./computer-use/desktop-helper.js";
import { buildCdpCommand } from "./computer-use/browser-control.js";
import { runComputerUseAgentLoop } from "./computer-use/agent-loop.js";
import { createCodexComputerUsePlanner } from "./computer-use/agent-loop-planner.js";
import {
  createTurnReplayStore,
  type TurnReplay
} from "./computer-use/turn-replay-store.js";
import {
  createAppPolicyBoundComputerUsePlanPreview,
  createComputerUsePlanPreview,
  createDerivedComputerUsePlanId
} from "./computer-use-plan-preview.js";
import {
  createAppPolicySettingsStore,
  decideAppPolicy,
  readInitialAppPolicySettings
} from "./app-policy-settings.js";
import {
  AssistantAgentTurnRuntimeError,
  isAssistantAgentMode,
  readAssistantAgentProviderStates,
  runAssistantAgentTurn,
  type AssistantAgentTurnResult
} from "./assistant-agent.js";
import {
  createAssistantAgentSettingsStore,
  readInitialAssistantAgentSettingsFromConfig
} from "./assistant-agent-settings.js";
import { testAssistantAgentProvider } from "./assistant-agent-provider-test.js";
import { createSkfiyApplicationSupportPath } from "./personal-memory.js";
import { createMemoryStores } from "./memory-stores.js";
import { createProfileStore } from "./profile-store.js";
import {
  createIsolatedProfileMemoryBaseDir,
  createProfileRuntime
} from "./profile-runtime.js";
import { registerProfileIpc } from "./main-profile-wiring.js";
import { captureProfileSettings } from "./profile-settings.js";
import { readChromeHostPolicyState } from "./chrome-host-policy.js";
import { readPersonalMemorySettingsUpdate } from "./personal-memory-settings.js";
import {
  approvePendingPersonalMemoryWrite,
  forgetPersonalMemoryEntry,
  readPersonalMemoryDashboardSnapshot,
  readPersonalMemoryForgetRequest,
  readPendingMemoryActionRequest,
  rejectPendingPersonalMemoryWrite
} from "./personal-memory-dashboard.js";
import { recordCompletedAssistantTurnForPersonalization } from "./personalization-learning-loop.js";
import {
  searchSessionMemory
} from "./session-memory.js";
import {
  createConversationSessionStore,
  type ConversationTurnReference
} from "./conversation-session-store.js";
import { runConversationSafeRetry as retryConversationProviderTurn } from "./conversation-safe-retry.js";
import {
  CONVERSATION_HISTORY_SCHEMA_VERSION,
  type ConversationHistorySnapshot,
  type ConversationProviderIdentity,
  type ConversationRetryResult
} from "../shared/conversation-history.js";
import type { FirstRunProviderReadiness } from "../shared/first-run-readiness.js";
import type { BrowserPageContext } from "./browser-page-context.js";
import {
  createAssistantComputerUseExecutor,
  type AssistantComputerUseToolIdentity,
  type AssistantComputerUseToolResult
} from "./assistant-computer-use-executor.js";
import { applyApprovedChromeTaskHostPolicy } from "./chrome-approval-policy.js";
import { createChromeTurnHostGrantStore } from "./chrome-turn-host-grant.js";
import { createChromeCdpClient } from "./chrome-cdp-client.js";
import { readChromeCdpEndpoint } from "./chrome-cdp-settings.js";
import { CHROME_NATIVE_HOST_NAME, readChromeExtensionConnectionStatus } from "./chrome-native-host.js";
import { createBrowserContextSourceStore } from "./browser-context-source-store.js";
import { createBrowserContextSourceActions } from "./browser-context-source-actions.js";
import { registerBrowserContextSourceIpc } from "./browser-context-source-wiring.js";
import { createTmuxSupervisionClient } from "./tmux-supervision-client.js";
import { createTmuxRecoveryClient } from "./tmux-recovery-client.js";
import {
  createTmuxRecoveryBudget,
  parseTmuxRecoveryAction,
  type TmuxRecoveryAction,
  type TmuxRecoveryBudget
} from "./computer-use/tmux-recovery.js";
import {
  createPlannerProviderSettingsStore,
  readInitialPlannerProviderSettings
} from "./planner-provider-settings.js";
import { decidePlannerProviderRuntime } from "./planner-provider-runtime.js";
import { resolvePlannerCommand } from "./planner-command.js";
import { createExternalCuaTerminalPlannerFromEnv } from "./external-cua-planner.js";
import { readDesktopSessionDiagnosticsForRenderer } from "./desktop-session-diagnostics.js";
import { resolveHelperPath as resolveDesktopHelperPath } from "./helper-path.js";
import {
  requiresChromeSubmitConfirmation,
  runChromePageTask
} from "./orchestrator/chrome-task.js";
import {
  parseChromeWorkflowCommand,
  runChromeWorkflowTask
} from "./orchestrator/chrome-workflow-task.js";
import {
  requiresFinderPlanConfirmation,
  runFinderOrganizationTask
} from "./orchestrator/finder-task.js";
import { runGhosttyCommandTask } from "./orchestrator/ghostty-task.js";
import {
  assertDesktopActionResult,
  createChromeDesktopClient,
  createFinderDesktopClient,
  createFinderFileClient,
  createGhosttyDesktopClient
} from "./main-desktop-clients.js";
import { runTmuxSupervisionTask } from "./orchestrator/tmux-supervision-task.js";
import { runTmuxRecoveryTask } from "./orchestrator/tmux-recovery-task.js";
import {
  readPermissionsForRenderer
} from "./permissions.js";
import type { CommandRoute } from "./task-routing.js";
import { readStartupWarnings } from "./startup-guard.js";
import {
  registerStopTurnHotkey,
  STOP_TURN_ACCELERATOR
} from "./stop-turn-hotkey.js";
import { createScreenshotPathFactory } from "./screenshot-path.js";
import {
  calculatePetWindowBounds,
  readWindowPositionOverride,
  type Point,
  type Size
} from "./window-position.js";
import {
  COMPACT_WINDOW_SIZE
} from "./main-window-state.js";
import {
  applyPetWindowDragMove,
  applyPetWindowMode
} from "./main-window-controls.js";
import {
  persistMainRuntimeSnapshot
} from "./main-runtime-snapshot-writer.js";
import { readDefaultLocalOriginPetSkin } from "./pet-skin.js";
import { readDefaultApprovalBypass } from "./approval-bypass.js";
import {
  createAutomationMonitorManager,
  createAutomationMonitorStatePath,
  createAutomationMonitorStore,
  createTmuxAutomationMonitorPreview,
  normalizeMonitorTimeoutMs,
  type AutomationMonitorNotificationEvent,
  type AutomationMonitorStoreIo
} from "./automation-monitor.js";
import {
  createAutomationRunStatePath,
  createAutomationRunStore
} from "./automation-run.js";
import { createDataAdminRuntime } from "./data-admin-runtime.js";
import { registerDataAdminIpc } from "./main-data-admin-wiring.js";
import { runStorageMigrations } from "./storage-migration.js";
import { createAutomationRunSupervisor } from "./automation-run-supervisor.js";
import {
  createAutomationMonitorNotificationCoordinator
} from "./automation-monitor-notification.js";
import {
  readAutomationMonitorId,
  readAutomationRunId,
  readConversationRenameRequest,
  readConversationRetryRequest,
  readConversationSessionId,
  readPermissionSettingsTarget,
  readRunCommandRequest,
  readTaskApprovalDecisionRequest,
  readTmuxAutomationPreviewInput,
  readTmuxMonitorInput
} from "./main-ipc-payload.js";
import {
  createToolResult
} from "./main-computer-use-tool-result.js";
import {
  createAppPolicyPreflightDecision,
  createChromeHostPolicyPreflightDecision
} from "./main-computer-use-preflight.js";
import { createRunCommandRouteDecision } from "./main-command-routing.js";
import { createComputerUseTaskEventDispatch } from "./main-task-event-dispatch.js";
import {
  createAssistantAgentTaskMessage,
  createRuntimeStatusResponse
} from "./main-renderer-payload.js";
import { createMainPermissionDiagnosticsResponse } from "./main-permission-diagnostics.js";
import { createAssistantComputerUseToolPlan } from "./main-assistant-computer-use-plan.js";
import {
  readAssistantAgentSettingsResponse,
  updateAssistantAgentSettingsResponse
} from "./main-assistant-agent-settings-response.js";
import { createFirstRunReadinessController } from "./first-run-readiness.js";
import { readBrowserReadinessEvidence } from "./main-browser-readiness.js";
import { testFinderAutomationReadiness } from "./main-finder-automation-readiness.js";
import {
  readComponentVersions,
  readDiagnosticReportForRenderer,
  resolveHelperInfoPlistPath
} from "./diagnostic-report.js";
import { readAppPolicySettingsUpdate, readPlannerProviderSettingsUpdate } from "./main-settings-updates.js";
import {
  createManualScreenshotCompletedTaskEvent,
  createManualScreenshotFailedTaskEvent,
  createManualScreenshotStartedTaskEvent,
  createPermissionSettingsFailedTaskEvent,
  createUnknownPermissionSettingsTargetTaskEvent,
  createRejectedRunCommandTaskEvent
} from "./main-manual-task-events.js";
import {
  cancelComputerUseToolCallState,
  completeComputerUseToolCallState,
  createClearedActiveComputerUseTaskState,
  createClearedPendingComputerUseTaskState,
  createPendingApproval,
  createPendingApprovalDeniedTaskEvent,
  createStartedComputerUseTaskState,
  readApprovedPendingApprovalContinuation,
  readComputerUseRouteForToolCallState,
  readComputerUseToolCallIdentityToCancel,
  USER_DENIED_COMPUTER_USE_REASON,
  type ComputerUseApprovalGate,
  type ComputerUseCommandRoute,
  type PendingApproval
} from "./main-pending-approval.js";
import {
  createAppPolicyApprovalRequiredTaskEvent,
  createAppPolicyBlockedTaskEvent,
  createAssistantChatRouteTaskEvent,
  createAssistantToolPlanRouteTaskEvent,
  createAssistantTurnFailedRouteTaskEvent,
  createComputerUseFailureTaskEvent,
  createNeedsClarificationRouteTaskEvent,
  createNeedsConfirmationRouteTaskEvent,
  createPlannerResolvedTaskEvent,
  createPlannerUnavailableTaskEvent,
  createTerminalRouteTaskEvent
} from "./main-route-task-events.js";
import {
  advanceComputerUseTaskControl,
  createTaskControlExecutionId,
  createTaskControlStopMessage,
  decorateTaskEventWithTaskControl,
  readComputerUseTaskSideEffectState,
  startComputerUseTaskControl
} from "./main-task-control.js";
import { createTaskControlStore } from "./task-control-store.js";
import { createTaskRecoveryRegistry } from "./task-recovery-registry.js";
import { startTaskRecoveryDispatch } from "./task-recovery-dispatch.js";
import {
  readTaskRecoveryChromePageSnapshot,
  runTaskRecoveryStage
} from "./task-recovery-stage.js";
import { readTaskRecoveryPathStatus } from "./task-recovery-stage-runtime.js";
import { createStopTaskEventDecision } from "./main-stop-task.js";
import { createSmokeAssistantAgentTaskTurn } from "./main-smoke-assistant-turn.js";
import {
  createTaskEvent,
  readTurnReplayTaskEvent,
  withRouteTaskEventMetadata,
  type ComputerUseTaskEvent,
  type ManualMode,
  type TaskEvent
} from "./task-event-view.js";
import type {
  TaskControlApproval,
  TaskControlSideEffectState,
  TaskControlSnapshot
} from "../shared/task-control.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const devServerUrl = process.env.SKFIY_DEV_SERVER_URL;
const smokeWindowHidden = process.env.SKFIY_SMOKE_WINDOW_MODE === "hidden";
app.setName("skfiy");
const skfiyAppSupportDir = createSkfiyApplicationSupportPath(os.homedir());
const appPolicySettingsStore = createAppPolicySettingsStore(readInitialAppPolicySettings());
const chromeCdpEndpoint = readChromeCdpEndpoint({
  argv: process.argv,
  env: process.env
});
const plannerProviderSettingsStore = createPlannerProviderSettingsStore(
  readInitialPlannerProviderSettings(process.env)
);
const assistantAgentSettingsStore = createAssistantAgentSettingsStore(
  readInitialAssistantAgentSettingsFromConfig(process.env, { cwd: process.cwd() })
);
const browserContextSourceStore = createBrowserContextSourceStore();
const browserContextSourceActions = createBrowserContextSourceActions({
  store: browserContextSourceStore,
  homeDir: os.homedir(),
  readConnectionStatus: readChromeExtensionConnectionStatus,
  emitChange: (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("skfiy:browser-context-changed", snapshot);
    }
  }
});
const firstRunReadinessController = createFirstRunReadinessController({
  readProviderReadiness: async () => readSelectedProviderReadiness(
    await readAssistantAgentSettingsResponse({ store: assistantAgentSettingsStore })
  ),
  testBackgroundAgentReadiness: async () => readSelectedProviderReadiness(
    await readAssistantAgentSettingsResponse({
      store: assistantAgentSettingsStore,
      readProviderStates: (settings) => readAssistantAgentProviderStates(settings, {
        proveChatReadiness: true
      })
    })
  ),
  readPermissions: () => readPermissionsForRenderer({ helper: createDesktopHelper() }),
  readDesktopSession: () => readDesktopSessionDiagnosticsForRenderer({ helper: createDesktopHelper() }),
  readBrowserReadiness: () => readBrowserReadinessEvidence({
    homeDir: os.homedir(),
    cliShimPath: resolveCliShimPath()
  }),
  testFinderAutomation: () => testFinderAutomationReadiness({
    getFinderSelection: () => createDesktopHelper().getFinderSelection()
  })
});
// Memory stores are rebuilt against a profile-scoped base dir when an
// isolated profile is active, so every existing memory consumer reads
// profile-scoped data with no further changes. The Default profile keeps
// the global base dir, preserving existing USER.md / AGENT.md / sessions.jsonl.
let memoryStores = createMemoryStores(skfiyAppSupportDir);
const profileStore = createProfileStore({
  baseDir: skfiyAppSupportDir,
  seed: captureProfileSettings({
    assistantAgent: assistantAgentSettingsStore.get(),
    plannerProvider: plannerProviderSettingsStore.get(),
    appPolicy: appPolicySettingsStore.get(),
    personalMemory: memoryStores.personalMemorySettings.read(),
    defaultManualMode: "active"
  })
});
const profileRuntime = createProfileRuntime({
  store: profileStore,
  liveSettings: {
    assistantAgent: assistantAgentSettingsStore,
    plannerProvider: plannerProviderSettingsStore,
    appPolicy: appPolicySettingsStore,
    personalMemory: {
      read: () => memoryStores.personalMemorySettings.read(),
      update: (update) => memoryStores.personalMemorySettings.update(update)
    }
  },
  sharedMemoryBaseDir: skfiyAppSupportDir,
  isolatedMemoryBaseDir: (profileId) =>
    createIsolatedProfileMemoryBaseDir(skfiyAppSupportDir, profileId),
  rebuildMemoryStores: (baseDir) => {
    memoryStores = createMemoryStores(baseDir);
  },
  readHostPolicy: async () =>
    (await readChromeHostPolicyState({ homeDir: os.homedir() })).policy,
  removeProfileDirectory: (profileId) => {
    fs.rmSync(createIsolatedProfileMemoryBaseDir(skfiyAppSupportDir, profileId), {
      recursive: true,
      force: true
    });
  },
  emitChanged: (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("skfiy:profile-changed", snapshot);
    }
  }
});
const PERSONAL_MEMORY_REVIEW_TIMEOUT_MS = 15_000;
type ConversationSessionStore = ReturnType<typeof createConversationSessionStore>;
let conversationSessionStore: ConversationSessionStore | null = null;
let conversationSessionStorageError: unknown;
try {
  conversationSessionStore = createConversationSessionStore({
    baseDir: skfiyAppSupportDir
  });
} catch (error) {
  conversationSessionStorageError = error;
}
const turnReplayStore = createTurnReplayStore({
  onReplayChanged: (replay) => {
    persistRuntimeSnapshot(replay);
  }
});
const taskRecoveryRegistry = createTaskRecoveryRegistry();
const taskControlStore = createTaskControlStore({
  onChanged: (snapshot) => taskRecoveryRegistry.sync(snapshot)
});
const automationMonitorNotificationCoordinator = createAutomationMonitorNotificationCoordinator();
const automationRunStore = createAutomationRunStore({
  filePath: createAutomationRunStatePath(os.homedir()),
  io: createNodeAutomationMonitorStoreIo()
});
const automationRunSupervisor = createAutomationRunSupervisor({
  onRunTerminal: showAutomationMonitorNotification,
  store: automationRunStore,
  tmuxClient: createTmuxSupervisionClient()
});
const automationMonitorStore = createAutomationMonitorStore({
  filePath: createAutomationMonitorStatePath(os.homedir()),
  io: createNodeAutomationMonitorStoreIo()
});
const automationMonitorManager = createAutomationMonitorManager({
  store: automationMonitorStore,
  supervisor: automationRunSupervisor
});
const dataAdminRuntime = createDataAdminRuntime({
  baseDir: skfiyAppSupportDir,
  homeDir: os.homedir(),
  appVersion: app.getVersion(),
  profileStore,
  profileRuntime,
  resolveMemoryBaseDir: () => {
    const activeId = profileStore.getActiveId();
    const profile = activeId ? profileStore.get(activeId) : undefined;
    return profile && profile.memoryScope === "isolated"
      ? createIsolatedProfileMemoryBaseDir(skfiyAppSupportDir, profile.id)
      : skfiyAppSupportDir;
  },
  conversationStore: () => conversationSessionStore,
  conversationStoreBaseDir: skfiyAppSupportDir,
  automationMonitorManager,
  automationMonitorStore,
  automationRunStore,
  stopMonitorRuns: (monitorId) => automationRunSupervisor.stopMonitorRuns(monitorId, "dashboard"),
  emitRestored: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("skfiy:data-restored");
    }
  }
});
// Per-session recovery budgets persist across IPC turns so retry counts
// accumulate instead of resetting on every task invocation.
const tmuxRecoveryBudgets = new Map<string, TmuxRecoveryBudget>();

function readTmuxRecoveryBudget(sessionName: string): TmuxRecoveryBudget {
  const existing = tmuxRecoveryBudgets.get(sessionName);
  if (existing) {
    return existing;
  }
  const created = createTmuxRecoveryBudget();
  tmuxRecoveryBudgets.set(sessionName, created);
  return created;
}

function persistTmuxRecoveryBudget(sessionName: string, budget: TmuxRecoveryBudget): void {
  tmuxRecoveryBudgets.set(sessionName, budget);
}
const assistantComputerUseExecutor = createAssistantComputerUseExecutor({
  replayStore: turnReplayStore
});
const chromeTurnHostGrantStore = createChromeTurnHostGrantStore();
let mainWindow: BrowserWindow | null = null;

function showAutomationMonitorNotification(event: AutomationMonitorNotificationEvent) {
  if (smokeWindowHidden) {
    return;
  }

  const window = mainWindow;
  const notice = automationMonitorNotificationCoordinator.take(event, {
    windowFocused: Boolean(window && !window.isDestroyed() && window.isFocused())
  });
  if (!notice || !ElectronNotification.isSupported()) {
    return;
  }

  const notification = new ElectronNotification({
    title: notice.title,
    body: notice.body,
    silent: true
  });
  notification.on("click", () => {
    if (!window || window.isDestroyed()) return;
    window.show();
    window.focus();
  });
  notification.show();
}
let currentPetAnchor: Point | null = null;
let currentPetSize: Size | null = null;
let currentTaskId = 0;
const createScreenshotPath = createScreenshotPathFactory({
  readTempDir: () => os.tmpdir()
});
let activeTaskController: AbortController | null = null;
let activeComputerUseToolIdentity: AssistantComputerUseToolIdentity | null = null;
let activeComputerUseRoute: ComputerUseCommandRoute | null = null;
let activeConversationTurn: (ConversationTurnReference & { toolCallId?: string }) | null = null;
let activeAssistantTurnController: AbortController | null = null;
let conversationRetryInProgress = false;
let pendingApproval: PendingApproval | null = null;
let stopTurnHotkeyRegistered = false;

function createNodeAutomationMonitorStoreIo(): AutomationMonitorStoreIo {
  return {
    exists: fs.existsSync,
    mkdir: (dirPath) => {
      fs.mkdirSync(dirPath, { recursive: true });
    },
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    rename: fs.renameSync,
    writeFile: (filePath, content) => {
      fs.writeFileSync(filePath, content, "utf8");
    }
  };
}

function persistRuntimeSnapshot(
  replay: TurnReplay | null,
  currentTurnEvent?: TaskEvent
): void {
  void persistMainRuntimeSnapshot({
    homeDir: os.homedir(),
    replay,
    ...(currentTurnEvent ? { currentTurnEvent } : {})
  }).catch(() => {
    // Dashboard runtime evidence is best-effort and must not block Computer Use turns.
  });
}

function emitTaskEvent(window: BrowserWindow | null, event: TaskEvent) {
  persistRuntimeSnapshot(turnReplayStore.getReplay(), event);

  if (!window || window.isDestroyed()) {
    return;
  }

  window.webContents.send("skfiy:task-event", event);
}

function createUnavailableConversationHistorySnapshot(): ConversationHistorySnapshot {
  return {
    schemaVersion: CONVERSATION_HISTORY_SCHEMA_VERSION,
    lastActiveSessionId: null,
    sessions: []
  };
}

function requireConversationSessionStore(): ConversationSessionStore {
  if (conversationSessionStore) {
    return conversationSessionStore;
  }

  const reason = conversationSessionStorageError instanceof Error
    ? conversationSessionStorageError.message
    : "Conversation history storage is unavailable.";
  throw new Error(reason);
}

function emitConversationHistoryChanged(
  window: BrowserWindow | null,
  snapshot = conversationSessionStore?.read()
): void {
  if (!snapshot || !window || window.isDestroyed()) {
    return;
  }

  window.webContents.send("skfiy:conversation-history-changed", snapshot);
}

function emitPersonalMemoryChanged(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  window.webContents.send(
    "skfiy:personal-memory-changed",
    readPersonalMemoryDashboardSnapshot({ baseDir: memoryStores.baseDir })
  );
}

function recordConversationTaskEvent(event: TaskEvent): boolean {
  const context = activeConversationTurn;
  const store = conversationSessionStore;
  if (!context?.toolCallId || !store) {
    return false;
  }

  if (event.status === "approval_required") {
    store.recordApproval({
      ...context,
      toolCallId: context.toolCallId,
      decision: "required",
      text: event.message ?? "Computer Use approval required.",
      reason: event.routeReason ?? event.message
    });
    return false;
  }

  if (event.status === "needs_confirmation") {
    const summary = event.message ?? "Computer Use verification needs user confirmation.";
    store.recordComputerUseResult({
      ...context,
      toolCallId: context.toolCallId,
      status: "failed",
      summary,
      text: summary
    });
    return true;
  }

  if (event.status === "cancelled") {
    store.stopTurn({
      ...context,
      reason: event.message ?? "Task stopped."
    });
    return true;
  }

  if (
    event.status === "completed"
    || event.status === "denied"
    || event.status === "blocked"
    || event.status === "failed"
  ) {
    const status = event.status;
    const summary = event.message ?? `Computer Use ${status}.`;
    store.recordComputerUseResult({
      ...context,
      toolCallId: context.toolCallId,
      status,
      summary,
      text: summary
    });
    return true;
  }

  return false;
}

function emitTurnReplayTaskEvent(window: BrowserWindow | null, event: TaskEvent): void {
  let conversationTerminal = false;
  try {
    conversationTerminal = recordConversationTaskEvent(event);
  } catch (error) {
    conversationSessionStorageError = error;
  }
  turnReplayStore.recordTaskEvent(readTurnReplayTaskEvent(event));
  emitTaskEvent(window, event);
  emitConversationHistoryChanged(window);
  if (conversationTerminal) {
    activeConversationTurn = null;
  }
}

function recordConversationRetryTerminalTaskEvent(
  event: TaskEvent
): void {
  const latestStatus = turnReplayStore.getReplay()?.timeline.at(-1)?.status;
  if (
    latestStatus === "completed"
    || latestStatus === "failed"
    || latestStatus === "denied"
    || latestStatus === "blocked"
    || latestStatus === "cancelled"
    || latestStatus === "needs_confirmation"
    || latestStatus === "needs_clarification"
  ) {
    return;
  }

  turnReplayStore.recordTaskEvent(readTurnReplayTaskEvent(event));
  persistRuntimeSnapshot(turnReplayStore.getReplay(), event);
}

function createConversationRetryStartedTaskEvent(): TaskEvent {
  return {
    status: "planned",
    message: "Retrying the Background Agent only. Computer Use remains disabled."
  };
}

function createConversationRetryResultTaskEvent(
  result: Pick<ConversationRetryResult, "status" | "message">
): TaskEvent {
  switch (result.status) {
    case "completed":
      return { status: "completed", message: result.message };
    case "cancelled":
      return { status: "cancelled", message: result.message };
    case "computer-use-blocked":
    case "unsafe-retry-blocked":
    case "not-found":
    case "retry-in-progress":
      return { status: "blocked", message: result.message };
    case "provider-failed":
    case "storage-error":
      return { status: "failed", message: result.message };
  }
}

function createConversationRetryUnexpectedFailureTaskEvent(): TaskEvent {
  return {
    status: "failed",
    message: "Background Agent retry failed unexpectedly. The retry is closed and safe to review."
  };
}

function startTaskControlForComputerUse({
  command,
  forceApproval,
  route,
  toolIdentity
}: {
  command: string;
  forceApproval: boolean;
  route: ComputerUseCommandRoute;
  toolIdentity: AssistantComputerUseToolIdentity;
}): TaskControlSnapshot {
  const plan = createComputerUsePlanPreview({ command, route, forceApproval });
  return startComputerUseTaskControl({
    store: taskControlStore,
    identity: toolIdentity,
    plan,
    message: `Plan ready for ${plan.appName}: ${plan.target}.`
  });
}

function readTaskControlForTool(
  toolIdentity: AssistantComputerUseToolIdentity
): TaskControlSnapshot {
  const snapshot = taskControlStore.read();
  const executionId = createTaskControlExecutionId(toolIdentity);
  if (!snapshot || snapshot.executionId !== executionId) {
    throw new Error(`Task Control execution ${executionId} is not active.`);
  }

  return snapshot;
}

function emitTaskControlTurnReplayTaskEvent(
  window: BrowserWindow | null,
  event: TaskEvent,
  {
    executionId,
    sideEffectState,
    approval
  }: {
    executionId: string;
    sideEffectState?: TaskControlSideEffectState;
    approval?: TaskControlApproval;
  }
): TaskControlSnapshot {
  const snapshot = advanceComputerUseTaskControl({
    store: taskControlStore,
    executionId,
    event,
    sideEffectState,
    approval
  });
  emitTurnReplayTaskEvent(window, decorateTaskEventWithTaskControl(event, snapshot));
  return snapshot;
}

function emitTaskControlEventForTool(
  window: BrowserWindow | null,
  event: TaskEvent,
  toolIdentity: AssistantComputerUseToolIdentity,
  sideEffectState?: TaskControlSideEffectState,
  approval?: TaskControlApproval
): TaskControlSnapshot {
  return emitTaskControlTurnReplayTaskEvent(window, event, {
    executionId: createTaskControlExecutionId(toolIdentity),
    ...(sideEffectState ? { sideEffectState } : {}),
    ...(approval ? { approval } : {})
  });
}

function createTaskControlApproval(
  approval: PendingApproval
): TaskControlApproval {
  return {
    gate: approval.gate,
    planId: approval.planId,
    ...(approval.approvedPlanPreview ? {
      finderPlanPreview: {
        ...approval.approvedPlanPreview,
        createFolders: [...approval.approvedPlanPreview.createFolders],
        moveFiles: approval.approvedPlanPreview.moveFiles.map((move) => ({ ...move })),
        ...(approval.approvedPlanPreview.copyFiles ? {
          copyFiles: approval.approvedPlanPreview.copyFiles.map((copy) => ({ ...copy }))
        } : {})
      }
    } : {}),
    ...(approval.approvedChromeSubmitBinding ? {
      chromeSubmitBinding: {
        ...approval.approvedChromeSubmitBinding,
        fieldSelectors: [...approval.approvedChromeSubmitBinding.fieldSelectors]
      }
    } : {}),
    ...(approval.approvedChromeWorkflowPreview ? {
      chromeWorkflowPreview: {
        ...approval.approvedChromeWorkflowPreview,
        steps: approval.approvedChromeWorkflowPreview.steps.map((step) => ({ ...step }))
      }
    } : {})
  };
}

function stopActiveConversationTurn(window: BrowserWindow | null, reason: string): void {
  const context = activeConversationTurn;
  if (context && conversationSessionStore) {
    try {
      conversationSessionStore.stopTurn({ ...context, reason });
      emitConversationHistoryChanged(window);
    } catch (error) {
      conversationSessionStorageError = error;
    }
  }
  activeConversationTurn = null;
}

function clearPendingComputerUseTask(): void {
  const nextState = createClearedPendingComputerUseTaskState({
    currentTaskId,
    pendingApproval
  });
  pendingApproval = nextState.pendingApproval;
  activeTaskController?.abort();
  activeTaskController = null;
  currentTaskId = nextState.currentTaskId;
}

function clearActiveComputerUseTask(): void {
  if (activeComputerUseToolIdentity) {
    chromeTurnHostGrantStore.clear(activeComputerUseToolIdentity);
  }
  const nextState = createClearedActiveComputerUseTaskState({
    currentTaskId,
    pendingApproval,
    activeToolIdentity: activeComputerUseToolIdentity,
    activeRoute: activeComputerUseRoute
  });
  pendingApproval = nextState.pendingApproval;
  activeComputerUseToolIdentity = nextState.activeToolIdentity;
  activeComputerUseRoute = nextState.activeRoute;
  activeTaskController?.abort();
  activeTaskController = null;
  currentTaskId = nextState.currentTaskId;
}

function startComputerUseTaskEpoch() {
  const nextState = createStartedComputerUseTaskState({
    currentTaskId,
    pendingApproval,
    activeToolIdentity: activeComputerUseToolIdentity,
    activeRoute: activeComputerUseRoute
  });
  currentTaskId = nextState.currentTaskId;
  pendingApproval = nextState.pendingApproval;
  activeTaskController?.abort();

  const controller = new AbortController();
  activeTaskController = controller;

  return { controller, taskId: nextState.taskId };
}

function resolveHelperPath(): string {
  return resolveDesktopHelperPath({
    env: process.env,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  });
}

function createDesktopHelper(): DesktopHelperClient {
  return new DesktopHelperClient({
    helperPath: resolveHelperPath()
  });
}

function resolveCliShimPath(): string {
  return app.isPackaged
    ? path.join(path.resolve(app.getAppPath(), "../../../.."), "skfiy")
    : path.join(app.getAppPath(), "dist", "skfiy");
}

function readSelectedProviderReadiness(
  response: Awaited<ReturnType<typeof readAssistantAgentSettingsResponse>>
): FirstRunProviderReadiness {
  return response.providers.find((provider) => provider.selected)?.readiness ?? "unknown";
}

function readSelectedConversationProvider(): ConversationProviderIdentity {
  const mode = assistantAgentSettingsStore.get().mode;
  return {
    id: mode,
    label: "Codex"
  };
}

async function createAssistantAgentTaskTurn(
  input: string,
  {
    createTurnId,
    provider,
    signal,
    sessionId,
    isRetry = false
  }: {
    createTurnId?: () => string;
    provider?: ConversationProviderIdentity;
    signal?: AbortSignal;
    sessionId?: string;
    isRetry?: boolean;
  } = {}
): Promise<AssistantAgentTurnResult> {
  const smokeTurn = createSmokeAssistantAgentTaskTurn(input, {
    createId: createTurnId
  });
  if (smokeTurn) {
    return smokeTurn;
  }

  const browserPageContext = isRetry
    ? undefined
    : await browserContextSourceActions.readTurnContext();
  const personalMemory = memoryStores.personalMemory.read();
  const personalSkillSettings = memoryStores.personalSkillSettings.read();
  const recallableRecords = conversationSessionStore?.readRecallableRecords()
    ?? memoryStores.sessionMemory.readAll();
  const currentSessionRecords = sessionId && conversationSessionStore
    ? conversationSessionStore.readRecallableRecords({ sessionId }).slice(-3)
    : [];
  const currentTurnIds = new Set(currentSessionRecords.map((record) => record.turnId));
  const recalledSessions = [
    ...currentSessionRecords,
    ...searchSessionMemory(recallableRecords, input, 3)
      .filter((record) => !currentTurnIds.has(record.turnId))
  ].slice(0, 3);

  try {
    const currentSettings = assistantAgentSettingsStore.get();
    const requestedMode = provider?.id;
    const providerMode: typeof currentSettings.mode | undefined = requestedMode === "codex"
      ? requestedMode as typeof currentSettings.mode
      : undefined;
    const settings = providerMode ? { ...currentSettings, mode: providerMode } : currentSettings;
    const turn = await runAssistantAgentTurn(input, {
      settings,
      ...(browserPageContext ? { browserPageContext } : {}),
      ...(createTurnId ? { createTurnId } : {}),
      personalMemory,
      personalSkillSettings,
      recalledSessions,
      signal
    });
    if (turn.status === "completed") {
      schedulePersonalMemoryPostTurnReview(input, turn, browserPageContext);
    }
    return turn;
  } catch (error) {
    if (error instanceof AssistantAgentTurnRuntimeError) {
      return error.turn;
    }

    throw error;
  }
}

function schedulePersonalMemoryPostTurnReview(
  userInput: string,
  turn: AssistantAgentTurnResult,
  browserPageContext: BrowserPageContext | undefined
): void {
  const settings = memoryStores.personalMemorySettings.read();
  if (!settings.postTurnLearningEnabled) {
    return;
  }

  const assistantSettings = assistantAgentSettingsStore.get();
  void recordCompletedAssistantTurnForPersonalization({
    userInput,
    turn,
    browserPageContext: browserPageContext ?? { state: "unavailable" },
    memoryStore: memoryStores.personalMemory,
    memoryJournalStore: memoryStores.personalMemoryJournal,
    pendingMemoryStore: memoryStores.pendingPersonalMemory,
    sessionMemoryStore: memoryStores.sessionMemory,
    memoryWriteApprovalEnabled: settings.writeApprovalEnabled,
    runReviewTurn: (reviewPrompt, { personalMemory }) => runAssistantAgentTurn(reviewPrompt, {
      settings: {
        ...assistantSettings,
        timeoutMs: Math.min(assistantSettings.timeoutMs, PERSONAL_MEMORY_REVIEW_TIMEOUT_MS)
      },
      personalMemory
    })
  })
    .then(() => {
      emitPersonalMemoryChanged();
    })
    .catch(() => {
      // Personalization is best-effort and must not interrupt the visible reply.
    });
}

function emitAssistantToolPlanTaskEvent(
  window: BrowserWindow | null,
  turn: AssistantAgentTurnResult,
  command: string,
  route: CommandRoute
): void {
  const event = createAssistantToolPlanRouteTaskEvent({ command, route, turn });
  if (!event) {
    return;
  }

  emitTurnReplayTaskEvent(window, event);
}

async function bindGhosttyPlannerCommand({
  command,
  forceApproval,
  route,
  toolIdentity,
  window
}: {
  command: string;
  forceApproval: boolean;
  route: Extract<ComputerUseCommandRoute, { kind: "ghostty" }>;
  toolIdentity: AssistantComputerUseToolIdentity;
  window: BrowserWindow | null;
}): Promise<string | null> {
  const plannerRuntime = decidePlannerProviderRuntime(plannerProviderSettingsStore.get());
  if (plannerRuntime.decision === "unavailable") {
    completeComputerUseToolCall(toolIdentity, createToolResult("failed", plannerRuntime.message));
    emitTaskControlEventForTool(window, createPlannerUnavailableTaskEvent({
      command,
      message: plannerRuntime.message,
      route,
      status: plannerRuntime.status
    }), toolIdentity);
    return null;
  }

  const { controller, taskId } = startComputerUseTaskEpoch();
  try {
    const plannedCommand = await resolvePlannerCommand({
      input: command,
      runtime: plannerRuntime,
      signal: controller.signal,
      createExternalPlanner: () => createExternalCuaTerminalPlannerFromEnv(process.env)
    });
    if (controller.signal.aborted || taskId !== currentTaskId) {
      return null;
    }

    const latestAppPolicy = decideAppPolicy(
      appPolicySettingsStore.get(),
      route.bundleId
    );
    const plan = createAppPolicyBoundComputerUsePlanPreview({
      appPolicy: latestAppPolicy.decision,
      command: plannedCommand.command,
      route,
      forceApproval
    });
    taskControlStore.bindPlan({
      executionId: createTaskControlExecutionId(toolIdentity),
      message: `Bound exact ${plan.appName} plan for ${plan.target}.`,
      plan
    });

    if (plannedCommand.providerLabel) {
      turnReplayStore.recordComputerUseEvent({
        type: "planner_resolved",
        providerLabel: plannedCommand.providerLabel,
        input: command,
        command: plannedCommand.command,
        rationale: plannedCommand.rationale
      });
      emitTaskControlEventForTool(window, createPlannerResolvedTaskEvent({
        command: plannedCommand.command,
        plannedCommand,
        providerLabel: plannedCommand.providerLabel,
        route
      }), toolIdentity);
    }

    return plannedCommand.command;
  } catch (error) {
    if (controller.signal.aborted || taskId !== currentTaskId) {
      return null;
    }

    const message = error instanceof Error ? error.message : "Computer Use Planner failed.";
    completeComputerUseToolCall(toolIdentity, createToolResult("failed", message));
    emitTaskControlEventForTool(window, createPlannerUnavailableTaskEvent({
      command,
      message,
      route,
      status: "failed"
    }), toolIdentity);
    return null;
  } finally {
    if (activeTaskController === controller) {
      activeTaskController = null;
    }
  }
}

function dispatchComputerUseTaskEvent({
  actionApproved,
  chromeSubmitApproved = false,
  chromeWorkflowApproved = false,
  command,
  finderPlanApproved,
  mode,
  route,
  taskEvent,
  toolIdentity,
  window
}: {
  actionApproved: boolean;
  chromeSubmitApproved?: boolean;
  chromeWorkflowApproved?: boolean;
  command: string;
  finderPlanApproved: boolean;
  mode: ManualMode;
  route: ComputerUseCommandRoute;
  taskEvent: ComputerUseTaskEvent;
  toolIdentity: AssistantComputerUseToolIdentity;
  window: BrowserWindow | null;
}): void {
  const taskControl = readTaskControlForTool(toolIdentity);
  const dispatch = createComputerUseTaskEventDispatch({
    approved: actionApproved,
    chromeSubmitApproved,
    chromeWorkflowApproved,
    command,
    event: taskEvent,
    mode,
    planApproved: finderPlanApproved,
    route
  });
  let approvalContext: TaskControlApproval | undefined;

  if (dispatch.approvalRequest) {
    const approvalGate: ComputerUseApprovalGate = dispatch.approvalRequest.approvedChromeSubmitBinding
      ? "chrome-submit"
      : dispatch.approvalRequest.approvedChromeWorkflowPreview
        ? "chrome-workflow"
        : dispatch.approvalRequest.approvedPlanPreview
          ? "finder-plan"
          : "action-plan";
    const approvalPlanId = approvalGate === "action-plan"
      ? taskControl.plan.planId
      : createDerivedComputerUsePlanId(
        taskControl.plan.planId,
        approvalGate === "finder-plan"
          ? dispatch.approvalRequest.approvedPlanPreview
          : approvalGate === "chrome-workflow"
            ? dispatch.approvalRequest.approvedChromeWorkflowPreview
            : dispatch.approvalRequest.approvedChromeSubmitBinding
      );
    const approval = requireComputerUseApproval({
      command: dispatch.approvalRequest.command,
      gate: approvalGate,
      mode,
      planId: approvalPlanId,
      route,
      toolIdentity,
      reason: dispatch.approvalRequest.reason,
      actionApproved,
      chromeSubmitApproved,
      chromeWorkflowApproved,
      finderPlanApproved,
      approvedPlanPreview: dispatch.approvalRequest.approvedPlanPreview,
      approvedChromeSubmitBinding: dispatch.approvalRequest.approvedChromeSubmitBinding,
      approvedChromeWorkflowPreview: dispatch.approvalRequest.approvedChromeWorkflowPreview
    });
    approvalContext = createTaskControlApproval(approval);
  }

  const sideEffectState = readComputerUseTaskSideEffectState(
    taskEvent,
    taskControl.plan,
    {
      actionApproved,
      chromeSubmitApproved,
      finderPlanApproved,
      chromeSubmitConfirmationRequired: route.kind === "chrome"
        && requiresChromeSubmitConfirmation(command),
      ...(route.kind === "finder" ? {
        finderPlanConfirmationRequired: requiresFinderPlanConfirmation(command)
      } : {})
    }
  );

  if (dispatch.toolResult) {
    // Emit the terminal event before completing the tool call so the
    // renderer always sees the outcome, even if the assistant agent's
    // continuation interferes with the dispatch.
    emitTaskControlEventForTool(
      window,
      dispatch.taskStatus,
      toolIdentity,
      sideEffectState,
      approvalContext
    );
    completeComputerUseToolCall(toolIdentity, dispatch.toolResult);
    return;
  }

  emitTaskControlEventForTool(
    window,
    dispatch.taskStatus,
    toolIdentity,
    sideEffectState,
    approvalContext
  );
}

function requireComputerUseApproval({
  actionApproved,
  chromeSubmitApproved,
  chromeWorkflowApproved,
  command,
  finderPlanApproved,
  gate,
  mode,
  planId,
  route,
  toolIdentity,
  reason,
  approvedPlanPreview,
  approvedChromeSubmitBinding,
  approvedChromeWorkflowPreview
}: {
  actionApproved: boolean;
  chromeSubmitApproved: boolean;
  chromeWorkflowApproved: boolean;
  command: string;
  finderPlanApproved: boolean;
  gate: ComputerUseApprovalGate;
  mode: ManualMode;
  planId: string;
  route: ComputerUseCommandRoute;
  toolIdentity: AssistantComputerUseToolIdentity;
  reason: string;
  approvedPlanPreview?: import("./orchestrator/finder-task.js").FinderPlanPreview;
  approvedChromeSubmitBinding?: import("./orchestrator/chrome-task.js").ChromeSubmitConfirmationBinding;
  approvedChromeWorkflowPreview?: import("./orchestrator/chrome-task.js").ChromeWorkflowPlanPreview;
}): PendingApproval {
  const taskControl = readTaskControlForTool(toolIdentity);
  if (taskControl.phase === "terminal" || taskControl.plan.risk.level === "blocked") {
    throw new Error("A terminal or blocked Computer Use plan cannot request approval.");
  }
  if (gate === "action-plan") {
    if (!taskControl.plan.approvalRequired || planId !== taskControl.plan.planId) {
      throw new Error("Computer Use action approval is not bound to the active plan.");
    }
  } else if (gate === "finder-plan") {
    if (
      route.kind !== "finder"
      || !approvedPlanPreview
      || planId !== createDerivedComputerUsePlanId(
        taskControl.plan.planId,
        approvedPlanPreview
      )
    ) {
      throw new Error("Finder approval is not bound to the active Finder plan preview.");
    }
  } else if (gate === "chrome-workflow") {
    if (
      route.kind !== "chrome"
      || !approvedChromeWorkflowPreview
      || planId !== createDerivedComputerUsePlanId(
        taskControl.plan.planId,
        approvedChromeWorkflowPreview
      )
    ) {
      throw new Error("Chrome workflow approval is not bound to the active workflow plan preview.");
    }
  } else if (
    route.kind !== "chrome"
    || !approvedChromeSubmitBinding
    || planId !== createDerivedComputerUsePlanId(
      taskControl.plan.planId,
      approvedChromeSubmitBinding
    )
  ) {
    throw new Error("Chrome submit approval is not bound to the active form submission.");
  }

  assistantComputerUseExecutor.requireApproval({
    ...toolIdentity,
    reason
  });
  pendingApproval = createPendingApproval({
    command,
    mode,
    identity: toolIdentity,
    route,
    gate,
    planId,
    actionApproved,
    chromeSubmitApproved,
    chromeWorkflowApproved,
    finderPlanApproved,
    ...(approvedPlanPreview ? { approvedPlanPreview } : {}),
    ...(approvedChromeSubmitBinding ? { approvedChromeSubmitBinding } : {}),
    ...(approvedChromeWorkflowPreview ? { approvedChromeWorkflowPreview } : {})
  });
  activeComputerUseToolIdentity = toolIdentity;
  activeComputerUseRoute = route;
  return pendingApproval;
}

function completeComputerUseToolCall(
  identity: AssistantComputerUseToolIdentity,
  result: AssistantComputerUseToolResult
): void {
  chromeTurnHostGrantStore.clear(identity);
  assistantComputerUseExecutor.completeToolCall({
    ...identity,
    result
  });
  const state = { pendingApproval, activeToolIdentity: activeComputerUseToolIdentity };
  const nextState = completeComputerUseToolCallState(state, identity);
  pendingApproval = nextState.pendingApproval;
  activeComputerUseToolIdentity = nextState.activeToolIdentity;
  activeComputerUseRoute = readComputerUseRouteForToolCallState({
    pendingApproval,
    activeToolIdentity: activeComputerUseToolIdentity,
    activeRoute: activeComputerUseRoute
  });
}

function cancelActiveComputerUseToolCall(reason: string): void {
  const state = { pendingApproval, activeToolIdentity: activeComputerUseToolIdentity };
  const identity = readComputerUseToolCallIdentityToCancel(state);
  if (!identity) {
    return;
  }

  chromeTurnHostGrantStore.clear(identity);
  assistantComputerUseExecutor.cancelToolCall({
    turnId: identity.turnId,
    toolCallId: identity.toolCallId,
    reason
  });
  const nextState = cancelComputerUseToolCallState(state, identity);
  pendingApproval = nextState.pendingApproval;
  activeComputerUseToolIdentity = nextState.activeToolIdentity;
  activeComputerUseRoute = readComputerUseRouteForToolCallState({
    pendingApproval,
    activeToolIdentity: activeComputerUseToolIdentity,
    activeRoute: activeComputerUseRoute
  });
}

async function resumePendingApprovalTask(
  window: BrowserWindow | null,
  approval: PendingApproval
): Promise<void> {
  const taskControl = readTaskControlForTool(approval);
  const approvalMatchesPlan = approval.gate === "action-plan"
    ? approval.planId === taskControl.plan.planId
    : approval.gate === "finder-plan"
      ? approval.route.kind === "finder"
        && Boolean(approval.approvedPlanPreview)
        && approval.planId === createDerivedComputerUsePlanId(
          taskControl.plan.planId,
          approval.approvedPlanPreview
        )
      : approval.gate === "chrome-workflow"
        ? approval.route.kind === "chrome"
          && Boolean(approval.approvedChromeWorkflowPreview)
          && approval.planId === createDerivedComputerUsePlanId(
            taskControl.plan.planId,
            approval.approvedChromeWorkflowPreview
          )
        : approval.route.kind === "chrome"
          && Boolean(approval.approvedChromeSubmitBinding)
          && approval.planId === createDerivedComputerUsePlanId(
            taskControl.plan.planId,
            approval.approvedChromeSubmitBinding
          );
  if (!approvalMatchesPlan || taskControl.phase !== "approval") {
    throw new Error("Pending Computer Use approval no longer matches the active plan.");
  }
  const continuation = readApprovedPendingApprovalContinuation(approval);
  pendingApproval = null;
  assistantComputerUseExecutor.resumeApproval({
    turnId: approval.turnId,
    toolCallId: approval.toolCallId,
    decision: "approved",
    reason: "User approved this Computer Use turn."
  });
  if (conversationSessionStore && activeConversationTurn?.turnId === approval.turnId) {
    conversationSessionStore.recordApproval({
      ...activeConversationTurn,
      toolCallId: approval.toolCallId,
      decision: "approved",
      text: "Computer Use approved.",
      reason: "User approved this Computer Use turn."
    });
    emitConversationHistoryChanged(window);
  }

  await continueComputerUseTask({
    window,
    command: approval.command,
    mode: approval.mode,
    actionApproved: continuation.actionApproved,
    chromeSubmitApproved: continuation.chromeSubmitApproved,
    chromeWorkflowApproved: continuation.chromeWorkflowApproved,
    finderPlanApproved: continuation.finderPlanApproved,
    approvedPlanPreview: approval.approvedPlanPreview,
    route: approval.route,
    toolIdentity: {
      turnId: approval.turnId,
      toolCallId: approval.toolCallId
    }
  });
}

async function continueComputerUseTask({
  window,
  command,
  mode,
  actionApproved,
  chromeSubmitApproved,
  chromeWorkflowApproved,
  finderPlanApproved,
  approvedPlanPreview,
  approvalReason,
  route,
  toolIdentity
}: {
  window: BrowserWindow | null;
  command: string;
  mode: ManualMode;
  actionApproved: boolean;
  chromeSubmitApproved: boolean;
  chromeWorkflowApproved: boolean;
  finderPlanApproved: boolean;
  approvedPlanPreview?: import("./orchestrator/finder-task.js").FinderPlanPreview;
  approvalReason?: string;
  route: ComputerUseCommandRoute;
  toolIdentity: AssistantComputerUseToolIdentity;
}): Promise<void> {
  activeComputerUseToolIdentity = toolIdentity;
  activeComputerUseRoute = route;
  let taskControl = readTaskControlForTool(toolIdentity);
  taskRecoveryRegistry.bindExecutionContext({
    executionId: taskControl.executionId,
    command,
    mode,
    route
  });
  const conversationStore = conversationSessionStore;
  const markConversationDispatching = () => {
    if (conversationStore && activeConversationTurn?.turnId === toolIdentity.turnId) {
      conversationStore.markComputerUseDispatching(activeConversationTurn);
      emitConversationHistoryChanged(window);
    }
  };

  const appPolicyPreflight = route.kind === "tmux_supervision" || route.kind === "tmux_recovery"
    ? { kind: "continue" as const }
    : createAppPolicyPreflightDecision({
      appPolicy: decideAppPolicy(appPolicySettingsStore.get(), route.bundleId),
      approved: actionApproved,
      command,
      mode,
      route
    });

  if (appPolicyPreflight.kind === "blocked") {
    clearPendingComputerUseTask();
    completeComputerUseToolCall(toolIdentity, appPolicyPreflight.toolResult);
    emitTaskControlEventForTool(window, appPolicyPreflight.taskEvent, toolIdentity);
    return;
  }

  if (taskControl.plan.risk.level === "blocked") {
    clearPendingComputerUseTask();
    const event = createAppPolicyBlockedTaskEvent({
      command,
      reason: taskControl.plan.risk.reason,
      route
    });
    completeComputerUseToolCall(toolIdentity, createToolResult("blocked", taskControl.plan.risk.reason));
    emitTaskControlEventForTool(window, event, toolIdentity);
    return;
  }

  if (
    !actionApproved
    && appPolicyPreflight.kind === "approval_required"
    && !taskControl.plan.approvalRequired
  ) {
    const reboundPlan = createAppPolicyBoundComputerUsePlanPreview({
      appPolicy: "ask",
      command,
      route
    });
    taskControl = taskControlStore.bindPlan({
      executionId: taskControl.executionId,
      message: `Updated ${reboundPlan.appName} plan for the latest app policy.`,
      plan: reboundPlan
    });
  }

  if (
    !actionApproved
    && (
      taskControl.plan.approvalRequired
      || appPolicyPreflight.kind === "approval_required"
    )
  ) {
    const event = appPolicyPreflight.kind === "approval_required"
      ? appPolicyPreflight.taskEvent
      : createAppPolicyApprovalRequiredTaskEvent({
        command,
        reason: approvalReason ?? taskControl.plan.risk.reason,
        route
      });
    const reason = appPolicyPreflight.kind === "approval_required"
      ? appPolicyPreflight.approvalRequest.reason
      : approvalReason ?? taskControl.plan.risk.reason;
    clearPendingComputerUseTask();
    const approval = requireComputerUseApproval({
      actionApproved,
      chromeSubmitApproved,
      chromeWorkflowApproved,
      command,
      finderPlanApproved,
      gate: "action-plan",
      mode,
      planId: taskControl.plan.planId,
      route,
      toolIdentity,
      reason
    });
    emitTaskControlEventForTool(
      window,
      event,
      toolIdentity,
      undefined,
      createTaskControlApproval(approval)
    );
    return;
  }

  emitTaskControlEventForTool(window, withRouteTaskEventMetadata({
    status: "executing",
    message: `Executing ${taskControl.plan.appName} plan for ${taskControl.plan.target}.`,
    command
  }, route), toolIdentity, taskControl.sideEffectState);

  if (route.kind === "tmux_supervision" || route.kind === "tmux_recovery") {
    markConversationDispatching();
    await runTmuxSupervisionCommandTask(window, {
      command,
      mode,
      actionApproved,
      route,
      toolIdentity
    });
    return;
  }

  if (actionApproved && route.kind === "chrome") {
    const { controller: hostPolicyController, taskId: hostPolicyTaskId } = startComputerUseTaskEpoch();
    const hostPolicyApproval = await applyApprovedChromeTaskHostPolicy({
      command,
      route,
      homeDir: os.homedir(),
      toolIdentity,
      turnGrantStore: chromeTurnHostGrantStore
    });
    if (activeTaskController === hostPolicyController) {
      activeTaskController = null;
    }
    if (hostPolicyController.signal.aborted || hostPolicyTaskId !== currentTaskId) {
      chromeTurnHostGrantStore.clear(toolIdentity);
      return;
    }
    const chromeHostPolicyPreflight = createChromeHostPolicyPreflightDecision({
      command,
      result: hostPolicyApproval,
      route
    });

    if (chromeHostPolicyPreflight.kind === "blocked" || chromeHostPolicyPreflight.kind === "failed") {
      clearPendingComputerUseTask();
      completeComputerUseToolCall(toolIdentity, chromeHostPolicyPreflight.toolResult);
      emitTaskControlEventForTool(window, chromeHostPolicyPreflight.taskEvent, toolIdentity);
      return;
    }

    if (chromeHostPolicyPreflight.kind === "allowed_current_turn") {
      emitTaskControlEventForTool(window, chromeHostPolicyPreflight.taskEvent, toolIdentity);
    }
  }

  markConversationDispatching();
  const { controller, taskId } = startComputerUseTaskEpoch();

  try {
    if (route.kind === "desktop") {
      const agentSettings = assistantAgentSettingsStore.get();
      const planner = await createCodexComputerUsePlanner({
        codexBinary: agentSettings.codexBinary,
        timeoutMs: Math.min(agentSettings.timeoutMs, 45_000)
      });
      const result = await runComputerUseAgentLoop({
        goal: command,
        route,
        client: createDesktopHelper(),
        planner,
        createScreenshotPath: (step) => createScreenshotPath(`desktop-agent-${step}`),
        removeScreenshot: (screenshotPath) => fs.promises.rm(screenshotPath, { force: true }),
        signal: controller.signal,
        onProgress: (progress) => {
          if (controller.signal.aborted || taskId !== currentTaskId) {
            return;
          }
          emitTaskControlEventForTool(window, withRouteTaskEventMetadata({
            status: progress.status,
            message: progress.message,
            command
          }, route), toolIdentity, progress.sideEffectState);
        }
      }).finally(() => planner.dispose().catch(() => undefined));
      if (controller.signal.aborted || taskId !== currentTaskId) {
        return;
      }
      const summary = result.status === "completed"
        ? `${result.summary} Verified with ${result.observationCount} fresh observations and ${result.actionCount} actions.`
        : result.summary;
      completeComputerUseToolCall(toolIdentity, createToolResult(result.status, summary));
      emitTaskControlEventForTool(window, withRouteTaskEventMetadata({
        status: result.status,
        message: summary,
        command
      }, route), toolIdentity, result.sideEffectState);
      return;
    }

    if (route.kind === "finder") {
      const helper = createDesktopHelper();
      const desktopClient = createFinderDesktopClient(helper);
      const fileClient = createFinderFileClient(helper);

      for await (const taskEvent of runFinderOrganizationTask(command, {
        approved: actionApproved,
        planApproved: finderPlanApproved,
        approvedPlanPreview,
        desktopClient,
        fileClient,
        createScreenshotPath: () => createScreenshotPath("finder-before")
      })) {
        if (controller.signal.aborted || taskId !== currentTaskId) {
          return;
        }

        turnReplayStore.recordComputerUseEvent(taskEvent);
        dispatchComputerUseTaskEvent({
          actionApproved,
          command,
          finderPlanApproved,
          mode,
          route,
          taskEvent,
          toolIdentity,
          window
        });
      }
      return;
    }

    if (route.kind === "chrome") {
      const chromeClient = chromeCdpEndpoint
        ? createChromeCdpClient({ endpoint: chromeCdpEndpoint })
        : undefined;
      const helper = createDesktopHelper();
      const desktopClient = createChromeDesktopClient(helper);
      const workflowCommand = parseChromeWorkflowCommand(command);

      if (workflowCommand.ok) {
        for await (const taskEvent of runChromeWorkflowTask({
          plan: workflowCommand.plan,
          approved: actionApproved,
          workflowApproved: chromeWorkflowApproved,
          desktopClient,
          cdpClient: chromeClient
        })) {
          if (controller.signal.aborted || taskId !== currentTaskId) {
            return;
          }

          turnReplayStore.recordComputerUseEvent(taskEvent);
          try {
            dispatchComputerUseTaskEvent({
              actionApproved,
              chromeWorkflowApproved,
              command,
              finderPlanApproved,
              mode,
              route,
              taskEvent,
              toolIdentity,
              window
            });
          } catch (error) {
            // The task-control phase machine can reject late events (e.g. a
            // second approval gate after side effects began). Fall back to a
            // plain task event so the renderer still sees the outcome.
            emitTaskEvent(window, withRouteTaskEventMetadata(
              createTaskEvent(taskEvent, mode),
              route
            ));
          }
        }
        return;
      }

      for await (const taskEvent of runChromePageTask(command, chromeClient, {
        approved: actionApproved,
        submitApproved: chromeSubmitApproved,
        desktopClient,
        createScreenshotPath: () => createScreenshotPath("chrome-fallback")
      })) {
        if (controller.signal.aborted || taskId !== currentTaskId) {
          return;
        }

        turnReplayStore.recordComputerUseEvent(taskEvent);
        try {
          dispatchComputerUseTaskEvent({
            actionApproved,
            chromeSubmitApproved,
            chromeWorkflowApproved,
            command,
            finderPlanApproved,
            mode,
            route,
            taskEvent,
            toolIdentity,
            window
          });
        } catch (error) {
          // The task-control phase machine can reject late events (e.g. a
          // second approval gate after side effects began). Fall back to a
          // plain task event so the renderer still sees the outcome.
          emitTaskEvent(window, withRouteTaskEventMetadata(
            createTaskEvent(taskEvent, mode),
            route
          ));
        }
      }
      return;
    }

    const helper = createDesktopHelper();
    const desktopClient = createGhosttyDesktopClient(helper);

    for await (const taskEvent of runGhosttyCommandTask(desktopClient, command, {
      approved: actionApproved,
      createScreenshotPath: (stage) => createScreenshotPath(`ghostty-${stage}`),
      signal: controller.signal
    })) {
      if (controller.signal.aborted || taskId !== currentTaskId) {
        return;
      }

      turnReplayStore.recordComputerUseEvent(taskEvent);
      dispatchComputerUseTaskEvent({
        actionApproved,
        command,
        finderPlanApproved,
        mode,
        route,
        taskEvent,
        toolIdentity,
        window
      });
    }
  } catch (error) {
    if (controller.signal.aborted || taskId !== currentTaskId) {
      return;
    }

    const message = error instanceof Error ? error.message : "Task failed.";
    completeComputerUseToolCall(toolIdentity, createToolResult("failed", message));
    emitTaskControlEventForTool(window, createComputerUseFailureTaskEvent({
      command,
      message,
      route
    }), toolIdentity);
  } finally {
    if (activeTaskController === controller) {
      activeTaskController = null;
    }
  }
}

async function runTmuxSupervisionCommandTask(
  window: BrowserWindow | null,
  {
    command,
    mode,
    actionApproved,
    route,
    toolIdentity
  }: {
    command: string;
    mode: ManualMode;
    actionApproved: boolean;
    route: Extract<ComputerUseCommandRoute, { kind: "tmux_supervision" | "tmux_recovery" }>;
    toolIdentity: AssistantComputerUseToolIdentity;
  }
): Promise<void> {
  const { controller, taskId } = startComputerUseTaskEpoch();

  try {
    for await (const taskEvent of runTmuxSupervisionTask(
      route.sessionName,
      createTmuxSupervisionClient(),
      { approved: actionApproved }
    )) {
      if (controller.signal.aborted || taskId !== currentTaskId) {
        return;
      }

      dispatchComputerUseTaskEvent({
        actionApproved,
        command,
        finderPlanApproved: false,
        mode,
        route,
        taskEvent,
        toolIdentity,
        window
      });
    }
  } catch (error) {
    if (controller.signal.aborted || taskId !== currentTaskId) {
      return;
    }

    const message = error instanceof Error ? error.message : "tmux supervision failed.";
    completeComputerUseToolCall(toolIdentity, createToolResult("failed", message));
    emitTaskControlEventForTool(window, createComputerUseFailureTaskEvent({
      command,
      message,
      route
    }), toolIdentity);
  } finally {
    if (activeTaskController === controller) {
      activeTaskController = null;
    }
  }
}

async function runCommandTask(
  window: BrowserWindow | null,
  command: string,
  mode: ManualMode,
  actionApproved: boolean
) {
  if (activeConversationTurn || conversationRetryInProgress) {
    emitTaskEvent(window, createRejectedRunCommandTaskEvent(
      "Finish or stop the current conversation turn before starting another."
    ));
    return;
  }

  if (taskControlStore.read()?.phase === "terminal") {
    taskControlStore.clear();
  }

  const conversationStore = requireConversationSessionStore();
  const conversationProvider = readSelectedConversationProvider();
  const conversationTurn = conversationStore.beginTurn({
    userInput: command,
    provider: conversationProvider
  });
  activeConversationTurn = {
    sessionId: conversationTurn.sessionId,
    turnId: conversationTurn.turnId
  };
  emitConversationHistoryChanged(window, conversationTurn.snapshot);

  turnReplayStore.startTurn();

  const providerController = new AbortController();
  activeAssistantTurnController = providerController;
  let assistantTurn: AssistantAgentTurnResult;
  try {
    assistantTurn = await createAssistantAgentTaskTurn(command, {
      createTurnId: () => conversationTurn.turnId,
      provider: conversationProvider,
      signal: providerController.signal,
      sessionId: conversationTurn.sessionId
    });
  } catch {
    const message = `${conversationProvider.label} failed to complete this reply. Check Background Agent readiness and retry.`;
    conversationStore.failProviderTurn({
      ...conversationTurn,
      text: message
    });
    activeConversationTurn = null;
    emitConversationHistoryChanged(window);
    emitTaskEvent(window, createRejectedRunCommandTaskEvent(message));
    return;
  } finally {
    if (activeAssistantTurnController === providerController) {
      activeAssistantTurnController = null;
    }
  }

  if (
    providerController.signal.aborted
    || activeConversationTurn?.turnId !== conversationTurn.turnId
  ) {
    return;
  }

  if (assistantTurn.status === "completed") {
    conversationStore.recordProviderSuccess({
      ...conversationTurn,
      text: assistantTurn.message,
      provider: {
        id: conversationProvider.id,
        label: assistantTurn.providerLabel
      }
    });
  } else if (assistantTurn.status === "cancelled") {
    conversationStore.stopTurn({
      ...conversationTurn,
      reason: `${assistantTurn.providerLabel} turn stopped.`
    });
    activeConversationTurn = null;
    emitConversationHistoryChanged(window);
    return;
  } else {
    conversationStore.failProviderTurn({
      ...conversationTurn,
      text: createAssistantAgentTaskMessage(assistantTurn)
    });
  }
  emitConversationHistoryChanged(window);

  const route = assistantTurn.route;
  const routeDecision = createRunCommandRouteDecision({
    approved: actionApproved,
    assistantTurnStatus: assistantTurn.status,
    route
  });

  if (routeDecision.kind === "chat") {
    clearPendingComputerUseTask();
    emitTurnReplayTaskEvent(window, createAssistantChatRouteTaskEvent({
      status: assistantTurn.status,
      message: createAssistantAgentTaskMessage(assistantTurn)
    }));
    activeConversationTurn = null;
    return;
  }

  if (routeDecision.kind === "assistant_failed") {
    clearPendingComputerUseTask();
    emitTurnReplayTaskEvent(window, createAssistantTurnFailedRouteTaskEvent({
      command,
      message: createAssistantAgentTaskMessage(assistantTurn),
      route: routeDecision.route
    }));
    activeConversationTurn = null;
    return;
  }

  if (routeDecision.kind === "needs_clarification") {
    clearPendingComputerUseTask();
    emitTurnReplayTaskEvent(window, createNeedsClarificationRouteTaskEvent(routeDecision.route));
    activeConversationTurn = null;
    return;
  }

  if (routeDecision.kind === "terminal_route_state") {
    clearPendingComputerUseTask();
    emitTurnReplayTaskEvent(window, createTerminalRouteTaskEvent({
      command,
      route: routeDecision.route
    }));
    activeConversationTurn = null;
    return;
  }

  const computerUsePlan = createAssistantComputerUseToolPlan(assistantTurn);
  const plannedCommand = computerUsePlan.planInput.command;
  const toolIdentity = computerUsePlan.identity;
  conversationStore.recordComputerUseRequest({
    ...conversationTurn,
    toolCallId: toolIdentity.toolCallId,
    command: plannedCommand,
    route: computerUsePlan.planInput.route.kind,
    text: assistantTurn.message
  });
  activeConversationTurn = {
    ...conversationTurn,
    toolCallId: toolIdentity.toolCallId
  };
  emitConversationHistoryChanged(window);
  activeComputerUseToolIdentity = toolIdentity;
  activeComputerUseRoute = routeDecision.executionRoute;
  assistantComputerUseExecutor.planToolCall(computerUsePlan.planInput);
  const executionRoute = routeDecision.executionRoute;
  const appPolicyRequiresApproval = executionRoute.kind !== "tmux_supervision"
    && executionRoute.kind !== "tmux_recovery"
    && decideAppPolicy(appPolicySettingsStore.get(), executionRoute.bundleId).decision === "ask";
  const forceApproval = !actionApproved && (
    routeDecision.kind === "needs_confirmation" || appPolicyRequiresApproval
  );
  startTaskControlForComputerUse({
    command: plannedCommand,
    forceApproval,
    route: executionRoute,
    toolIdentity
  });

  emitAssistantToolPlanTaskEvent(window, assistantTurn, plannedCommand, route);

  const boundCommand = executionRoute.kind === "ghostty"
    ? await bindGhosttyPlannerCommand({
      command: plannedCommand,
      forceApproval,
      route: executionRoute,
      toolIdentity,
      window
    })
    : plannedCommand;
  if (!boundCommand) {
    return;
  }

  if (actionApproved) {
    assistantComputerUseExecutor.bypassApproval({
      ...toolIdentity,
      reason: "Explicit approval bypass enabled for this Computer Use turn."
    });
    conversationStore.recordApproval({
      ...conversationTurn,
      toolCallId: toolIdentity.toolCallId,
      decision: "bypassed",
      text: "Computer Use approval bypassed by explicit local configuration.",
      reason: "Explicit local approval bypass."
    });
    emitConversationHistoryChanged(window);
  }

  await continueComputerUseTask({
    window,
    command: boundCommand,
    mode,
    actionApproved,
    chromeSubmitApproved: false,
    chromeWorkflowApproved: false,
    finderPlanApproved: false,
    ...(routeDecision.kind === "needs_confirmation"
      ? { approvalReason: routeDecision.route.reason }
      : {}),
    route: executionRoute,
    toolIdentity
  });
}

async function createWindow() {
  const initialBounds = calculatePetWindowBounds({
    cursorPoint: screen.getCursorScreenPoint(),
    displays: screen.getAllDisplays(),
    windowSize: COMPACT_WINDOW_SIZE,
    margin: 28,
    positionOverride: readWindowPositionOverride(process.env)
  });

  mainWindow = new BrowserWindow({
    width: COMPACT_WINDOW_SIZE.width,
    height: COMPACT_WINDOW_SIZE.height,
    x: initialBounds.x,
    y: initialBounds.y,
    minWidth: COMPACT_WINDOW_SIZE.width,
    minHeight: COMPACT_WINDOW_SIZE.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: !smokeWindowHidden,
    focusable: !smokeWindowHidden,
    paintWhenInitiallyHidden: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: "skfiy",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

ipcMain.on("skfiy:move-window-by", (event, deltaX: unknown, deltaY: unknown, visibleRectValue: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const nextAnchorState = applyPetWindowDragMove({
    currentPetAnchor,
    currentPetSize,
    deltaX,
    deltaY,
    displays: screen.getAllDisplays(),
    visibleRectValue,
    window
  });
  currentPetAnchor = nextAnchorState.currentPetAnchor;
  currentPetSize = nextAnchorState.currentPetSize;
});

ipcMain.on("skfiy:set-window-mode", (event, mode: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  applyPetWindowMode({
    currentPetAnchor,
    currentPetSize,
    displays: screen.getAllDisplays(),
    mode,
    window
  });
});

ipcMain.handle("skfiy:get-window-bounds", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);

  if (!window || window.isDestroyed()) {
    return null;
  }

  return window.getBounds();
});

ipcMain.handle(
  "skfiy:run-command",
  async (event, command: unknown, options: unknown = {}) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const request = readRunCommandRequest(command, options);

    if (!request.ok) {
      emitTaskEvent(window, createRejectedRunCommandTaskEvent(request.message));
      return;
    }

    await runCommandTask(window, request.command, request.mode, readDefaultApprovalBypass(process.env));
  }
);

ipcMain.handle("skfiy:approve-task", async (event, value: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const request = readTaskApprovalDecisionRequest(value);
  const approval = pendingApproval;
  const taskControl = taskControlStore.read();
  if (
    !request
    || !approval
    || !taskControl
    || taskControl.phase !== "approval"
    || taskControl.executionId !== request.executionId
    || approval.planId !== request.planId
    || taskControl.approval?.planId !== request.planId
    || taskControl.approval.gate !== approval.gate
  ) {
    throw new Error("Task approval no longer matches the displayed Task Control plan.");
  }

  await resumePendingApprovalTask(window, approval);
});

ipcMain.handle("skfiy:deny-task", async (event, value: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const request = readTaskApprovalDecisionRequest(value);
  const approval = pendingApproval;
  const taskControl = taskControlStore.read();

  if (
    !request
    || !approval
    || !taskControl
    || taskControl.phase !== "approval"
    || taskControl.executionId !== request.executionId
    || approval.planId !== request.planId
    || taskControl.approval?.planId !== request.planId
    || taskControl.approval.gate !== approval.gate
  ) {
    throw new Error("Task denial no longer matches the displayed Task Control plan.");
  }

  assistantComputerUseExecutor.resumeApproval({
    turnId: approval.turnId,
    toolCallId: approval.toolCallId,
    decision: "denied",
    reason: USER_DENIED_COMPUTER_USE_REASON
  });
  if (conversationSessionStore && activeConversationTurn?.turnId === approval.turnId) {
    conversationSessionStore.recordApproval({
      ...activeConversationTurn,
      toolCallId: approval.toolCallId,
      decision: "denied",
      text: "Computer Use denied.",
      reason: USER_DENIED_COMPUTER_USE_REASON
    });
    emitConversationHistoryChanged(window);
  }

  clearActiveComputerUseTask();

  const denialEvent = createPendingApprovalDeniedTaskEvent(approval);
  emitTaskControlTurnReplayTaskEvent(window, denialEvent, {
    executionId: taskControl.executionId
  });
});

ipcMain.handle("skfiy:take-screenshot", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const helper = createDesktopHelper();

  emitTaskEvent(window, createManualScreenshotStartedTaskEvent());

  try {
    const screenshot = await helper.screenshot(createScreenshotPath("manual"));
    emitTaskEvent(window, createManualScreenshotCompletedTaskEvent(screenshot.outputPath));
  } catch (error) {
    emitTaskEvent(window, createManualScreenshotFailedTaskEvent(error));
  }
});

ipcMain.handle("skfiy:stop-task", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const taskControl = taskControlStore.read();
  const hasLiveProviderTurn = activeAssistantTurnController !== null
    || conversationRetryInProgress
    || activeConversationTurn !== null;
  if (taskControl?.phase === "terminal" && !hasLiveProviderTurn) {
    return taskControl;
  }
  const activeTaskControl = taskControl?.phase === "terminal" ? null : taskControl;
  const hadActiveConversationTurn = hasLiveProviderTurn;
  const stopTask = createStopTaskEventDecision({
    activeRoute: activeComputerUseRoute,
    pendingApproval,
    ...(activeTaskControl ? { message: createTaskControlStopMessage(activeTaskControl) } : {})
  });
  activeAssistantTurnController?.abort(new Error(stopTask.cancellationReason));
  activeAssistantTurnController = null;
  stopActiveConversationTurn(window, stopTask.cancellationReason);
  cancelActiveComputerUseToolCall(stopTask.cancellationReason);
  clearActiveComputerUseTask();

  if (activeTaskControl) {
    emitTaskControlTurnReplayTaskEvent(window, stopTask.event, {
      executionId: activeTaskControl.executionId
    });
    return;
  }

  if (stopTask.delivery === "turn-replay" || hadActiveConversationTurn) {
    emitTurnReplayTaskEvent(window, stopTask.event);
    return;
  }

  emitTaskEvent(window, stopTask.event);
});

ipcMain.handle("skfiy:get-permissions", async (event) => {
  return readPermissionsForRenderer({ helper: createDesktopHelper() });
});

ipcMain.handle("skfiy:get-permission-diagnostics", async () => {
  const helper = createDesktopHelper();
  const active = await readPermissionsForRenderer({ helper });

  return createMainPermissionDiagnosticsResponse({
    active,
    appProcess: {
      screenRecording: systemPreferences.getMediaAccessStatus("screen"),
      accessibilityTrusted: systemPreferences.isTrustedAccessibilityClient(false)
    },
    identity: {
      appPath: app.getAppPath(),
      executablePath: process.execPath,
      helperPath: resolveHelperPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged
    }
  });
});

ipcMain.handle("skfiy:get-desktop-session-diagnostics", async () => {
  return readDesktopSessionDiagnosticsForRenderer({ helper: createDesktopHelper() });
});

ipcMain.handle("skfiy:get-diagnostic-report", async () => {
  const settings = assistantAgentSettingsStore.get();
  const providerStates = await readAssistantAgentProviderStates(settings);
  const helper = createDesktopHelper();
  const activePermissions = await readPermissionsForRenderer({ helper });

  return readDiagnosticReportForRenderer({
    sources: {
      readPermissions: () => createMainPermissionDiagnosticsResponse({
        active: activePermissions,
        appProcess: {
          screenRecording: systemPreferences.getMediaAccessStatus("screen"),
          accessibilityTrusted: systemPreferences.isTrustedAccessibilityClient(false)
        },
        identity: {
          appPath: app.getAppPath(),
          executablePath: process.execPath,
          helperPath: resolveHelperPath(),
          resourcesPath: process.resourcesPath,
          isPackaged: app.isPackaged
        }
      }),
      readDesktopSession: () => readDesktopSessionDiagnosticsForRenderer({ helper: createDesktopHelper() }),
      readBrowserReadiness: () => readBrowserReadinessEvidence({
        homeDir: os.homedir(),
        cliShimPath: resolveCliShimPath()
      }),
      readChromeHostPolicy: () => readChromeHostPolicyState({ homeDir: os.homedir() }),
      readFinderAutomation: () => testFinderAutomationReadiness({
        getFinderSelection: () => createDesktopHelper().getFinderSelection()
      }),
      readProviderStates: async () => providerStates,
      readStartupWarnings: async () => readStartupWarnings({
        appPath: app.getAppPath(),
        devServerUrl,
        env: process.env,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath
      }),
      readComponentVersions: () => readComponentVersions({
        appVersion: app.getVersion(),
        cliShimPath: resolveCliShimPath(),
        helperInfoPlistPath: resolveHelperInfoPlistPath({
          appPath: app.getAppPath(),
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath
        }),
        extensionManifestPath: path.join(app.getAppPath(), "chrome-extension", "manifest.json"),
        nativeHostManifestPath: path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "Google",
          "Chrome",
          "NativeMessagingHosts",
          `${CHROME_NATIVE_HOST_NAME}.json`
        ),
        providerStates
      })
    }
  });
});

ipcMain.handle("skfiy:open-permission-settings", async (event, permission: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const target = readPermissionSettingsTarget(permission);

  if (!target) {
    emitTaskEvent(window, createUnknownPermissionSettingsTargetTaskEvent());
    return;
  }

  try {
    const result = await createDesktopHelper().openPermissionSettings(target);
    assertDesktopActionResult(result, "open permission settings");
  } catch (error) {
    emitTaskEvent(window, createPermissionSettingsFailedTaskEvent(error));
  }
});

ipcMain.handle("skfiy:get-startup-warnings", () => {
  return readStartupWarnings({
    appPath: app.getAppPath(),
    devServerUrl,
    env: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  });
});

ipcMain.handle("skfiy:get-app-policy-settings", () => {
  return appPolicySettingsStore.get();
});

ipcMain.handle("skfiy:set-app-policy", (_event, update: unknown) => {
  const settings = appPolicySettingsStore.set(readAppPolicySettingsUpdate(update));
  profileRuntime.captureActiveProfile();
  return settings;
});

ipcMain.handle("skfiy:get-planner-provider-settings", () => {
  return plannerProviderSettingsStore.get();
});

ipcMain.handle("skfiy:set-planner-provider-settings", (_event, update: unknown) => {
  const settings = plannerProviderSettingsStore.set(readPlannerProviderSettingsUpdate(update));
  profileRuntime.captureActiveProfile();
  return settings;
});

ipcMain.handle("skfiy:get-assistant-agent-settings", async () => {
  return readAssistantAgentSettingsResponse({
    store: assistantAgentSettingsStore
  });
});

ipcMain.handle("skfiy:set-assistant-agent-settings", async (_event, update: unknown) => {
  firstRunReadinessController.resetBackgroundAgentTest();
  const response = await updateAssistantAgentSettingsResponse({
    store: assistantAgentSettingsStore,
    update
  });
  profileRuntime.captureActiveProfile();
  return response;
});

ipcMain.handle("skfiy:get-personal-memory", () => {
  return readPersonalMemoryDashboardSnapshot({ baseDir: memoryStores.baseDir });
});

ipcMain.handle("skfiy:set-personal-memory-settings", (_event, update: unknown) => {
  const settings = memoryStores.personalMemorySettings.update(readPersonalMemorySettingsUpdate(update));
  profileRuntime.captureActiveProfile();
  emitPersonalMemoryChanged();
  return settings;
});

ipcMain.handle("skfiy:forget-personal-memory", (_event, input: unknown) => {
  const request = readPersonalMemoryForgetRequest(input);
  if (!request) {
    throw new Error("Personal memory forget requires target user or agent and exact content.");
  }

  const result = forgetPersonalMemoryEntry({ baseDir: memoryStores.baseDir, ...request });
  emitPersonalMemoryChanged();
  return result;
});

ipcMain.handle("skfiy:approve-pending-memory", (_event, input: unknown) => {
  const request = readPendingMemoryActionRequest(input);
  if (!request) {
    throw new Error("Personal memory pending action requires a pendingId.");
  }

  const result = approvePendingPersonalMemoryWrite({
    baseDir: memoryStores.baseDir,
    pendingId: request.pendingId
  });
  emitPersonalMemoryChanged();
  return result;
});

ipcMain.handle("skfiy:reject-pending-memory", (_event, input: unknown) => {
  const request = readPendingMemoryActionRequest(input);
  if (!request) {
    throw new Error("Personal memory pending action requires a pendingId.");
  }

  const result = rejectPendingPersonalMemoryWrite({
    baseDir: memoryStores.baseDir,
    pendingId: request.pendingId
  });
  emitPersonalMemoryChanged();
  return result;
});

ipcMain.handle("skfiy:test-assistant-agent-provider", async (_event, input: unknown) => {
  const mode = input && typeof input === "object" && "mode" in input
    ? (input as { mode?: unknown }).mode
    : undefined;
  if (!isAssistantAgentMode(mode)) {
    throw new Error("Assistant agent provider test requires a valid mode.");
  }
  const result = await testAssistantAgentProvider({
    settings: assistantAgentSettingsStore.get(),
    mode
  });
  return result.state;
});

ipcMain.handle("skfiy:get-first-run-readiness", () => {
  return firstRunReadinessController.read();
});

ipcMain.handle("skfiy:test-background-agent", () => {
  return firstRunReadinessController.testBackgroundAgent();
});

ipcMain.handle("skfiy:test-finder-automation", () => {
  return firstRunReadinessController.testFinderAutomation();
});

ipcMain.handle("skfiy:get-conversation-history", () => {
  return requireConversationSessionStore().read();
});

ipcMain.handle("skfiy:start-conversation-session", (event) => {
  const snapshot = requireConversationSessionStore().startSession();
  emitConversationHistoryChanged(BrowserWindow.fromWebContents(event.sender), snapshot);
  return snapshot;
});

ipcMain.handle("skfiy:switch-conversation-session", (event, value: unknown) => {
  const sessionId = readConversationSessionId(value);
  if (!sessionId) throw new Error("Conversation session id must be bounded text.");
  const snapshot = requireConversationSessionStore().switchSession(sessionId);
  emitConversationHistoryChanged(BrowserWindow.fromWebContents(event.sender), snapshot);
  return snapshot;
});

ipcMain.handle("skfiy:rename-conversation-session", (event, value: unknown) => {
  const request = readConversationRenameRequest(value);
  if (!request) throw new Error("Conversation rename request is invalid.");
  const snapshot = requireConversationSessionStore().renameSession(request.sessionId, request.title);
  emitConversationHistoryChanged(BrowserWindow.fromWebContents(event.sender), snapshot);
  return snapshot;
});

ipcMain.handle("skfiy:archive-conversation-session", (event, value: unknown) => {
  const sessionId = readConversationSessionId(value);
  if (!sessionId) throw new Error("Conversation session id must be bounded text.");
  const snapshot = requireConversationSessionStore().archiveSession(sessionId);
  emitConversationHistoryChanged(BrowserWindow.fromWebContents(event.sender), snapshot);
  return snapshot;
});

ipcMain.handle("skfiy:delete-conversation-session", (event, value: unknown) => {
  const sessionId = readConversationSessionId(value);
  if (!sessionId) throw new Error("Conversation session id must be bounded text.");
  const snapshot = requireConversationSessionStore().deleteSession(sessionId);
  emitConversationHistoryChanged(BrowserWindow.fromWebContents(event.sender), snapshot);
  return snapshot;
});

ipcMain.handle("skfiy:restore-conversation-session", (event, value: unknown) => {
  const sessionId = readConversationSessionId(value);
  if (!sessionId) throw new Error("Conversation session id must be bounded text.");
  const snapshot = requireConversationSessionStore().restoreSession(sessionId);
  emitConversationHistoryChanged(BrowserWindow.fromWebContents(event.sender), snapshot);
  return snapshot;
});

ipcMain.handle("skfiy:retry-conversation-turn", async (event, value: unknown) => {
  const request = readConversationRetryRequest(value);
  const window = BrowserWindow.fromWebContents(event.sender);
  const snapshot = conversationSessionStore?.read() ?? createUnavailableConversationHistorySnapshot();
  if (!request) {
    return {
      status: "unsafe-retry-blocked" as const,
      message: "Conversation retry request is invalid.",
      snapshot
    };
  }
  if (!conversationSessionStore) {
    return {
      status: "storage-error" as const,
      message: "Conversation history storage is unavailable.",
      snapshot
    };
  }
  if (activeConversationTurn || conversationRetryInProgress) {
    return {
      status: "retry-in-progress" as const,
      message: "Another conversation turn is already active.",
      snapshot
    };
  }

  conversationRetryInProgress = true;
  if (taskControlStore.read()?.phase === "terminal") {
    taskControlStore.clear();
  }
  turnReplayStore.startTurn();
  const retryStartedEvent = createConversationRetryStartedTaskEvent();
  turnReplayStore.recordTaskEvent(readTurnReplayTaskEvent(retryStartedEvent));
  persistRuntimeSnapshot(turnReplayStore.getReplay(), retryStartedEvent);
  const controller = new AbortController();
  activeAssistantTurnController = controller;
  try {
    const result = await retryConversationProviderTurn({
      ...request,
      store: conversationSessionStore,
      signal: controller.signal,
      runProvider: (input, context) => createAssistantAgentTaskTurn(input, {
        createTurnId: () => context.turnId,
        provider: context.provider,
        isRetry: true,
        sessionId: request.sessionId,
        signal: controller.signal
      })
    });
    recordConversationRetryTerminalTaskEvent(
      createConversationRetryResultTaskEvent(result)
    );
    emitConversationHistoryChanged(window, result.snapshot);
    return result;
  } catch (error) {
    recordConversationRetryTerminalTaskEvent(
      createConversationRetryUnexpectedFailureTaskEvent()
    );
    throw error;
  } finally {
    conversationRetryInProgress = false;
    if (activeAssistantTurnController === controller) {
      activeAssistantTurnController = null;
    }
  }
});

ipcMain.handle("skfiy:get-turn-replay", () => {
  return turnReplayStore.getReplay();
});

ipcMain.handle("skfiy:get-task-control", () => {
  return taskControlStore.read();
});

ipcMain.handle("skfiy:prepare-task-recovery", (_event, value: unknown) => {
  return taskRecoveryRegistry.prepare(value, taskControlStore.read());
});

ipcMain.handle("skfiy:dispatch-task-recovery", (event, value: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const helper = createDesktopHelper();
  let recoveryController: AbortController | null = null;
  let recoveryTaskId: number | null = null;
  const dispatch = startTaskRecoveryDispatch({
    registry: taskRecoveryRegistry,
    request: value,
    store: taskControlStore,
    runStage: (input) => {
      const epoch = startComputerUseTaskEpoch();
      recoveryController = epoch.controller;
      recoveryTaskId = epoch.taskId;
      return runTaskRecoveryStage(input, {
        readPathStatus: (candidatePath) => readTaskRecoveryPathStatus(candidatePath),
        listRunningAppBundleIds: async () => (await helper.listApps())
          .map((candidate) => candidate.bundleId),
        ...(chromeCdpEndpoint ? {
          observeChromePage: async () => {
            const result = await createChromeCdpClient({ endpoint: chromeCdpEndpoint })
              .sendCdpCommand(buildCdpCommand({ type: "extract_page_snapshot" }));
            return readTaskRecoveryChromePageSnapshot(result);
          }
        } : {})
      });
    },
    isCurrent: () => Boolean(
      recoveryController
      && !recoveryController.signal.aborted
      && recoveryTaskId === currentTaskId
    ),
    onLifecycle: ({ status, message, snapshot }) => {
      emitTurnReplayTaskEvent(window, decorateTaskEventWithTaskControl(
        { status, message, route: snapshot.plan.route },
        snapshot
      ));
    }
  });

  if (dispatch.completion) {
    void dispatch.completion.catch(() => undefined).finally(() => {
      if (activeTaskController === recoveryController) {
        activeTaskController = null;
      }
    });
  }
  return dispatch.result;
});

ipcMain.handle("skfiy:get-automation-monitors", () => {
  return automationMonitorManager.readSnapshot();
});

ipcMain.handle("skfiy:upsert-tmux-monitor", async (_event, input: unknown) => {
  const definition = automationMonitorManager.upsertTmuxSessionMonitor(readTmuxMonitorInput(input));
  await automationMonitorManager.runMonitorNow(definition.id);
  return automationMonitorManager.readSnapshot();
});

ipcMain.handle("skfiy:run-automation-monitor-now", async (_event, id: unknown) => {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Automation monitor id must be text.");
  }

  await automationMonitorManager.runMonitorNow(id.trim());
  return automationMonitorManager.readSnapshot();
});

ipcMain.handle("skfiy:duplicate-automation-monitor", (_event, id: unknown) => {
  const monitorId = readAutomationMonitorId(id);
  if (!monitorId) {
    throw new Error("Automation monitor id is invalid.");
  }

  automationMonitorManager.duplicateMonitor(monitorId);
  return automationMonitorManager.readSnapshot();
});

ipcMain.handle(
  "skfiy:set-automation-monitor-enabled",
  (_event, id: unknown, enabled: unknown) => {
    const monitorId = readAutomationMonitorId(id);
    if (!monitorId || typeof enabled !== "boolean") {
      throw new Error("Automation monitor lifecycle request is invalid.");
    }

    automationMonitorManager.setMonitorEnabled(monitorId, enabled);
    return automationMonitorManager.readSnapshot();
  }
);

ipcMain.handle("skfiy:delete-automation-monitor", (_event, id: unknown) => {
  const monitorId = readAutomationMonitorId(id);
  if (!monitorId) {
    throw new Error("Automation monitor id is invalid.");
  }
  if (!automationMonitorManager.deleteMonitor(monitorId)) {
    throw new Error(`Unknown automation monitor: ${monitorId}`);
  }

  return automationMonitorManager.readSnapshot();
});

ipcMain.handle("skfiy:preview-tmux-automation", (_event, input: unknown) => {
  const request = readTmuxAutomationPreviewInput(input);
  const sessionName = request.sessionName.trim();
  if (!/^[A-Za-z0-9_.:-]+$/u.test(sessionName)) {
    throw new Error("Automation monitor tmux session name is invalid.");
  }

  const timeoutMs = normalizeMonitorTimeoutMs(request.timeoutMs);
  return createTmuxAutomationMonitorPreview(sessionName, timeoutMs);
});

ipcMain.handle("skfiy:get-automation-runs", () => {
  return automationRunSupervisor.readSnapshot();
});

ipcMain.handle("skfiy:stop-automation-run", async (_event, runId: unknown) => {
  const normalizedRunId = readAutomationRunId(runId);
  if (!normalizedRunId) {
    throw new Error("Automation run id is invalid.");
  }

  const run = await automationRunSupervisor.stopRun(normalizedRunId, "dashboard");
  if (!run) {
    throw new Error(`Unknown automation run: ${normalizedRunId}`);
  }

  return automationRunSupervisor.readSnapshot();
});

ipcMain.handle("skfiy:approve-tmux-recovery", async (_event, input: unknown) => {
  const request = readTmuxRecoveryApprovalRequest(input);
  const budget = readTmuxRecoveryBudget(request.sessionName);
  const events: unknown[] = [];
  let terminalBudget = budget;

  for await (const event of runTmuxRecoveryTask(request.action, createTmuxRecoveryClient(), {
    approved: true,
    budget,
    sessionName: request.sessionName
  })) {
    events.push(event);
    if ("budget" in event) {
      terminalBudget = event.budget;
    }
  }

  persistTmuxRecoveryBudget(request.sessionName, terminalBudget);
  return {
    sessionName: request.sessionName,
    proposalId: request.proposalId,
    events
  };
});

function readTmuxRecoveryApprovalRequest(input: unknown): {
  sessionName: string;
  proposalId: string;
  action: TmuxRecoveryAction;
} {
  if (!input || typeof input !== "object") {
    throw new Error("tmux recovery approval request must be an object.");
  }
  const record = input as Record<string, unknown>;
  const sessionName = typeof record.sessionName === "string"
    ? record.sessionName.trim()
    : "";
  if (!/^[A-Za-z0-9_.:-]+$/u.test(sessionName)) {
    throw new Error("tmux recovery session name is invalid.");
  }
  const proposalId = typeof record.proposalId === "string" && record.proposalId.trim().length > 0
    ? record.proposalId
    : "";
  if (!proposalId) {
    throw new Error("tmux recovery proposal id is invalid.");
  }
  const action = parseTmuxRecoveryAction(record.action);
  if (!action) {
    throw new Error("tmux recovery action is invalid.");
  }
  return { sessionName, proposalId, action };
}

ipcMain.handle("skfiy:get-runtime-status", () => {
  return createRuntimeStatusResponse(stopTurnHotkeyRegistered);
});

ipcMain.handle("skfiy:get-pet-skin", async () => {
  return readDefaultLocalOriginPetSkin({ homeDir: os.homedir() });
});

registerBrowserContextSourceIpc({
  ipcMain,
  actions: browserContextSourceActions
});

registerProfileIpc({
  ipcMain,
  runtime: profileRuntime
});

registerDataAdminIpc({
  ipcMain,
  runtime: dataAdminRuntime
});

app.whenReady().then(async () => {
  automationRunSupervisor.start();
  automationMonitorManager.start();
  try {
    runStorageMigrations({ baseDir: skfiyAppSupportDir });
  } catch (error) {
    console.error("Storage migrations failed:", error);
  }
  void dataAdminRuntime.applyRetention();
  setInterval(() => {
    void dataAdminRuntime.applyRetention();
  }, 24 * 60 * 60 * 1_000).unref();
  await createWindow();
  if (!stopTurnHotkeyRegistered) {
    stopTurnHotkeyRegistered = registerStopTurnHotkey({
      registry: globalShortcut,
      getWindow: () => mainWindow
    });
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("before-quit", () => {
  automationMonitorManager.stop();
  automationRunSupervisor.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  if (stopTurnHotkeyRegistered) {
    globalShortcut.unregister(STOP_TURN_ACCELERATOR);
    stopTurnHotkeyRegistered = false;
  }
});
