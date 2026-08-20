import { describe, expect, it, vi } from "vitest";
import {
  readAssistantAgentSettingsResponse,
  readAssistantAgentSettingsUpdate,
  updateAssistantAgentSettingsResponse,
  type AssistantAgentSettingsStoreLike
} from "./main-assistant-agent-settings-response";
import type {
  AssistantAgentProviderState,
  AssistantAgentSettings
} from "./assistant-agent";

function createSettings(
  overrides: Partial<AssistantAgentSettings> = {}
): AssistantAgentSettings {
  return {
    mode: "codex",
    codexBinary: "codex",
    codexBinarySource: "default",
    claudeCodeBinary: "claude",
    claudeCodeBinarySource: "default",
    hermesBinary: "hermes",
    hermesBinarySource: "default",
    cwd: "/tmp/skfiy",
    timeoutMs: 45_000,
    ...overrides
  };
}

function createProvider(
  id: AssistantAgentProviderState["id"],
  readiness: AssistantAgentProviderState["readiness"],
  selected = false
): AssistantAgentProviderState {
  const label = id === "codex" ? "Codex" : id === "claude-code" ? "Claude Code" : "Hermes";
  return {
    provider: "assistant",
    id,
    label,
    selected,
    configured: true,
    executablePath: id,
    executableSource: "default",
    readiness
  };
}

function createStore(settings: AssistantAgentSettings): AssistantAgentSettingsStoreLike {
  let current = settings;
  return {
    get: () => current,
    set: vi.fn((update) => {
      current = { ...current, ...update };
      return current;
    })
  };
}

describe("main assistant agent settings response", () => {
  it("reads the current settings and provider states with fallback", async () => {
    const settings = createSettings({ mode: "codex" });
    const store = createStore(settings);
    const providers = [
      createProvider("codex", "chat-ready", true),
      createProvider("claude-code", "unavailable"),
      createProvider("hermes", "unavailable")
    ];
    const readProviderStates = vi.fn(async () => providers);

    const response = await readAssistantAgentSettingsResponse({
      store,
      readProviderStates
    });

    expect(response.settings).toBe(settings);
    expect(response.providers).toBe(providers);
    expect(response.fallback).toBeUndefined();
    expect(readProviderStates).toHaveBeenCalledWith(settings);
  });

  it("includes a fallback decision when the selected provider is unavailable", async () => {
    const settings = createSettings({ mode: "codex" });
    const store = createStore(settings);
    const providers = [
      createProvider("codex", "unavailable", true),
      createProvider("claude-code", "chat-ready"),
      createProvider("hermes", "unavailable")
    ];

    const response = await readAssistantAgentSettingsResponse({
      store,
      readProviderStates: async () => providers
    });

    expect(response.fallback).toEqual({
      kind: "fallback",
      requestedMode: "codex",
      activeMode: "claude-code",
      reason: "Codex is unavailable; skfiy can fall back to Claude Code."
    });
  });

  it("includes an offline fallback when no provider is available", async () => {
    const settings = createSettings({ mode: "codex" });
    const store = createStore(settings);
    const providers = [
      createProvider("codex", "unavailable", true),
      createProvider("claude-code", "unavailable"),
      createProvider("hermes", "unconfigured")
    ];

    const response = await readAssistantAgentSettingsResponse({
      store,
      readProviderStates: async () => providers
    });

    expect(response.fallback).toEqual({
      kind: "offline",
      requestedMode: "codex",
      reason: "Codex is unavailable and no fallback provider is available."
    });
  });

  it("updates the store and returns the refreshed response", async () => {
    const settings = createSettings({ mode: "codex" });
    const store = createStore(settings);
    const providers = [
      createProvider("codex", "chat-ready", true),
      createProvider("claude-code", "chat-ready"),
      createProvider("hermes", "unavailable")
    ];

    const response = await updateAssistantAgentSettingsResponse({
      store,
      update: { mode: "claude-code" },
      readProviderStates: async () => providers
    });

    expect(store.set).toHaveBeenCalledWith({ mode: "claude-code" });
    expect(response.settings.mode).toBe("claude-code");
    expect(response.fallback).toBeUndefined();
  });

  it("passes providerRuntime updates to the store", async () => {
    const settings = createSettings({ mode: "codex" });
    const store = createStore(settings);

    await updateAssistantAgentSettingsResponse({
      store,
      update: {
        providerRuntime: { codex: { cwd: "/workspace", timeoutMs: 30_000 } }
      },
      readProviderStates: async () => [
        createProvider("codex", "chat-ready", true),
        createProvider("claude-code", "unavailable"),
        createProvider("hermes", "unavailable")
      ]
    });

    expect(store.set).toHaveBeenCalledWith({
      providerRuntime: { codex: { cwd: "/workspace", timeoutMs: 30_000 } }
    });
  });

  it("normalizes non-object updates to an empty object", () => {
    expect(readAssistantAgentSettingsUpdate(null)).toEqual({});
    expect(readAssistantAgentSettingsUpdate("invalid")).toEqual({});
    expect(readAssistantAgentSettingsUpdate(42)).toEqual({});
    expect(readAssistantAgentSettingsUpdate({ mode: "hermes" })).toEqual({
      mode: "hermes"
    });
  });
});
