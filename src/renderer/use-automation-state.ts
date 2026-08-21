import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_AUTOMATION_MONITOR_SNAPSHOT,
  createAutomationFeedback,
  type AutomationFeedback
} from "./app-automation-state";
import { DEFAULT_AUTOMATION_RUN_SNAPSHOT } from "./app-automation-run-state";
import {
  type AutomationDefinitionDraft,
  type AutomationEditorState,
  type AutomationPreviewState
} from "./app-automation-components";
import type {
  AutomationMonitorRuntime,
  AutomationMonitorSnapshot,
  AutomationRunSnapshot,
  DesktopApi
} from "./app-types";

export function useAutomationState(api: DesktopApi) {
  const [automationMonitors, setAutomationMonitors] = useState<AutomationMonitorSnapshot>(
    DEFAULT_AUTOMATION_MONITOR_SNAPSHOT
  );
  const [automationRuns, setAutomationRuns] = useState<AutomationRunSnapshot>(
    DEFAULT_AUTOMATION_RUN_SNAPSHOT
  );
  const [automationFeedback, setAutomationFeedback] =
    useState<AutomationFeedback | null>(null);
  const [automationActionPending, setAutomationActionPending] = useState(false);
  const [automationEditor, setAutomationEditor] = useState<AutomationEditorState | null>(null);
  const [automationPreview, setAutomationPreview] = useState<AutomationPreviewState | null>(
    null
  );

  const applyAutomationSnapshot = useCallback((snapshot: AutomationMonitorSnapshot) => {
    setAutomationMonitors(snapshot);
  }, []);

  const applyAutomationRunSnapshot = useCallback((snapshot: AutomationRunSnapshot) => {
    setAutomationRuns(snapshot);
  }, []);

  const refreshAutomationMonitors = useCallback(async () => {
    try {
      applyAutomationSnapshot(await api.getAutomationMonitors());
      applyAutomationRunSnapshot(await api.getAutomationRuns());
    } catch {
      setAutomationFeedback(createAutomationFeedback("danger", "自动化监控状态不可用。"));
    }
  }, [api, applyAutomationSnapshot, applyAutomationRunSnapshot]);

  useEffect(() => {
    void refreshAutomationMonitors();
  }, [refreshAutomationMonitors]);

  const stopAutomationRun = useCallback(
    async (runId: string) => {
      setAutomationActionPending(true);
      try {
        applyAutomationRunSnapshot(await api.stopAutomationRun(runId));
        setAutomationFeedback(createAutomationFeedback("success", "已停止该运行。"));
      } catch {
        setAutomationFeedback(createAutomationFeedback("danger", "停止运行失败。"));
      } finally {
        setAutomationActionPending(false);
      }
    },
    [api, applyAutomationRunSnapshot]
  );

  const runAutomationMonitorNow = useCallback(
    async (id: string) => {
      setAutomationActionPending(true);
      try {
        applyAutomationSnapshot(await api.runAutomationMonitorNow(id));
        setAutomationFeedback(createAutomationFeedback("success", "已触发一次手动检查。"));
      } catch {
        setAutomationFeedback(createAutomationFeedback("danger", "手动检查失败。"));
      } finally {
        setAutomationActionPending(false);
      }
    },
    [api, applyAutomationSnapshot]
  );

  const toggleAutomationMonitor = useCallback(
    async (id: string, enabled: boolean) => {
      setAutomationActionPending(true);
      try {
        applyAutomationSnapshot(await api.setAutomationMonitorEnabled(id, enabled));
        setAutomationFeedback(createAutomationFeedback(
          "success",
          enabled ? "已恢复该监控。" : "已暂停该监控。"
        ));
      } catch {
        setAutomationFeedback(createAutomationFeedback("danger", "更新监控状态失败。"));
      } finally {
        setAutomationActionPending(false);
      }
    },
    [api, applyAutomationSnapshot]
  );

  const duplicateAutomationMonitor = useCallback(
    async (id: string) => {
      setAutomationActionPending(true);
      try {
        applyAutomationSnapshot(await api.duplicateAutomationMonitor(id));
        setAutomationFeedback(createAutomationFeedback("success", "已复制为停用的新监控。"));
      } catch {
        setAutomationFeedback(createAutomationFeedback("danger", "复制监控失败。"));
      } finally {
        setAutomationActionPending(false);
      }
    },
    [api, applyAutomationSnapshot]
  );

  const deleteAutomationMonitor = useCallback(
    async (id: string) => {
      setAutomationActionPending(true);
      try {
        applyAutomationSnapshot(await api.deleteAutomationMonitor(id));
        setAutomationFeedback(createAutomationFeedback("success", "已删除该监控。"));
      } catch {
        setAutomationFeedback(createAutomationFeedback("danger", "删除监控失败。"));
      } finally {
        setAutomationActionPending(false);
      }
    },
    [api, applyAutomationSnapshot]
  );

  const openAutomationCreator = useCallback(() => {
    setAutomationPreview(null);
    setAutomationEditor({ mode: "create" });
  }, []);

  const openAutomationEditor = useCallback((monitor: AutomationMonitorRuntime) => {
    setAutomationPreview(null);
    setAutomationEditor({ mode: "edit", monitor });
  }, []);

  const closeAutomationEditor = useCallback(() => {
    setAutomationEditor(null);
    setAutomationPreview(null);
  }, []);

  const submitAutomationDefinition = useCallback(
    async (draft: AutomationDefinitionDraft) => {
      setAutomationActionPending(true);
      try {
        const preview = await api.previewTmuxAutomation({
          sessionName: draft.sessionName,
          timeoutMs: draft.timeoutMs,
          triggerMode: draft.triggerMode
        });
        if (preview) {
          setAutomationPreview({ preview, draft });
          setAutomationFeedback(null);
        } else {
          setAutomationFeedback(createAutomationFeedback("danger", "无法生成安全边界预览。"));
        }
      } catch {
        setAutomationFeedback(createAutomationFeedback("danger", "生成安全边界预览失败。"));
      } finally {
        setAutomationActionPending(false);
      }
    },
    [api]
  );

  const confirmAutomationDefinition = useCallback(
    async (enabled: boolean) => {
      const pending = automationPreview;
      if (!pending) {
        return;
      }

      setAutomationActionPending(true);
      try {
        const snapshot = await api.upsertTmuxMonitor({
          ...(pending.draft.monitorId ? { monitorId: pending.draft.monitorId } : {}),
          sessionName: pending.draft.sessionName,
          ...(pending.draft.label ? { label: pending.draft.label } : {}),
          intervalMs: pending.draft.intervalMs,
          timeoutMs: pending.draft.timeoutMs,
          triggerMode: pending.draft.triggerMode,
          enabled
        });
        applyAutomationSnapshot(snapshot);
        setAutomationEditor(null);
        setAutomationPreview(null);
        setAutomationFeedback(createAutomationFeedback(
          "success",
          enabled ? "已保存并启用该监控。" : "已保存该监控（停用）。"
        ));
      } catch {
        setAutomationFeedback(createAutomationFeedback("danger", "保存监控定义失败。"));
      } finally {
        setAutomationActionPending(false);
      }
    },
    [api, applyAutomationSnapshot, automationPreview]
  );

  return {
    automationMonitors,
    automationRuns,
    automationFeedback,
    automationActionPending,
    automationEditor,
    automationPreview,
    refreshAutomationMonitors,
    stopAutomationRun,
    runAutomationMonitorNow,
    toggleAutomationMonitor,
    duplicateAutomationMonitor,
    deleteAutomationMonitor,
    openAutomationCreator,
    openAutomationEditor,
    closeAutomationEditor,
    submitAutomationDefinition,
    confirmAutomationDefinition
  };
}
