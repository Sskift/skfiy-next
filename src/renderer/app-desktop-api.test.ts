import { afterEach, describe, expect, it } from "vitest";

import type { DesktopApi } from "./app-types";
import { fallbackDesktopApi, getDesktopApi } from "./app-desktop-api";
import {
  UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS,
  UNKNOWN_PERMISSIONS
} from "./app-permission-state";
import {
  DEFAULT_APP_POLICY_SETTINGS,
  DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE,
  DEFAULT_PLANNER_PROVIDER_SETTINGS
} from "./app-settings-state";

describe("app desktop api", () => {
  afterEach(() => {
    delete window.skfiy;
  });

  it("uses the preload api when it is available", () => {
    const api = { ...fallbackDesktopApi };
    window.skfiy = api;

    expect(getDesktopApi()).toBe(api);
  });

  it("falls back to inert defaults when preload is unavailable", async () => {
    delete window.skfiy;
    const api = getDesktopApi();

    expect(api).toBe(fallbackDesktopApi);
    await expect(api.getPermissions()).resolves.toBe(UNKNOWN_PERMISSIONS);
    await expect(api.getDesktopSessionDiagnostics()).resolves.toBe(UNKNOWN_DESKTOP_SESSION_DIAGNOSTICS);
    await expect(api.getAppPolicySettings()).resolves.toBe(DEFAULT_APP_POLICY_SETTINGS);
    await expect(api.getAssistantAgentSettings()).resolves.toBe(DEFAULT_ASSISTANT_AGENT_SETTINGS_RESPONSE);
    await expect(api.getPlannerProviderSettings()).resolves.toBe(DEFAULT_PLANNER_PROVIDER_SETTINGS);
    await expect(api.getTurnReplay()).resolves.toBeNull();
    await expect(api.getWindowBounds()).resolves.toBeNull();
  });

  it("applies fallback settings reducers for local interaction", async () => {
    const api: DesktopApi = getDesktopApi();

    await expect(api.setAppPolicy({
      bundleId: "com.apple.finder",
      policy: "deny"
    })).resolves.toMatchObject({
      apps: [
        { bundleId: "com.mitchellh.ghostty", policy: "allow" },
        { bundleId: "com.google.Chrome", policy: "ask" },
        { bundleId: "com.apple.finder", policy: "deny" }
      ]
    });
    await expect(api.setAssistantAgentSettings({ mode: "hermes" }))
      .resolves.toMatchObject({
        settings: { mode: "hermes" },
        providers: [
          { id: "codex", selected: false },
          { id: "claude-code", selected: false },
          { id: "hermes", selected: true }
        ]
      });
    await expect(api.setPlannerProviderSettings({ mode: "disabled" }))
      .resolves.toMatchObject({ mode: "disabled" });
  });
});
