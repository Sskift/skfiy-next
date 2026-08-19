import { describe, expect, it, vi } from "vitest";
import type {
  DesktopActionResult,
  DesktopExecutableAction,
  DesktopSessionStatus,
  PermissionSummary
} from "../computer-use/types";
import { runGhosttyCommandTask, type DesktopClient } from "./ghostty-task";

async function collectEvents(
  task: AsyncGenerator<{ type: string }>
): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];

  for await (const event of task) {
    events.push(event);
  }

  return events;
}

function createDesktopClient(): DesktopClient & {
  executeAction: ReturnType<typeof vi.fn>;
  getDesktopSessionStatus: ReturnType<typeof vi.fn<() => Promise<DesktopSessionStatus>>>;
  getPermissions: ReturnType<typeof vi.fn<() => Promise<PermissionSummary>>>;
  ocrImage: ReturnType<typeof vi.fn>;
} {
  const client: DesktopClient & {
    executeAction: ReturnType<typeof vi.fn>;
    getDesktopSessionStatus: ReturnType<typeof vi.fn<() => Promise<DesktopSessionStatus>>>;
    getPermissions: ReturnType<typeof vi.fn<() => Promise<PermissionSummary>>>;
    ocrImage: ReturnType<typeof vi.fn>;
  } = {
    listApps: vi.fn(async () => [
      { name: "Ghostty", bundleId: "com.mitchellh.ghostty" }
    ]),
    getPermissions: vi.fn(async () => ({
      screenRecording: { state: "granted" },
      accessibility: { state: "granted" },
    })),
    getDesktopSessionStatus: vi.fn(async () => ({
      controllable: true,
      frontmostBundleId: "com.mitchellh.ghostty",
      frontmostLocalizedName: "Ghostty",
      frontmostProcessIdentifier: 54502,
      mainDisplayAsleep: false
    })),
    ocrImage: vi.fn(async (inputPath: string) => ({
      labels: inputPath.includes("after")
        ? [{
            text: readLatestCompletionMarker(client.executeAction.mock.calls) ?? "SKFIY_DONE_A",
            confidence: 0.93,
            bounds: { x: 36, y: 420, width: 180, height: 18 }
          }]
        : inputPath.includes("before")
          ? [{
              text: "SKFIY_READY",
              confidence: 0.92,
              bounds: { x: 36, y: 120, width: 120, height: 18 }
            }]
        : []
    })),
    executeAction: vi.fn(async (action: DesktopExecutableAction): Promise<DesktopActionResult> => {
      switch (action.type) {
        case "open_ghostty_session":
          return {
            bundleId: "com.mitchellh.ghostty",
            title: "skfiy-shell",
            pid: 54502,
            opened: true
          };
        case "activate_app":
        case "type_text":
        case "press_key":
        case "hotkey":
        case "scroll":
        case "drag":
          return { ok: true };
        case "observe_app":
          return {
            bundleId: action.bundleId,
            pid: action.pid,
            isRunning: true,
            isActive: true,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.mitchellh.ghostty",
            accessibilityTrusted: true,
            windows: [
              {
                title: "skfiy-shell",
                layer: 0,
                bounds: { x: 10, y: 20, width: 640, height: 480 }
              }
            ]
          };
        case "screenshot":
          return { outputPath: action.outputPath };
        case "click":
          return { ok: true };
      }
    })
  };

  return client;
}

function createScreenshotPath(stage: "before" | "after"): string {
  return stage === "before" ? "/tmp/before.png" : "/tmp/after.png";
}

