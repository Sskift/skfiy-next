import { describe, expect, it } from "vitest";
import { createTurnTranscript } from "./turn-transcript";

describe("createTurnTranscript", () => {
  it("summarizes app, screenshots, actions, and risk for a Computer Use turn", () => {
    expect(createTurnTranscript([
      {
        type: "started",
        command: "pwd",
        risk: {
          level: "low",
          reason: "Read-only terminal command.",
          requiresApproval: false
        }
      },
      { type: "locating_app", appName: "Ghostty" },
      { type: "session_opened", appName: "Ghostty", title: "skfiy-shell", pid: 54502 },
      { type: "app_activated", appName: "Ghostty", bundleId: "com.mitchellh.ghostty", pid: 54502 },
      {
        type: "screenshot_before",
        path: "/tmp/before.png",
        observation: {
          bundleId: "com.mitchellh.ghostty",
          pid: 54502,
          isRunning: true,
          isActive: true,
          screenshotPath: "/tmp/before.png",
          accessibilityTrusted: true,
          windows: [
            {
              title: "skfiy-shell",
              layer: 0,
              bounds: { x: 10, y: 20, width: 640, height: 480 }
            }
          ]
        }
      },
      { type: "typing", command: "pwd" },
      { type: "submitted", key: "enter" },
      {
        type: "screenshot_after",
        path: "/tmp/after.png",
        observation: {
          bundleId: "com.mitchellh.ghostty",
          pid: 54502,
          isRunning: true,
          isActive: true,
          screenshotPath: "/tmp/after.png",
          accessibilityTrusted: true,
          windows: [
            {
              title: "skfiy-shell",
              layer: 0,
              bounds: { x: 10, y: 20, width: 640, height: 480 }
            }
          ]
        }
      },
      { type: "completed", command: "pwd", summary: "Command submitted to Ghostty." }
    ])).toEqual({
      command: "pwd",
      risk: {
        level: "low",
        reason: "Read-only terminal command.",
        requiresApproval: false
      },
      approvalRequired: false,
      apps: [
        {
          name: "Ghostty",
          bundleId: "com.mitchellh.ghostty",
          pid: 54502
        }
      ],
      screenshots: [
        {
          stage: "before",
          path: "/tmp/before.png",
          bundleId: "com.mitchellh.ghostty",
          pid: 54502,
          accessibilityTrusted: true,
          grounding: {
            bundleId: "com.mitchellh.ghostty",
            screenshotPath: "/tmp/before.png",
            recommendation: "structured_first",
            sources: [
              {
                source: "macos_accessibility",
                status: "covered",
                observedElementCount: 1,
                labelCount: 1,
                notes: ["Accessibility is trusted and produced 1 window-level element."]
              },
              {
                source: "screenshot_ocr",
                status: "missing",
                observedElementCount: 0,
                labelCount: 0,
                notes: ["OCR labels have not been parsed for this screenshot."]
              }
            ]
          }
        },
        {
          stage: "after",
          path: "/tmp/after.png",
          bundleId: "com.mitchellh.ghostty",
          pid: 54502,
          accessibilityTrusted: true,
          grounding: {
            bundleId: "com.mitchellh.ghostty",
            screenshotPath: "/tmp/after.png",
            recommendation: "structured_first",
            sources: [
              {
                source: "macos_accessibility",
                status: "covered",
                observedElementCount: 1,
                labelCount: 1,
                notes: ["Accessibility is trusted and produced 1 window-level element."]
              },
              {
                source: "screenshot_ocr",
                status: "missing",
                observedElementCount: 0,
                labelCount: 0,
                notes: ["OCR labels have not been parsed for this screenshot."]
              }
            ]
          }
        }
      ],
      actions: [
        { type: "open_session", appName: "Ghostty", pid: 54502 },
        { type: "activate_app", appName: "Ghostty", bundleId: "com.mitchellh.ghostty", pid: 54502 },
        { type: "type_text", text: "pwd" },
        { type: "press_key", key: "enter" }
      ],
      outcome: "completed"
    });
  });

  it("records approval context for risky commands", () => {
    expect(createTurnTranscript([
      {
        type: "started",
        command: "mkdir demo",
        risk: {
          level: "medium",
          reason: "Command can create or modify local state.",
          requiresApproval: true
        }
      },
      {
        type: "approval_required",
        command: "mkdir demo",
        risk: {
          level: "medium",
          reason: "Command can create or modify local state.",
          requiresApproval: true
        }
      }
    ])).toMatchObject({
      command: "mkdir demo",
      risk: {
        level: "medium"
      },
      approvalRequired: true,
      actions: [],
      outcome: "approval_required"
    });
  });

  it("records agent-owned tool lifecycle identity and terminal denial", () => {
    expect(createTurnTranscript([
      {
        type: "tool_call",
        turnId: "turn-agent-1",
        toolCallId: "turn-agent-1-tool-1",
        command: "打开 Chrome 测试页面",
        route: "chrome",
        status: "planned"
      },
      {
        type: "tool_call",
        turnId: "turn-agent-1",
        toolCallId: "turn-agent-1-tool-1",
        command: "打开 Chrome 测试页面",
        route: "chrome",
        status: "approval_required"
      },
      {
        type: "approval_decision",
        turnId: "turn-agent-1",
        toolCallId: "turn-agent-1-tool-1",
        command: "打开 Chrome 测试页面",
        route: "chrome",
        decision: "denied",
        reason: "User denied browser mutation."
      },
      {
        type: "tool_result",
        turnId: "turn-agent-1",
        toolCallId: "turn-agent-1-tool-1",
        command: "打开 Chrome 测试页面",
        route: "chrome",
        status: "denied",
        summary: "User denied browser mutation."
      }
    ])).toMatchObject({
      command: "打开 Chrome 测试页面",
      approvalRequired: true,
      outcome: "denied",
      actions: [
        {
          type: "tool_call",
          turnId: "turn-agent-1",
          toolCallId: "turn-agent-1-tool-1",
          route: "chrome",
          status: "planned"
        },
        {
          type: "tool_call",
          turnId: "turn-agent-1",
          toolCallId: "turn-agent-1-tool-1",
          route: "chrome",
          status: "approval_required"
        },
        {
          type: "approval_decision",
          turnId: "turn-agent-1",
          toolCallId: "turn-agent-1-tool-1",
          route: "chrome",
          decision: "denied",
          reason: "User denied browser mutation."
        },
        {
          type: "tool_result",
          turnId: "turn-agent-1",
          toolCallId: "turn-agent-1-tool-1",
          route: "chrome",
          status: "denied",
          summary: "User denied browser mutation.",
          artifactCount: 0
        }
      ]
    });
  });

  it("records planner rationale before execution actions", () => {
    expect(createTurnTranscript([
      {
        type: "planner_resolved",
        providerLabel: "External CUA",
        input: "打开 Ghostty 执行 pwd 并截图",
        command: "pwd",
        rationale: "Read the current working directory."
      },
      {
        type: "started",
        command: "pwd",
        risk: {
          level: "low",
          reason: "Read-only terminal command.",
          requiresApproval: false
        }
      },
      { type: "typing", command: "pwd" }
    ])).toMatchObject({
      command: "pwd",
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
        },
        { type: "type_text", text: "pwd" }
      ]
    });
  });

  it("records action verification decisions as replay actions", () => {
    expect(createTurnTranscript([
      {
        type: "action_verified",
        actionType: "type_text",
        status: "passed",
        message: "type_text helper result accepted."
      },
      {
        type: "action_verified",
        actionType: "press_key",
        status: "needs_user_confirmation",
        reason: "Completion marker was not observed."
      }
    ])).toMatchObject({
      actions: [
        {
          type: "verify",
          actionType: "type_text",
          status: "passed",
          message: "type_text helper result accepted."
        },
        {
          type: "verify",
          actionType: "press_key",
          status: "needs_user_confirmation",
          reason: "Completion marker was not observed."
        }
      ],
      outcome: "needs_confirmation"
    });
  });

  it("keeps verification failures that need a human distinct from permission failures", () => {
    expect(createTurnTranscript([
      {
        type: "verification_failed",
        stage: "after",
        reason: "Completion marker was not observed."
      }
    ])).toMatchObject({
      outcome: "needs_confirmation"
    });

    expect(createTurnTranscript([
      {
        type: "verification_failed",
        stage: "permissions",
        reason: "Screen Recording permission is required."
      }
    ])).toMatchObject({
      outcome: "failed"
    });
  });

  it("records Finder semantic selection observations as replay actions", () => {
    expect(createTurnTranscript([
      {
        type: "finder_selection_observed",
        context: {
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
      }
    ])).toMatchObject({
      actions: [
        {
          type: "observe_finder_selection",
          source: "finder-applescript",
          frontmostBundleId: "com.apple.finder",
          targetPath: "/tmp/skfiy-finder-smoke",
          selectedCount: 1
        }
      ]
    });
  });

  it("records Finder plan previews as replay actions before execution", () => {
    expect(createTurnTranscript([
      {
        type: "plan_preview",
        preview: {
          rootPath: "/tmp/skfiy-finder-smoke",
          operationCount: 6,
          destructiveOperationCount: 0,
          createFolders: ["Images", "Documents", "Code"],
          moveFiles: [
            {
              from: "/tmp/skfiy-finder-smoke/photo.png",
              to: "/tmp/skfiy-finder-smoke/Images/photo.png"
            },
            {
              from: "/tmp/skfiy-finder-smoke/notes.pdf",
              to: "/tmp/skfiy-finder-smoke/Documents/notes.pdf"
            },
            {
              from: "/tmp/skfiy-finder-smoke/script.ts",
              to: "/tmp/skfiy-finder-smoke/Code/script.ts"
            }
          ]
        }
      }
    ])).toMatchObject({
      apps: [
        {
          name: "Finder",
          bundleId: "com.apple.finder"
        }
      ],
      actions: [
        {
          type: "preview_finder_plan",
          rootPath: "/tmp/skfiy-finder-smoke",
          operationCount: 6,
          destructiveOperationCount: 0,
          createFolderCount: 3,
          moveFileCount: 3
        }
      ]
    });
  });

  it("records Finder plan confirmation as an approval checkpoint", () => {
    expect(createTurnTranscript([
      {
        type: "plan_confirmation_required",
        command: "Finder current folder",
        reason: "Finder current-folder organization needs confirmation after plan preview.",
        preview: {
          rootPath: "/tmp/skfiy-finder-smoke",
          operationCount: 6,
          destructiveOperationCount: 0,
          createFolders: ["Images", "Documents", "Code"],
          moveFiles: [
            {
              from: "/tmp/skfiy-finder-smoke/photo.png",
              to: "/tmp/skfiy-finder-smoke/Images/photo.png"
            }
          ]
        }
      }
    ])).toMatchObject({
      command: "Finder current folder",
      approvalRequired: true,
      outcome: "needs_confirmation",
      actions: [
        {
          type: "confirm_finder_plan",
          rootPath: "/tmp/skfiy-finder-smoke",
          operationCount: 6,
          destructiveOperationCount: 0,
          reason: "Finder current-folder organization needs confirmation after plan preview."
        }
      ]
    });
  });

  it("records Chrome submit confirmation without form values", () => {
    const transcript = createTurnTranscript([{
      type: "submit_confirmation_required",
      command: "file:///tmp/skfiy-form.html",
      binding: {
        schemaVersion: 1,
        url: "file:///tmp/skfiy-form.html",
        fieldSelectors: ["#name", "#role"],
        submitSelector: "#submit"
      },
      reason: "Confirm submitting 2 non-sensitive fields with #submit."
    }]);

    expect(transcript).toMatchObject({
      approvalRequired: true,
      outcome: "approval_required",
      apps: [{ name: "Chrome", bundleId: "com.google.Chrome" }],
      actions: [{
        type: "confirm_chrome_submit",
        fieldSelectors: ["#name", "#role"],
        submitSelector: "#submit"
      }]
    });
    expect(JSON.stringify(transcript)).not.toContain("private-value");
  });

  it("uses OCR labels as screenshot grounding when accessibility is blocked", () => {
    expect(createTurnTranscript([
      {
        type: "screenshot_before",
        path: "/tmp/before.png",
        observation: {
          bundleId: "com.mitchellh.ghostty",
          pid: 54502,
          isRunning: true,
          isActive: true,
          screenshotPath: "/tmp/before.png",
          accessibilityTrusted: false,
          windows: [],
          ocrLabels: [
            {
              text: "pwd",
              confidence: 0.88,
              bounds: { x: 36, y: 88, width: 42, height: 18 }
            }
          ]
        }
      }
    ] as never)).toMatchObject({
      screenshots: [
        {
          grounding: {
            recommendation: "ocr_fallback",
            sources: [
              {
                source: "macos_accessibility",
                status: "blocked"
              },
              {
                source: "screenshot_ocr",
                status: "covered",
                observedElementCount: 1,
                labelCount: 1
              }
            ]
          }
        }
      ]
    });
  });

  it("transcribes the Finder task result from a completed event", () => {
    const result = {
      schemaVersion: 1 as const,
      rootPath: "/tmp/work",
      destinationPath: "/tmp/work",
      collisionPolicy: "cancel" as const,
      totalOperationCount: 6,
      completedCount: 5,
      failedCount: 1,
      skippedCount: 0,
      completedItems: [
        {
          operationId: "op-1",
          operationType: "create_folder" as const,
          to: "/tmp/work/Images",
          resultingName: "Images",
          resolution: "create" as const
        }
      ],
      failedItems: [
        {
          operationId: "op-4",
          operationType: "move_file" as const,
          from: "/tmp/work/photo.png",
          to: "/tmp/work/Images/photo.png",
          reason: "Destination already exists.",
          errorCode: "destination-exists"
        }
      ],
      destinationVerified: true,
      resultingNamesVerified: true
    };

    const transcript = createTurnTranscript([
      { type: "started", command: "/tmp/work", risk: { level: "medium", reason: "Finder organization.", requiresApproval: true } },
      { type: "completed", command: "/tmp/work", summary: "5 of 6 operations completed, 1 failed.", result }
    ]);

    expect(transcript.outcome).toBe("completed");
    expect(transcript.finderTaskResult).toEqual(result);
  });

  it("omits the Finder task result when the completed event has none", () => {
    const transcript = createTurnTranscript([
      { type: "completed", command: "pwd", summary: "Command completed in Ghostty." }
    ]);

    expect(transcript.outcome).toBe("completed");
    expect(transcript.finderTaskResult).toBeUndefined();
  });

  it("folds terminal context observation into a transcript action", () => {
    const transcript = createTurnTranscript([
      {
        type: "terminal_context_observed",
        context: {
          workingDirectory: "/Users/foo",
          promptReady: true,
          lastCommandEcho: "",
          recentOutputTail: "line-a",
          sensitiveContentDetected: false
        }
      }
    ]);

    expect(transcript.actions).toContainEqual({
      type: "observe_terminal_context",
      workingDirectory: "/Users/foo",
      promptReady: true,
      sensitiveContentDetected: false
    });
  });

  it("folds a command preview into a transcript action", () => {
    const transcript = createTurnTranscript([
      {
        type: "command_preview",
        preview: {
          command: "mkdir skfiy-test",
          workingDirectory: "/Users/foo",
          risk: {
            level: "medium",
            reason: "Command can create or modify local state.",
            requiresApproval: true
          },
          mutating: true,
          expectedResult: "May modify local state; outcome is verified after completion",
          expectedVerification: "Confirm the owned Ghostty session remains active and observe the command completion marker."
        }
      }
    ]);

    expect(transcript.actions).toContainEqual({
      type: "preview_terminal_command",
      command: "mkdir skfiy-test",
      workingDirectory: "/Users/foo",
      mutating: true,
      riskLevel: "medium",
      expectedResult: "May modify local state; outcome is verified after completion"
    });
  });

  it("folds a retry attempt into a transcript action", () => {
    const transcript = createTurnTranscript([
      {
        type: "retry_attempted",
        stage: "verification",
        attempt: 1,
        reason: "Exit status was not readable; re-observing."
      }
    ]);

    expect(transcript.actions).toContainEqual({
      type: "retry_observation",
      stage: "verification",
      attempt: 1,
      reason: "Exit status was not readable; re-observing."
    });
  });

  it("records the completed exit code on the transcript", () => {
    const transcript = createTurnTranscript([
      { type: "completed", command: "pwd", summary: "Command completed in Ghostty with exit code 0.", exitCode: 0 }
    ]);

    expect(transcript.outcome).toBe("completed");
    expect(transcript.exitCode).toBe(0);
  });

  it("records an unknown exit code on the transcript", () => {
    const transcript = createTurnTranscript([
      { type: "completed", command: "pwd", summary: "Command completed in Ghostty with exit code unknown.", exitCode: "unknown" }
    ]);

    expect(transcript.exitCode).toBe("unknown");
  });
});
