import type { TaskControlRecoveryDescriptor } from "../shared/task-control.js";
import { parseChromePageIntent } from "./orchestrator/chrome-task.js";
import type {
  FinderExecutionPlanBinding,
  FinderFileIdentityBinding
} from "./orchestrator/finder-task.js";
import type { TaskRecoveryExecutionContext } from "./task-recovery-registry.js";

export type TaskRecoveryStageResult =
  | { state: "passed"; message: string }
  | { state: "confirmation_required"; message: string }
  | { state: "blocked"; message: string }
  | { state: "failed"; message: string };

export type TaskRecoveryPathStatus =
  | { state: "missing" }
  | { state: "directory" }
  | { state: "indirect" }
  | { state: "file"; identity: FinderFileIdentityBinding };

export interface TaskRecoveryStageDependencies {
  readPathStatus?: (candidatePath: string) => Promise<TaskRecoveryPathStatus>;
  observeChromePage?: () => Promise<{ url: string; title: string }>;
  listRunningAppBundleIds?: () => Promise<string[]>;
  probeTmuxSession?: (
    sessionName: string
  ) => Promise<{ state: "observable" | "missing" | "unknown" }>;
}

export interface TaskRecoveryStageInput {
  descriptor: TaskControlRecoveryDescriptor;
  context: TaskRecoveryExecutionContext;
}

export function readTaskRecoveryChromePageSnapshot(value: unknown): {
  url: string;
  title: string;
} {
  if (
    value
    && typeof value === "object"
    && "result" in value
    && value.result
    && typeof value.result === "object"
    && "value" in value.result
    && value.result.value
    && typeof value.result.value === "object"
    && "url" in value.result.value
    && typeof value.result.value.url === "string"
    && "title" in value.result.value
    && typeof value.result.value.title === "string"
  ) {
    return {
      url: value.result.value.url,
      title: value.result.value.title
    };
  }

  throw new Error("Chrome recovery observation did not return bounded page identity.");
}

export async function runTaskRecoveryStage(
  input: TaskRecoveryStageInput,
  dependencies: TaskRecoveryStageDependencies
): Promise<TaskRecoveryStageResult> {
  if (
    input.descriptor.mode !== "prepare_only"
    || (
      input.descriptor.action !== "retry_observation"
      && input.descriptor.action !== "retry_verification"
    )
    || input.descriptor.executionId !== input.context.executionId
    || input.descriptor.route !== input.context.route.kind
  ) {
    return {
      state: "blocked",
      message: "The recovery stage is not bound to the exact failed execution."
    };
  }

  switch (input.context.route.kind) {
    case "finder":
      return runFinderRecoveryStage(input, dependencies);
    case "chrome":
      return runChromeRecoveryStage(input, dependencies);
    case "ghostty":
      return runGhosttyRecoveryStage(input, dependencies);
    case "tmux_supervision":
      return runTmuxRecoveryStage(input, dependencies);
  }
}

async function runFinderRecoveryStage(
  input: TaskRecoveryStageInput,
  dependencies: TaskRecoveryStageDependencies
): Promise<TaskRecoveryStageResult> {
  const executionPlan = input.context.finderExecutionPlan;
  const readPathStatus = dependencies.readPathStatus;
  if (!executionPlan) {
    return {
      state: "blocked",
      message: "The exact Finder execution plan is unavailable for read-only recovery."
    };
  }
  if (!readPathStatus) {
    return {
      state: "failed",
      message: "The read-only Finder recovery probe is unavailable."
    };
  }

  try {
    const root = await readPathStatus(executionPlan.rootPath);
    if (root.state !== "directory") {
      return {
        state: "blocked",
        message: "The bound Finder root is not currently available as a direct folder."
      };
    }

    if (input.descriptor.action === "retry_observation") {
      await inspectFinderOperationPaths(executionPlan, readPathStatus);
      return {
        state: "passed",
        message: `Read-only Finder observation inspected ${executionPlan.operations.length} bound operations.`
      };
    }

    const checks = await Promise.all(executionPlan.operations.map((operation) => {
      if (operation.type === "create_folder") {
        return readPathStatus(operation.path).then((status) => status.state === "directory");
      }

      return Promise.all([
        readPathStatus(operation.from),
        readPathStatus(operation.to)
      ]).then(([source, destination]) => {
        if (operation.resolution === "skip") {
          return source.state === "file"
            && Boolean(operation.expectedSourceIdentity)
            && areFinderObjectAndContentIdentitiesEqual(
              source.identity,
              operation.expectedSourceIdentity!
            );
        }
        if (operation.resolution === "unresolved") {
          return false;
        }
        return source.state === "missing"
          && destination.state === "file"
          && Boolean(operation.expectedSourceIdentity)
          && areFinderObjectAndContentIdentitiesEqual(
            destination.identity,
            operation.expectedSourceIdentity!
          );
      });
    }));
    const unprovenCount = checks.filter((passed) => !passed).length;
    if (unprovenCount > 0) {
      return {
        state: "confirmation_required",
        message: `Read-only Finder verification could not prove ${unprovenCount} of ${checks.length} bound operations. Review the current file state.`
      };
    }

    return {
      state: "passed",
      message: `Read-only Finder verification passed for ${checks.length} bound operations.`
    };
  } catch {
    return {
      state: "failed",
      message: "The read-only Finder recovery probe could not inspect the bound file state."
    };
  }
}