function readLatestCompletionMarker(calls: unknown[][]): string | undefined {
  const typedTexts = calls
    .map(([action]) => action as DesktopExecutableAction | undefined)
    .filter((action): action is Extract<DesktopExecutableAction, { type: "type_text" }> =>
      action?.type === "type_text"
    )
    .map((action) => action.text)
    .reverse();

  for (const text of typedTexts) {
    const match = text.match(/SKFIY DONE %s STATUS %s\\nSKFIY DONE %s STATUS %s\\n' '([A-Z]+)'/);
    if (match) {
      return `SKFIY_DONE_${match[1]}`;
    }
  }

  return undefined;
}

describe("runGhosttyCommandTask", () => {
  it("runs a low-risk command in Ghostty and emits task progress events", async () => {
    const client = createDesktopClient();

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "session_initialized",
      "screenshot_before",
      "action_verified",
      "typing",
      "action_verified",
      "submitted",
      "screenshot_after",
      "completed"
    ]);
    expect(events.find((event) => event.type === "session_initialized")).toMatchObject({
      type: "session_initialized",
      title: "skfiy-shell",
      marker: "skfiy"
    });
    expect(events.find((event) => event.type === "screenshot_before")).toMatchObject({
      type: "screenshot_before",
      path: "/tmp/before.png",
      observation: {
        screenshotPath: "/tmp/before.png",
        pid: 54502,
        frontmostBundleId: "com.mitchellh.ghostty",
        accessibilityTrusted: true,
        windows: [
          {
            title: "skfiy-shell",
            layer: 0,
            bounds: { x: 10, y: 20, width: 640, height: 480 }
          }
        ]
      }
    });
    expect(events.find((event) => event.type === "screenshot_after")).toMatchObject({
      type: "screenshot_after",
      path: "/tmp/after.png",
      observation: {
        screenshotPath: "/tmp/after.png",
        accessibilityTrusted: true
      }
    });
    expect(client.listApps).not.toHaveBeenCalled();
    expect(client.executeAction).toHaveBeenNthCalledWith(1, {
      type: "open_ghostty_session",
      title: "skfiy-shell"
    });
    expect(client.executeAction).toHaveBeenNthCalledWith(2, {
      type: "activate_app",
      bundleId: "com.mitchellh.ghostty",
      pid: 54502
    });
    expect(client.executeAction).toHaveBeenNthCalledWith(3, {
      type: "type_text",
      text: expect.stringContaining("skfiy-shell")
    });
    expect(client.executeAction).toHaveBeenNthCalledWith(4, {
      type: "press_key",
      key: "enter"
    });
    expect(client.executeAction).toHaveBeenNthCalledWith(5, {
      type: "observe_app",
      bundleId: "com.mitchellh.ghostty",
      pid: 54502,
      screenshotOutputPath: "/tmp/before.png"
    });
    expect(client.executeAction).toHaveBeenNthCalledWith(6, {
      type: "type_text",
      text: expect.stringMatching(
        /^pwd; __skfiy_status="\$\?"; printf '\\nSKFIY DONE %s STATUS %s\\nSKFIY DONE %s STATUS %s\\n' '[A-Z]+' "\$__skfiy_status" '[A-Z]+' "\$__skfiy_status"$/
      )
    });
    expect(client.executeAction).toHaveBeenNthCalledWith(7, {
      type: "press_key",
      key: "enter"
    });
    expect(client.executeAction).toHaveBeenNthCalledWith(8, {
      type: "observe_app",
      bundleId: "com.mitchellh.ghostty",
      pid: 54502,
      screenshotOutputPath: "/tmp/after.png"
    });
  });

  it("blocks before opening Ghostty when the desktop session is locked", async () => {
    const client = createDesktopClient();
    client.getDesktopSessionStatus.mockResolvedValue({
      controllable: false,
      frontmostBundleId: "com.apple.loginwindow",
      frontmostLocalizedName: "loginwindow",
      frontmostProcessIdentifier: 591,
      mainDisplayAsleep: true
    });

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "started",
        command: "pwd"
      }),
      {
        type: "verification_failed",
        stage: "desktop_session",
        reason: "Main display is asleep and desktop session is locked by loginwindow (pid 591). Wake and unlock the Mac, then retry."
      }
    ]);
    expect(client.executeAction).not.toHaveBeenCalled();
  });

  it("adds OCR labels to screenshot observations without turning OCR into a desktop action", async () => {
    const client = createDesktopClient();
    client.ocrImage.mockImplementation(async (inputPath: string) => ({
      labels: inputPath.includes("after")
        ? [{
            text: readLatestCompletionMarker(client.executeAction.mock.calls) ?? "SKFIY_DONE_A",
            confidence: 0.93,
            bounds: { x: 36, y: 420, width: 180, height: 18 }
          }]
        : [
            {
              text: "SKFIY_READY",
              confidence: 0.92,
              bounds: { x: 36, y: 120, width: 120, height: 18 }
            },
            {
              text: "pwd",
              confidence: 0.88,
              bounds: { x: 36, y: 88, width: 42, height: 18 }
            }
          ]
    }));

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events.find((event) => event.type === "screenshot_before")).toMatchObject({
      observation: {
        ocrLabels: [
          {
            text: "SKFIY_READY",
            confidence: 0.92,
            bounds: { x: 36, y: 120, width: 120, height: 18 }
          },
          {
            text: "pwd",
            confidence: 0.88,
            bounds: { x: 36, y: 88, width: 42, height: 18 }
          }
        ]
      }
    });
    expect(client.ocrImage).toHaveBeenCalledWith("/tmp/before.png");
    expect(client.ocrImage).toHaveBeenCalledWith("/tmp/after.png");
    expect(client.executeAction).not.toHaveBeenCalledWith({
      type: "ocr_image",
      inputPath: "/tmp/before.png"
    });
  });

  it("emits structured action verification events for helper-accepted typing and submit actions", async () => {
    const client = createDesktopClient();

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events).toEqual(expect.arrayContaining([
      {
        type: "action_verified",
        actionType: "type_text",
        status: "passed",
        message: "type_text helper result accepted."
      },
      {
        type: "action_verified",
        actionType: "press_key",
        status: "passed",
        message: "press_key helper result accepted."
      }
    ]));
    expect(events.findIndex((event) => event.type === "action_verified")).toBeGreaterThan(
      events.findIndex((event) => event.type === "screenshot_before")
    );
  });

  it("initializes the skfiy shell marker before observing or typing the user command", async () => {
    const client = createDesktopClient();

    await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));

    const actions = client.executeAction.mock.calls.map(([action]) => action);
    const initIndex = actions.findIndex(
      (action) => action.type === "type_text" && action.text.includes("SKFIY_SESSION=1")
    );
    const beforeObserveIndex = actions.findIndex(
      (action) => action.type === "observe_app" && action.screenshotOutputPath === "/tmp/before.png"
    );
    const userTypeIndex = actions.findIndex(
      (action) => action.type === "type_text" && action.text.startsWith("pwd; __skfiy_status=")
    );

    expect(initIndex).toBeGreaterThan(-1);
    expect(beforeObserveIndex).toBeGreaterThan(initIndex);
    expect(userTypeIndex).toBeGreaterThan(beforeObserveIndex);
  });

  it("waits after pasting the shell initialization command before pressing enter", async () => {
    const client = createDesktopClient();
    const originalExecuteAction = client.executeAction.getMockImplementation() as
      | ((action: DesktopExecutableAction) => Promise<DesktopActionResult>)
      | undefined;
    const actionTimes: Array<{ action: DesktopExecutableAction; timestamp: number }> = [];

    client.executeAction.mockImplementation(async (action: DesktopExecutableAction) => {
      actionTimes.push({ action, timestamp: Date.now() });
      if (!originalExecuteAction) {
        throw new Error("Missing executeAction test implementation.");
      }

      return originalExecuteAction(action);
    });

    await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));

    const initType = actionTimes.find(
      ({ action }) => action.type === "type_text" && action.text.includes("SKFIY_SESSION=1")
    );
    const initEnter = actionTimes.find(
      ({ action, timestamp }) =>
        action.type === "press_key" && action.key === "enter" && timestamp >= (initType?.timestamp ?? 0)
    );

    expect(initType).toBeDefined();
    expect(initEnter).toBeDefined();
    expect((initEnter?.timestamp ?? 0) - (initType?.timestamp ?? 0)).toBeGreaterThanOrEqual(70);
  });

  it("waits after activating Ghostty before pasting the shell initialization command", async () => {
    const client = createDesktopClient();
    const originalExecuteAction = client.executeAction.getMockImplementation() as
      | ((action: DesktopExecutableAction) => Promise<DesktopActionResult>)
      | undefined;
    const actionTimes: Array<{ action: DesktopExecutableAction; timestamp: number }> = [];

    client.executeAction.mockImplementation(async (action: DesktopExecutableAction) => {
      actionTimes.push({ action, timestamp: Date.now() });
      if (!originalExecuteAction) {
        throw new Error("Missing executeAction test implementation.");
      }

      return originalExecuteAction(action);
    });

    await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));

    const activation = actionTimes.find(
      ({ action }) => action.type === "activate_app" && action.bundleId === "com.mitchellh.ghostty"
    );
    const initType = actionTimes.find(
      ({ action, timestamp }) =>
        action.type === "type_text"
        && action.text.includes("SKFIY_SESSION=1")
        && timestamp >= (activation?.timestamp ?? 0)
    );

    expect(activation).toBeDefined();
    expect(initType).toBeDefined();
    expect((initType?.timestamp ?? 0) - (activation?.timestamp ?? 0)).toBeGreaterThanOrEqual(250);
  });

  it("does not type the user command until the Ghostty shell ready marker is visible", async () => {
    const client = createDesktopClient();
    client.ocrImage.mockResolvedValue({ labels: [] });

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));
    const typedTexts = client.executeAction.mock.calls
      .map(([action]) => action as DesktopExecutableAction)
      .filter((action): action is Extract<DesktopExecutableAction, { type: "type_text" }> =>
        action.type === "type_text"
      )
      .map((action) => action.text);

    expect(typedTexts).toContainEqual(expect.stringContaining("SKFIY_SESSION=1"));
    expect(typedTexts).not.toContainEqual(expect.stringMatching(/^pwd; __skfiy_status=/));
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "initialize",
      reason: "Ghostty shell ready marker was not observed."
    });
    expect(events.some((event) => event.type === "session_initialized")).toBe(false);
  }, 10000);

  it("does not treat an unsubmitted initialization command as the shell ready marker", async () => {
    const client = createDesktopClient();
    client.ocrImage.mockImplementation(async (inputPath: string) => ({
      labels: inputPath.includes("before")
        ? [{
            text: "printf ' InSKFIY_READYIn'",
            confidence: 0.5,
            bounds: { x: 737, y: 80, width: 187, height: 13 }
          }]
        : []
    }));

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));
    const typedTexts = client.executeAction.mock.calls
      .map(([action]) => action as DesktopExecutableAction)
      .filter((action): action is Extract<DesktopExecutableAction, { type: "type_text" }> =>
        action.type === "type_text"
      )
      .map((action) => action.text);

    expect(typedTexts).toContainEqual(expect.stringContaining("SKFIY_SESSION=1"));
    expect(typedTexts).not.toContainEqual(expect.stringMatching(/^pwd; __skfiy_status=/));
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "initialize",
      reason: "Ghostty shell ready marker was not observed."
    });
  }, 10000);

  it("reinitializes the skfiy shell once when the ready marker is missing after launch", async () => {
    const client = createDesktopClient();
    client.ocrImage.mockImplementation(async (inputPath: string) => {
      const initTypeCount = client.executeAction.mock.calls
        .map(([action]) => action as DesktopExecutableAction)
        .filter((action) => action.type === "type_text" && action.text.includes("SKFIY_SESSION=1"))
        .length;

      if (inputPath.includes("before")) {
        return {
          labels: initTypeCount < 2
            ? []
            : [{
                text: "SKFIY_READY",
                confidence: 0.92,
                bounds: { x: 36, y: 120, width: 120, height: 18 }
              }]
        };
      }

      return {
        labels: [{
          text: readLatestCompletionMarker(client.executeAction.mock.calls) ?? "SKFIY_DONE_A",
          confidence: 0.93,
          bounds: { x: 36, y: 420, width: 180, height: 18 }
        }]
      };
    });

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));
    const typedTexts = client.executeAction.mock.calls
      .map(([action]) => action as DesktopExecutableAction)
      .filter((action): action is Extract<DesktopExecutableAction, { type: "type_text" }> =>
        action.type === "type_text"
      )
      .map((action) => action.text);

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      command: "pwd"
    });
    expect(typedTexts.filter((text) => text.includes("SKFIY_SESSION=1"))).toHaveLength(2);
    expect(typedTexts.findIndex((text) => text.startsWith("pwd; __skfiy_status="))).toBeGreaterThan(
      typedTexts.findIndex((text) => text.includes("SKFIY_SESSION=1"))
    );
  });

  it("recovers when the ready marker appears on a non-observable Ghostty retry", async () => {
    const client = createDesktopClient();
    let openCount = 0;
    let brokenReadyObservationSeen = false;

    client.executeAction.mockImplementation(async (action: DesktopExecutableAction) => {
      if (action.type === "open_ghostty_session") {
        openCount += 1;
        return {
          bundleId: "com.mitchellh.ghostty",
          title: "skfiy-shell",
          pid: openCount === 1 ? 54502 : 54599,
          opened: true
        };
      }

      if (action.type === "observe_app") {
        const initTypeCount = client.executeAction.mock.calls
          .map(([recordedAction]) => recordedAction as DesktopExecutableAction)
          .filter((recordedAction) =>
            recordedAction.type === "type_text" && recordedAction.text.includes("SKFIY_SESSION=1")
          )
          .length;

        if (openCount === 1 && initTypeCount >= 2 && !brokenReadyObservationSeen) {
          brokenReadyObservationSeen = true;
          return {
            bundleId: action.bundleId,
            pid: action.pid,
            isRunning: false,
            isActive: false,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: []
          };
        }

        return {
          bundleId: action.bundleId,
          pid: action.pid,
          isRunning: true,
          isActive: true,
          screenshotPath: action.screenshotOutputPath,
          frontmostBundleId: "com.mitchellh.ghostty",
          accessibilityTrusted: true,
          windows: [
            {
              title: "skfiy-shell",
              layer: 0,
              bounds: { x: 10, y: 20, width: 640, height: 480 }
            }
          ]
        };
      }

      return { ok: true };
    });
    client.ocrImage.mockImplementation(async (inputPath: string) => {
      if (inputPath.includes("after")) {
        return {
          labels: [{
            text: readLatestCompletionMarker(client.executeAction.mock.calls) ?? "SKFIY_DONE_A",
            confidence: 0.93,
            bounds: { x: 36, y: 420, width: 180, height: 18 }
          }]
        };
      }

      const initTypeCount = client.executeAction.mock.calls
        .map(([action]) => action as DesktopExecutableAction)
        .filter((action) => action.type === "type_text" && action.text.includes("SKFIY_SESSION=1"))
        .length;

      return {
        labels: initTypeCount >= 2
          ? [{
              text: "SKFIY_READY",
              confidence: 0.92,
              bounds: { x: 36, y: 120, width: 120, height: 18 }
            }]
          : []
      };
    });

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));
    const actions = client.executeAction.mock.calls.map(([action]) => action as DesktopExecutableAction);
    const userTypeIndex = actions.findIndex((action) =>
      action.type === "type_text"
      && action.text.startsWith("pwd; __skfiy_status=")
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "screenshot_before",
      "recovery_attempted",
      "session_opened",
      "app_activated",
      "session_initialized",
      "screenshot_before",
      "action_verified",
      "typing",
      "action_verified",
      "submitted",
      "screenshot_after",
      "completed"
    ]);
    expect(events.find((event) => event.type === "recovery_attempted")).toMatchObject({
      type: "recovery_attempted",
      stage: "before",
      action: "open",
      reason: "Target app is not running or has no observable windows."
    });
    expect(events.filter((event) => event.type === "session_opened")).toMatchObject([
      { type: "session_opened", pid: 54502 },
      { type: "session_opened", pid: 54599 }
    ]);
    expect(userTypeIndex).toBeGreaterThan(
      actions.findIndex((action) => action.type === "activate_app" && action.pid === 54599)
    );
  }, 10000);

  it("plans an agent request into the terminal command before typing", async () => {
    const client = createDesktopClient();

    const events = await collectEvents(
      runGhosttyCommandTask(client, "打开 Ghostty 执行 pwd 并截图", { createScreenshotPath })
    );

    expect(events[0]).toMatchObject({
      type: "started",
      command: "pwd"
    });
    expect(client.executeAction).toHaveBeenCalledWith({
      type: "type_text",
      text: expect.stringContaining("pwd; __skfiy_status=")
    });
    expect(client.executeAction).not.toHaveBeenCalledWith({
      type: "type_text",
      text: expect.stringContaining("打开 Ghostty 执行 pwd 并截图")
    });
  });

  it("fails after submission when the completion marker is not observed", async () => {
    const client = createDesktopClient();
    client.ocrImage.mockImplementation(async (inputPath: string) => ({
      labels: inputPath.includes("before")
        ? [{
            text: "SKFIY_READY",
            confidence: 0.92,
            bounds: { x: 36, y: 120, width: 120, height: 18 }
          }]
        : []
    }));

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "session_initialized",
      "screenshot_before",
      "action_verified",
      "typing",
      "action_verified",
      "submitted",
      "screenshot_after",
      "verification_failed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "after",
      reason: "Command completion marker was not observed in Ghostty output."
    });
  });

  it("retries after-submit observation until the command completion marker is visible", async () => {
    const client = createDesktopClient();
    let afterObservationCount = 0;

    client.ocrImage.mockImplementation(async (inputPath: string) => {
      if (inputPath.includes("before")) {
        return {
          labels: [{
            text: "SKFIY_READY",
            confidence: 0.92,
            bounds: { x: 36, y: 120, width: 120, height: 18 }
          }]
        };
      }

      afterObservationCount += 1;
      if (afterObservationCount < 2) {
        return { labels: [] };
      }

      return {
        labels: [{
          text: readLatestCompletionMarker(client.executeAction.mock.calls) ?? "SKFIY_DONE_A",
          confidence: 0.93,
          bounds: { x: 36, y: 420, width: 180, height: 18 }
        }]
      };
    });

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      command: "pwd"
    });
    expect(afterObservationCount).toBeGreaterThan(1);
  });

  it("accepts an OCR completion marker when the zero status is read as a letter O", async () => {
    const client = createDesktopClient();
    client.ocrImage.mockImplementation(async (inputPath: string) => ({
      labels: inputPath.includes("before")
        ? [{
            text: "SKFIY_READY",
            confidence: 0.92,
            bounds: { x: 36, y: 120, width: 120, height: 18 }
          }]
        : (() => {
            const markerSuffix =
              readLatestCompletionMarker(client.executeAction.mock.calls)?.replace(/^SKFIY_DONE_/, "")
              ?? "A";
            return [{
              text: `SKFIY DONE ${markerSuffix} STATUS O`,
              confidence: 0.5,
              bounds: { x: 36, y: 420, width: 220, height: 18 }
            }];
          })()
    }));

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      summary: "Command completed in Ghostty."
    });
  });

  it("pauses before typing when OCR reveals sensitive terminal content", async () => {
    const client = createDesktopClient();
    client.ocrImage.mockImplementation(async (inputPath: string) => ({
      labels: inputPath.includes("before")
        ? [{
            text: "Enter API token",
            confidence: 0.91,
            bounds: { x: 36, y: 160, width: 180, height: 18 }
          }]
        : []
    }));

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "screenshot_before",
      "verification_failed"
    ]);
    expect(events.some((event) => event.type === "session_initialized")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "before",
      reason: "Sensitive UI text is visible."
    });
    expect(client.executeAction).not.toHaveBeenCalledWith({
      type: "type_text",
      text: expect.stringMatching(/^pwd; __skfiy_status=/)
    });
  });

  it("rechecks sensitive OCR content after recovering the target app", async () => {
    const client = createDesktopClient();
    let observeCount = 0;
    client.executeAction.mockImplementation(async (action: DesktopExecutableAction): Promise<DesktopActionResult> => {
      if (action.type === "open_ghostty_session") {
        return {
          bundleId: "com.mitchellh.ghostty",
          title: "skfiy-shell",
          pid: 54502,
          opened: true
        };
      }

      if (action.type === "observe_app") {
        observeCount += 1;
        return {
          bundleId: action.bundleId,
          pid: action.pid,
          isRunning: true,
          isActive: observeCount > 1,
          screenshotPath: action.screenshotOutputPath,
          frontmostBundleId: observeCount > 1 ? "com.mitchellh.ghostty" : "com.apple.finder",
          accessibilityTrusted: true,
          windows: [
            {
              title: "skfiy-shell",
              layer: 0,
              bounds: { x: 10, y: 20, width: 640, height: 480 }
            }
          ]
        };
      }

      return { ok: true };
    });
    client.ocrImage.mockImplementation(async () => ({
      labels: observeCount > 1
        ? [{
            text: "Private key passphrase",
            confidence: 0.91,
            bounds: { x: 36, y: 160, width: 220, height: 18 }
          }]
        : []
    }));

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "screenshot_before",
      "recovery_attempted",
      "screenshot_before",
      "verification_failed"
    ]);
    expect(events.some((event) => event.type === "session_initialized")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "before",
      reason: "Sensitive UI text is visible."
    });
    expect(client.executeAction).not.toHaveBeenCalledWith({
      type: "type_text",
      text: expect.stringMatching(/^pwd; __skfiy_status=/)
    });
  });

  it("blocks unrecognized natural language before opening Ghostty", async () => {
    const client = createDesktopClient();

    const events = await collectEvents(
      runGhosttyCommandTask(client, "帮我整理一下桌面", { createScreenshotPath })
    );

    expect(events.map((event) => event.type)).toEqual(["started", "approval_required"]);
    expect(events[0]).toMatchObject({
      type: "started",
      risk: {
        level: "blocked"
      }
    });
    expect(client.getPermissions).not.toHaveBeenCalled();
    expect(client.executeAction).not.toHaveBeenCalled();
  });

  it("stops before opening Ghostty when required Computer Use permissions are missing", async () => {
    const client = createDesktopClient();
    client.getPermissions.mockResolvedValue({
      screenRecording: { state: "denied" },
      accessibility: { state: "not-determined" },
    });

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", { createScreenshotPath })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "verification_failed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "permissions",
      reason: expect.stringContaining("Screen Recording")
    });
    expect(events.at(-1)).toMatchObject({
      reason: expect.stringContaining("Accessibility")
    });
    expect(client.executeAction).not.toHaveBeenCalled();
  });

  it("requires approval for high-risk commands before typing or submitting", async () => {
    const client = createDesktopClient();

    const events = await collectEvents(runGhosttyCommandTask(client, "rm -rf ~/Desktop"));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "approval_required"
    ]);
    expect(client.listApps).not.toHaveBeenCalled();
    expect(client.getPermissions).not.toHaveBeenCalled();
    expect(client.executeAction).not.toHaveBeenCalled();
  });

  it("checks permissions after approval for high-risk commands and still avoids opening Ghostty when blocked", async () => {
    const client = createDesktopClient();
    client.getPermissions.mockResolvedValue({
      screenRecording: { state: "granted" },
      accessibility: { state: "denied" },
    });

    const events = await collectEvents(
      runGhosttyCommandTask(client, "sudo spctl --master-disable", {
        approved: true,
        createScreenshotPath
      })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "approval_required",
      "verification_failed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "permissions",
      reason: expect.stringContaining("Accessibility")
    });
    expect(client.executeAction).not.toHaveBeenCalled();
  });

  it("stops before typing when aborted after the before screenshot", async () => {
    const client = createDesktopClient();
    const controller = new AbortController();
    client.executeAction.mockImplementation(async (action: DesktopExecutableAction) => {
      if (action.type === "open_ghostty_session") {
        return {
          bundleId: "com.mitchellh.ghostty",
          title: "skfiy-shell",
          pid: 54502,
          opened: true
        };
      }

      if (action.type === "observe_app") {
        controller.abort();
        return {
          bundleId: action.bundleId,
          pid: action.pid,
          isRunning: true,
          isActive: true,
          screenshotPath: action.screenshotOutputPath
        };
      }

      return { ok: true };
    });

    const events = await collectEvents(
      runGhosttyCommandTask(client, "pwd", {
        createScreenshotPath,
        signal: controller.signal
      })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "screenshot_before"
    ]);
    expect(events.some((event) => event.type === "session_initialized")).toBe(false);
    expect(client.executeAction).toHaveBeenCalledTimes(5);
  });

  it("asks for confirmation instead of typing when the observed Ghostty window is unsafe", async () => {
    const client = createDesktopClient();
    client.executeAction.mockImplementation(async (action: DesktopExecutableAction) => {
      if (action.type === "open_ghostty_session") {
        return {
          bundleId: "com.mitchellh.ghostty",
          title: "skfiy-shell",
          pid: 54502,
          opened: true
        };
      }

      if (action.type === "observe_app") {
        return {
          bundleId: action.bundleId,
          pid: action.pid,
          isRunning: true,
          isActive: true,
          screenshotPath: action.screenshotOutputPath,
          frontmostBundleId: "com.mitchellh.ghostty",
          accessibilityTrusted: true,
          windows: [
            {
              title: "Codex",
              layer: 0,
              bounds: { x: 10, y: 20, width: 640, height: 480 }
            }
          ]
        };
      }

      return { ok: true };
    });

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "session_initialized",
      "screenshot_before",
      "verification_failed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "before",
      reason: "Observed Ghostty window is not a skfiy-owned session."
    });
    expect(client.executeAction).not.toHaveBeenCalledWith({
      type: "type_text",
      text: "pwd"
    });
  });

  it("fails closed when the opened session is not the exact Ghostty bundle id", async () => {
    const client = createDesktopClient();
    client.executeAction.mockResolvedValueOnce({
      bundleId: "com.example.fakeghostty",
      title: "skfiy-shell",
      pid: 54502,
      opened: true
    });

    await expect(collectEvents(runGhosttyCommandTask(client, "pwd"))).rejects.toThrow(
      "Opened Ghostty session reported an unexpected bundle id."
    );
    expect(client.executeAction).toHaveBeenCalledTimes(1);
    expect(client.executeAction).not.toHaveBeenCalledWith({
      type: "type_text",
      text: "pwd"
    });
  });

  it("asks for confirmation when Ghostty cannot become the focused app", async () => {
    const client = createDesktopClient();
    client.executeAction
      .mockResolvedValueOnce({
        bundleId: "com.mitchellh.ghostty",
        title: "skfiy-shell",
        pid: 54502,
        opened: true
      })
      .mockResolvedValueOnce({
        ok: false,
        message: "Ghostty did not become frontmost."
      });

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "verification_failed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "activate",
      reason: "Ghostty did not become frontmost."
    });
    expect(client.executeAction).toHaveBeenCalledTimes(2);
  });

  it("recovers by reactivating when the before screenshot is not frontmost", async () => {
    const client = createDesktopClient();
    let observeCount = 0;
    client.executeAction.mockImplementation(async (action: DesktopExecutableAction) => {
      if (action.type === "open_ghostty_session") {
        return {
          bundleId: "com.mitchellh.ghostty",
          title: "skfiy-shell",
          pid: 54502,
          opened: true
        };
      }

      if (action.type === "observe_app") {
        observeCount += 1;
        return {
          bundleId: action.bundleId,
          pid: action.pid,
          isRunning: true,
          isActive: observeCount > 1,
          screenshotPath: action.screenshotOutputPath,
          frontmostBundleId: observeCount === 1 ? "com.apple.finder" : "com.mitchellh.ghostty",
          accessibilityTrusted: true,
          windows: [
            {
              title: "skfiy-shell",
              layer: 0,
              bounds: { x: 10, y: 20, width: 640, height: 480 }
            }
          ]
        };
      }

      return { ok: true };
    });

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "session_initialized",
      "screenshot_before",
      "recovery_attempted",
      "screenshot_before",
      "action_verified",
      "typing",
      "action_verified",
      "submitted",
      "screenshot_after",
      "completed"
    ]);
    expect(events.find((event) => event.type === "recovery_attempted")).toMatchObject({
      type: "recovery_attempted",
      stage: "before",
      action: "activate",
      reason: "Target app is running but not frontmost."
    });
    expect(client.executeAction).toHaveBeenNthCalledWith(6, {
      type: "activate_app",
      bundleId: "com.mitchellh.ghostty",
      pid: 54502
    });
    expect(client.executeAction).toHaveBeenNthCalledWith(8, {
      type: "type_text",
      text: expect.stringContaining("pwd; __skfiy_status=")
    });
  });

  it("reactivates before typing when the ready marker appears after Ghostty lost focus", async () => {
    const client = createDesktopClient();
    let observeCount = 0;

    client.executeAction.mockImplementation(async (action: DesktopExecutableAction) => {
      if (action.type === "open_ghostty_session") {
        return {
          bundleId: "com.mitchellh.ghostty",
          title: "skfiy-shell",
          pid: 54502,
          opened: true
        };
      }

      if (action.type === "observe_app") {
        observeCount += 1;
        return {
          bundleId: action.bundleId,
          pid: action.pid,
          isRunning: true,
          isActive: observeCount !== 2,
          screenshotPath: action.screenshotOutputPath,
          frontmostBundleId: observeCount === 2 ? "com.openai.codex" : "com.mitchellh.ghostty",
          accessibilityTrusted: true,
          windows: [
            {
              title: "skfiy-shell",
              layer: 0,
              bounds: { x: 10, y: 20, width: 640, height: 480 }
            }
          ]
        };
      }

      return { ok: true };
    });
    client.ocrImage.mockImplementation(async (inputPath: string) => {
      if (inputPath.includes("after")) {
        return {
          labels: [{
            text: readLatestCompletionMarker(client.executeAction.mock.calls) ?? "SKFIY_DONE_A",
            confidence: 0.93,
            bounds: { x: 36, y: 420, width: 180, height: 18 }
          }]
        };
      }

      const observedBeforeCount = client.executeAction.mock.calls
        .map(([action]) => action as DesktopExecutableAction)
        .filter((action) => action.type === "observe_app")
        .length;

      return {
        labels: observedBeforeCount >= 2
          ? [{
              text: "SKFIY_READY",
              confidence: 0.92,
              bounds: { x: 36, y: 120, width: 120, height: 18 }
            }]
          : []
      };
    });

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));
    const actions = client.executeAction.mock.calls.map(([action]) => action as DesktopExecutableAction);
    let lastActivationBeforeTyping = -1;
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      const action = actions[index];
      if (
        action.type === "activate_app"
        && action.bundleId === "com.mitchellh.ghostty"
        && action.pid === 54502
      ) {
        lastActivationBeforeTyping = index;
        break;
      }
    }
    const userTypeIndex = actions.findIndex((action) =>
      action.type === "type_text"
      && action.text.startsWith("pwd; __skfiy_status=")
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "screenshot_before",
      "session_initialized",
      "screenshot_before",
      "recovery_attempted",
      "screenshot_before",
      "action_verified",
      "typing",
      "action_verified",
      "submitted",
      "screenshot_after",
      "completed"
    ]);
    expect(events.find((event) => event.type === "recovery_attempted")).toMatchObject({
      type: "recovery_attempted",
      stage: "before",
      action: "activate",
      reason: "Target app is running but not frontmost."
    });
    expect(userTypeIndex).toBeGreaterThan(lastActivationBeforeTyping);
  });

  it("recovers by opening a fresh skfiy Ghostty session when no target window is observable", async () => {
    const client = createDesktopClient();
    let openCount = 0;
    let observeCount = 0;
    client.executeAction.mockImplementation(async (action: DesktopExecutableAction) => {
      if (action.type === "open_ghostty_session") {
        openCount += 1;
        return {
          bundleId: "com.mitchellh.ghostty",
          title: "skfiy-shell",
          pid: openCount === 1 ? 54502 : 54599,
          opened: true
        };
      }

      if (action.type === "observe_app") {
        observeCount += 1;
        if (observeCount === 1) {
          return {
            bundleId: action.bundleId,
            pid: action.pid,
            isRunning: false,
            isActive: false,
            screenshotPath: action.screenshotOutputPath,
            frontmostBundleId: "com.apple.finder",
            accessibilityTrusted: true,
            windows: []
          };
        }

        return {
          bundleId: action.bundleId,
          pid: action.pid,
          isRunning: true,
          isActive: true,
          screenshotPath: action.screenshotOutputPath,
          frontmostBundleId: "com.mitchellh.ghostty",
          accessibilityTrusted: true,
          windows: [
            {
              title: "skfiy-shell",
              layer: 0,
              bounds: { x: 10, y: 20, width: 640, height: 480 }
            }
          ]
        };
      }

      return { ok: true };
    });

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "session_initialized",
      "screenshot_before",
      "recovery_attempted",
      "session_opened",
      "app_activated",
      "session_initialized",
      "screenshot_before",
      "action_verified",
      "typing",
      "action_verified",
      "submitted",
      "screenshot_after",
      "completed"
    ]);
    expect(events.find((event) => event.type === "recovery_attempted")).toMatchObject({
      type: "recovery_attempted",
      stage: "before",
      action: "open",
      reason: "Target app is not running or has no observable windows."
    });
    expect(events.filter((event) => event.type === "session_opened")).toMatchObject([
      {
        type: "session_opened",
        pid: 54502
      },
      {
        type: "session_opened",
        pid: 54599
      }
    ]);
    expect(client.executeAction).toHaveBeenNthCalledWith(6, {
      type: "open_ghostty_session",
      title: "skfiy-shell"
    });
    expect(client.executeAction).toHaveBeenCalledWith({
      type: "type_text",
      text: expect.stringContaining("pwd; __skfiy_status=")
    });
    expect(client.executeAction).not.toHaveBeenCalledWith({
      type: "observe_app",
      bundleId: "com.mitchellh.ghostty",
      pid: 54502,
      screenshotOutputPath: "/tmp/after.png"
    });
    expect(client.executeAction).toHaveBeenCalledWith({
      type: "observe_app",
      bundleId: "com.mitchellh.ghostty",
      pid: 54599,
      screenshotOutputPath: "/tmp/after.png"
    });
  });

  it("asks for confirmation when the after screenshot no longer observes the owned session", async () => {
    const client = createDesktopClient();
    let observeCount = 0;
    client.executeAction.mockImplementation(async (action: DesktopExecutableAction) => {
      if (action.type === "open_ghostty_session") {
        return {
          bundleId: "com.mitchellh.ghostty",
          title: "skfiy-shell",
          pid: 54502,
          opened: true
        };
      }

      if (action.type === "observe_app") {
        observeCount += 1;
        return {
          bundleId: action.bundleId,
          pid: observeCount === 1 ? action.pid : 12345,
          isRunning: true,
          isActive: true,
          screenshotPath: action.screenshotOutputPath,
          frontmostBundleId: "com.mitchellh.ghostty",
          accessibilityTrusted: true,
          windows: [
            {
              title: observeCount === 1 ? "skfiy-shell" : "other-shell",
              layer: 0,
              bounds: { x: 10, y: 20, width: 640, height: 480 }
            }
          ]
        };
      }

      return { ok: true };
    });

    const events = await collectEvents(runGhosttyCommandTask(client, "pwd", { createScreenshotPath }));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "locating_app",
      "session_opened",
      "app_activated",
      "session_initialized",
      "screenshot_before",
      "action_verified",
      "typing",
      "action_verified",
      "submitted",
      "screenshot_after",
      "verification_failed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "verification_failed",
      stage: "after",
      reason: "Observed Ghostty window is not a skfiy-owned session."
    });
  });

  it("runs an approved high-risk command after emitting approval context", async () => {
    const client = createDesktopClient();

    const events = await collectEvents(
      runGhosttyCommandTask(client, "sudo spctl --master-disable", {
        approved: true,
        createScreenshotPath
      })
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "approval_required",
      "locating_app",
      "session_opened",
      "app_activated",
      "session_initialized",
      "screenshot_before",
      "action_verified",
      "typing",
      "action_verified",
      "submitted",
      "screenshot_after",
      "completed"
    ]);
    expect(client.executeAction).toHaveBeenCalledWith({
      type: "type_text",
      text: expect.stringContaining("sudo spctl --master-disable; __skfiy_status=")
    });
    expect(client.executeAction).toHaveBeenCalledWith({
      type: "press_key",
      key: "enter"
    });
  });
});
