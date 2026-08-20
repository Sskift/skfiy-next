import { lstat, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runFinderOrganizationTask } from "./finder-task";
import type { FinderPlanPreview } from "./finder-task";
import { formatFinderTaskResultSummary } from "./finder-task-result";
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

  it("organizes only directly selected Finder files after exact preview confirmation", async () => {
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
          targetPath: rootPath,
          selection: [
            {
              path: path.join(rootPath, "photo.png"),
              name: "photo.png",
              kind: "file" as const
            },
            {
              path: path.join(rootPath, "notes.pdf"),
              name: "notes.pdf",
              kind: "file" as const
            }
          ]
        };
      }
    };

    try {
      const previewEvents = await collectEvents(
        runFinderOrganizationTask("整理 Finder 选中项目", {
          approved: true,
          desktopClient,
          createScreenshotPath: () => "/tmp/skfiy-finder-before.png"
        })
      );
      const approvedPlanPreview = previewEvents.find((event) => event.type === "plan_preview")
        ?.preview as FinderPlanPreview | undefined;
      expect(approvedPlanPreview).toMatchObject({ operationCount: 4 });
      expect(JSON.stringify(approvedPlanPreview)).not.toContain("script.ts");

      const events = await collectEvents(
        runFinderOrganizationTask("整理 Finder 选中项目", {
          approved: true,
          planApproved: true,
          approvedPlanPreview,
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
        "completed"
      ]);
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
      await expect(readFile(path.join(rootPath, "Documents", "notes.pdf"), "utf8"))
        .resolves.toBe("document");
      await expect(readFile(path.join(rootPath, "script.ts"), "utf8"))
        .resolves.toBe("code");
      await expect(stat(path.join(rootPath, "Code"))).rejects.toThrow();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects selected Finder items when the selection changes after preview", async () => {
    const rootPath = await createFixture();
    let selectedNames = ["photo.png"];
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        return action.type === "observe_app"
          ? {
              bundleId: "com.apple.finder",
              isRunning: true,
              isActive: true,
              screenshotPath: action.screenshotOutputPath,
              frontmostBundleId: "com.apple.finder",
              accessibilityTrusted: true,
              windows: []
            }
          : { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          targetPath: rootPath,
          selection: selectedNames.map((name) => ({
            path: path.join(rootPath, name),
            name,
            kind: "file" as const
          }))
        };
      }
    };

    try {
      const previewEvents = await collectEvents(
        runFinderOrganizationTask("整理 Finder 选中项目", {
          approved: true,
          desktopClient
        })
      );
      const approvedPlanPreview = previewEvents.find((event) => event.type === "plan_preview")
        ?.preview as FinderPlanPreview | undefined;
      expect(approvedPlanPreview).toMatchObject({ operationCount: 2 });

      selectedNames = ["photo.png", "notes.pdf"];
      const events = await collectEvents(
        runFinderOrganizationTask("整理 Finder 选中项目", {
          approved: true,
          planApproved: true,
          approvedPlanPreview,
          desktopClient
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "verification_failed",
        stage: "selection",
        reason: "Finder approved plan no longer matches the current Finder target."
      });
      expect(await readdir(rootPath)).toEqual(["notes.pdf", "photo.png", "script.ts"]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("renames exactly one selected Finder file after preview confirmation", async () => {
    const rootPath = await createFixture();
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        return action.type === "observe_app"
          ? {
              bundleId: "com.apple.finder",
              isRunning: true,
              isActive: true,
              screenshotPath: action.screenshotOutputPath,
              frontmostBundleId: "com.apple.finder",
              accessibilityTrusted: true,
              windows: []
            }
          : { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          targetPath: rootPath,
          selection: [{
            path: path.join(rootPath, "photo.png"),
            name: "photo.png",
            kind: "file" as const
          }]
        };
      }
    };

    try {
      const command = "重命名 Finder 选中文件为 holiday-photo.png";
      const previewEvents = await collectEvents(runFinderOrganizationTask(command, {
        approved: true,
        desktopClient
      }));
      const approvedPlanPreview = previewEvents.find((event) => event.type === "plan_preview")
        ?.preview as FinderPlanPreview | undefined;
      expect(approvedPlanPreview).toMatchObject({
        operationCount: 1,
        moveFiles: [{
          from: path.join(rootPath, "photo.png"),
          to: path.join(rootPath, "holiday-photo.png")
        }]
      });

      const events = await collectEvents(runFinderOrganizationTask(command, {
        approved: true,
        planApproved: true,
        approvedPlanPreview,
        desktopClient
      }));

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "locating_app",
        "app_activated",
        "screenshot_before",
        "finder_selection_observed",
        "plan_preview",
        "action_verified",
        "completed"
      ]);
      await expect(readFile(path.join(rootPath, "holiday-photo.png"), "utf8"))
        .resolves.toBe("image");
      await expect(stat(path.join(rootPath, "photo.png"))).rejects.toThrow();
      await expect(readFile(path.join(rootPath, "notes.pdf"), "utf8"))
        .resolves.toBe("document");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("copies exactly one selected Finder file after preview confirmation", async () => {
    const rootPath = await createFixture();
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        return action.type === "observe_app"
          ? {
              bundleId: "com.apple.finder",
              isRunning: true,
              isActive: true,
              screenshotPath: action.screenshotOutputPath,
              frontmostBundleId: "com.apple.finder",
              accessibilityTrusted: true,
              windows: []
            }
          : { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          targetPath: rootPath,
          selection: [{
            path: path.join(rootPath, "photo.png"),
            name: "photo.png",
            kind: "file" as const
          }]
        };
      }
    };

    try {
      const command = "复制 Finder 选中文件为 holiday-photo.png";
      const previewEvents = await collectEvents(runFinderOrganizationTask(command, {
        approved: true,
        desktopClient
      }));
      const approvedPlanPreview = previewEvents.find((event) => event.type === "plan_preview")
        ?.preview as FinderPlanPreview | undefined;
      expect(approvedPlanPreview).toMatchObject({
        operationCount: 1,
        moveFiles: [],
        copyFiles: [{
          from: path.join(rootPath, "photo.png"),
          to: path.join(rootPath, "holiday-photo.png")
        }]
      });

      const events = await collectEvents(runFinderOrganizationTask(command, {
        approved: true,
        planApproved: true,
        approvedPlanPreview,
        desktopClient
      }));

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "locating_app",
        "app_activated",
        "screenshot_before",
        "finder_selection_observed",
        "plan_preview",
        "action_verified",
        "completed"
      ]);
      expect(events.find((event) => event.type === "action_verified")).toMatchObject({
        actionType: "copy_file"
      });
      await expect(readFile(path.join(rootPath, "holiday-photo.png"), "utf8"))
        .resolves.toBe("image");
      await expect(readFile(path.join(rootPath, "photo.png"), "utf8"))
        .resolves.toBe("image");
      const source = await lstat(path.join(rootPath, "photo.png"));
      const destination = await lstat(path.join(rootPath, "holiday-photo.png"));
      expect(destination.ino).not.toBe(source.ino);
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
        summary: "6 of 6 operations completed."
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

  it("stops at a destination collision under the default cancel policy and reports the failed item", async () => {
    const rootPath = await createFixture();

    try {
      await mkdir(path.join(rootPath, "Images"), { recursive: true });
      await writeFile(path.join(rootPath, "Images", "photo.png"), "existing");

      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, { approved: true })
      );

      expect(events.at(-1)).toMatchObject({
        type: "completed",
        summary: "3 of 6 operations completed, 1 failed.",
        result: {
          collisionPolicy: "cancel",
          totalOperationCount: 6,
          completedCount: 3,
          failedCount: 1,
          skippedCount: 0,
          destinationVerified: true,
          resultingNamesVerified: true,
          failedItems: [
            {
              operationType: "move_file",
              from: path.join(rootPath, "photo.png"),
              to: path.join(rootPath, "Images", "photo.png"),
              errorCode: "destination-exists",
              reason: expect.stringContaining("Destination already exists")
            }
          ]
        }
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("existing");
      await expect(readFile(path.join(rootPath, "photo.png"), "utf8"))
        .resolves.toBe("image");
      // Operations before the collision ran.
      await expect(readFile(path.join(rootPath, "Documents", "notes.pdf"), "utf8"))
        .resolves.toBe("document");
      // Operations after the collision are never attempted.
      await expect(stat(path.join(rootPath, "Code", "script.ts"))).rejects.toThrow();
      await expect(readFile(path.join(rootPath, "script.ts"), "utf8"))
        .resolves.toBe("code");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("reports partial success when one move fails mid-execution", async () => {
    const rootPath = await createFixture();

    try {
      const task = runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, { approved: true });

      const started = await task.next();
      expect(started.value).toMatchObject({ type: "started" });
      const preview = await task.next();
      expect(preview.value).toMatchObject({ type: "plan_preview" });
      const locating = await task.next();
      expect(locating.value).toMatchObject({ type: "locating_app" });
      const firstVerified = await task.next();
      expect(firstVerified.value).toMatchObject({ type: "action_verified" });

      // Delete a source that has not been moved yet (script.ts is the last operation).
      await rm(path.join(rootPath, "script.ts"), { force: true });

      const events: Array<Record<string, unknown>> = [];
      for await (const event of task) {
        events.push(event);
      }

      const completed = events.find((event) => event.type === "completed");
      expect(completed).toMatchObject({
        type: "completed",
        result: {
          totalOperationCount: 6,
          completedCount: 5,
          failedCount: 1,
          skippedCount: 0,
          destinationVerified: true,
          resultingNamesVerified: true,
          failedItems: [
            {
              operationType: "move_file",
              from: path.join(rootPath, "script.ts"),
              to: path.join(rootPath, "Code", "script.ts"),
              errorCode: "source-missing"
            }
          ]
        }
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
      await expect(readFile(path.join(rootPath, "Documents", "notes.pdf"), "utf8"))
        .resolves.toBe("document");
      await expect(stat(path.join(rootPath, "Code", "script.ts"))).rejects.toThrow();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("skips a colliding move under the skip collision policy and leaves the source in place", async () => {
    const rootPath = await createFixture();

    try {
      await mkdir(path.join(rootPath, "Images"), { recursive: true });
      await writeFile(path.join(rootPath, "Images", "photo.png"), "existing");

      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          collisionPolicy: "skip"
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "completed",
        summary: "5 of 6 operations completed, 1 skipped.",
        result: {
          collisionPolicy: "skip",
          totalOperationCount: 6,
          completedCount: 5,
          failedCount: 0,
          skippedCount: 1,
          destinationVerified: true,
          resultingNamesVerified: true,
          completedItems: expect.arrayContaining([
            expect.objectContaining({
              operationType: "move_file",
              from: path.join(rootPath, "photo.png"),
              to: path.join(rootPath, "Images", "photo.png"),
              resolution: "skip"
            })
          ])
        }
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("existing");
      await expect(readFile(path.join(rootPath, "photo.png"), "utf8"))
        .resolves.toBe("image");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("auto-renames a colliding move under the rename collision policy", async () => {
    const rootPath = await createFixture();

    try {
      await mkdir(path.join(rootPath, "Images"), { recursive: true });
      await writeFile(path.join(rootPath, "Images", "photo.png"), "existing");

      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          collisionPolicy: "rename"
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "completed",
        summary: "6 of 6 operations completed.",
        result: {
          collisionPolicy: "rename",
          totalOperationCount: 6,
          completedCount: 6,
          failedCount: 0,
          skippedCount: 0,
          destinationVerified: true,
          resultingNamesVerified: true,
          completedItems: expect.arrayContaining([
            expect.objectContaining({
              operationType: "move_file",
              from: path.join(rootPath, "photo.png"),
              to: path.join(rootPath, "Images", "photo (1).png"),
              resultingName: "photo (1).png",
              resolution: "rename"
            })
          ])
        }
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("existing");
      await expect(readFile(path.join(rootPath, "Images", "photo (1).png"), "utf8"))
        .resolves.toBe("image");
      await expect(stat(path.join(rootPath, "photo.png"))).rejects.toThrow();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("reports the full result structure with verification flags when all operations succeed", async () => {
    const rootPath = await createFixture();

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, { approved: true })
      );

      const completed = events.at(-1) as { type: string; summary: string; result: Record<string, unknown> };
      expect(completed.type).toBe("completed");
      expect(completed.summary).toBe("6 of 6 operations completed.");
      expect(completed.result).toMatchObject({
        schemaVersion: 1,
        rootPath,
        destinationPath: rootPath,
        collisionPolicy: "cancel",
        totalOperationCount: 6,
        completedCount: 6,
        failedCount: 0,
        skippedCount: 0,
        destinationVerified: true,
        resultingNamesVerified: true
      });
      expect(completed.summary).toBe(formatFinderTaskResultSummary(completed.result as never));
      expect(completed.result.completedItems).toHaveLength(6);
      expect(completed.result.failedItems).toHaveLength(0);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("emits operationId on action_verified events for per-operation correlation", async () => {
    const rootPath = await createFixture();

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, { approved: true })
      );

      const verified = events.filter((event) => event.type === "action_verified");
      expect(verified).toHaveLength(6);
      for (const event of verified) {
        expect(event.operationId).toEqual(expect.stringMatching(/^op-\d+$/));
      }

      const completed = events.at(-1) as { result: { completedItems: Array<{ operationId: string }> } };
      const verifiedIds = verified.map((event) => event.operationId);
      const completedIds = completed.result.completedItems.map((item) => item.operationId);
      expect(verifiedIds.sort()).toEqual(completedIds.sort());
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("maps a permission-denied filesystem error to the permission-denied error code", async () => {
    const rootPath = await createFixture();

    try {
      const task = runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, { approved: true });

      const started = await task.next();
      expect(started.value).toMatchObject({ type: "started" });
      await task.next(); // plan_preview
      await task.next(); // locating_app
      await task.next(); // action_verified: create Documents
      await task.next(); // action_verified: move notes.pdf
      await task.next(); // action_verified: create Images

      // Make the Images folder read-only so the photo.png move is denied.
      await chmod(path.join(rootPath, "Images"), 0o555);

      const events: Array<Record<string, unknown>> = [];
      for await (const event of task) {
        events.push(event);
      }

      const completed = events.find((event) => event.type === "completed");
      expect(completed).toMatchObject({
        result: {
          completedCount: 5,
          failedCount: 1,
          failedItems: [
            expect.objectContaining({
              operationType: "move_file",
              from: path.join(rootPath, "photo.png"),
              errorCode: "permission-denied"
            })
          ]
        }
      });
    } finally {
      await chmod(path.join(rootPath, "Images"), 0o755).catch(() => undefined);
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("uses the injected file client and maps atomic move states to error codes", async () => {
    const rootPath = await createFixture();
    const atomicMoveFileNoReplace = vi.fn(async (request: { sourcePath: string; destinationPath: string }) => {
      await rename(request.sourcePath, request.destinationPath);
      return { state: "moved" as const };
    });
    const atomicCopyFileNoReplace = vi.fn(async () => ({ state: "copied" as const }));

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          fileClient: { atomicMoveFileNoReplace, atomicCopyFileNoReplace }
        })
      );

      expect(atomicMoveFileNoReplace).toHaveBeenCalledTimes(3);
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        result: {
          completedCount: 6,
          failedCount: 0,
          destinationVerified: true,
          resultingNamesVerified: true
        }
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("maps an atomic source-changed state to the source-changed error code", async () => {
    const rootPath = await createFixture();
    const fileClient = {
      async atomicMoveFileNoReplace() {
        return { state: "source-changed" as const };
      },
      async atomicCopyFileNoReplace() {
        return { state: "copied" as const };
      }
    };

    try {
      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          fileClient: fileClient
        })
      );

      const completed = events.at(-1) as { result: Record<string, unknown> };
      expect(completed.result).toMatchObject({
        completedCount: 3,
        failedCount: 3,
        failedItems: expect.arrayContaining([
          expect.objectContaining({ errorCode: "source-changed" })
        ])
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("treats the replace policy as cancel when the plan was not approved", async () => {
    const rootPath = await createFixture();

    try {
      await mkdir(path.join(rootPath, "Images"), { recursive: true });
      await writeFile(path.join(rootPath, "Images", "photo.png"), "existing");

      const events = await collectEvents(
        runFinderOrganizationTask(`整理 Finder 测试文件夹 ${rootPath}`, {
          approved: true,
          collisionPolicy: "replace"
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "completed",
        result: {
          completedCount: 3,
          failedCount: 1,
          failedItems: [
            expect.objectContaining({
              errorCode: "destination-exists"
            })
          ]
        }
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("existing");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("overwrites a colliding destination under the replace policy with plan approval", async () => {
    const rootPath = await createFixture();
    const desktopClient = {
      async executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult> {
        return action.type === "observe_app"
          ? {
              bundleId: "com.apple.finder",
              isRunning: true,
              isActive: true,
              screenshotPath: action.screenshotOutputPath,
              frontmostBundleId: "com.apple.finder",
              accessibilityTrusted: true,
              windows: []
            }
          : { ok: true };
      },
      async getFinderSelection() {
        return {
          source: "finder-applescript" as const,
          targetPath: rootPath,
          selection: [{
            path: path.join(rootPath, "photo.png"),
            name: "photo.png",
            kind: "file" as const
          }]
        };
      }
    };

    try {
      await mkdir(path.join(rootPath, "Images"), { recursive: true });
      await writeFile(path.join(rootPath, "Images", "photo.png"), "existing");

      const previewEvents = await collectEvents(
        runFinderOrganizationTask("整理 Finder 选中项目", {
          approved: true,
          desktopClient
        })
      );
      const approvedPlanPreview = previewEvents.find((event) => event.type === "plan_preview")
        ?.preview as FinderPlanPreview | undefined;

      const events = await collectEvents(
        runFinderOrganizationTask("整理 Finder 选中项目", {
          approved: true,
          planApproved: true,
          approvedPlanPreview,
          desktopClient,
          collisionPolicy: "replace"
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "completed",
        result: {
          collisionPolicy: "replace",
          completedCount: 2,
          failedCount: 0,
          completedItems: expect.arrayContaining([
            expect.objectContaining({
              operationType: "move_file",
              resolution: "replace",
              resultingName: "photo.png"
            })
          ])
        }
      });
      await expect(readFile(path.join(rootPath, "Images", "photo.png"), "utf8"))
        .resolves.toBe("image");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
