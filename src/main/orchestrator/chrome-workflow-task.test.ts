import { describe, expect, it, vi } from "vitest";
import type { CdpCommand } from "../computer-use/browser-control.js";
import type { ChromeCurrentPageSnapshot } from "./chrome-task.js";
import type { ChromeTaskEvent } from "./chrome-task.js";
import type { ChromeWorkflowPlan } from "../computer-use/chrome-workflow-template.js";
import {
  createChromeWorkflowPlanPreview,
  parseChromeWorkflowCommand,
  runChromeWorkflowTask,
  type ChromeWorkflowClient
} from "./chrome-workflow-task";

const FORM_SNAPSHOT: ChromeCurrentPageSnapshot = {
  url: "https://example.com/form",
  documentId: "doc-1",
  title: "example form",
  text: "form text"
};

const RESULTS_SNAPSHOT: ChromeCurrentPageSnapshot = {
  url: "https://example.com/results",
  documentId: "doc-2",
  title: "example results",
  text: "results text"
};

async function collectEvents(task: AsyncGenerator<{ type: string }>) {
  const events: Array<{ type: string }> = [];

  for await (const event of task) {
    events.push(event);
  }

  return events;
}

function createWorkflowClient(
  snapshot: ChromeCurrentPageSnapshot = FORM_SNAPSHOT,
  verification: { passed: boolean; actual: string } = { passed: true, actual: "visible" }
): ChromeWorkflowClient & { sendCdpCommand: ReturnType<typeof vi.fn> } {
  return {
    sendCdpCommand: vi.fn(async (command: CdpCommand) => {
      const expression = typeof command.params?.expression === "string"
        ? command.params.expression
        : "";

      if (expression.includes("title: document.title")) {
        return { result: { type: "object", value: snapshot } };
      }

      if (expression.includes("passed")) {
        return { result: { type: "object", value: verification } };
      }

      return { result: { type: "boolean", value: true } };
    }),
    readPageSafetyState: vi.fn(async () => ({ findings: [], needsConfirmation: false })),
    readDownloadsStatus: vi.fn(async () => ({ downloads: [] })),
    readPageTargets: vi.fn(async () => [])
  };
}

function createThreeStepPlan(): ChromeWorkflowPlan {
  return {
    command: "test workflow",
    steps: [
      { kind: "observe" },
      { kind: "click", selector: "#next" },
      { kind: "verify", selector: "#results", expected: { kind: "visible" } }
    ]
  };
}

describe("runChromeWorkflowTask approval gates", () => {
  it("requires action approval before any CDP command", async () => {
    const client = createWorkflowClient();

    const events = await collectEvents(
      runChromeWorkflowTask({ plan: createThreeStepPlan(), cdpClient: client })
    );

    expect(events.map((event) => event.type)).toEqual(["started", "approval_required"]);
    expect(client.sendCdpCommand).not.toHaveBeenCalled();
  });

  it("requires a value-free workflow confirmation after action approval", async () => {
    const client = createWorkflowClient();
    const plan: ChromeWorkflowPlan = {
      command: "secret workflow",
      steps: [
        { kind: "observe" },
        { kind: "fill", selector: "#query", value: "secret-value" },
        { kind: "submit", selector: "#search-button" }
      ]
    };

    const events = await collectEvents(
      runChromeWorkflowTask({ plan, cdpClient: client, approved: true })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "approval_required",
      "workflow_confirmation_required"
    ]);
    const confirmation = events[2] as Extract<
      ChromeTaskEvent,
      { type: "workflow_confirmation_required" }
    >;
    expect(confirmation.preview.stepCount).toBe(3);
    expect(confirmation.preview.steps).toEqual([
      { stepKind: "observe", risk: "low" },
      { stepKind: "fill", selector: "#query", risk: "medium" },
      { stepKind: "submit", selector: "#search-button", risk: "high" }
    ]);
    expect(confirmation.preview.maxSteps).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(events)).not.toContain("secret-value");
    expect(client.sendCdpCommand).not.toHaveBeenCalled();
  });
});

