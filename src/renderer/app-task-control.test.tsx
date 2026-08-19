import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  TaskControlRecoveryAction,
  TaskControlRecoveryDescriptor,
  TaskControlSnapshot
} from "../shared/task-control";
import { TaskControlCard } from "./app-components";

function createRecoveryDescriptor(
  action: TaskControlRecoveryAction,
  overrides: Partial<TaskControlRecoveryDescriptor> = {}
): TaskControlRecoveryDescriptor {
  return {
    recoveryId: `recovery-${action}`,
    action,
    mode: action === "revise_plan"
      ? "draft_only"
      : action === "open_readiness"
        ? "navigation"
        : "prepare_only",
    executionId: "execution-1",
    planId: "plan-1",
    route: "chrome",
    outcome: "failed",
    failureStage: "verification",
    ...overrides
  };
}

function createTaskControlSnapshot(
  overrides: Partial<TaskControlSnapshot> = {}
): TaskControlSnapshot {
  return {
    schemaVersion: 1,
    executionId: "execution-1",
    phase: "waiting",
    status: "waiting",
    message: "Waiting for the supported app adapter.",
    plan: {
      planId: "plan-1",
      route: "chrome",
      appName: "Chrome",
      target: "example.test",
      risk: {
        level: "medium",
        reason: "This workflow can change the current page.",
        requiresApproval: true
      },
      approvalRequired: true,
      expectedVerification: "Confirm the page reports the requested result.",
      mutating: true
    },
    sideEffectState: "none",
    replayAvailable: false,
    recoveryActions: [],
    ...overrides
  };
}

function createApprovalSnapshot({
  finderPlanPreview,
  gate = "action-plan"
}: {
  finderPlanPreview?: NonNullable<TaskControlSnapshot["approval"]>["finderPlanPreview"];
  gate?: NonNullable<TaskControlSnapshot["approval"]>["gate"];
} = {}): TaskControlSnapshot {
  const snapshot = createTaskControlSnapshot({
    phase: "approval",
    status: "approval_required"
  });
  return {
    ...snapshot,
    approval: {
      gate,
      planId: gate === "finder-plan" ? `${snapshot.plan.planId}:finder-1` : snapshot.plan.planId,
      ...(finderPlanPreview ? { finderPlanPreview } : {})
    }
  };
}

