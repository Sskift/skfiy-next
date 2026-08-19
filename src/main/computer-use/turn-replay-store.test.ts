import { describe, expect, it } from "vitest";
import { createTurnReplayStore } from "./turn-replay-store";

describe("createTurnReplayStore", () => {
  it("summarizes the latest Computer Use turn with task timeline events", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordComputerUseEvent({
      type: "started",
      command: "pwd",
      risk: {
        level: "low",
        reason: "Read-only terminal command.",
        requiresApproval: false
      }
    });
    store.recordTaskEvent({
      status: "executing",
      message: "Risk low: Read-only terminal command."
    });
    store.recordComputerUseEvent({ type: "typing", command: "pwd" });
    store.recordTaskEvent({ status: "executing", message: "Typing command in Ghostty." });
    store.recordComputerUseEvent({ type: "submitted", key: "enter" });
    store.recordTaskEvent({ status: "executing", message: "Submitted command with enter." });
    store.recordComputerUseEvent({
      type: "completed",
      command: "pwd",
      summary: "Command submitted to Ghostty."
    });
    store.recordTaskEvent({ status: "completed", message: "Command submitted to Ghostty." });

    expect(store.getReplay()).toMatchObject({
      transcript: {
        command: "pwd",
        risk: { level: "low" },
        actions: [
          { type: "type_text", text: "pwd" },
          { type: "press_key", key: "enter" }
        ],
        outcome: "completed"
      },
      timeline: [
        { status: "executing", message: "Risk low: Read-only terminal command." },
        { status: "executing", message: "Typing command in Ghostty." },
        { status: "executing", message: "Submitted command with enter." },
        { status: "completed", message: "Command submitted to Ghostty." }
      ]
    });
  });

  it("keeps only the newest turn after reset", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordTaskEvent({ status: "completed", message: "old turn" });
    store.startTurn();
    store.recordTaskEvent({ status: "failed", message: "new turn" });

    expect(store.getReplay()?.timeline).toEqual([
      { status: "failed", message: "new turn" }
    ]);
  });

  it("marks the transcript failed when the task timeline fails before raw completion", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordComputerUseEvent({
      type: "started",
      command: "pwd",
      risk: {
        level: "low",
        reason: "Read-only terminal command.",
        requiresApproval: false
      }
    });
    store.recordTaskEvent({
      status: "failed",
      message: "Accessibility permission is required."
    });

    expect(store.getReplay()?.transcript.outcome).toBe("failed");
  });

  it("uses terminal task timeline events to preserve completed route outcome after prior progress", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordComputerUseEvent({
      type: "tool_call",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: "run pwd in Ghostty",
      route: "ghostty",
      status: "running"
    });
    store.recordTaskEvent({
      status: "executing",
      message: "Typing command in Ghostty.",
      command: "run pwd in Ghostty",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      route: "ghostty"
    });
    store.recordComputerUseEvent({
      type: "tool_result",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: "run pwd in Ghostty",
      route: "ghostty",
      status: "completed",
      summary: "pwd completed.",
      evidence: {
        summary: "Computer Use route completed with replayed orchestration events."
      }
    });
    store.recordTaskEvent({
      status: "completed",
      message: "pwd completed.",
      command: "run pwd in Ghostty",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      route: "ghostty"
    });

    expect(store.getReplay()).toMatchObject({
      transcript: {
        outcome: "completed"
      },
      routeOutcome: {
        kind: "completed",
        source: "turn-replay",
        routeLabel: "ghostty",
        detail: "pwd completed."
      },
      timeline: [
        {
          status: "executing",
          message: "Typing command in Ghostty.",
          route: "ghostty"
        },
        {
          status: "completed",
          message: "pwd completed.",
          route: "ghostty"
        }
      ]
    });
  });

  it("preserves route confirmation as a terminal task timeline outcome", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordTaskEvent({
      status: "needs_confirmation",
      message: "Verification failed (after): Completion marker was not observed.",
      route: "ghostty"
    });

    expect(store.getReplay()).toMatchObject({
      transcript: {
        outcome: "needs_confirmation"
      },
      routeOutcome: {
        kind: "needs_confirmation",
        source: "turn-replay",
        routeLabel: "ghostty",
        detail: "Verification failed (after): Completion marker was not observed."
      },
      timeline: [
        {
          status: "needs_confirmation",
          message: "Verification failed (after): Completion marker was not observed.",
          route: "ghostty"
        }
      ]
    });
  });

  it("treats transcript verification failures as confirmable replay route outcomes", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordComputerUseEvent({
      type: "tool_call",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: "run pwd in Ghostty",
      route: "ghostty",
      status: "running"
    });
    store.recordComputerUseEvent({
      type: "action_verified",
      actionType: "completion_marker",
      status: "failed",
      message: "Completion marker was not observed.",
      reason: "after screenshot did not include the marker"
    });

    expect(store.getReplay()).toMatchObject({
      transcript: {
        outcome: "verification_failed"
      },
      routeOutcome: {
        kind: "needs_confirmation",
        value: "needs_confirmation",
        source: "turn-replay",
        routeLabel: "ghostty",
        state: "needs_confirmation"
      }
    });
  });

  it("lets structured route task events preserve policy metadata after generic terminal events", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordComputerUseEvent({
      type: "tool_result",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: "open Ghostty",
      route: "ghostty",
      status: "blocked",
      summary: "Computer Use tool call blocked."
    });
    store.recordTaskEvent({
      status: "blocked",
      message: "Computer Use tool call blocked.",
      route: "ghostty"
    });
    store.recordTaskEvent({
      status: "blocked",
      message: "Ghostty denied by app policy.",
      route: "ghostty",
      denialKind: "app_policy",
      policyKind: "app-policy"
    });

    expect(store.getReplay()).toMatchObject({
      transcript: {
        outcome: "blocked"
      },
      routeOutcome: {
        kind: "app_policy_denied",
        source: "turn-replay",
        routeLabel: "ghostty",
        detail: "Ghostty denied by app policy.",
        denialKind: "app_policy",
        policyKind: "app-policy"
      },
      timeline: [
        {
          status: "blocked",
          message: "Computer Use tool call blocked.",
          route: "ghostty"
        },
        {
          status: "blocked",
          message: "Ghostty denied by app policy.",
          route: "ghostty",
          denialKind: "app_policy",
          policyKind: "app-policy"
        }
      ]
    });
  });

  it("preserves unsupported route clarification as a terminal task timeline status", () => {
    const updates: unknown[] = [];
    const store = createTurnReplayStore({
      onReplayChanged: (replay) => {
        updates.push(replay);
      }
    });

    store.startTurn();
    store.recordTaskEvent({
      status: "needs_clarification",
      message: "No supported desktop control route matched this request.",
      routeReason: "No supported desktop control route matched this request."
    });

    expect(store.getReplay()).toMatchObject({
      transcript: {
        outcome: "needs_clarification"
      },
      routeOutcome: {
        kind: "needs_clarification",
        source: "turn-replay",
        routeLabel: "unknown",
        detail: "No supported desktop control route matched this request."
      },
      timeline: [
        {
          status: "needs_clarification",
          message: "No supported desktop control route matched this request.",
          routeReason: "No supported desktop control route matched this request."
        }
      ]
    });
    expect(updates.at(-1)).toMatchObject({
      routeOutcome: {
        kind: "needs_clarification"
      },
      timeline: [
        {
          status: "needs_clarification"
        }
      ]
    });
  });

  it("preserves replay route outcome metadata without leaking token-like details", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordComputerUseEvent({
      type: "tool_result",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: "open Ghostty",
      route: "ghostty",
      status: "blocked",
      summary: "Ghostty denied by app policy with token=secret-token",
      evidence: {
        summary: "blocked by local policy",
        artifacts: []
      }
    });
    store.recordTaskEvent({
      status: "blocked",
      message: "Ghostty denied by app policy with token=secret-token",
      route: "ghostty",
      denialKind: "app_policy",
      policyKind: "app-policy"
    });

    expect(store.getReplay()?.routeOutcome).toMatchObject({
      kind: "app_policy_denied",
      source: "turn-replay",
      routeLabel: "ghostty",
      detail: "Ghostty denied by app policy with token=[redacted]"
    });
  });

  it("uses explicit task route outcomes for replay route semantics without leaking tokens", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordTaskEvent({
      status: "blocked",
      message: "Fallback route message should not replace the explicit outcome.",
      route: "chrome",
      routeReason: "Fallback route reason should not replace the explicit outcome.",
      routeOutcome: {
        kind: "chrome_host_policy_denied",
        title: "Chrome host policy denied route",
        value: "chrome_host_policy_denied",
        detail: "Chrome host policy blocked token=explicit-secret",
        tone: "danger",
        source: "task-event",
        routeLabel: "chrome",
        state: "blocked",
        policyKind: "chrome-host-policy"
      }
    });

    const replay = store.getReplay();

    expect(replay?.routeOutcome).toEqual({
      kind: "chrome_host_policy_denied",
      title: "Chrome host policy denied route",
      value: "chrome_host_policy_denied",
      detail: "Chrome host policy blocked token=[redacted]",
      tone: "danger",
      source: "task-event",
      routeLabel: "chrome",
      state: "blocked",
      policyKind: "chrome-host-policy"
    });
    expect(replay?.timeline[0]?.routeOutcome).toMatchObject({
      kind: "chrome_host_policy_denied",
      detail: "Chrome host policy blocked token=[redacted]",
      policyKind: "chrome-host-policy"
    });
    expect(JSON.stringify(replay)).not.toContain("explicit-secret");
  });

  it("keeps turn/tool lifecycle identity across approval and completion", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordComputerUseEvent({
      type: "tool_call",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: "打开 Chrome 测试页面",
      route: "chrome",
      status: "planned"
    });
    store.recordTaskEvent({
      status: "planned",
      command: "打开 Chrome 测试页面",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      route: "chrome"
    });
    store.recordComputerUseEvent({
      type: "approval_decision",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: "打开 Chrome 测试页面",
      route: "chrome",
      decision: "bypassed",
      reason: "Dogfood bypass enabled."
    });
    store.recordComputerUseEvent({
      type: "tool_result",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      command: "打开 Chrome 测试页面",
      route: "chrome",
      status: "completed",
      summary: "Chrome page opened.",
      evidence: {
        summary: "Screenshot captured.",
        artifacts: ["/tmp/chrome-after.png"]
      }
    });
    store.recordTaskEvent({
      status: "completed",
      message: "Chrome page opened.",
      command: "打开 Chrome 测试页面",
      turnId: "turn-agent-1",
      toolCallId: "turn-agent-1-tool-1",
      route: "chrome"
    });

    expect(store.getReplay()).toMatchObject({
      transcript: {
        outcome: "completed",
        actions: expect.arrayContaining([
          expect.objectContaining({
            type: "approval_decision",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            decision: "bypassed"
          }),
          expect.objectContaining({
            type: "tool_result",
            turnId: "turn-agent-1",
            toolCallId: "turn-agent-1-tool-1",
            status: "completed",
            evidenceSummary: "Screenshot captured.",
            artifactCount: 1
          })
        ])
      },
      timeline: [
        {
          status: "planned",
          command: "打开 Chrome 测试页面",
          turnId: "turn-agent-1",
          toolCallId: "turn-agent-1-tool-1",
          route: "chrome"
        },
        {
          status: "completed",
          message: "Chrome page opened.",
          command: "打开 Chrome 测试页面",
          turnId: "turn-agent-1",
          toolCallId: "turn-agent-1-tool-1",
          route: "chrome"
        }
      ]
    });
  });

  it("keeps external planner rationale in the replay transcript", () => {
    const store = createTurnReplayStore();

    store.startTurn();
    store.recordComputerUseEvent({
      type: "planner_resolved",
      providerLabel: "External CUA",
      input: "打开 Ghostty 执行 pwd 并截图",
      command: "pwd",
      rationale: "Read the current working directory."
    });
    store.recordTaskEvent({
      status: "executing",
      message: "External CUA planned: pwd"
    });

    expect(store.getReplay()).toMatchObject({
      transcript: {
        planner: {
          providerLabel: "External CUA",
          input: "打开 Ghostty 执行 pwd 并截图",
          command: "pwd",
          rationale: "Read the current working directory."
        },
        actions: [
          {
            type: "plan",
            providerLabel: "External CUA",
            command: "pwd"
          }
        ]
      }
    });
  });

  it("notifies a subscriber whenever replay state changes", () => {
    const updates: unknown[] = [];
    const store = createTurnReplayStore({
      onReplayChanged: (replay) => {
        updates.push(replay);
      }
    });

    store.startTurn();
    store.recordComputerUseEvent({
      type: "started",
      command: "pwd",
      risk: {
        level: "low",
        reason: "Read-only terminal command.",
        requiresApproval: false
      }
    });
    store.recordTaskEvent({
      status: "executing",
      message: "Typing command in Ghostty."
    });

    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatchObject({
      transcript: {
        approvalRequired: false,
        actions: [],
        outcome: "running"
      },
      timeline: []
    });
    expect(updates[2]).toMatchObject({
      transcript: {
        command: "pwd"
      },
      timeline: [
        {
          status: "executing",
          message: "Typing command in Ghostty."
        }
      ]
    });
  });
});
