import { describe, expect, it } from "vitest";
import {
  isAssistantAgentProviderAvailable,
  readAssistantAgentFallback,
  readAssistantAgentFallbackLabel
} from "./assistant-agent-provider-fallback";
import type {
  AssistantAgentProviderState,
  AssistantAgentSettings
} from "./assistant-agent";

function createSettings(
  mode: AssistantAgentSettings["mode"] = "codex"
): AssistantAgentSettings {
  return {
    mode,
    codexBinary: "codex",
    codexBinarySource: "default",
    claudeCodeBinary: "claude",
    claudeCodeBinarySource: "default",
    hermesBinary: "hermes",
    hermesBinarySource: "default",
    cwd: "/tmp/skfiy",
    timeoutMs: 45_000
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

describe("assistant agent provider fallback", () => {
  it("returns no fallback when the selected provider is available", () => {
    const providers = [
      createProvider("codex", "chat-ready", true),
      createProvider("claude-code", "unavailable"),
      createProvider("hermes", "unavailable")
    ];

    expect(readAssistantAgentFallback(createSettings("codex"), providers)).toBeUndefined();
  });

  it("returns no fallback when the selected provider is version-ok", () => {
    const providers = [
      createProvider("codex", "version-ok", true),
      createProvider("claude-code", "unavailable")
    ];

    expect(readAssistantAgentFallback(createSettings("codex"), providers)).toBeUndefined();
  });

  it("falls back to the next available provider when the selected one is unavailable", () => {
    const providers = [
      createProvider("codex", "unavailable", true),
      createProvider("claude-code", "chat-ready"),
      createProvider("hermes", "unavailable")
    ];

    const fallback = readAssistantAgentFallback(createSettings("codex"), providers);
    expect(fallback).toEqual({
      kind: "fallback",
      requestedMode: "codex",
      activeMode: "claude-code",
      reason: "Codex is unavailable; skfiy can fall back to Claude Code."
    });
  });

  it("falls back to a version-ok provider when no chat-ready provider exists", () => {
    const providers = [
      createProvider("codex", "auth-or-permission-blocked", true),
      createProvider("claude-code", "unavailable"),
      createProvider("hermes", "version-ok")
    ];

    const fallback = readAssistantAgentFallback(createSettings("codex"), providers);
    expect(fallback).toEqual({
      kind: "fallback",
      requestedMode: "codex",
      activeMode: "hermes",
      reason: "Codex is auth-or-permission-blocked; skfiy can fall back to Hermes."
    });
  });

  it("returns an offline decision when no fallback provider is available", () => {
    const providers = [
      createProvider("codex", "unavailable", true),
      createProvider("claude-code", "unavailable"),
      createProvider("hermes", "unconfigured")
    ];

    const fallback = readAssistantAgentFallback(createSettings("codex"), providers);
    expect(fallback).toEqual({
      kind: "offline",
      requestedMode: "codex",
      reason: "Codex is unavailable and no fallback provider is available."
    });
  });

  it("returns an offline decision when the selected provider is unconfigured", () => {
    const providers = [
      createProvider("codex", "unconfigured", true),
      createProvider("claude-code", "unavailable")
    ];

    const fallback = readAssistantAgentFallback(createSettings("codex"), providers);
    expect(fallback?.kind).toBe("offline");
  });

  it("treats chat-ready and version-ok as available readiness states", () => {
    expect(isAssistantAgentProviderAvailable("chat-ready")).toBe(true);
    expect(isAssistantAgentProviderAvailable("version-ok")).toBe(true);
    expect(isAssistantAgentProviderAvailable("binary-found")).toBe(false);
    expect(isAssistantAgentProviderAvailable("unavailable")).toBe(false);
    expect(isAssistantAgentProviderAvailable("auth-or-permission-blocked")).toBe(false);
  });

  it("labels fallback decisions for the UI", () => {
    expect(readAssistantAgentFallbackLabel(undefined)).toBe("");
    expect(readAssistantAgentFallbackLabel({
      kind: "fallback",
      requestedMode: "codex",
      activeMode: "hermes",
      reason: "test"
    })).toBe("fallback:hermes");
    expect(readAssistantAgentFallbackLabel({
      kind: "offline",
      requestedMode: "codex",
      reason: "test"
    })).toBe("offline");
  });
});
