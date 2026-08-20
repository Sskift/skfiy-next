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

  it("exposes three default assistant agent providers", () => {
    expect(DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE.providers.map((provider) => provider.id)).toEqual([
      "codex",
      "claude-code",
      "hermes"
    ]);
    expect(DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE.providers.map((provider) => provider.selected)).toEqual([
      true,
      false,
      false
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
      { mode: "claude-code" }
    )).toMatchObject({
      settings: {
        mode: "claude-code"
      },
      providers: [
        { id: "codex", selected: false },
        { id: "claude-code", selected: true },
        { id: "hermes", selected: false }
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

  it("merges per-provider runtime overrides without touching other providers", () => {
    const reduced = reduceAssistantAgentSettingsResponse(
      DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
      {
        mode: "codex",
        providerRuntime: {
          codex: { cwd: "/workspace/codex", timeoutMs: 30_000 },
          hermes: { cwd: "/workspace/hermes" }
        }
      }
    );

    expect(reduced.settings.providerRuntime).toEqual({
      codex: { cwd: "/workspace/codex", timeoutMs: 30_000 },
      hermes: { cwd: "/workspace/hermes" }
    });
  });

  it("merges per-provider runtime overrides across updates", () => {
    const first = reduceAssistantAgentSettingsResponse(
      DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
      { providerRuntime: { codex: { cwd: "/workspace/codex" } } }
    );
    const second = reduceAssistantAgentSettingsResponse(first, {
      providerRuntime: { codex: { timeoutMs: 60_000 } }
    });

    expect(second.settings.providerRuntime).toEqual({
      codex: { cwd: "/workspace/codex", timeoutMs: 60_000 }
    });
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
