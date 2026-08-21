import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT,
  createPersonalMemoryFeedback,
  type PersonalMemoryFeedback
} from "./app-memory-state";
import type { DesktopApi, PersonalMemoryDashboardSnapshot } from "./app-types";

export interface PersonalMemorySettingsUpdate {
  postTurnLearningEnabled?: boolean;
  writeApprovalEnabled?: boolean;
}

export function useMemoryState(api: DesktopApi) {
  const [personalMemory, setPersonalMemory] = useState<PersonalMemoryDashboardSnapshot>(
    DEFAULT_PERSONAL_MEMORY_DASHBOARD_SNAPSHOT
  );
  const [personalMemoryFeedback, setPersonalMemoryFeedback] =
    useState<PersonalMemoryFeedback | null>(null);
  const [personalMemoryActionPending, setPersonalMemoryActionPending] = useState(false);

  const applyPersonalMemorySnapshot = useCallback(
    (snapshot: PersonalMemoryDashboardSnapshot) => {
      setPersonalMemory(snapshot);
    },
    []
  );

  const refreshPersonalMemory = useCallback(async () => {
    try {
      const snapshot = await api.getPersonalMemory();
      applyPersonalMemorySnapshot(snapshot);
    } catch {
      setPersonalMemoryFeedback(createPersonalMemoryFeedback("danger", "记忆状态不可用。"));
    }
  }, [api, applyPersonalMemorySnapshot]);

  useEffect(() => {
    const unsubscribe = api.onPersonalMemoryChanged(applyPersonalMemorySnapshot);
    void refreshPersonalMemory();
    return unsubscribe;
  }, [api, applyPersonalMemorySnapshot, refreshPersonalMemory]);

  const updatePersonalMemorySettings = useCallback(
    async (update: PersonalMemorySettingsUpdate) => {
      setPersonalMemoryActionPending(true);
      try {
        const settings = await api.setPersonalMemorySettings(update);
        setPersonalMemory((current) => ({ ...current, settings }));
        setPersonalMemoryFeedback(createPersonalMemoryFeedback("success", "记忆设置已更新。"));
      } catch {
        setPersonalMemoryFeedback(createPersonalMemoryFeedback("danger", "记忆设置更新失败。"));
      } finally {
        setPersonalMemoryActionPending(false);
      }
    },
    [api]
  );

  const forgetPersonalMemoryEntry = useCallback(
    async (target: "user" | "agent", content: string) => {
      setPersonalMemoryActionPending(true);
      try {
        const result = await api.forgetPersonalMemory({ target, content });
        applyPersonalMemorySnapshot(result.snapshot);
        setPersonalMemoryFeedback(createPersonalMemoryFeedback(
          result.result === "forgotten" ? "success" : "danger",
          result.result === "forgotten" ? "已忘记该条记忆。" : "未找到匹配的记忆条目。"
        ));
      } catch {
        setPersonalMemoryFeedback(createPersonalMemoryFeedback("danger", "忘记记忆失败。"));
      } finally {
        setPersonalMemoryActionPending(false);
      }
    },
    [api, applyPersonalMemorySnapshot]
  );

  const approvePendingMemory = useCallback(
    async (pendingId: string) => {
      setPersonalMemoryActionPending(true);
      try {
        const result = await api.approvePendingMemory(pendingId);
        applyPersonalMemorySnapshot(result.snapshot);
        if (result.result === "approved") {
          setPersonalMemoryFeedback(createPersonalMemoryFeedback(
            "success",
            `已批准 ${result.applied ?? 0} 条记忆写入。`
          ));
        } else {
          setPersonalMemoryFeedback(createPersonalMemoryFeedback("danger", "未找到该条待审批写入。"));
        }
      } catch {
        setPersonalMemoryFeedback(createPersonalMemoryFeedback("danger", "批准记忆写入失败。"));
      } finally {
        setPersonalMemoryActionPending(false);
      }
    },
    [api, applyPersonalMemorySnapshot]
  );

  const rejectPendingMemory = useCallback(
    async (pendingId: string) => {
      setPersonalMemoryActionPending(true);
      try {
        const result = await api.rejectPendingMemory(pendingId);
        applyPersonalMemorySnapshot(result.snapshot);
        setPersonalMemoryFeedback(createPersonalMemoryFeedback(
          result.result === "rejected" ? "success" : "danger",
          result.result === "rejected" ? "已拒绝该条记忆写入。" : "未找到该条待审批写入。"
        ));
      } catch {
        setPersonalMemoryFeedback(createPersonalMemoryFeedback("danger", "拒绝记忆写入失败。"));
      } finally {
        setPersonalMemoryActionPending(false);
      }
    },
    [api, applyPersonalMemorySnapshot]
  );

  return {
    personalMemory,
    personalMemoryFeedback,
    personalMemoryActionPending,
    refreshPersonalMemory,
    updatePersonalMemorySettings,
    forgetPersonalMemoryEntry,
    approvePendingMemory,
    rejectPendingMemory
  };
}