async function inspectFinderOperationPaths(
  executionPlan: FinderExecutionPlanBinding,
  readPathStatus: NonNullable<TaskRecoveryStageDependencies["readPathStatus"]>
): Promise<void> {
  for (const operation of executionPlan.operations) {
    if (operation.type === "create_folder") {
      await readPathStatus(operation.path);
      continue;
    }
    await Promise.all([
      readPathStatus(operation.from),
      readPathStatus(operation.to)
    ]);
  }
}

function areFinderObjectAndContentIdentitiesEqual(
  left: FinderFileIdentityBinding,
  right: FinderFileIdentityBinding
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedAtMs === right.modifiedAtMs;
}

async function runChromeRecoveryStage(
  input: TaskRecoveryStageInput,
  dependencies: TaskRecoveryStageDependencies
): Promise<TaskRecoveryStageResult> {
  const observeChromePage = dependencies.observeChromePage;
  if (!observeChromePage) {
    return {
      state: "failed",
      message: "The structured read-only Chrome observation channel is unavailable."
    };
  }
  const intent = parseChromePageIntent(input.context.command);
  if (!intent.ok) {
    return {
      state: "blocked",
      message: "The bound Chrome request no longer has a supported page target."
    };
  }

  try {
    const page = await observeChromePage();
    if ("kind" in intent && intent.kind === "form") {
      return {
        state: "confirmation_required",
        message: "A read-only page observation cannot prove a form submission or external side effect. Review the current page."
      };
    }
    if ("kind" in intent && intent.kind === "current_page") {
      return {
        state: "passed",
        message: "Read-only Chrome recovery observed the bound current-page target."
      };
    }
    if (!areChromeUrlsEquivalent(page.url, intent.url)) {
      return {
        state: "confirmation_required",
        message: "Chrome changed pages after the bound task. Re-observe and review the current page before any action."
      };
    }
    return {
      state: "passed",
      message: input.descriptor.action === "retry_observation"
        ? "Read-only Chrome observation matched the bound page target."
        : "Read-only Chrome verification matched the bound page target."
    };
  } catch {
    return {
      state: "failed",
      message: "The read-only Chrome observation could not be completed."
    };
  }
}

function areChromeUrlsEquivalent(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return false;
  }
}

async function runGhosttyRecoveryStage(
  input: TaskRecoveryStageInput,
  dependencies: TaskRecoveryStageDependencies
): Promise<TaskRecoveryStageResult> {
  const listRunningAppBundleIds = dependencies.listRunningAppBundleIds;
  if (!listRunningAppBundleIds) {
    return {
      state: "failed",
      message: "The read-only Ghostty observation probe is unavailable."
    };
  }

  try {
    const bundleIds = await listRunningAppBundleIds();
    if (!bundleIds.includes(input.context.route.kind === "ghostty"
      ? input.context.route.bundleId
      : "")) {
      return {
        state: "blocked",
        message: "The bound Ghostty app is not currently running."
      };
    }
    return input.descriptor.action === "retry_observation"
      ? {
          state: "passed",
          message: "Read-only Ghostty observation confirmed that the bound app is running."
        }
      : {
          state: "confirmation_required",
          message: "App presence cannot prove terminal command completion without capturing terminal content. Review the terminal result."
        };
  } catch {
    return {
      state: "failed",
      message: "The read-only Ghostty observation could not be completed."
    };
  }
}

async function runTmuxRecoveryStage(
  input: TaskRecoveryStageInput,
  dependencies: TaskRecoveryStageDependencies
): Promise<TaskRecoveryStageResult> {
  const probeTmuxSession = dependencies.probeTmuxSession;
  if (!probeTmuxSession || input.context.route.kind !== "tmux_supervision") {
    return {
      state: "failed",
      message: "The read-only tmux observation probe is unavailable."
    };
  }

  try {
    const probe = await probeTmuxSession(input.context.route.sessionName);
    if (probe.state !== "observable") {
      return {
        state: "blocked",
        message: "The bound tmux session is not currently observable."
      };
    }
    return input.descriptor.action === "retry_observation"
      ? {
          state: "passed",
          message: "Read-only tmux observation confirmed that the bound session is observable."
        }
      : {
          state: "confirmation_required",
          message: "Session readiness alone cannot prove the previous supervision result. Review the current session state."
        };
  } catch {
    return {
      state: "failed",
      message: "The read-only tmux observation could not be completed."
    };
  }
}
