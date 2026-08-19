import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  resolveComputerUseDesktopTarget,
  runComputerUseAgentLoop,
  type ComputerUseAgentLoopClient,
  type ComputerUseAgentPlanner
} from "./agent-loop";
import { createCodexComputerUsePlanner } from "./agent-loop-planner";

function createObservation(
  screenshotPath: string,
  ocrText: string,
  bundleId = "com.apple.Notes"
) {
  return {
    bundleId,
    pid: 42,
    isRunning: true,
    isActive: true,
    screenshotPath,
    frontmostBundleId: bundleId,
    windows: [{
      title: "Notes",
      layer: 0,
      bounds: { x: 100, y: 80, width: 900, height: 700 }
    }],
    ocrLabels: [{
      text: ocrText,
      confidence: 0.99,
      bounds: { x: 180, y: 160, width: 300, height: 30 }
    }]
  };
}

describe("generic Computer Use agent loop", () => {
  it("binds a named app and chooses different actions from fresh observations", async () => {
    const observations = [
      createObservation("/tmp/notes-1.png", "Blank note"),
      createObservation("/tmp/notes-2.png", "hello from skfiy"),
      createObservation("/tmp/notes-3.png", "hello from skfiy Saved")
    ];
    const executed: unknown[] = [];
    const client: ComputerUseAgentLoopClient = {
      listApps: vi.fn(async () => [
        { bundleId: "com.google.Chrome", name: "Google Chrome", pid: 10 },
        { bundleId: "com.apple.Notes", name: "备忘录", pid: 42 }
      ]),
      getDesktopSessionStatus: vi.fn(async () => ({
        controllable: true,
        frontmostBundleId: "com.apple.Notes",
        frontmostLocalizedName: "备忘录",
        frontmostProcessIdentifier: 42
      })),
      getAppState: vi.fn(async () => {
        const observation = observations.shift();
        if (!observation) throw new Error("Unexpected extra observation");
        return observation;
      }),
      ocrImage: vi.fn(async (path) => ({
        labels: path.includes("notes-1")
          ? createObservation(path, "Blank note").ocrLabels
          : createObservation(path, path.includes("notes-2") ? "hello from skfiy" : "Saved").ocrLabels
      })),
      executeAction: vi.fn(async (action) => {
        executed.push(action);
        return { ok: true };
      })
    };
    const target = await resolveComputerUseDesktopTarget("在备忘录里写下 hello from skfiy 并保存", client);
    expect(target).toEqual({
      kind: "resolved",
      route: {
        kind: "desktop",
        bundleId: "com.apple.Notes",
        appName: "备忘录",
        pid: 42
      }
    });
    await expect(resolveComputerUseDesktopTarget(
      "在 Safari 里点击工具栏按钮",
      client
    )).resolves.toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("Safari")
    });

    const planner: ComputerUseAgentPlanner = {
      async decide({ observation, history }) {
        const words = observation.ocrLabels.map((label) => label.text).join(" ");
        if (words.includes("Blank")) {
          return {
            kind: "type_text",
            risk: "local_mutation",
            text: "hello from skfiy",
            rationale: "The note body is empty."
          };
        }
        if (history.length === 1) {
          return {
            kind: "hotkey",
            risk: "local_mutation",
            key: "s",
            modifiers: ["command"],
            rationale: "Save the edited note."
          };
        }
        return {
          kind: "finish",
          risk: "read_only",
          summary: "The note contains the requested text and shows a saved state.",
          rationale: "The fresh observation verifies the goal."
        };
      }
    };
    const removed: string[] = [];
    const result = await runComputerUseAgentLoop({
      goal: "在备忘录里写下 hello from skfiy 并保存",
      route: target.kind === "resolved" ? target.route : neverTarget(),
      client,
      planner,
      createScreenshotPath: (step) => `/tmp/requested-${step}.png`,
      removeScreenshot: async (path) => { removed.push(path); }
    });

    expect(result).toMatchObject({
      status: "completed",
      actionCount: 2,
      observationCount: 3,
      sideEffectState: "occurred"
    });
    expect(executed).toEqual([
      { type: "type_text", text: "hello from skfiy" },
      { type: "hotkey", key: "s", modifiers: ["command"] }
    ]);
    expect(removed).toEqual([
      "/tmp/notes-1.png",
      "/tmp/notes-2.png",
      "/tmp/notes-3.png"
    ]);
  });

  it("blocks without mutation when the bound target changes before an action", async () => {
    let statusRead = 0;
    const executeAction = vi.fn(async () => ({ ok: true }));
    const client: ComputerUseAgentLoopClient = {
      listApps: vi.fn(async () => []),
      getDesktopSessionStatus: vi.fn(async () => {
        statusRead += 1;
        return statusRead === 1
          ? {
            controllable: true,
            frontmostBundleId: "com.apple.Notes",
            frontmostProcessIdentifier: 42
          }
          : {
            controllable: true,
            frontmostBundleId: "com.google.Chrome",
            frontmostProcessIdentifier: 10
          };
      }),
      getAppState: vi.fn(async () => createObservation("/tmp/notes.png", "Save")),
      ocrImage: vi.fn(async () => ({ labels: [] })),
      executeAction
    };

    const result = await runComputerUseAgentLoop({
      goal: "点击保存",
      route: {
        kind: "desktop",
        bundleId: "com.apple.Notes",
        appName: "Notes",
        pid: 42
      },
      client,
      planner: {
        async decide() {
          return {
            kind: "click",
            risk: "local_mutation",
            x: 300,
            y: 200,
            rationale: "Click Save."
          };
        }
      },
      createScreenshotPath: () => "/tmp/notes.png"
    });

    expect(result).toMatchObject({ status: "blocked", actionCount: 0 });
    expect(result.summary).toContain("target app changed");
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("refuses credential or external-side-effect planner decisions", async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    const client: ComputerUseAgentLoopClient = {
      listApps: vi.fn(async () => []),
      getDesktopSessionStatus: vi.fn(async () => ({
        controllable: true,
        frontmostBundleId: "com.apple.Notes",
        frontmostProcessIdentifier: 42
      })),
      getAppState: vi.fn(async () => createObservation("/tmp/notes.png", "Password")),
      ocrImage: vi.fn(async () => ({ labels: [] })),
      executeAction
    };

    const result = await runComputerUseAgentLoop({
      goal: "编辑当前文档",
      route: {
        kind: "desktop",
        bundleId: "com.apple.Notes",
        appName: "Notes",
        pid: 42
      },
      client,
      planner: {
        async decide() {
          return {
          kind: "type_text",
          risk: "credential",
          text: "secret",
          rationale: "Enter a password."
          };
        }
      },
      createScreenshotPath: () => "/tmp/notes.png"
    });

    expect(result).toMatchObject({ status: "blocked", actionCount: 0 });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("runs the visual planner in a read-only temporary workspace with a response schema", async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skfiy-loop-test-"));
    let invocation: { command: string; args: string[]; cwd: string } | undefined;
    const planner = await createCodexComputerUsePlanner({
      codexBinary: "/opt/bin/codex",
      timeoutMs: 5_000,
      tempRoot,
      runProcess: async (command, args, options) => {
        invocation = { command, args, cwd: options.cwd };
        const schemaPath = args[args.indexOf("--output-schema") + 1];
        const outputPath = args[args.indexOf("--output-last-message") + 1];
        const schema = JSON.parse(await fs.promises.readFile(schemaPath, "utf8")) as {
          additionalProperties?: boolean;
          required?: string[];
        };
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toContain("risk");
        await fs.promises.writeFile(outputPath, JSON.stringify({
          kind: "finish",
          risk: "read_only",
          rationale: "The screenshot visibly verifies the goal.",
          summary: "Verified."
        }));
        return { stdout: "", stderr: "" };
      }
    });

    try {
      await expect(planner.decide({
        goal: "Read the current note",
        route: {
          kind: "desktop",
          bundleId: "com.apple.Notes",
          appName: "Notes",
          pid: 42
        },
        observation: createObservation("/tmp/notes.png", "Verified"),
        history: [],
        step: 1,
        remainingSteps: 11
      })).resolves.toMatchObject({ kind: "finish", risk: "read_only" });
      expect(invocation?.command).toBe("/opt/bin/codex");
      expect(invocation?.args).toEqual(expect.arrayContaining([
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--image",
        "/tmp/notes.png",
        "--output-schema"
      ]));
      expect(invocation?.cwd.startsWith(tempRoot)).toBe(true);
    } finally {
      await planner.dispose();
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function neverTarget(): never {
  throw new Error("Expected target resolution to succeed.");
}
