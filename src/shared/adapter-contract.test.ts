import { describe, expect, it } from "vitest";
import type {
  AdapterActionVerifiedEvent,
  AdapterApprovalRequiredEvent,
  AdapterBlocker,
  AdapterBlockerStage,
  AdapterCapability,
  AdapterCompletedEvent,
  AdapterContract,
  AdapterIntent,
  AdapterPermission,
  AdapterReplayEvent,
  AdapterSmokeContract,
  AdapterStartedEvent,
  AdapterTaskOptions,
  AdapterVerificationFailedEvent,
  AnyAdapterContract,
  SupportedAdapterId
} from "./adapter-contract";
import type { RiskDecision } from "./types";

describe("adapter contract types", () => {
  it("exposes the four supported adapter identifiers", () => {
    const ids: readonly SupportedAdapterId[] = [
      "ghostty",
      "chrome",
      "finder",
      "tmux_supervision"
    ];
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("models a parsed intent with a plan and a normalized command", () => {
    const ok: AdapterIntent<string> = {
      ok: true,
      command: "pwd",
      plan: "pwd"
    };
    const failed: AdapterIntent<string> = {
      ok: false,
      reason: "no terminal command"
    };

    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.plan).toBe("pwd");
    }
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toContain("no terminal");
    }
  });

  it("declares the observable capability vocabulary", () => {
    const capabilities: readonly AdapterCapability[] = [
      "desktop_action_execute",
      "desktop_screenshot",
      "desktop_ocr",
      "desktop_session_status",
      "desktop_permissions",
      "cdp_command",
      "finder_selection",
      "finder_item_layout",
      "tmux_observe",
      "app_list"
    ];
    expect(capabilities).toContain("cdp_command");
    expect(capabilities).toContain("tmux_observe");
  });

  it("declares the shared blocker stage union", () => {
    const stages: readonly AdapterBlockerStage[] = [
      "input",
      "permissions",
      "desktop_session",
      "activate",
      "initialize",
      "before",
      "after",
      "connection",
      "navigation",
      "interaction",
      "extraction",
      "sensitive",
      "file_operation",
      "observe",
      "selection",
      "layout",
      "drag",
      "tmux"
    ];
    expect(stages).toHaveLength(18);
    expect(new Set(stages).size).toBe(18);
  });

  it("models a typed blocker with an optional code", () => {
    const blocker: AdapterBlocker = {
      stage: "sensitive",
      reason: "sensitive text detected",
      code: "target_changed"
    };
    expect(blocker.code).toBe("target_changed");

    const plain: AdapterBlocker = {
      stage: "permissions",
      reason: "missing grant"
    };
    expect(plain.code).toBeUndefined();
  });

  it("models a packaged smoke contract", () => {
    const smoke: AdapterSmokeContract = {
      npmScript: "smoke:chrome",
      planModule: "scripts/smoke-chrome-plan.mjs",
      productPath: "renderer -> preload -> main -> CDP -> Chrome",
      evidenceClassifiers: ["classifyChromeSmokeEvidence"]
    };
    expect(smoke.npmScript).toBe("smoke:chrome");
    expect(smoke.evidenceClassifiers).toHaveLength(1);
  });

  it("models a permission with kind, state, and label", () => {
    const permission: AdapterPermission = {
      kind: "screenRecording",
      state: "granted",
      label: "Screen Recording"
    };
    expect(permission.state).toBe("granted");
  });

  it("shares the common lifecycle event bases", () => {
    const risk: RiskDecision = {
      level: "medium",
      reason: "test",
      requiresApproval: true
    };

    const started: AdapterStartedEvent = {
      type: "started",
      command: "pwd",
      risk
    };
    const approval: AdapterApprovalRequiredEvent = {
      type: "approval_required",
      command: "pwd",
      risk
    };
    const verified: AdapterActionVerifiedEvent = {
      type: "action_verified",
      actionType: "navigate",
      status: "passed",
      message: "ok"
    };
    const failed: AdapterVerificationFailedEvent = {
      type: "verification_failed",
      stage: "input",
      reason: "bad input"
    };
    const completed: AdapterCompletedEvent = {
      type: "completed",
      command: "pwd",
      summary: "done"
    };

    expect(started.type).toBe("started");
    expect(approval.type).toBe("approval_required");
    expect(verified.status).toBe("passed");
    expect(failed.stage).toBe("input");
    expect(completed.summary).toBe("done");
  });

  it("satisfies the AdapterReplayEvent constraint for event unions", () => {
    const replay: AdapterReplayEvent = { type: "started" };
    expect(replay.type).toBe("started");
  });

  it("accepts the shared options base", () => {
    const options: AdapterTaskOptions = {
      approved: true,
      createScreenshotPath: (stage) => `/tmp/${stage}.png`
    };
    expect(options.approved).toBe(true);
    expect(options.createScreenshotPath?.("before")).toBe("/tmp/before.png");
  });
});

describe("AnyAdapterContract assignability", () => {
  // Compile-time check: a concrete adapter must be assignable to the
  // type-erased AnyAdapterContract used by the registry.
  function assertAnyAdapter(adapter: AnyAdapterContract): AnyAdapterContract {
    return adapter;
  }

  it("accepts a minimal contract-shaped object", () => {
    const adapter = {
      id: "ghostty" as const,
      displayName: "Ghostty",
      targetIdentity: { kind: "bundle_id" as const, value: "com.mitchellh.ghostty" },
      parseInput: (input: string): AdapterIntent<string> => ({
        ok: true,
        command: input,
        plan: input
      }),
      matchesRoute: (input: string) => input.length > 0,
      capabilities: [] as readonly AdapterCapability[],
      readRequiredPermissions: async () => [] as AdapterPermission[],
      readRisk: (): RiskDecision => ({
        level: "low",
        reason: "test",
        requiresApproval: false
      }),
      approvalPolicy: { gates: ["action" as const] },
      planSchema: { schemaVersion: 1 },
      run: async function* () {
        yield { type: "started" } as AdapterReplayEvent;
      },
      verificationStrategy: "terminal_completion_marker" as const,
      stopBehavior: { supportsAbortSignal: true },
      blockerStages: [] as readonly AdapterBlockerStage[]
    };

    // The generic contract interface must accept the concrete shape.
    const typed: AdapterContract<string, string, AdapterReplayEvent, unknown, AdapterTaskOptions> = adapter;
    const erased = assertAnyAdapter(typed);
    expect(erased.id).toBe("ghostty");
  });
});
