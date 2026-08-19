import { describe, expect, it } from "vitest";
import { DesktopHelperClient } from "./desktop-helper";
import type { DesktopHelperProcessResult, ProcessRunner } from "./types";

function createClientWithResponses(responses: DesktopHelperProcessResult[]) {
  const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];
  const runner: ProcessRunner = async (command, args, options?: { signal?: AbortSignal }) => {
    calls.push({ command, args: [...args], signal: options?.signal });
    const response = responses.shift();

    if (!response) {
      throw new Error("Unexpected helper invocation.");
    }

    return response;
  };

  return {
    calls,
    client: new DesktopHelperClient({
      helperPath: "/tmp/skfiy-helper",
      runner
    })
  };
}

describe("DesktopHelperClient", () => {
  it("builds safe argument arrays for each helper command", async () => {
    const ok = { stdout: "{\"ok\":true}", stderr: "", exitCode: 0 };
    const { calls, client } = createClientWithResponses([
      { stdout: "{\"apps\":[]}", stderr: "", exitCode: 0 },
      ok,
      { stdout: "{\"outputPath\":\"/tmp/shot.png\"}", stderr: "", exitCode: 0 },
      ok,
      ok,
      ok,
      ok,
      ok,
      ok,
      {
        stdout:
          "{\"screenRecording\":{\"state\":\"granted\"},\"accessibility\":{\"state\":\"denied\"}}",
        stderr: "",
        exitCode: 0
      },
      ok,
      ok
    ]);

    await client.listApps();
    await client.activateApp("com.mitchellh.ghostty");
    await client.screenshot("/tmp/shot.png");
    await client.typeText("echo hello; rm -rf /");
    await client.pressKey("enter");
    await client.click(12, 34);
    await client.selectInputSource("com.example.inputmethod.pinyin");
    await client.doubleTapFunctionKey();
    await client.pressShortcut("space", ["control", "option", "command", "shift"]);
    await client.getPermissions();
    await client.openPermissionSettings("screen-recording");

    expect(calls).toEqual([
      { command: "/tmp/skfiy-helper", args: ["list-apps"] },
      { command: "/tmp/skfiy-helper", args: ["activate-app", "--bundle-id", "com.mitchellh.ghostty"] },
      { command: "/tmp/skfiy-helper", args: ["screenshot", "--output", "/tmp/shot.png"] },
      { command: "/tmp/skfiy-helper", args: ["type-text", "--text", "echo hello; rm -rf /"] },
      { command: "/tmp/skfiy-helper", args: ["press-key", "--key", "enter"] },
      { command: "/tmp/skfiy-helper", args: ["click", "--x", "12", "--y", "34"] },
      {
        command: "/tmp/skfiy-helper",
        args: [
          "select-input-source",
          "--source-id",
          "com.example.inputmethod.pinyin"
        ]
      },
      {
        command: "/tmp/skfiy-helper",
        args: ["double-tap-fn"]
      },
      {
        command: "/tmp/skfiy-helper",
        args: [
          "press-shortcut",
          "--key",
          "space",
          "--modifiers",
          "control,option,command,shift"
        ]
      },
      { command: "/tmp/skfiy-helper", args: ["permissions-status"] },
      {
        command: "/tmp/skfiy-helper",
        args: ["open-permission-settings", "--permission", "screen-recording"]
      }
    ]);
  });

  it("dispatches desktop actions through safe helper commands", async () => {
    const { calls, client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: true,
          command: "open-ghostty-session",
          data: {
            bundleId: "com.mitchellh.ghostty",
            title: "skfiy-shell",
            processIdentifier: 54502,
            opened: true
          }
        }),
        stderr: "",
        exitCode: 0
      },
      { stdout: "{\"ok\":true}", stderr: "", exitCode: 0 },
      { stdout: "{\"outputPath\":\"/tmp/action-shot.png\"}", stderr: "", exitCode: 0 },
      { stdout: "{\"ok\":true,\"message\":\"clicked\"}", stderr: "", exitCode: 0 },
      { stdout: "{\"ok\":true}", stderr: "", exitCode: 0 },
      { stdout: "{\"ok\":true}", stderr: "", exitCode: 0 },
      { stdout: "{\"ok\":true}", stderr: "", exitCode: 0 },
      { stdout: "{\"ok\":true}", stderr: "", exitCode: 0 },
      { stdout: "{\"ok\":true}", stderr: "", exitCode: 0 }
    ]);

    await expect(
      client.executeAction({
        type: "open_ghostty_session",
        title: "skfiy-shell",
        workingDirectory: "/Users/bytedance"
      })
    ).resolves.toEqual({
      bundleId: "com.mitchellh.ghostty",
      title: "skfiy-shell",
      pid: 54502,
      opened: true
    });
    await expect(
      client.executeAction({ type: "activate_app", bundleId: "com.mitchellh.ghostty" })
    ).resolves.toEqual({ ok: true });
    await expect(
      client.executeAction({ type: "screenshot", outputPath: "/tmp/action-shot.png" })
    ).resolves.toEqual({ outputPath: "/tmp/action-shot.png" });
    await expect(client.executeAction({ type: "click", x: 12, y: 34 })).resolves.toEqual({
      ok: true,
      message: "clicked"
    });
    await expect(client.executeAction({ type: "type_text", text: "hello" })).resolves.toEqual({
      ok: true
    });
    await expect(client.executeAction({ type: "press_key", key: "enter" })).resolves.toEqual({
      ok: true
    });
    await expect(
      client.executeAction({
        type: "hotkey",
        key: "space",
        modifiers: ["control", "option", "command", "shift"]
      })
    ).resolves.toEqual({ ok: true });
    await expect(
      client.executeAction({ type: "scroll", deltaX: 0, deltaY: -420 })
    ).resolves.toEqual({ ok: true });
    await expect(
      client.executeAction({
        type: "drag",
        from: { x: 10, y: 20 },
        to: { x: 110, y: 220 },
        durationMs: 250
      })
    ).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        command: "/tmp/skfiy-helper",
        args: [
          "open-ghostty-session",
          "--title",
          "skfiy-shell",
          "--working-directory",
          "/Users/bytedance"
        ]
      },
      { command: "/tmp/skfiy-helper", args: ["activate-app", "--bundle-id", "com.mitchellh.ghostty"] },
      { command: "/tmp/skfiy-helper", args: ["screenshot", "--output", "/tmp/action-shot.png"] },
      { command: "/tmp/skfiy-helper", args: ["click", "--x", "12", "--y", "34"] },
      { command: "/tmp/skfiy-helper", args: ["type-text", "--text", "hello"] },
      { command: "/tmp/skfiy-helper", args: ["press-key", "--key", "enter"] },
      {
        command: "/tmp/skfiy-helper",
        args: [
          "press-shortcut",
          "--key",
          "space",
          "--modifiers",
          "control,option,command,shift"
        ]
      },
      { command: "/tmp/skfiy-helper", args: ["scroll", "--delta-x", "0", "--delta-y", "-420"] },
      {
        command: "/tmp/skfiy-helper",
        args: [
          "drag",
          "--from-x",
          "10",
          "--from-y",
          "20",
          "--to-x",
          "110",
          "--to-y",
          "220",
          "--duration-ms",
          "250"
        ]
      }
    ]);
  });

  it("parses JSON responses from listApps and getAppState", async () => {
    const { calls, client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          apps: [
            { bundleId: "com.mitchellh.ghostty", name: "Ghostty", pid: 4312 },
            { bundleId: "com.apple.finder", name: "Finder" }
          ]
        }),
        stderr: "",
        exitCode: 0
      },
      {
        stdout: JSON.stringify({
          bundleId: "com.mitchellh.ghostty",
          isRunning: true,
          isActive: false,
          screenshotPath: "/tmp/state.png"
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(client.listApps()).resolves.toEqual([
      { bundleId: "com.mitchellh.ghostty", name: "Ghostty", pid: 4312 },
      { bundleId: "com.apple.finder", name: "Finder" }
    ]);

    await expect(client.getAppState("com.mitchellh.ghostty", "/tmp/state.png")).resolves.toEqual({
      bundleId: "com.mitchellh.ghostty",
      isRunning: true,
      isActive: false,
      screenshotPath: "/tmp/state.png"
    });

    expect(calls[1]).toEqual({
      command: "/tmp/skfiy-helper",
      args: [
        "get-app-state",
        "--bundle-id",
        "com.mitchellh.ghostty",
        "--screenshot-output",
        "/tmp/state.png"
      ]
    });
  });

  it("parses permission status responses", async () => {
    const { client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: true,
          command: "permissions-status",
          data: {
            screenRecording: { status: "authorized", granted: true },
            accessibility: { status: "notAuthorized", granted: false }
          }
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(client.getPermissions()).resolves.toEqual({
      screenRecording: { state: "granted" },
      accessibility: { state: "denied" }
    });
  });

  it("reads desktop session preflight diagnostics from the helper", async () => {
    const { calls, client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: true,
          command: "desktop-session-status",
          data: {
            frontmostBundleId: "com.apple.loginwindow",
            frontmostLocalizedName: "loginwindow",
            frontmostProcessIdentifier: 123,
            mainDisplayAsleep: true,
            controllable: false
          }
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(client.getDesktopSessionStatus()).resolves.toEqual({
      frontmostBundleId: "com.apple.loginwindow",
      frontmostLocalizedName: "loginwindow",
      frontmostProcessIdentifier: 123,
      mainDisplayAsleep: true,
      controllable: false
    });
    expect(calls).toEqual([
      {
        command: "/tmp/skfiy-helper",
        args: ["desktop-session-status"]
      }
    ]);
  });

  it("parses OCR labels from screenshot image responses", async () => {
    const { calls, client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: true,
          command: "ocr-image",
          data: {
            labels: [
              {
                text: "skfiy-shell",
                confidence: 0.91,
                bounds: { x: 14, y: 24, width: 180, height: 22 }
              }
            ]
          }
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(client.ocrImage("/tmp/ghostty.png")).resolves.toEqual({
      labels: [
        {
          text: "skfiy-shell",
          confidence: 0.91,
          bounds: { x: 14, y: 24, width: 180, height: 22 }
        }
      ]
    });

    expect(calls).toEqual([
      {
        command: "/tmp/skfiy-helper",
        args: ["ocr-image", "--input", "/tmp/ghostty.png"]
      }
    ]);
  });

  it("reads semantic Finder selection context from the helper", async () => {
    const { calls, client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: true,
          command: "get-finder-selection",
          data: {
            source: "finder-applescript",
            frontmostBundleId: "com.apple.finder",
            targetPath: "/tmp/skfiy-finder-smoke",
            selection: [
              {
                path: "/tmp/skfiy-finder-smoke/photo.png",
                name: "photo.png",
                kind: "file"
              }
            ]
          }
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(client.getFinderSelection()).resolves.toEqual({
      source: "finder-applescript",
      frontmostBundleId: "com.apple.finder",
      targetPath: "/tmp/skfiy-finder-smoke",
      selection: [
        {
          path: "/tmp/skfiy-finder-smoke/photo.png",
          name: "photo.png",
          kind: "file"
        }
      ]
    });

    expect(calls).toEqual([
      {
        command: "/tmp/skfiy-helper",
        args: ["get-finder-selection"]
      }
    ]);
  });

  it("reads Finder item layout coordinates from the helper", async () => {
    const { calls, client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: true,
          command: "get-finder-item-layout",
          data: {
            source: "finder-applescript-layout",
            frontmostBundleId: "com.apple.finder",
            folderPath: "/tmp/skfiy-finder-smoke",
            items: [
              {
                path: "/tmp/skfiy-finder-smoke/photo.png",
                name: "photo.png",
                kind: "file",
                center: { x: 160, y: 220 },
                bounds: { x: 128, y: 188, width: 64, height: 64 }
              },
              {
                path: "/tmp/skfiy-finder-smoke/Images",
                name: "Images",
                kind: "directory",
                center: { x: 360, y: 220 },
                bounds: { x: 328, y: 188, width: 64, height: 64 }
              }
            ]
          }
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(
      client.getFinderItemLayout("/tmp/skfiy-finder-smoke", ["photo.png", "Images"])
    ).resolves.toEqual({
      source: "finder-applescript-layout",
      frontmostBundleId: "com.apple.finder",
      folderPath: "/tmp/skfiy-finder-smoke",
      items: [
        {
          path: "/tmp/skfiy-finder-smoke/photo.png",
          name: "photo.png",
          kind: "file",
          center: { x: 160, y: 220 },
          bounds: { x: 128, y: 188, width: 64, height: 64 }
        },
        {
          path: "/tmp/skfiy-finder-smoke/Images",
          name: "Images",
          kind: "directory",
          center: { x: 360, y: 220 },
          bounds: { x: 328, y: 188, width: 64, height: 64 }
        }
      ]
    });

    expect(calls).toEqual([
      {
        command: "/tmp/skfiy-helper",
        args: [
          "get-finder-item-layout",
          "--folder",
          "/tmp/skfiy-finder-smoke",
          "--items",
          "photo.png,Images"
        ]
      }
    ]);
  });

  it("returns app state for observe_app desktop actions", async () => {
    const { calls, client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          bundleId: "com.mitchellh.ghostty",
          isRunning: true,
          isActive: true,
          screenshotPath: "/tmp/observed.png"
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(
      client.executeAction({
        type: "observe_app",
        bundleId: "com.mitchellh.ghostty",
        pid: 54502,
        screenshotOutputPath: "/tmp/observed.png"
      })
    ).resolves.toEqual({
      bundleId: "com.mitchellh.ghostty",
      isRunning: true,
      isActive: true,
      screenshotPath: "/tmp/observed.png"
    });

    expect(calls).toEqual([
      {
        command: "/tmp/skfiy-helper",
        args: [
          "get-app-state",
          "--bundle-id",
          "com.mitchellh.ghostty",
          "--pid",
          "54502",
          "--screenshot-output",
          "/tmp/observed.png"
        ]
      }
    ]);
  });

  it("parses enveloped Swift helper responses and normalizes payload names", async () => {
    const { client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: true,
          command: "list-apps",
          data: {
            apps: [
              {
                bundleId: "com.mitchellh.ghostty",
                localizedName: "Ghostty",
                processIdentifier: 4312,
                isActive: true
              }
            ]
          }
        }),
        stderr: "",
        exitCode: 0
      },
      {
        stdout: JSON.stringify({
          ok: true,
          command: "activate-app",
          data: { bundleId: "com.mitchellh.ghostty", activated: true }
        }),
        stderr: "",
        exitCode: 0
      },
      {
        stdout: JSON.stringify({
          ok: true,
          command: "screenshot",
          data: { output: "/tmp/shot.png" }
        }),
        stderr: "",
        exitCode: 0
      },
      {
        stdout: JSON.stringify({
          ok: true,
          command: "get-app-state",
          data: {
            app: {
              bundleId: "com.mitchellh.ghostty",
              localizedName: "Ghostty",
              processIdentifier: 4312,
              isActive: false
            },
            frontmostBundleId: "com.mitchellh.ghostty",
            accessibilityTrusted: true,
            screenshot: { output: "/tmp/state.png" },
            windows: [
              {
                title: "skfiy-shell",
                layer: 0,
                bounds: { x: 10, y: 20, width: 640, height: 480 }
              }
            ]
          }
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(client.listApps()).resolves.toEqual([
      { bundleId: "com.mitchellh.ghostty", name: "Ghostty", pid: 4312 }
    ]);
    await expect(client.activateApp("com.mitchellh.ghostty")).resolves.toEqual({ ok: true });
    await expect(client.screenshot("/tmp/shot.png")).resolves.toEqual({
      outputPath: "/tmp/shot.png"
    });
    await expect(client.getAppState("com.mitchellh.ghostty", "/tmp/state.png")).resolves.toEqual({
      bundleId: "com.mitchellh.ghostty",
      pid: 4312,
      isRunning: true,
      isActive: false,
      screenshotPath: "/tmp/state.png",
      frontmostBundleId: "com.mitchellh.ghostty",
      accessibilityTrusted: true,
      windows: [
        {
          title: "skfiy-shell",
          layer: 0,
          bounds: { x: 10, y: 20, width: 640, height: 480 }
        }
      ]
    });
  });

  it("explains activate-app failures when macOS keeps loginwindow frontmost", async () => {
    const { client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: true,
          command: "activate-app",
          data: {
            bundleId: "com.mitchellh.ghostty",
            processIdentifier: 54502,
            activated: false,
            requestedActivation: false,
            frontmostBundleId: "com.apple.loginwindow"
          }
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(client.activateApp("com.mitchellh.ghostty", 54502)).resolves.toEqual({
      ok: false,
      message: "Desktop session is not controllable because loginwindow is frontmost. Unlock the Mac and keep the display awake, then try again."
    });
  });

  it("explains activate-app failures with the app that stayed frontmost", async () => {
    const { client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: true,
          command: "activate-app",
          data: {
            bundleId: "com.mitchellh.ghostty",
            processIdentifier: 54502,
            activated: false,
            requestedActivation: true,
            frontmostBundleId: "com.apple.finder",
            frontmostProcessIdentifier: 4312
          }
        }),
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(client.activateApp("com.mitchellh.ghostty", 54502)).resolves.toEqual({
      ok: false,
      message: "Target app did not become frontmost; current frontmost app is com.apple.finder (pid 4312)."
    });
  });

  it("throws useful errors when the helper exits non-zero", async () => {
    const { client } = createClientWithResponses([
      {
        stdout: "",
        stderr: "Accessibility permission denied",
        exitCode: 13
      }
    ]);

    await expect(client.click(1, 2)).rejects.toThrow(
      "Desktop helper command failed (click) with exit code 13: Accessibility permission denied"
    );
  });

  it("explains screenshot permission failures when screencapture exits silently", async () => {
    const { client } = createClientWithResponses([
      {
        stdout: "",
        stderr: "",
        exitCode: 1
      }
    ]);

    await expect(client.screenshot("/tmp/shot.png")).rejects.toThrow(
      "Desktop helper command failed (screenshot) with exit code 1: Screen Recording permission is required"
    );
  });

  it("throws useful errors from helper error envelopes", async () => {
    const { client } = createClientWithResponses([
      {
        stdout: JSON.stringify({
          ok: false,
          command: "click",
          error: {
            code: "accessibility_permission_required",
            message: "Accessibility permission is required for this action."
          }
        }),
        stderr: "",
        exitCode: 1
      }
    ]);

    await expect(client.click(1, 2)).rejects.toThrow(
      "Desktop helper command failed (click) with exit code 1: Accessibility permission is required for this action."
    );
  });

  it("throws useful errors for invalid JSON responses", async () => {
    const { client } = createClientWithResponses([
      {
        stdout: "not-json",
        stderr: "",
        exitCode: 0
      }
    ]);

    await expect(client.listApps()).rejects.toThrow(
      "Desktop helper returned invalid JSON for list-apps: not-json"
    );
  });

  it("rejects invalid action inputs before invoking the helper", async () => {
    const { calls, client } = createClientWithResponses([]);

    await expect(client.executeAction({ type: "click", x: Number.NaN, y: 1 })).rejects.toThrow(
      "x must be a finite number"
    );
    await expect(client.executeAction({ type: "type_text", text: "" })).rejects.toThrow(
      "text must be a non-empty string"
    );
    await expect(client.executeAction({ type: "screenshot", outputPath: "" })).rejects.toThrow(
      "outputPath must be a non-empty string"
    );
    await expect(
      client.executeAction({ type: "activate_app", bundleId: "" })
    ).rejects.toThrow("bundleId must be a non-empty string");
    await expect(client.executeAction({ type: "press_key", key: "" })).rejects.toThrow(
      "key must be a non-empty string"
    );
    await expect(
      client.executeAction({
        type: "observe_app",
        bundleId: "com.mitchellh.ghostty",
        screenshotOutputPath: ""
      })
    ).rejects.toThrow("screenshotOutputPath must be a non-empty string");
    await expect(
      client.executeAction({ type: "hotkey", key: "space", modifiers: [] })
    ).rejects.toThrow("modifiers must include at least one modifier");
    await expect(
      client.executeAction({ type: "scroll", deltaX: Number.NaN, deltaY: 1 })
    ).rejects.toThrow("deltaX must be a finite number");
    await expect(
      client.executeAction({
        type: "drag",
        from: { x: 0, y: Number.NaN },
        to: { x: 1, y: 1 }
      })
    ).rejects.toThrow(
      "from.y must be a finite number"
    );

    expect(calls).toEqual([]);
  });

  it("rejects invalid legacy helper method inputs before invoking the helper", async () => {
    const { calls, client } = createClientWithResponses([]);

    await expect(client.click(Number.POSITIVE_INFINITY, 1)).rejects.toThrow(
      "x must be a finite number"
    );
    await expect(client.typeText("")).rejects.toThrow("text must be a non-empty string");
    await expect(client.pressKey("")).rejects.toThrow("key must be a non-empty string");
    await expect(client.activateApp("")).rejects.toThrow("bundleId must be a non-empty string");
    await expect(client.screenshot("")).rejects.toThrow(
      "outputPath must be a non-empty string"
    );
    await expect(client.getAppState("com.mitchellh.ghostty", "")).rejects.toThrow(
      "screenshotOutputPath must be a non-empty string"
    );
    await expect(client.ocrImage("")).rejects.toThrow(
      "inputPath must be a non-empty string"
    );
    await expect(client.selectInputSource("")).rejects.toThrow(
      "sourceId must be a non-empty string"
    );
    await expect(client.pressShortcut("", ["control"])).rejects.toThrow(
      "key must be a non-empty string"
    );
    await expect(client.pressShortcut("space", [])).rejects.toThrow(
      "modifiers must include at least one modifier"
    );
    await expect(client.pressShortcut("space", ["control", ""])).rejects.toThrow(
      "modifier must be a non-empty string"
    );

    expect(calls).toEqual([]);
  });
});
