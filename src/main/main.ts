import { app, BrowserWindow, globalShortcut, ipcMain, screen, systemPreferences } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopHelperClient } from "./computer-use/desktop-helper.js";
import {
  createTurnReplayStore,
  type TurnReplay
} from "./computer-use/turn-replay-store.js";
import {
  createAppPolicySettingsStore,
  decideAppPolicy,
  readInitialAppPolicySettings
} from "./app-policy-settings.js";
import {
  AssistantAgentTurnRuntimeError,
  runAssistantAgentTurn,
  type AssistantAgentTurnResult
} from "./assistant-agent.js";
import {
  createAssistantAgentSettingsStore,
  readInitialAssistantAgentSettingsFromConfig
} from "./assistant-agent-settings.js";
import {
  createPersonalMemoryStore,
  createSkfiyApplicationSupportPath
} from "./personal-memory.js";
import { createPersonalSkillSettingsStore } from "./personal-skills.js";
import {
  createSessionMemoryStore,
  searchSessionMemory
} from "./session-memory.js";
import type { BrowserPageContext } from "./browser-page-context.js";
import { readLatestBrowserPageContext } from "./main-browser-context-reader.js";
import {
  createAssistantComputerUseExecutor,
  type AssistantComputerUseToolIdentity,
  type AssistantComputerUseToolResult
} from "./assistant-computer-use-executor.js";
import { applyApprovedChromeTaskHostPolicy } from "./chrome-approval-policy.js";
import { createChromeCdpClient } from "./chrome-cdp-client.js";
import { readChromeCdpEndpoint } from "./chrome-cdp-settings.js";
import { readChromeExtensionConnectionStatus } from "./chrome-native-host.js";
import { createTmuxSupervisionClient } from "./tmux-supervision-client.js";
import {
  createPlannerProviderSettingsStore,
  readInitialPlannerProviderSettings
} from "./planner-provider-settings.js";
import { decidePlannerProviderRuntime } from "./planner-provider-runtime.js";
import { resolvePlannerCommand } from "./planner-command.js";
import { createExternalCuaTerminalPlannerFromEnv } from "./external-cua-planner.js";
import { readDesktopSessionDiagnosticsForRenderer } from "./desktop-session-diagnostics.js";
import { resolveHelperPath as resolveDesktopHelperPath } from "./helper-path.js";
import { runChromePageTask } from "./orchestrator/chrome-task.js";
import { runFinderOrganizationTask } from "./orchestrator/finder-task.js";
import { runGhosttyCommandTask } from "./orchestrator/ghostty-task.js";
import {
  assertDesktopActionResult,
  createChromeDesktopClient,
  createFinderDesktopClient,
  createGhosttyDesktopClient
} from "./main-desktop-clients.js";
import { runTmuxSupervisionTask } from "./orchestrator/tmux-supervision-task.js";
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
  type AutomationMonitorStoreIo
} from "./automation-monitor.js";
import {
  isEnabledEnvFlag,
  readPermissionSettingsTarget,
  readRunCommandRequest,
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
  readComputerUseRouteForToolCallState,
  readComputerUseToolCallIdentityToCancel,
  USER_DENIED_COMPUTER_USE_REASON,
  type ComputerUseCommandRoute,
  type PendingApproval
} from "./main-pending-approval.js";
import {
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
import { createStopTaskEventDecision } from "./main-stop-task.js";
import { createSmokeAssistantAgentTaskTurn } from "./main-smoke-assistant-turn.js";
import {
  readTurnReplayTaskEvent,
  type ComputerUseTaskEvent,
  type ManualMode,
  type TaskEvent
} from "./task-event-view.js";

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
const personalMemoryStore = createPersonalMemoryStore({
  baseDir: skfiyAppSupportDir
});
const personalSkillSettingsStore = createPersonalSkillSettingsStore({
  baseDir: skfiyAppSupportDir
});
const sessionMemoryStore = createSessionMemoryStore({
  baseDir: skfiyAppSupportDir
});
const turnReplayStore = createTurnReplayStore({
  onReplayChanged: (replay) => {
    persistRuntimeSnapshot(replay);
  }
});
const automationMonitorManager = createAutomationMonitorManager({
  store: createAutomationMonitorStore({
    filePath: createAutomationMonitorStatePath(os.homedir()),
    io: createNodeAutomationMonitorStoreIo()
  }),
  tmuxClient: createTmuxSupervisionClient()
});
const assistantComputerUseExecutor = createAssistantComputerUseExecutor({
  replayStore: turnReplayStore
});
let mainWindow: BrowserWindow | null = null;
let currentPetAnchor: Point | null = null;
let currentPetSize: Size | null = null;
let currentTaskId = 0;
const createScreenshotPath = createScreenshotPathFactory({
  readTempDir: () => os.tmpdir()
});
let activeTaskController: AbortController | null = null;
let activeComputerUseToolIdentity: AssistantComputerUseToolIdentity | null = null;
let activeComputerUseRoute: ComputerUseCommandRoute | null = null;
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

function emitTurnReplayTaskEvent(window: BrowserWindow | null, event: TaskEvent): void {
  turnReplayStore.recordTaskEvent(readTurnReplayTaskEvent(event));
  emitTaskEvent(window, event);
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

async function createAssistantAgentTaskTurn(input: string): Promise<AssistantAgentTurnResult> {
  const smokeTurn = createSmokeAssistantAgentTaskTurn(input);
  if (smokeTurn) {
    return smokeTurn;
  }

  const browserPageContext = await readLatestBrowserPageContext({
    homeDir: os.homedir(),
    readConnectionStatus: readChromeExtensionConnectionStatus
  });
  const personalMemory = personalMemoryStore.read();
  const personalSkillSettings = personalSkillSettingsStore.read();
  const recalledSessions = searchSessionMemory(sessionMemoryStore.readAll(), input, 3);

  try {
    const turn = await runAssistantAgentTurn(input, {
      settings: assistantAgentSettingsStore.get(),
      browserPageContext,
      personalMemory,
      personalSkillSettings,
      recalledSessions
    });
    return turn;
  } catch (error) {
    if (error instanceof AssistantAgentTurnRuntimeError) {
      return error.turn;
    }

    throw error;
  }
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

function dispatchComputerUseTaskEvent({
  approved,
  command,
  mode,
  planApproved,
  route,
  taskEvent,
  toolIdentity,
  window
}: {
  approved: boolean;
  command: string;
  mode: ManualMode;
  planApproved: boolean;
  route: ComputerUseCommandRoute;
  taskEvent: ComputerUseTaskEvent;
  toolIdentity: AssistantComputerUseToolIdentity;
  window: BrowserWindow | null;
}): void {
  const dispatch = createComputerUseTaskEventDispatch({
    approved,
    command,
    event: taskEvent,
    mode,
    planApproved,
    route
  });

  if (dispatch.approvalRequest) {
    requireComputerUseApproval({
      command: dispatch.approvalRequest.command,
      mode,
      route,
      toolIdentity,
      reason: dispatch.approvalRequest.reason,
      planApproved: dispatch.approvalRequest.planApproved,
      approvedPlanPreview: dispatch.approvalRequest.approvedPlanPreview
    });
  }

  if (dispatch.toolResult) {
    completeComputerUseToolCall(toolIdentity, dispatch.toolResult);
    emitTurnReplayTaskEvent(window, dispatch.taskStatus);
    return;
  }

  emitTurnReplayTaskEvent(window, dispatch.taskStatus);
}

function requireComputerUseApproval({
  command,
  mode,
  route,
  toolIdentity,
  reason,
  planApproved = false,
  approvedPlanPreview
}: {
  command: string;
  mode: ManualMode;
  route: ComputerUseCommandRoute;
  toolIdentity: AssistantComputerUseToolIdentity;
  reason: string;
  planApproved?: boolean;
  approvedPlanPreview?: import("./orchestrator/finder-task.js").FinderPlanPreview;
}): void {
  assistantComputerUseExecutor.requireApproval({
    ...toolIdentity,
    reason
  });
  pendingApproval = createPendingApproval(
    command,
    mode,
    toolIdentity,
    route,
    planApproved,
    approvedPlanPreview
  );
  activeComputerUseToolIdentity = toolIdentity;
  activeComputerUseRoute = route;
}

function completeComputerUseToolCall(
  identity: AssistantComputerUseToolIdentity,
  result: AssistantComputerUseToolResult
): void {
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
  pendingApproval = null;
  assistantComputerUseExecutor.resumeApproval({
    turnId: approval.turnId,
    toolCallId: approval.toolCallId,
    decision: "approved",
    reason: "User approved this Computer Use turn."
  });

  await continueComputerUseTask({
    window,
    command: approval.command,
    mode: approval.mode,
    approved: true,
    planApproved: approval.planApproved === true,
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
  approved,
  planApproved,
  approvedPlanPreview,
  route,
  toolIdentity
}: {
  window: BrowserWindow | null;
  command: string;
  mode: ManualMode;
  approved: boolean;
  planApproved: boolean;
  approvedPlanPreview?: import("./orchestrator/finder-task.js").FinderPlanPreview;
  route: ComputerUseCommandRoute;
  toolIdentity: AssistantComputerUseToolIdentity;
}): Promise<void> {
  activeComputerUseToolIdentity = toolIdentity;
  activeComputerUseRoute = route;

  if (route.kind === "tmux_supervision") {
    await runTmuxSupervisionCommandTask(window, {
      command,
      mode,
      approved,
      route,
      toolIdentity
    });
    return;
  }

  const appPolicyPreflight = createAppPolicyPreflightDecision({
    appPolicy: decideAppPolicy(appPolicySettingsStore.get(), route.bundleId),
    approved,
    command,
    mode,
    route
  });

  if (appPolicyPreflight.kind === "blocked") {
    clearPendingComputerUseTask();
    completeComputerUseToolCall(toolIdentity, appPolicyPreflight.toolResult);
    emitTurnReplayTaskEvent(window, appPolicyPreflight.taskEvent);
    return;
  }

  if (appPolicyPreflight.kind === "approval_required") {
    clearPendingComputerUseTask();
    requireComputerUseApproval({
      ...appPolicyPreflight.approvalRequest,
      toolIdentity
    });
    emitTurnReplayTaskEvent(window, appPolicyPreflight.taskEvent);
    return;
  }

  if (approved && route.kind === "chrome") {
    const hostPolicyApproval = await applyApprovedChromeTaskHostPolicy({
      command,
      route,
      homeDir: os.homedir()
    });
    const chromeHostPolicyPreflight = createChromeHostPolicyPreflightDecision({
      command,
      result: hostPolicyApproval,
      route
    });

    if (chromeHostPolicyPreflight.kind === "blocked" || chromeHostPolicyPreflight.kind === "failed") {
      clearPendingComputerUseTask();
      completeComputerUseToolCall(toolIdentity, chromeHostPolicyPreflight.toolResult);
      emitTurnReplayTaskEvent(window, chromeHostPolicyPreflight.taskEvent);
      return;
    }

    if (chromeHostPolicyPreflight.kind === "allowed_current_turn") {
      emitTurnReplayTaskEvent(window, chromeHostPolicyPreflight.taskEvent);
    }
  }

  const { controller, taskId } = startComputerUseTaskEpoch();

  try {
    if (route.kind === "finder") {
      const helper = createDesktopHelper();
      const desktopClient = createFinderDesktopClient(helper);

      for await (const taskEvent of runFinderOrganizationTask(command, {
        approved,
        planApproved,
        approvedPlanPreview,
        desktopClient,
        createScreenshotPath: () => createScreenshotPath("finder-before")
      })) {
        if (controller.signal.aborted || taskId !== currentTaskId) {
          return;
        }

        turnReplayStore.recordComputerUseEvent(taskEvent);
        dispatchComputerUseTaskEvent({
          approved,
          command,
          mode,
          planApproved,
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

      for await (const taskEvent of runChromePageTask(command, chromeClient, {
        approved,
        desktopClient,
        createScreenshotPath: () => createScreenshotPath("chrome-fallback")
      })) {
        if (controller.signal.aborted || taskId !== currentTaskId) {
          return;
        }

        turnReplayStore.recordComputerUseEvent(taskEvent);
        dispatchComputerUseTaskEvent({
          approved,
          command,
          mode,
          planApproved,
          route,
          taskEvent,
          toolIdentity,
          window
        });
      }
      return;
    }

    const plannerRuntime = decidePlannerProviderRuntime(plannerProviderSettingsStore.get());

    if (plannerRuntime.decision === "unavailable") {
      clearPendingComputerUseTask();
      completeComputerUseToolCall(toolIdentity, createToolResult("failed", plannerRuntime.message));
      emitTurnReplayTaskEvent(window, createPlannerUnavailableTaskEvent({
        command,
        message: plannerRuntime.message,
        route,
        status: plannerRuntime.status
      }));
      return;
    }

    const plannedCommand = await resolvePlannerCommand({
      input: command,
      runtime: plannerRuntime,
      signal: controller.signal,
      createExternalPlanner: () => createExternalCuaTerminalPlannerFromEnv(process.env)
    });

    if (plannedCommand.providerLabel) {
      turnReplayStore.recordComputerUseEvent({
        type: "planner_resolved",
        providerLabel: plannedCommand.providerLabel,
        input: command,
        command: plannedCommand.command,
        rationale: plannedCommand.rationale
      });
      emitTurnReplayTaskEvent(window, createPlannerResolvedTaskEvent({
        command,
        plannedCommand,
        providerLabel: plannedCommand.providerLabel,
        route
      }));
    }

    const helper = createDesktopHelper();
    const desktopClient = createGhosttyDesktopClient(helper);

    for await (const taskEvent of runGhosttyCommandTask(desktopClient, plannedCommand.command, {
      approved,
      createScreenshotPath: (stage) => createScreenshotPath(`ghostty-${stage}`),
      signal: controller.signal
    })) {
      if (controller.signal.aborted || taskId !== currentTaskId) {
        return;
      }

      turnReplayStore.recordComputerUseEvent(taskEvent);
      dispatchComputerUseTaskEvent({
        approved,
        command,
        mode,
        planApproved,
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
    emitTurnReplayTaskEvent(window, createComputerUseFailureTaskEvent({
      command,
      message,
      route
    }));
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
    approved,
    route,
    toolIdentity
  }: {
    command: string;
    mode: ManualMode;
    approved: boolean;
    route: Extract<ComputerUseCommandRoute, { kind: "tmux_supervision" }>;
    toolIdentity: AssistantComputerUseToolIdentity;
  }
): Promise<void> {
  const { controller, taskId } = startComputerUseTaskEpoch();

  try {
    for await (const taskEvent of runTmuxSupervisionTask(
      route.sessionName,
      createTmuxSupervisionClient(),
      { approved }
    )) {
      if (controller.signal.aborted || taskId !== currentTaskId) {
        return;
      }

      dispatchComputerUseTaskEvent({
        approved,
        command,
        mode,
        planApproved: false,
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
    emitTurnReplayTaskEvent(window, createComputerUseFailureTaskEvent({
      command,
      message,
      route
    }));
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
  approved: boolean,
  planApproved = false
) {
  if (!approved) {
    turnReplayStore.startTurn();
  }

  const assistantTurn = await createAssistantAgentTaskTurn(command);
  const route = assistantTurn.route;
  const routeDecision = createRunCommandRouteDecision({
    approved,
    assistantTurnStatus: assistantTurn.status,
    route
  });

  if (routeDecision.kind === "chat") {
    clearPendingComputerUseTask();
    emitTurnReplayTaskEvent(window, createAssistantChatRouteTaskEvent({
      status: assistantTurn.status,
      message: createAssistantAgentTaskMessage(assistantTurn)
    }));
    return;
  }

  if (routeDecision.kind === "assistant_failed") {
    clearPendingComputerUseTask();
    emitTurnReplayTaskEvent(window, createAssistantTurnFailedRouteTaskEvent({
      command,
      message: createAssistantAgentTaskMessage(assistantTurn),
      route: routeDecision.route
    }));
    return;
  }

  if (routeDecision.kind === "needs_clarification") {
    clearPendingComputerUseTask();
    emitTurnReplayTaskEvent(window, createNeedsClarificationRouteTaskEvent(routeDecision.route));
    return;
  }

  if (routeDecision.kind === "terminal_route_state") {
    clearPendingComputerUseTask();
    emitTurnReplayTaskEvent(window, createTerminalRouteTaskEvent({
      command,
      route: routeDecision.route
    }));
    return;
  }

  const computerUsePlan = createAssistantComputerUseToolPlan(assistantTurn);
  const toolIdentity = computerUsePlan.identity;
  activeComputerUseToolIdentity = toolIdentity;
  assistantComputerUseExecutor.planToolCall(computerUsePlan.planInput);

  emitAssistantToolPlanTaskEvent(window, assistantTurn, command, route);

  if (routeDecision.kind === "needs_confirmation") {
    clearPendingComputerUseTask();
    requireComputerUseApproval({
      command,
      mode,
      route: routeDecision.executionRoute,
      toolIdentity,
      reason: routeDecision.route.reason
    });
    emitTurnReplayTaskEvent(window, createNeedsConfirmationRouteTaskEvent({
      command,
      route: routeDecision.route
    }));
    return;
  }

  if (approved) {
    assistantComputerUseExecutor.bypassApproval({
      ...toolIdentity,
      reason: "Default approval bypass enabled for this Computer Use turn."
    });
  }

  await continueComputerUseTask({
    window,
    command,
    mode,
    approved,
    planApproved,
    route: routeDecision.executionRoute,
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

ipcMain.handle("skfiy:approve-task", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const approval = pendingApproval;

  if (!approval) {
    emitTaskEvent(window, createPendingApprovalDeniedTaskEvent(null));
    return;
  }

  await resumePendingApprovalTask(window, approval);
});

ipcMain.handle("skfiy:deny-task", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const approval = pendingApproval;

  if (approval) {
    assistantComputerUseExecutor.resumeApproval({
      turnId: approval.turnId,
      toolCallId: approval.toolCallId,
      decision: "denied",
      reason: USER_DENIED_COMPUTER_USE_REASON
    });
  }

  clearActiveComputerUseTask();

  const denialEvent = createPendingApprovalDeniedTaskEvent(approval);
  if (approval) {
    emitTurnReplayTaskEvent(window, denialEvent);
  } else {
    emitTaskEvent(window, denialEvent);
  }
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
  const stopTask = createStopTaskEventDecision({ activeRoute: activeComputerUseRoute, pendingApproval });
  cancelActiveComputerUseToolCall(stopTask.cancellationReason);
  clearActiveComputerUseTask();

  if (stopTask.delivery === "turn-replay") {
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
  return appPolicySettingsStore.set(readAppPolicySettingsUpdate(update));
});

ipcMain.handle("skfiy:get-planner-provider-settings", () => {
  return plannerProviderSettingsStore.get();
});

ipcMain.handle("skfiy:set-planner-provider-settings", (_event, update: unknown) => {
  return plannerProviderSettingsStore.set(readPlannerProviderSettingsUpdate(update));
});

ipcMain.handle("skfiy:get-assistant-agent-settings", async () => {
  return readAssistantAgentSettingsResponse({
    store: assistantAgentSettingsStore
  });
});

ipcMain.handle("skfiy:set-assistant-agent-settings", async (_event, update: unknown) => {
  return updateAssistantAgentSettingsResponse({
    store: assistantAgentSettingsStore,
    update
  });
});

ipcMain.handle("skfiy:get-turn-replay", () => {
  return turnReplayStore.getReplay();
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

ipcMain.handle("skfiy:get-runtime-status", () => {
  return createRuntimeStatusResponse(stopTurnHotkeyRegistered);
});

ipcMain.handle("skfiy:get-pet-skin", async () => {
  return readDefaultLocalOriginPetSkin({ homeDir: os.homedir() });
});

app.whenReady().then(async () => {
  automationMonitorManager.start();
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
