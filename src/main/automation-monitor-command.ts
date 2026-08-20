import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import {
  createAutomationMonitorManager,
  createAutomationMonitorStatePath,
  createAutomationMonitorStore,
  type AutomationMonitorRuntime,
  type AutomationMonitorSnapshot,
  type AutomationMonitorStoreIo,
  type AutomationMonitorTriggerMode
} from "./automation-monitor.js";
import {
  createTmuxSupervisionClient,
  type TmuxSupervisionClient
} from "./tmux-supervision-client.js";

export type AutomationMonitorCommandSource = "cli" | "mcp";
export type AutomationMonitorCommandRequest =
  | { action: "list" }
  | {
      action: "upsert-tmux";
      monitorId?: string;
      sessionName: string;
      label?: string;
      intervalMs: number;
      timeoutMs?: number;
      triggerMode?: AutomationMonitorTriggerMode;
      enabled?: boolean;
    }
  | { action: "duplicate"; monitorId: string }
  | { action: "run-now"; monitorId: string }
  | { action: "set-enabled"; monitorId: string; enabled: boolean }
  | { action: "delete"; monitorId: string };

export type AutomationMonitorCommandResultKind =
  | "listed"
  | "configured"
  | "duplicated"
  | "checked"
  | "paused"
  | "resumed"
  | "deleted";

export interface AutomationMonitorCommandResult {
  schemaVersion: 1;
  command: "automation monitor";
  generatedAt: string;
  source: AutomationMonitorCommandSource;
  action: AutomationMonitorCommandRequest["action"];
  result: AutomationMonitorCommandResultKind;
  plannedMutation: boolean;
  executesSystemMutation: false;
  mutatesSession: false;
  monitorId?: string;
  monitor?: AutomationMonitorRuntime;
  automation: AutomationMonitorSnapshot;
}

export interface AutomationMonitorCommandService {
  execute: (
    request: AutomationMonitorCommandRequest,
    source: AutomationMonitorCommandSource
  ) => Promise<AutomationMonitorCommandResult>;
}

export function createAutomationMonitorCommandService({
  filePath,
  generatedAt = () => new Date().toISOString(),
  homeDir,
  io = createDefaultAutomationMonitorCommandIo(),
  tmuxClient = createTmuxSupervisionClient()
}: {
  filePath?: string;
  generatedAt?: () => string;
  homeDir?: string;
  io?: AutomationMonitorStoreIo;
  tmuxClient?: TmuxSupervisionClient;
}): AutomationMonitorCommandService {
  const statePath = filePath ?? createAutomationMonitorStatePath(homeDir ?? "");
  const manager = createAutomationMonitorManager({
    now: generatedAt,
    store: createAutomationMonitorStore({ filePath: statePath, io }),
    tmuxClient
  });

  return {
    async execute(request, source) {
      if (request.action === "list") {
        return createAutomationMonitorCommandResult({
          action: request.action,
          automation: manager.readSnapshot(),
          generatedAt: generatedAt(),
          result: "listed",
          source
        });
      }

      if (request.action === "upsert-tmux") {
        const definition = manager.upsertTmuxSessionMonitor({
          monitorId: request.monitorId,
          sessionName: request.sessionName,
          label: request.label,
          intervalMs: request.intervalMs,
          timeoutMs: request.timeoutMs,
          triggerMode: request.triggerMode,
          enabled: request.enabled
        });
        const automation = manager.readSnapshot();
        return createAutomationMonitorCommandResult({
          action: request.action,
          automation,
          generatedAt: generatedAt(),
          monitorId: definition.id,
          monitor: readMonitor(automation, definition.id),
          result: "configured",
          source
        });
      }

      if (request.action === "duplicate") {
        const definition = manager.duplicateMonitor(request.monitorId);
        const automation = manager.readSnapshot();
        return createAutomationMonitorCommandResult({
          action: request.action,
          automation,
          generatedAt: generatedAt(),
          monitorId: definition.id,
          monitor: readMonitor(automation, definition.id),
          result: "duplicated",
          source
        });
      }

      if (request.action === "run-now") {
        const monitor = await manager.runMonitorNow(request.monitorId);
        return createAutomationMonitorCommandResult({
          action: request.action,
          automation: manager.readSnapshot(),
          generatedAt: generatedAt(),
          monitorId: request.monitorId,
          monitor,
          result: "checked",
          source
        });
      }

      if (request.action === "set-enabled") {
        const monitor = manager.setMonitorEnabled(request.monitorId, request.enabled);
        return createAutomationMonitorCommandResult({
          action: request.action,
          automation: manager.readSnapshot(),
          generatedAt: generatedAt(),
          monitorId: request.monitorId,
          monitor,
          result: request.enabled ? "resumed" : "paused",
          source
        });
      }

      if (!manager.deleteMonitor(request.monitorId)) {
        throw new Error(`Unknown automation monitor: ${request.monitorId}`);
      }
      return createAutomationMonitorCommandResult({
        action: request.action,
        automation: manager.readSnapshot(),
        generatedAt: generatedAt(),
        monitorId: request.monitorId,
        result: "deleted",
        source
      });
    }
  };
}

function createAutomationMonitorCommandResult({
  action,
  automation,
  generatedAt,
  monitor,
  monitorId,
  result,
  source
}: {
  action: AutomationMonitorCommandRequest["action"];
  automation: AutomationMonitorSnapshot;
  generatedAt: string;
  monitor?: AutomationMonitorRuntime;
  monitorId?: string;
  result: AutomationMonitorCommandResultKind;
  source: AutomationMonitorCommandSource;
}): AutomationMonitorCommandResult {
  return {
    schemaVersion: 1,
    command: "automation monitor",
    generatedAt,
    source,
    action,
    result,
    plannedMutation: action !== "list",
    executesSystemMutation: false,
    mutatesSession: false,
    automation,
    ...(monitorId ? { monitorId } : {}),
    ...(monitor ? { monitor } : {})
  };
}

function readMonitor(snapshot: AutomationMonitorSnapshot, id: string): AutomationMonitorRuntime {
  const monitor = snapshot.monitors.find((candidate) => candidate.id === id);
  if (!monitor) {
    throw new Error(`Unknown automation monitor: ${id}`);
  }
  return monitor;
}

function createDefaultAutomationMonitorCommandIo(): AutomationMonitorStoreIo {
  return {
    exists: existsSync,
    mkdir: (dirPath) => mkdirSync(dirPath, { recursive: true }),
    readFile: (targetPath) => readFileSync(targetPath, "utf8"),
    rename: renameSync,
    writeFile: (targetPath, content) => writeFileSync(targetPath, content, "utf8")
  };
}
