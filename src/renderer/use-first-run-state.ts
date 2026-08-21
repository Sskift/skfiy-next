import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import {
  createFirstRunReadinessSnapshot,
  type FirstRunReadinessSnapshot,
  type FirstRunReadinessStepId
} from "../shared/first-run-readiness";
import {
  createTaskStatusView,
  type TaskView
} from "./app-task-state";
import type { DesktopApi } from "./app-types";

export interface FirstRunStateDeps {
  preserveActiveTaskView: (current: TaskView, next: TaskView) => TaskView;
  setTask: Dispatch<SetStateAction<TaskView>>;
}

export function useFirstRunState(api: DesktopApi, deps: FirstRunStateDeps) {
  const { preserveActiveTaskView, setTask } = deps;

  const [firstRunReadiness, setFirstRunReadiness] = useState<FirstRunReadinessSnapshot>(() =>
    createFirstRunReadinessSnapshot({})
  );
  const [firstRunReadinessLoaded, setFirstRunReadinessLoaded] = useState(false);
  const [firstRunReadinessLoading, setFirstRunReadinessLoading] = useState(false);
  const [firstRunActionStepId, setFirstRunActionStepId] =
    useState<FirstRunReadinessStepId | null>(null);

  const refreshFirstRunReadiness = useCallback(async () => {
    setFirstRunReadinessLoading(true);
    try {
      setFirstRunReadiness(await api.getFirstRunReadiness());
    } catch {
      setFirstRunReadiness(createFirstRunReadinessSnapshot({}));
    } finally {
      setFirstRunReadinessLoaded(true);
      setFirstRunReadinessLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refreshFirstRunReadiness();
  }, [refreshFirstRunReadiness]);

  const runFirstRunAction = useCallback(
    async (stepId: FirstRunReadinessStepId, action: () => Promise<void>) => {
      setFirstRunActionStepId(stepId);
      try {
        await action();
      } finally {
        setFirstRunActionStepId(null);
      }
    },
    []
  );

  async function testBackgroundAgentReadiness() {
    setFirstRunActionStepId("background-agent");
    try {
      setFirstRunReadiness(await api.testBackgroundAgent());
      setFirstRunReadinessLoaded(true);
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskStatusView("failed", "Background Agent 安全测试失败，请重试.")
      ));
    } finally {
      setFirstRunActionStepId(null);
    }
  }

  async function testFinderReadiness() {
    setFirstRunActionStepId("finder-automation");
    try {
      setFirstRunReadiness(await api.testFinderAutomation());
      setFirstRunReadinessLoaded(true);
    } catch {
      setTask((current) => preserveActiveTaskView(
        current,
        createTaskStatusView("failed", "Finder Automation 只读测试失败，请重试.")
      ));
    } finally {
      setFirstRunActionStepId(null);
    }
  }

  return {
    firstRunReadiness,
    firstRunReadinessLoaded,
    firstRunReadinessLoading,
    firstRunActionStepId,
    refreshFirstRunReadiness,
    runFirstRunAction,
    testBackgroundAgentReadiness,
    testFinderReadiness
  };
}
