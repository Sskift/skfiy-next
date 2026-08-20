import { describe, expect, it } from "vitest";

import {
  captureProfileSettings,
  createDefaultProfileSettings,
  type LiveProfileSettings
} from "./profile-settings";
import { readInitialAppPolicySettings } from "./app-policy-settings";

describe("profile settings", () => {
  it("creates defaults that mirror the initial app policy settings", () => {
    const settings = createDefaultProfileSettings();

    expect(settings.assistantAgent.mode).toBe("codex");
    expect(settings.plannerProvider.mode).toBe("local-deterministic");
    expect(settings.workflowDefaults).toEqual({
      defaultManualMode: "active",
      postTurnLearningEnabled: true,
      writeApprovalEnabled: false
    });

    // The default profile seeds from the live initial settings, so its app
    // policy must match readInitialAppPolicySettings exactly.
    const initial = readInitialAppPolicySettings();
    expect(settings.appPolicy.apps.map((app) => app.bundleId).sort()).toEqual(
      initial.apps.map((app) => app.bundleId).sort()
    );
    for (const app of settings.appPolicy.apps) {
      const initialApp = initial.apps.find((entry) => entry.bundleId === app.bundleId);
      expect(app.policy).toBe(initialApp?.policy);
    }
  });

  it("captures the live settings subset without leaking provider binary paths", () => {
    const captured = captureProfileSettings({
      assistantAgent: {
        mode: "claude-code",
        providerRuntime: { "claude-code": { cwd: "/repo", timeoutMs: 12_000 } }
      },
      plannerProvider: { mode: "external-cua" },
      appPolicy: {
        apps: [
          { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" },
          { name: "Chrome", bundleId: "com.google.Chrome", policy: "deny" }
        ]
      },
      personalMemory: {
        postTurnLearningEnabled: false,
        writeApprovalEnabled: true
      },
      defaultManualMode: "quiet"
    });

    expect(captured.assistantAgent).toEqual({
      mode: "claude-code",
      providerRuntime: { "claude-code": { cwd: "/repo", timeoutMs: 12_000 } }
    });
    expect(captured.plannerProvider).toEqual({ mode: "external-cua" });
    expect(captured.appPolicy.apps).toHaveLength(2);
    expect(captured.workflowDefaults).toEqual({
      defaultManualMode: "quiet",
      postTurnLearningEnabled: false,
      writeApprovalEnabled: true
    });

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("codexBinary");
    expect(serialized).not.toContain("claudeCodeBinary");
  });

  it("clones captured settings so later live edits do not mutate the profile", () => {
    const live: LiveProfileSettings = {
      assistantAgent: { mode: "codex" },
      plannerProvider: { mode: "local-deterministic" },
      appPolicy: {
        apps: [
          { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" }
        ]
      },
      personalMemory: {
        postTurnLearningEnabled: true,
        writeApprovalEnabled: false
      },
      defaultManualMode: "active"
    };

    const captured = captureProfileSettings(live);
    live.appPolicy.apps[0].policy = "deny";

    expect(captured.appPolicy.apps[0].policy).toBe("allow");
  });
});
