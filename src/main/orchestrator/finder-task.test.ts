import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runFinderOrganizationTask } from "./finder-task";
import type {
  DesktopActionResult,
  DesktopExecutableAction,
  DesktopSessionStatus
} from "../computer-use/types";

async function collectEvents(task: AsyncGenerator<{ type: string }>) {
  const events: Array<Record<string, unknown>> = [];

  for await (const event of task) {
    events.push(event);
  }

  return events;
}

async function createFixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "skfiy-finder-task-"));
  await writeFile(path.join(rootPath, "photo.png"), "image");
  await writeFile(path.join(rootPath, "notes.pdf"), "document");
  await writeFile(path.join(rootPath, "script.ts"), "code");

  return rootPath;
}

describe("runFinderOrganizationTask", () => {
  it("requires approval before reading the selected Finder folder", async () => {
    const events = await collectEvents(
      runFinderOrganizationTask("整理 Finder 选中文件夹")
    );

    expect(events).toEqual([
      {
        type: "started",
        command: "Finder selected folder",
        risk: expect.objectContaining({
          level: "medium",
          requiresApproval: true
        })
      },
      {
        type: "approval_required",
        command: "Finder selected folder",
        risk: expect.objectContaining({
          level: "medium",
          requiresApproval: true
        })
      }
    ]);
  });

  it("requires approval before reading the current Finder folder", async () => {
    const events = await collectEvents(
      runFinderOrganizationTask("整理 Finder 当前文件夹")
    );

    expect(events).toEqual([
      {
        type: "started",
        command: "Finder current folder",
        risk: expect.objectContaining({
          level: "medium",
          requiresApproval: true
        })
      },
      {
        type: "approval_required",
        command: "Finder current folder",
        risk: expect.objectContaining({
          level: "medium",
          requiresApproval: true
        })
      }
    ]);
  });

  it("requires approval before organizing files", async () => {
    const rootPath = await createFixture();

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`)
      );

      expect(events.map((event) => event.type)).toEqual(["started", "approval_required"]);
      expect(await readdir(rootPath)).toEqual(["notes.pdf", "photo.png", "script.ts"]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("previews the Finder organization plan before filesystem changes after approval", async () => {
    const rootPath = await createFixture();

    try {
      const task = runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, { approved: true });

      expect(await task.next()).toMatchObject({
        value: { type: "started" },
        done: false
      });

      const preview = await task.next();
      expect(preview).toMatchObject({
        value: {
          type: "plan_preview",
          preview: {
            rootPath,
            operationCount: 6,
            destructiveOperationCount: 0,
            createFolders: expect.arrayContaining([
              path.join(rootPath, "Images"),
              path.join(rootPath, "Documents"),
              path.join(rootPath, "Code")
            ]),
            moveFiles: expect.arrayContaining([
              {
                from: path.join(rootPath, "photo.png"),
                to: path.join(rootPath, "Images", "photo.png")
              },
              {
                from: path.join(rootPath, "notes.pdf"),
                to: path.join(rootPath, "Documents", "notes.pdf")
              },
              {
                from: path.join(rootPath, "script.ts"),
                to: path.join(rootPath, "Code", "script.ts")
              }
            ])
          }
        },
        done: false
      });
      expect(await readdir(rootPath)).toEqual(["notes.pdf", "photo.png", "script.ts"]);

      for await (const _event of task) {
        // Drain the task after proving preview happens before mutation.
      }
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("requires a second confirmation after preview before changing the current Finder folder", async () => {
    const rootPath = await createFixture();
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: path.basename(rootPath),
                layer: 0,
                bounds: { x: 10, y: 20, width: 640, height: 480 }
              }
            ]
          };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: rootPath,
          selection: []
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask("整理 Finder 当前文件夹", {
          approved: true,
          desktopClient,
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "locating_app",
        "app_activated",
        "screenshot_before",
        "finder_selection_observed",
        "plan_preview",
        "plan_confirmation_required"
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "plan_confirmation_required",
        command: "Finder current folder",
        reason: "Finder current-folder organization needs confirmation after plan preview."
      });
      expect(await readdir(rootPath)).toEqual(["notes.pdf", "photo.png", "script.ts"]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("organizes a test folder after approval without deleting files", async () => {
    const rootPath = await createFixture();

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, { approved: true })
      );

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "plan_preview",
        "locating_app",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "completed"
      ]);
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
      await expect(readFile(path.join(rootPath, "Documents", "notes.pdf"), "utf8"))
        .resolves.toBe("document");
      await expect(readFile(path.join(rootPath, "Code", "script.ts"), "utf8"))
        .resolves.toBe("code");
      await expect(stat(path.join(rootPath, "photo.png"))).rejects.toThrow();
      await expect(stat(path.join(rootPath, "notes.pdf"))).rejects.toThrow();
      await expect(stat(path.join(rootPath, "script.ts"))).rejects.toThrow();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("blocks before activating Finder when the desktop session is locked", async () => {
    const rootPath = await createFixture();
    const executeAction = vi.fn(async (_action: DesktopExecutableAction): Promise<DesktopActionResult> => ({
      ok: true
    }));
    const getDesktopSessionStatus = vi.fn(async (): Promise<DesktopSessionStatus> => ({
      controllable: false,
      frontmostBundleId: "com.apple.loginwindow",
      frontmostLocalizedName: "loginwindow",
      frontmostProcessIdentifier: 591,
      mainDisplayAsleep: true
    }));

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          desktopClient: {
            executeAction,
            getDesktopSessionStatus
          },
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "plan_preview",
        "locating_app",
        "verification_failed"
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "verification_failed",
        stage: "desktop_session",
        reason: "Main display is asleep and desktop session is locked by loginwindow (pid 591). Wake and unlock the Mac, then retry."
      });
      expect(executeAction).not.toHaveBeenCalled();
      expect(await readdir(rootPath)).toEqual(["notes.pdf", "photo.png", "script.ts"]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("organizes one selected Finder folder from semantic selection", async () => {
    const rootPath = await createFixture();
    const parentPath = path.dirname(rootPath);
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: path.basename(parentPath),
                layer: 0,
                bounds: { x: 10, y: 20, width: 640, height: 480 }
              }
            ]
          };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: parentPath,
          selection: [
            {
              path: rootPath,
              name: path.basename(rootPath),
              kind: "directory" as const
            }
          ]
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask("整理 Finder 选中文件夹", {
          approved: true,
          planApproved: true,
          desktopClient,
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "locating_app",
        "app_activated",
        "screenshot_before",
        "finder_selection_observed",
        "plan_preview",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "completed"
      ]);
      expect(events.find((event) => event.type === "finder_selection_observed")).toMatchObject({
        type: "finder_selection_observed",
        context: {
          targetPath: parentPath,
          selection: [
            {
              path: rootPath,
              kind: "directory"
            }
          ]
        }
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
      await expect(readFile(path.join(rootPath, "Documents", "notes.pdf"), "utf8"))
        .resolves.toBe("document");
      await expect(readFile(path.join(rootPath, "Code", "script.ts"), "utf8"))
        .resolves.toBe("code");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("fails closed when selected Finder folder grounding has zero or multiple folders", async () => {
    const rootPath = await createFixture();
    const otherPath = await mkdtemp(path.join(os.tmpdir(), "skfiy-finder-other-"));
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: []
          };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: path.dirname(rootPath),
          selection: [
            {
              path: rootPath,
              name: path.basename(rootPath),
              kind: "directory" as const
            },
            {
              path: otherPath,
              name: path.basename(otherPath),
              kind: "directory" as const
            }
          ]
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask("整理 Finder 选中文件夹", {
          approved: true,
          desktopClient
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "verification_failed",
        stage: "selection",
        reason: "Finder selected-folder organization needs exactly one selected folder."
      });
      expect(await readdir(rootPath)).toEqual(["notes.pdf", "photo.png", "script.ts"]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
      await rm(otherPath, { recursive: true, force: true });
    }
  });

  it("organizes the current Finder folder from semantic Finder context", async () => {
    const rootPath = await createFixture();
    const actions: DesktopExecutableAction[] = [];
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        actions.push(action);

        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: path.basename(rootPath),
                layer: 0,
                bounds: { x: 10, y: 20, width: 640, height: 480 }
              }
            ]
          };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: rootPath,
          selection: []
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask("整理 Finder 当前文件夹", {
          approved: true,
          planApproved: true,
          desktopClient,
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );

      expect(actions.slice(0, 2)).toEqual([
        { type: "activate_app", bundleId: "com.apple.finder" },
        {
          type: "observe_app",
          bundleId: "com.apple.finder",
          screenshotOutputPath: "/tmp/skfiy-finder-before.png"
        }
      ]);
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "locating_app",
        "app_activated",
        "screenshot_before",
        "finder_selection_observed",
        "plan_preview",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "completed"
      ]);
      expect(events.find((event) => event.type === "finder_selection_observed")).toMatchObject({
        type: "finder_selection_observed",
        context: {
          targetPath: rootPath,
          selection: []
        }
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
      await expect(readFile(path.join(rootPath, "Documents", "notes.pdf"), "utf8"))
        .resolves.toBe("document");
      await expect(readFile(path.join(rootPath, "Code", "script.ts"), "utf8"))
        .resolves.toBe("code");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("does not execute a current-folder plan when the approved preview root changes before resume", async () => {
    const approvedRoot = await createFixture();
    const shiftedRoot = await createFixture();
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: path.basename(shiftedRoot),
                layer: 0,
                bounds: { x: 10, y: 20, width: 640, height: 480 }
              }
            ]
          };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: shiftedRoot,
          selection: []
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask("整理 Finder 当前文件夹", {
          approved: true,
          planApproved: true,
          desktopClient,
          approvedPlanPreview: {
            rootPath: approvedRoot,
            operationCount: 6,
            destructiveOperationCount: 0,
            createFolders: [
              path.join(approvedRoot, "Documents"),
              path.join(approvedRoot, "Images"),
              path.join(approvedRoot, "Code")
            ],
            moveFiles: [
              {
                from: path.join(approvedRoot, "notes.pdf"),
                to: path.join(approvedRoot, "Documents", "notes.pdf")
              },
              {
                from: path.join(approvedRoot, "photo.png"),
                to: path.join(approvedRoot, "Images", "photo.png")
              },
              {
                from: path.join(approvedRoot, "script.ts"),
                to: path.join(approvedRoot, "Code", "script.ts")
              }
            ]
          }
        } as Parameters<typeof runFinderOrganizationTask>[1] & {
          approvedPlanPreview: unknown;
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "verification_failed",
        stage: "selection",
        reason: "Finder approved plan no longer matches the current Finder target."
      });
      expect(await readdir(shiftedRoot)).toEqual(["notes.pdf", "photo.png", "script.ts"]);
    } finally {
      await rm(approvedRoot, { recursive: true, force: true });
      await rm(shiftedRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the current Finder folder cannot be grounded semantically", async () => {
    const rootPath = await createFixture();
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: []
          };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          selection: []
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask("整理 Finder 当前文件夹", {
          approved: true,
          desktopClient
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "verification_failed",
        stage: "selection",
        reason: "Finder current-folder organization needs a Finder window target path or one selected folder."
      });
      expect(await readdir(rootPath)).toEqual(["notes.pdf", "photo.png", "script.ts"]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("activates and observes Finder before moving files when a desktop client is available", async () => {
    const rootPath = await createFixture();
    const actions: DesktopExecutableAction[] = [];
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        actions.push(action);

        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: "skfiy-finder-smoke",
                layer: 0,
                bounds: { x: 10, y: 20, width: 640, height: 480 }
              }
            ]
          };
        }

        return { ok: true };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          desktopClient,
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );

      expect(actions.slice(0, 2)).toEqual([
        { type: "activate_app", bundleId: "com.apple.finder" },
        {
          type: "observe_app",
          bundleId: "com.apple.finder",
          screenshotOutputPath: "/tmp/skfiy-finder-before.png"
        }
      ]);
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "plan_preview",
        "locating_app",
        "app_activated",
        "screenshot_before",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "completed"
      ]);
      expect(events.find((event) => event.type === "screenshot_before")).toMatchObject({
        type: "screenshot_before",
        path: "/tmp/skfiy-finder-before.png",
        observation: {
          bundleId: "com.apple.finder",
          frontmostBundleId: "com.apple.finder",
          accessibilityTrusted: true
        }
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("performs a Finder drag probe through the desktop client before filesystem organization", async () => {
    const rootPath = await createFixture();
    const actions: DesktopExecutableAction[] = [];
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        actions.push(action);

        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: path.basename(rootPath),
                layer: 0,
                bounds: { x: 100, y: 120, width: 640, height: 480 }
              }
            ]
          };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: rootPath,
          selection: []
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`探测 Finder 拖拽测试文件夹 ${rootPath}`, {
          approved: true,
          desktopClient,
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );

      expect(actions.slice(0, 3)).toEqual([
        { type: "activate_app", bundleId: "com.apple.finder" },
        {
          type: "observe_app",
          bundleId: "com.apple.finder",
          screenshotOutputPath: "/tmp/skfiy-finder-before.png"
        },
        {
          type: "drag",
          from: { x: 260, y: 360 },
          to: { x: 580, y: 360 },
          durationMs: 300
        }
      ]);
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "plan_preview",
        "locating_app",
        "app_activated",
        "screenshot_before",
        "finder_selection_observed",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "action_verified",
        "completed"
      ]);
      expect(events.find((event) => (
        event.type === "action_verified"
        && "actionType" in event
        && event.actionType === "drag"
      ))).toMatchObject({
        type: "action_verified",
        actionType: "drag",
        status: "passed",
        message: "Finder drag probe from 260,360 to 580,360 over 300ms."
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("performs a Finder item drag/drop and verifies the file moved before organizing the rest", async () => {
    const rootPath = await createFixture();
    const actions: DesktopExecutableAction[] = [];
    const layoutRequests: Array<{ folderPath: string; itemNames: readonly string[] }> = [];
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        actions.push(action);

        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: path.basename(rootPath),
                layer: 0,
                bounds: { x: 100, y: 120, width: 640, height: 480 }
              }
            ]
          };
        }

        if (action.type === "drag") {
          await rename(path.join(rootPath, "photo.png"), path.join(rootPath, "Images", "photo.png"));
          return { ok: true };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: rootPath,
          selection: []
        };
      },
      async getFinderItemLayout(folderPath: string, itemNames: readonly string[]) {
        layoutRequests.push({ folderPath, itemNames: [...itemNames] });
        await expect(stat(path.join(rootPath, "Images"))).resolves.toMatchObject({
          isDirectory: expect.any(Function)
        });

        return {
          source: "finder-applescript-layout" as const,
          frontmostBundleId: "com.apple.finder",
          folderPath,
          items: [
            {
              path: path.join(rootPath, "photo.png"),
              name: "photo.png",
              kind: "file" as const,
              center: { x: 160, y: 220 },
              bounds: { x: 128, y: 188, width: 64, height: 64 }
            },
            {
              path: path.join(rootPath, "Images"),
              name: "Images",
              kind: "directory" as const,
              center: { x: 360, y: 220 },
              bounds: { x: 328, y: 188, width: 64, height: 64 }
            }
          ]
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`拖放 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          desktopClient,
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );

      expect(layoutRequests).toEqual([
        { folderPath: rootPath, itemNames: ["photo.png", "Images"] }
      ]);
      expect(actions).toContainEqual({
        type: "drag",
        from: { x: 160, y: 220 },
        to: { x: 360, y: 220 },
        durationMs: 300
      });
      expect(events).toContainEqual({
        type: "action_verified",
        actionType: "item_drag_drop",
        status: "passed",
        message: `Dragged Finder item: ${path.join(rootPath, "photo.png")} -> ${path.join(rootPath, "Images", "photo.png")}`
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
      await expect(readFile(path.join(rootPath, "Documents", "notes.pdf"), "utf8"))
        .resolves.toBe("document");
      await expect(readFile(path.join(rootPath, "Code", "script.ts"), "utf8"))
        .resolves.toBe("code");
      await expect(stat(path.join(rootPath, "photo.png"))).rejects.toThrow();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("fails closed without organizing files when Finder item layout is blocked", async () => {
    const rootPath = await createFixture();
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: path.basename(rootPath),
                layer: 0,
                bounds: { x: 100, y: 120, width: 640, height: 480 }
              }
            ]
          };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: rootPath,
          selection: []
        };
      },
      async getFinderItemLayout() {
        throw new Error("Automation permission is required to read Finder item layout.");
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`拖放 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          desktopClient,
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );

      expect(events).toContainEqual({
        type: "verification_failed",
        stage: "layout",
        reason: "Automation permission is required to read Finder item layout."
      });
      expect(events.map((event) => event.type)).not.toContain("completed");
      expect(events).not.toContainEqual(expect.objectContaining({
        type: "action_verified",
        actionType: "move_file"
      }));
      expect(await readdir(rootPath)).toEqual(["notes.pdf", "photo.png", "script.ts"]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("records a permission-blocked Finder drag probe without skipping safe organization", async () => {
    const rootPath = await createFixture();
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: path.basename(rootPath),
                layer: 0,
                bounds: { x: 100, y: 120, width: 640, height: 480 }
              }
            ]
          };
        }

        if (action.type === "drag") {
          return { ok: false, message: "Accessibility permission is required for skfiy." };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: rootPath,
          selection: []
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`探测 Finder 拖拽测试文件夹 ${rootPath}`, {
          approved: true,
          desktopClient
        })
      );

      expect(events).toContainEqual({
        type: "verification_failed",
        stage: "drag",
        reason: "Accessibility permission is required for skfiy."
      });
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        summary: "Finder test folder organized."
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("emits Finder semantic selection context when the desktop client can read it", async () => {
    const rootPath = await createFixture();
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        if (action.type === "observe_app") {
          return {
            bundleId: "com.apple.finder",
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: [
              {
                title: "skfiy-finder-smoke",
                layer: 0,
                bounds: { x: 10, y: 20, width: 640, height: 480 }
              }
            ]
          };
        }

        return { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          frontmostBundleId: "com.apple.finder",
          targetPath: rootPath,
          selection: [
            {
              path: path.join(rootPath, "photo.png"),
              name: "photo.png",
              kind: "file" as const
            }
          ]
        };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          desktopClient,
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );

      expect(events.find((event) => event.type === "finder_selection_observed")).toMatchObject({
        type: "finder_selection_observed",
        context: {
          source: "finder-applescript",
          frontmostBundleId: "com.apple.finder",
          targetPath: rootPath,
          selection: [
            {
              name: "photo.png",
              kind: "file"
            }
          ]
        }
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("fails closed instead of overwriting an existing destination file", async () => {
    const rootPath = await createFixture();

    try {
      await mkdir(path.join(rootPath, "Images"), { recursive: true });
      await writeFile(path.join(rootPath, "Images", "photo.png"), "existing");

      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, { approved: true })
      );

      expect(events.at(-1)).toMatchObject({
        type: "verification_failed",
        stage: "file_operation",
        reason: expect.stringContaining("Destination already exists")
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("existing");
      await expect(readFile(path.join(rootPath, "photo.png"), "utf8"))
        .resolves.toBe("image");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
