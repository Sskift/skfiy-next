import { describe, expect, it } from "vitest";

import {
  APP_POLICY_OPTIONS,
  ASSISTANT_AGENT_OPTIONS,
  DEFAULT_APP_POLICY_SETTINGS,
  DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
  DEFAULT_PLANNER_PROVIDER_SETTINGS,
  PLANNER_PROVIDER_OPTIONS,
  reduceAppPolicySettings,
  reduceAssistantAgentSettingsResponse,
  reducePlannerProviderSettings
} from "./app-settings-state";

describe("app settings state", () => {
  it("exposes stable settings option labels", () => {
    expect(APP_POLICY_OPTIONS).toEqual([
      { policy: "allow", label: "允许" },
      { policy: "ask", label: "询问" },
      { policy: "deny", label: "拒绝" }
    ]);
    expect(ASSISTANT_AGENT_OPTIONS.map((option) => option.mode)).toEqual([
      "codex",
      "claude-code",
      "hermes"
    ]);
    expect(PLANNER_PROVIDER_OPTIONS.map((option) => option.mode)).toEqual([
      "local-deterministic",
      "external-cua",
      "disabled"
    ]);
  });

  it("updates one controlled app policy without changing other entries", () => {
    expect(reduceAppPolicySettings(DEFAULT_APP_POLICY_SETTINGS, {
      bundleId: "com.apple.finder",
      policy: "deny"
    })).toEqual({
      apps: [
        { name: "Ghostty", bundleId: "com.mitchellh.ghostty", policy: "allow" },
        { name: "Chrome", bundleId: "com.google.Chrome", policy: "ask" },
        { name: "Finder", bundleId: "com.apple.finder", policy: "deny" }
      ]
    });
  });

  it("updates Background Agent mode and selected provider together", () => {
    expect(reduceAssistantAgentSettingsResponse(
      DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
      { mode: "hermes" }
    )).toMatchObject({
      settings: {
        mode: "hermes"
      },
      providers: [
        { id: "codex", selected: false },
        { id: "claude-code", selected: false },
        { id: "hermes", selected: true }
      ]
    });
  });

  it("keeps Background Agent selection stable for empty updates", () => {
    expect(reduceAssistantAgentSettingsResponse(
      DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
      {}
    ).providers.map((provider) => [provider.id, provider.selected])).toEqual([
      ["codex", true],
      ["claude-code", false],
      ["hermes", false]
    ]);
  });

  it("updates only the Computer Use Planner mode", () => {
    expect(reducePlannerProviderSettings(DEFAULT_PLANNER_PROVIDER_SETTINGS, {
      mode: "disabled"
    })).toEqual({
      ...DEFAULT_PLANNER_PROVIDER_SETTINGS,
      mode: "disabled"
    });
  });
});