describe("TaskControlCard", () => {
  it("shows a compact safe plan preview and a persistent stop in every active phase", () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <TaskControlCard
        snapshot={createTaskControlSnapshot({
          message: "Waiting after /tmp/private-screen.png was captured."
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onOpenReplay={vi.fn()}
        onRecover={vi.fn()}
        onStop={onStop}
        approvalDecisionPending={false}
        stopPending={false}
      />
    );

    const card = screen.getByLabelText("Computer Use task control");
    expect(card).toHaveAttribute("data-phase", "waiting");
    expect(card).toHaveAttribute("data-status", "waiting");
    expect(card).toHaveTextContent("Chrome");
    expect(card).toHaveTextContent("example.test");
    expect(card).toHaveTextContent("Medium");
    expect(card).toHaveTextContent("Required");
    expect(card).toHaveTextContent("Confirm the page reports the requested result.");
    expect(card).not.toHaveTextContent("/tmp/private-screen.png");
    expect(screen.getByRole("button", { name: "Stop task" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    expect(onStop).toHaveBeenCalledTimes(1);

    for (const [phase, status] of [
      ["approval", "approval_required"],
      ["executing", "executing"],
      ["verifying", "verifying"]
    ] as const) {
      rerender(
        <TaskControlCard
          snapshot={phase === "approval"
            ? createApprovalSnapshot()
            : createTaskControlSnapshot({ phase, status })}
          onApprove={vi.fn()}
          onDeny={vi.fn()}
          onOpenReplay={vi.fn()}
          onRecover={vi.fn()}
          onStop={onStop}
          approvalDecisionPending={false}
          stopPending={false}
        />
      );
      expect(card).toHaveAttribute("data-phase", phase);
      expect(card).toHaveAttribute("data-status", status);
      expect(screen.getByRole("button", { name: "Stop task" })).toBeEnabled();
    }
  });

  it("only exposes approval for an executable approval-bound plan", () => {
    const { rerender } = render(
      <TaskControlCard
        snapshot={createApprovalSnapshot()}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onOpenReplay={vi.fn()}
        onRecover={vi.fn()}
        onStop={vi.fn()}
        approvalDecisionPending={false}
        stopPending={false}
      />
    );

    expect(screen.getByRole("button", { name: "Approve task plan" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deny task plan" })).toBeEnabled();

    rerender(
      <TaskControlCard
        snapshot={{
          ...createApprovalSnapshot(),
          plan: {
            ...createTaskControlSnapshot().plan,
            risk: {
              level: "low",
              reason: "Read-only work is gated by the configured app policy.",
              requiresApproval: false
            },
            approvalRequired: true,
            mutating: false
          }
        }}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onOpenReplay={vi.fn()}
        onRecover={vi.fn()}
        onStop={vi.fn()}
        approvalDecisionPending={false}
        stopPending={false}
      />
    );

    expect(screen.getByRole("button", { name: "Approve task plan" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deny task plan" })).toBeEnabled();

    rerender(
      <TaskControlCard
        snapshot={createTaskControlSnapshot({
          phase: "terminal",
          status: "blocked",
          outcome: "blocked",
          plan: {
            ...createTaskControlSnapshot().plan,
            risk: {
              level: "blocked",
              reason: "This action is not executable.",
              requiresApproval: false
            },
            approvalRequired: false,
            mutating: false
          }
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onOpenReplay={vi.fn()}
        onRecover={vi.fn()}
        onStop={vi.fn()}
        approvalDecisionPending={false}
        stopPending={false}
      />
    );

    expect(screen.queryByRole("button", { name: "Approve task plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny task plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop task" })).not.toBeInTheDocument();
  });

  it("keeps exact terminal outcomes distinct and exposes replay and recovery entry points", () => {
    const onOpenReplay = vi.fn();
    const onRecover = vi.fn();
    const recoveryActions = [
      "retry_observation",
      "retry_verification",
      "revise_plan",
      "open_readiness"
    ] as const;
    const { rerender } = render(
      <TaskControlCard
        snapshot={createTaskControlSnapshot({
          phase: "terminal",
          status: "failed",
          outcome: "failed",
          message: "Verification did not pass.",
          sideEffectState: "possible",
          replayAvailable: true,
          executionPlanId: "plan-1",
          failureStage: "verification",
          recoveryActions: [...recoveryActions],
          recoveryDescriptors: recoveryActions.map((action) => createRecoveryDescriptor(action))
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onOpenReplay={onOpenReplay}
        onRecover={onRecover}
        onStop={vi.fn()}
        approvalDecisionPending={false}
        stopPending={false}
      />
    );

    const card = screen.getByLabelText("Computer Use task control");
    expect(card).toHaveAttribute("data-status", "failed");
    expect(card).toHaveTextContent("Dispatched or completed actions, if any, were not undone.");
    expect(screen.getByLabelText("Task Control completion summary")).toHaveTextContent(
      "Dispatched or completed actions, if any, were not undone."
    );
    fireEvent.click(screen.getByRole("button", { name: "Open task replay" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry observation" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
    fireEvent.click(screen.getByRole("button", { name: "Revise plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Open readiness details" }));
    expect(onOpenReplay).toHaveBeenCalledTimes(1);
    expect(onRecover.mock.calls.map(([descriptor]) => descriptor.action)).toEqual([
      "retry_observation",
      "retry_verification",
      "revise_plan",
      "open_readiness"
    ]);

    for (const outcome of [
      "app_policy_denied",
      "user_denied",
      "blocked",
      "confirmation_required",
      "failed",
      "cancelled",
      "completed"
    ] as const) {
      rerender(
        <TaskControlCard
          snapshot={createTaskControlSnapshot({
            phase: "terminal",
            status: outcome,
            outcome,
            replayAvailable: true
          })}
          onApprove={vi.fn()}
          onDeny={vi.fn()}
          onOpenReplay={onOpenReplay}
          onRecover={onRecover}
          onStop={vi.fn()}
          approvalDecisionPending={false}
          stopPending={false}
        />
      );
      expect(card).toHaveAttribute("data-status", outcome);
      expect(card).toHaveTextContent(outcome);
    }
  });

  it("shows the existing safe Finder operation summary for a bound second approval", () => {
    const finderPlanPreview = {
      rootPath: "/Users/tester/Private/Downloads",
      operationCount: 2,
      destructiveOperationCount: 0,
      createFolders: ["Images"],
      moveFiles: [{
        from: "/Users/tester/Private/Downloads/photo.png",
        to: "/Users/tester/Private/Downloads/Images/photo.png"
      }]
    };
    render(
      <TaskControlCard
        snapshot={{
          ...createApprovalSnapshot({ gate: "finder-plan", finderPlanPreview }),
          plan: {
            ...createTaskControlSnapshot().plan,
            route: "finder",
            appName: "Finder",
            target: "Selected Finder folder"
          }
        }}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onOpenReplay={vi.fn()}
        onRecover={vi.fn()}
        onStop={vi.fn()}
        approvalDecisionPending={false}
        stopPending={false}
      />
    );

    expect(screen.getByLabelText("Finder plan preview")).toHaveTextContent("photo.png -> Images/photo.png");
    expect(screen.getByLabelText("Finder plan preview")).not.toHaveTextContent("/Users/tester/Private");
  });

  it("submits the exact displayed approval binding and disables both decisions together", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const snapshot = createApprovalSnapshot();
    const { rerender } = render(
      <TaskControlCard
        snapshot={snapshot}
        onApprove={onApprove}
        onDeny={onDeny}
        onOpenReplay={vi.fn()}
        onRecover={vi.fn()}
        onStop={vi.fn()}
        approvalDecisionPending={false}
        stopPending={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve task plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny task plan" }));
    expect(onApprove).toHaveBeenCalledWith({
      executionId: snapshot.executionId,
      planId: snapshot.approval?.planId
    });
    expect(onDeny).toHaveBeenCalledWith({
      executionId: snapshot.executionId,
      planId: snapshot.approval?.planId
    });

    rerender(
      <TaskControlCard
        snapshot={snapshot}
        onApprove={onApprove}
        onDeny={onDeny}
        onOpenReplay={vi.fn()}
        onRecover={vi.fn()}
        onStop={vi.fn()}
        approvalDecisionPending
        stopPending={false}
      />
    );
    expect(screen.getByLabelText("Task Control actions")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Approve task plan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny task plan" })).toBeDisabled();
  });

  it("never exposes approval controls when the snapshot has no bound approval", () => {
    render(
      <TaskControlCard
        snapshot={createTaskControlSnapshot({
          phase: "approval",
          status: "approval_required"
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onOpenReplay={vi.fn()}
        onRecover={vi.fn()}
        onStop={vi.fn()}
        approvalDecisionPending={false}
        stopPending={false}
      />
    );

    expect(screen.queryByRole("button", { name: "Approve task plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny task plan" })).not.toBeInTheDocument();
  });

  it("leaves the active phase authoritative while a stop request is pending", () => {
    render(
      <TaskControlCard
        snapshot={createTaskControlSnapshot({
          phase: "executing",
          status: "executing"
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onOpenReplay={vi.fn()}
        onRecover={vi.fn()}
        onStop={vi.fn()}
        approvalDecisionPending={false}
        stopPending
      />
    );

    expect(screen.getByLabelText("Computer Use task control")).toHaveAttribute(
      "data-status",
      "executing"
    );
    expect(screen.getByRole("button", { name: "Stopping task" })).toBeDisabled();
    expect(screen.queryByText("cancelled")).not.toBeInTheDocument();
  });
});