describe("runChromeWorkflowTask execution", () => {
  it("emits step started/completed events and a completed summary", async () => {
    const client = createWorkflowClient();

    const events = await collectEvents(
      runChromeWorkflowTask({
        plan: createThreeStepPlan(),
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "approval_required",
      "workflow_step_started",
      "workflow_step_completed",
      "workflow_step_started",
      "workflow_step_completed",
      "workflow_step_started",
      "dom_verification_passed",
      "workflow_step_completed",
      "completed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      summary: "Chrome workflow completed: 3/3 steps passed."
    });
    expect(client.sendCdpCommand).toHaveBeenCalledWith(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({
        expression: expect.stringContaining("#next")
      })
    }));
  });

  it("binds mutating actions to the observed page identity", async () => {
    const client = createWorkflowClient();

    await collectEvents(
      runChromeWorkflowTask({
        plan: createThreeStepPlan(),
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    const clickCall = client.sendCdpCommand.mock.calls.find(([command]) =>
      typeof command.params?.expression === "string"
      && command.params.expression.includes("#next")
    );
    expect(clickCall?.[0].params?.expression).toContain("window.location.href");
    expect(clickCall?.[0].params?.expression).toContain("https://example.com/form");
  });

  it("detects navigation after a mutation, re-binds, and continues", async () => {
    const client = createWorkflowClient();
    const snapshots = [FORM_SNAPSHOT, RESULTS_SNAPSHOT];
    let snapshotIndex = 0;
    client.sendCdpCommand.mockImplementation(async (command: CdpCommand) => {
      const expression = typeof command.params?.expression === "string"
        ? command.params.expression
        : "";
      if (expression.includes("title: document.title")) {
        const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        return { result: { type: "object", value: snapshot } };
      }
      return { result: { type: "boolean", value: true } };
    });
    const plan: ChromeWorkflowPlan = {
      command: "navigate workflow",
      steps: [
        { kind: "observe" },
        { kind: "click", selector: "#next" }
      ]
    };

    const events = await collectEvents(
      runChromeWorkflowTask({
        plan,
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "navigation_detected",
        fromUrl: "https://example.com/form",
        toUrl: "https://example.com/results",
        stepIndex: 1
      })
    ]));
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      summary: "Chrome workflow completed: 2/2 steps passed."
    });
  });

  it("blocks when a mutation opens a new tab", async () => {
    const client = createWorkflowClient();
    client.readPageTargets = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{
        id: "tab-2",
        url: "https://example.com/new-tab",
        type: "page" as const
      }]);

    const events = await collectEvents(
      runChromeWorkflowTask({
        plan: createThreeStepPlan(),
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    expect(events.at(-1)).toMatchObject({
      type: "new_tab_detected",
      tabUrl: "https://example.com/new-tab",
      stepIndex: 1
    });
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("blocks when the page shows an auth wall after a mutation", async () => {
    const client = createWorkflowClient();
    client.readPageSafetyState = vi.fn().mockResolvedValue({
      findings: [{ kind: "credential_or_otp_prompt", severity: "high" }],
      needsConfirmation: true
    });

    const events = await collectEvents(
      runChromeWorkflowTask({
        plan: createThreeStepPlan(),
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    expect(events.at(-1)).toMatchObject({
      type: "auth_wall_detected",
      url: "https://example.com/form",
      safetyFindings: [{ kind: "credential_or_otp_prompt", severity: "high" }]
    });
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("reports downloads as informational events and continues", async () => {
    const client = createWorkflowClient();
    client.readDownloadsStatus = vi.fn()
      .mockResolvedValueOnce({ downloads: [] })
      .mockResolvedValue({
        downloads: [{
          id: "dl-1",
          url: "https://cdn.example.com/assets/report.pdf",
          state: "completed"
        }]
      });

    const events = await collectEvents(
      runChromeWorkflowTask({
        plan: createThreeStepPlan(),
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "download_detected",
        downloadUrl: "cdn.example.com",
        stepIndex: 1
      })
    ]));
    expect(events.some((event) => event.type === "completed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("report.pdf");
  });

  it("detects a page reload after a mutation, re-observes, and continues", async () => {
    const client = createWorkflowClient();
    const snapshots = [
      FORM_SNAPSHOT,
      { ...FORM_SNAPSHOT, documentId: "doc-reloaded" }
    ];
    let snapshotIndex = 0;
    client.sendCdpCommand.mockImplementation(async (command: CdpCommand) => {
      const expression = typeof command.params?.expression === "string"
        ? command.params.expression
        : "";
      if (expression.includes("title: document.title")) {
        const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        return { result: { type: "object", value: snapshot } };
      }
      return { result: { type: "boolean", value: true } };
    });
    const plan: ChromeWorkflowPlan = {
      command: "reload workflow",
      steps: [
        { kind: "observe" },
        { kind: "click", selector: "#reload" }
      ]
    };

    const events = await collectEvents(
      runChromeWorkflowTask({
        plan,
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "page_reload_detected",
        url: "https://example.com/form",
        stepIndex: 1
      })
    ]));
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("emits dom_verification_passed evidence for passing verify steps", async () => {
    const client = createWorkflowClient(
      FORM_SNAPSHOT,
      { passed: true, actual: "visible" }
    );

    const events = await collectEvents(
      runChromeWorkflowTask({
        plan: createThreeStepPlan(),
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "dom_verification_passed",
        stepIndex: 2,
        selector: "#results",
        expected: "element visible",
        actual: "visible"
      })
    ]));
  });

  it("stops with a partial completed summary when DOM verification fails", async () => {
    const client = createWorkflowClient(
      FORM_SNAPSHOT,
      { passed: false, actual: "hidden" }
    );

    const events = await collectEvents(
      runChromeWorkflowTask({
        plan: createThreeStepPlan(),
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    expect(events.at(-2)).toMatchObject({
      type: "dom_verification_failed",
      stepIndex: 2,
      selector: "#results",
      expected: "element visible",
      actual: "hidden"
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      summary: "Chrome workflow completed: 2/3 steps passed."
    });
  });

  it("never emits fill values in events", async () => {
    const client = createWorkflowClient();
    const plan: ChromeWorkflowPlan = {
      command: "fill workflow",
      steps: [
        { kind: "observe" },
        { kind: "fill", selector: "#query", value: "super-secret-value" },
        { kind: "verify", selector: "#results", expected: { kind: "visible" } }
      ]
    };

    const events = await collectEvents(
      runChromeWorkflowTask({
        plan,
        cdpClient: client,
        approved: true,
        workflowApproved: true
      })
    );

    expect(JSON.stringify(events)).not.toContain("super-secret-value");
    const fillCall = client.sendCdpCommand.mock.calls.find(([command]) =>
      typeof command.params?.expression === "string"
      && command.params.expression.includes("#query")
    );
    expect(fillCall?.[0].params?.expression).toContain("super-secret-value");
  });

  it("falls back to a screenshot observation when CDP is unavailable", async () => {
    const events = await collectEvents(
      runChromeWorkflowTask({
        plan: createThreeStepPlan(),
        approved: true,
        workflowApproved: true
      })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "approval_required",
      "fallback_switch",
      "verification_failed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "connection"
    });
  });
});

describe("createChromeWorkflowPlanPreview", () => {
  it("builds a value-free preview with per-step risks", () => {
    const preview = createChromeWorkflowPlanPreview({
      command: "preview workflow",
      steps: [
        { kind: "observe" },
        { kind: "fill", selector: "#query", value: "redacted" },
        { kind: "scroll", selector: "#content", deltaY: 400 },
        { kind: "submit", selector: "#go" }
      ]
    });

    expect(preview.stepCount).toBe(4);
    expect(preview.steps.map((step) => step.risk)).toEqual([
      "low",
      "medium",
      "low",
      "high"
    ]);
    expect(JSON.stringify(preview)).not.toContain("redacted");
    expect(preview.planId).toMatch(/^chrome-workflow-/u);
  });
});

describe("parseChromeWorkflowCommand", () => {
  it("instantiates a built-in template with fill values", () => {
    const result = parseChromeWorkflowCommand("Chrome workflow search-form query=skfiy");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.steps).toHaveLength(4);
    const fillStep = result.plan.steps[1];
    expect(fillStep).toMatchObject({ kind: "fill", selector: "#search-input", value: "skfiy" });
    expect(result.plan.command).toContain("search form");
  });

  it("accepts fill values containing spaces", () => {
    const result = parseChromeWorkflowCommand("chrome workflow search-form query=hello world");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.steps[1]).toMatchObject({ value: "hello world" });
  });

  it("accepts the Chinese workflow command form", () => {
    const result = parseChromeWorkflowCommand("执行 Chrome 工作流 scroll-and-verify");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.steps).toHaveLength(3);
  });

  it("rejects unknown template ids", () => {
    expect(parseChromeWorkflowCommand("Chrome workflow no-such-template")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Unknown Chrome workflow template")
    });
  });

  it("rejects templates missing required fill values", () => {
    expect(parseChromeWorkflowCommand("Chrome workflow search-form")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("missing fill value")
    });
  });

  it("does not match ordinary Chrome page commands", () => {
    expect(parseChromeWorkflowCommand(
      "打开 Chrome 测试页面 file:///tmp/skfiy-chrome.html 并提取正文"
    )).toMatchObject({ ok: false });
  });
});
